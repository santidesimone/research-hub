# Progress

Update at the end of every task. For each: what changed, what was tested for real (and how), what was NOT tested.

| Task | Status | Notes |
|---|---|---|
| 0 Baseline against real services | done (2026-10-30) | See "Task 0" below. |
| 1 Schema model v3 | done (2026-10-30) | See "Task 1" below. |
| 2 Vocabulary nodes and matcher | done (2026-10-30) | See "Task 2" below. |
| 3 Generic items API | not started | |
| 4 Claude analysis, single-call save, audit | not started | |
| 5 Library UI: Collections, forms, audit | not started | |
| 6 CLI, API docs, CI, docs | not started | |
| 7 Hardening | not started | |

## Task 0. Baseline against real services

**Changed**
- `web/core/query.js`: paper search returned a Cypher syntax error on Neo4j 5. `head([(s:Personal {key: ...}) | s.status])` is a pattern comprehension over a single node, which Neo4j rejects because it needs a relationship. It now reads the status through `(s:Personal)-[:FOR]->(p)`. Both the full-text path and the scan fallback were broken. The full-text failure was swallowed silently, so it is now logged with `log.warn`.
- `web/core/query.js`: topic search never matched tag-style queries. Concepts are stored as `name: 'digital cash'` for the tag `topic:digital-cash`, so the query is now normalised (`-` becomes a space) before the concept-name match.
- `web/test/run.js`: offline tests for both fixes, each mutation-checked (reverting the fix fails the test).
- `web/package-lock.json`: `npm install` synced the lockfile's version string to 0.6.0. No dependency changes.

**Tested for real**
- Neo4j 5 Community in a throwaway container with no volume, on ports 17474/17687. Migrations 001 to 004 and personal_001 applied. The `artifact_text` full-text index is ONLINE.
- `npm run test:integration` passes against that database. It covers full-text and topic search, the read-only guard, notes sync with prune, and an idempotent backup/restore.
- Docker image: `docker build .` succeeds. With `NODE_ENV=production`, a short token or the default Neo4j password stops start-up (exit 1). A real token boots and gives `/readyz` 200, 401 without the token, 200 with it, and CSP/nosniff headers.
- CLI against the production container: `hub add` (JSON file, `--file` link, `--status`), `hub search`, `hub get`, `hub sync-notes ./content` (dry run, real run, idempotent re-run), `hub backup`, and `hub restore`. Restore was checked after deleting a paper: the paper, its file link, status and edges came back, and a second restore created no duplicates.

**Not tested / findings**
- Google OAuth and Drive upload/sharing, Crossref (`hub add <doi>` lookup), OpenAlex (`hub enrich`), and Cloud Run deploy were not run: they need real credentials.
- `hub search` does not use the server's ranked search. It sends its own title/author/venue substring query to `/api/query`, so it never searches topics or abstracts. Only MCP calls `query.searchPapers`. Candidate for Task 6 (CLI), which would need a REST search endpoint.
- `./scripts/local.sh` was not run. It targets the persistent `research-hub-neo4j` volume, which may hold real data.

## Task 1. Schema model v3

**Changed**
- `schema/schema.json` v3:
  - `common_fields`, and per-type `fields` for paper, method, use_case and case_study, plus `managed`, `schema_version`, `key_prefix` and the layout hints.
  - Vocabulary entities (Topic, Domain, Venue, Organisation, Dataset, alongside Person and Concept), each with `public` and `prune_orphans`.
  - `relation_types` with endpoints, and a per-type `public_props`.
  - Note and project stay Markdown-managed. History is in `schema/CHANGELOG.md` (new).
- `web/core/schema.js`: `check()` rejects a malformed schema at start-up. `validate()` treats missing required fields as errors and everything else as warnings, and reports unknown fields. New helpers: `fieldsOf`, `keyPrefix`, `managedBy`, `publicProps`, `orphanLabels`, `publicEntityLabels`.
- `web/core/generic-type.js`: uses the key prefix (`usecase:`, `case:`) and runs the validator. Declared fields are stored (objects as JSON text) and unknown fields are kept, except reserved hub properties and unsafe names.
- `web/core/artifacts.js`: every write stamps `managed`, `schema_version` and `collection`. `record_status: auto` is set only on create. Validator warnings are returned. Orphan clean-up covers only Person and Concept.
- `web/core/notes.js`: only `managed: markdown` types sync. `methods/` files (or `kind: method`, `use_case` ...) are skipped with a message. Prune is limited to the Markdown-managed labels, even if a database item carries `source: 'markdown'`.
- `web/core/public-export.js` and `web/core/backup.js`: labels and relationship types come from the schema, so vocabulary nodes are backed up. Each type's whitelist narrows the global one, vocabulary nodes export key and name only, and Organisation is never public.
- `web/features/personal/index.js`: a type with its own `status` field (use_case) no longer writes that value into your personal reading status. This was a collision introduced by the new field; it was found while updating the docs and fixed.
- `web/migrations/005_collections.js`:
  - Constraints for the new labels and an index on `collection`.
  - Rebuilds the full-text index over all type labels, adding `tldr`.
  - Stamps `managed`, `schema_version`, `collection` and `record_status` on existing nodes.
  - Markdown methods become `source: hub` with `imported_from: markdown`, and their edges `source: hub`.
  - Seeds the 10 Domains (MERGE with ON CREATE, so owner edits survive a re-run).
- README, `web/openapi.json`, and the overview text Claude sees (`query.js`) were updated. `_env.example` did not change.

**Tested for real**
- Offline: new tests for the loader (14 broken-schema cases plus the invalid-file throw), the validator, the generic writer, prune limits, the per-type public whitelist, vocabulary backup, migration 005's Cypher, and the status collision.
  - Mutation check: 35 single-line breaks of the new code; 34 fail the suite.
  - The survivor is the validator `throw` in generic-type.js. It is unreachable today because title, the only required field, is rejected earlier. It becomes live when another field is marked `required`.
- Legacy data on a throwaway Neo4j 5:
  - Created with the previous commit's code (git worktree at 474224d): 4 seed papers, `sync-notes ./content` (2 Markdown methods, a note and a project), a personal status, and a method from the old `POST /api/artifacts/method`.
  - The new code then booted on that database and applied 005.
  - Checked: methods migrated with their edges, Domains seeded, the full-text index ONLINE over all six labels, new constraints present, and personal statuses untouched.
  - The old API still works: `GET /api/artifacts?type=method`, a legacy method POST with `?overwrite=true` (USES edge kept, `record_status` not reset), a note POST, `hub search`, `hub get`, and `sync-notes` (methods skipped, nothing removed).
  - New types: a case study POST (warnings, unknown field kept), and a missing title returns 400.
  - Public preview: only whitelisted fields.
  - Backup after migration contains every pre-migration node and relationship, and restore is idempotent.
- `npm run test:integration` passes on that migrated database and on an empty one (001 to 005 from scratch).
- Headless Chrome on `/`, `/library` and `/console` (anonymous view): pages render with no console or CSP errors. A control page confirmed console errors are captured.

**Not tested / open**
- The signed-in Library UI was not opened in a browser. No UI code changed in this task; Task 5 builds the collection views.
- Not run against your own database. `./scripts/local.sh` (the `/verify` step 2) was skipped because it kills the process on port 3000 and uses the persistent `research-hub-neo4j` volume. Migration 005 will run there on the next app start; take a `hub backup` first.
- Papers do not go through the validator yet (reference-manager input; `item_type` values differ from the design's enum). `ref` fields are stored as text. Existing method values (`level: technique`, `domain: research`) are kept and only produce warnings. These are for Tasks 2 and 3.
- `content/methods/*.md` are now historical copies. Edits there no longer reach the hub.

## Task 2. Vocabulary nodes and name matcher

**Changed**
- `web/core/vocab.js` (new): `resolve(kind, name, { create, aliases, by, model })`, which returns `{ key, name, created, match }`, plus `analyse`, `judge`, `derived` and `nameProps`.
  - Normalisation: case, punctuation, accents, plurals (terms only), and "Last, First" (people).
  - Matches, in rank order: exact, alias, acronym (letter by letter on either side, guarded so a 2-letter acronym alone never matches), typo (one edit in one word of 8+ letters).
  - Candidates come from indexed `norm`/`letters` lookups, then the `vocab_text` full-text index.
  - Non-exact matches learn the spelling as an alias.
  - Creates and alias writes take a per-label `(:VocabLock)` and re-check under it. The key comes from the normalised name, written with MERGE on the unique key.
- `schema/schema.json`: a `match` mode per entity, validated by the loader.
- `web/migrations/006_vocab_matching.js`: `norm` and `letters` indexes per label, the `vocab_text` full-text index, `VocabLock` nodes with a unique constraint, and a batched backfill of the derived fields (existing keys kept).
- Writers stamp `norm` and `letters` when they create vocabulary nodes: `artifacts.js` (paper authors and topics, concepts), `notes.js` (concepts), and `backup.js` (when restoring old backups).
- README ("Vocabulary and name matching"), `schema/CHANGELOG.md`. No API or env change, so openapi and `_env.example` are unchanged.

**Tested for real**
- Offline: normalisation, the matching rules and 12 false-positive guards, `resolve()` against a fake graph (exact without writes, alias learning under the lock, `create:false` never writes, lock then re-check then create, a node created meanwhile is found, a missing full-text index), the writers' derived fields, and migration 006's Cypher and backfill.
  - Mutation check: 42 single-line breaks; 41 fail the suite. The survivor is equivalent: `letters > 0` only matters when no acronym is involved, and that case is already an exact match.
- Integration on a throwaway Neo4j 5:
  - 20 parallel `resolve('Topic', …)` calls over 5 spellings ("Zero-knowledge proof", "ZK proofs", "zero knowledge proofs", "ZERO KNOWLEDGE PROOF", "ZKP") create exactly one node with `by: claude` and the model.
  - Every spelling then resolves to it, and a typo is found through `vocab_text` with `create:false`.
  - 10 of 10 runs passed.
  - With the lock removed, the same test fails on every run (3 nodes created), so it does detect races.
  - This test also found a real gap in an earlier version: "ZKP" and "ZK proofs" did not match each other, which made duplicates order-dependent (2 of 6 runs failed). The letter-by-letter acronym rule and the `letters` lookup fixed it.
- Legacy data: created with the previous commit's code (papers with "José García", "Lovelace, Ada", `topic:zero-knowledge-proofs`, and the Markdown notes). After migration 006 no vocabulary node lacked `norm`, and `vocab_text` was ONLINE. Each of these resolved to the existing node under its old key, with `create:false` writing nothing:
  - "Jose Garcia" and "José García" → `person:jos-garc-a`
  - "Ada Lovelace" → `person:lovelace-ada`
  - "Zero-knowledge proof", "ZK proofs" and "ZKP" → `concept:zero-knowledge-proofs`
  - "CBDC" and "Central bank digital currencies" → `domain:digital-currency`
  - The integration suite passed on that migrated database too.

**Not tested / open**
- Not wired into the writers yet: papers, notes and the generic API still create vocabulary nodes by slug key (now with `norm`/`letters` stamped). Until Task 4 routes them through `resolve()`, a new paper tag can still create a sibling of a node the matcher created. Example: a paper tagged `topic:zk-proofs` gets `concept:zk-proofs` even when `concept:zero-knowledge-proof` exists.
- Proper nouns get odd-looking keys from singularising (for example, "Bayes" becomes `baye`). Matching is consistent on both sides; only the key reads strangely.
- Existing duplicate vocabulary nodes (two legacy keys with one meaning) are not merged. `resolve()` picks the first by key.
- `vocab_text` covers the entity labels known today. Adding an entity needs a migration that rebuilds it.
- Not run against your own database. Migration 006 runs there on the next app start; it is additive (indexes, lock nodes, derived fields), but take a `hub backup` first.
