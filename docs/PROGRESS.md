# Progress

Update at the end of every task. For each: what changed, what was tested for real (and how), what was NOT tested.

| Task | Status | Notes |
|---|---|---|
| 0 Baseline against real services | done (2026-10-30) | See "Task 0" below. |
| 1 Schema model v3 | done (2026-10-30) | See "Task 1" below. |
| 2 Vocabulary nodes and matcher | done (2026-10-30) | See "Task 2" below. |
| 3 Generic items API | done (2026-10-30) | See "Task 3" below. |
| 4 Claude analysis, single-call save, audit | done (2026-10-30) | See "Task 4" below. |
| 5 Library UI: Collections, forms, audit | done (2026-10-30) | See "Task 5" below. |
| 6 CLI, API docs, CI, docs | done (2026-10-30), CI not run yet | See "Task 6" below. |
| 7 Hardening | done (2026-10-31) | See "Task 7" below. |
| 8 Frameworks, research questions and hypotheses, ontologies | done (2026-10-31) | See "Task 8" below. |
| 8b File upload beyond PDFs (ontology snapshots) | done (2026-10-31), live Drive not tested | See "Task 8b" below. |
| 9 Claude chat connector: OAuth for MCP, upload link | done (2026-10-31), tested live from the claude.ai chat | See "Task 9" below. |
| Served at santidesimone.com/research-hub | done (2026-11-01), tested live | See "Served at santidesimone.com" below. |
| Publishing settings (default visibility, full public detail) | done (2026-11-01), not deployed yet | See "Publishing settings" below. |
| 10 Curation: reviewable change plans | done (2026-11-01), tested live from the claude.ai chat | See "Task 10" below. |
| 11 Library redesign (`docs/UI_REDESIGN.md`) | in progress: step 1 of 6 done (2026-11-02), not deployed | See "Task 11" below. |

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

## Task 3. Generic items API with provenance

**Changed**
- `web/core/items.js` (new): storage per field type (properties, `<field>_json`, edges for link fields via `vocab.resolve`, and `provenance_json`), `get`, `list`, `create`, `update`, `remove`, `link`, `unlink`, and `write(key, fields, {by, model, confidence, force})` with the merge rules. Task 4 calls `write` with `by: 'claude'`.
  - **Owner:** writes always apply, marked `by: owner, status: reviewed`.
  - **Claude and source:** fill only empty fields their kind may fill. They never touch owner or reviewed values (a value without provenance counts as the owner's). `force` replaces only that writer's own values.
  - The decision is re-checked inside the write transaction, and vocabulary is resolved only for fields that will be written.
- `web/features/items/index.js` (new): `GET/POST /api/items`, `GET/PATCH/DELETE /api/items/:key` and `PUT/DELETE /api/items/:key/links`, all owner only. DOI keys with `/` work URL-encoded.
- Listing: enum and link filters from the schema's `filters` (link filters by vocabulary name or key, never creating nodes), full-text `q` with a title-scan fallback, a whitelisted `sort`, keyset cursor pagination (limit at most 100), and `total`.
- Papers: create goes through the paper writer (DOI lookup, Person nodes, file link). `item_type` is converted at the boundary (`journal_article` and `journalArticle`), so stored data and the CSL export are unchanged. PATCH refuses `doi`, `authors` and `venue`.
- Text written by older versions into link fields (a method's `domain: research`, a paper's `venue`) reads as `{key: null, name}`. An owner PATCH replaces it with real links.
- `web/core/generic-type.js` (legacy `/api/artifacts`): objects in `<field>_json`. A `status` is no longer kept as an unknown field (the personal layer takes it, and the warning now says so). One accurate warning per unknown field.
- `web/core/schema.js`: link fields must be unambiguous and allowed by `relation_types`. `validate(..., {partial})` checks a PATCH.
- Migrations:
  - `007_items_json_fields`: copies Task 1-style object values into `<field>_json`, then removes the old property.
  - `008_vocab_letters_plain`: fixes the Task 2 race below.
- `web/openapi.json` (the items paths and schemas), README ("Collections API"), `schema/CHANGELOG.md`. No env change.

**Found and fixed: a Task 2 bug.** The new integration tests hit two failures.
- **Flaky test (test bug):** "parallel calls created 0 nodes" in about 1 run of 26. The test's random tag sometimes ended in "s" and was singularised away. Fixed: tags use the letters a–p only.
- **Real duplicate race (code bug):** "ZK proofs" and "ZERO KNOWLEDGE PROOF *tag*" could create two Topics. Next to lowercase text, "ZERO" and "PROOF" were taken as acronyms, so the stored letter signature was wrong and "ZK proofs" could not match it. A standalone reproducer showed 13 of 40 rounds with duplicates. Fixed by trying capitalised words both as acronyms and as words, and storing both signatures (migration 008). Afterwards, 0 of 80 rounds and 0 of 30 integration runs duplicated.

**Tested for real**
- Offline: about 120 new assertions over an in-memory graph behind the fake db, plus a real Express app on an ephemeral port driven with `fetch`:
  - CRUD for all four collections; papers with `item_type` mapping, author order and locked fields.
  - Every merge rule: owner, reviewed, no provenance, `force` own vs other, field `by`, empty values, unknown fields, the stale decision under the transaction.
  - Links: endpoint validation in both directions, evidence and confidence limits, `{kind, name}` targets.
  - List query building: filters, codec, `q` and fallback, sort expressions, cursor in both directions, exact last page, limit cap.
  - All routes owner-only; encoded DOI keys; migrations 007 and 008.
  - Mutation checks: items 53/53; vocabulary 44/47 (one equivalent survivor, two stale entries for code that no longer exists, checked by hand); the new warning filters killed.
- Integration on a throwaway Neo4j 5:
  - Create, read and delete for all four collections; names linked to the seeded Domains (including the alias "CBDC").
  - Owner value kept against a Claude write; Claude fills empty fields with model and confidence; `force` on its own value; a Claude-created Topic flagged `by: claude`.
  - Links with endpoint checks; enum, link and `item_type` filters.
  - A full cursor walk returns every item in order with no repeats.
  - 30 of 30 runs passed after the fixes.
- Legacy data: created with the previous commit (Task 2 code), including use cases and case studies stored through `/api/artifacts`. After 007 and 008:
  - Objects read back parsed through `/api/items`.
  - Old text domains appear as `{key: null}`.
  - A DOI-keyed paper reads with `book_chapter` and its authors.
  - An owner PATCH replaced the text domain with the seeded Domain, and the domain filter finds it.
  - `/api/papers`, `/api/artifacts` and `/api/export` still answer 200.
  - The integration suite passed on that database.

**Not tested / open**
- No UI uses `/api/items` yet (Task 5), so there is no browser check in this task.
- Paper authors and venue cannot be edited through `/api/items` (Task 4 fills them from Crossref and OpenAlex and writes Venue nodes). A paper's `venue` stays text until then.
- Paper create is two transactions (the paper writer, then the extra fields). A failure in the second leaves the paper without those fields; re-send them with PATCH.
- Filters match link edges only: older text values (`domain: research`) are not found by a domain filter until edited.
- Not run against your own database. Migrations 007 and 008 run on the next start; they copy before removing, but take a `hub backup` first.

## Task 4. Claude analysis: single-call save, audit

**Changed**
- `web/core/analysis.js` (new), `POST /api/analysis` and MCP `save_analysis`: one call finds or creates the item, fills a paper's source facts from Crossref and OpenAlex, saves Claude's fields with provenance through `items.write`, and writes typed links. It returns `{key, url, created, filled, skipped, links, links_skipped, empty_core_standard, warnings, flagged}` (201 when created, 200 for a re-analysis).
  - **Identity:** `key`, a paper `doi` or `url`, or a new item's title.
  - **Source facts:** title, authors (Person nodes through the matcher), year, venue (a Venue node, with the text kept for the CSL export), abstract, citation count and its date, open access, language and `openalex_id`, all written `by: source`.
  - **Claude's fields:** model and confidence (one level or per field, default medium). The schema's `by` keeps Claude off source-only fields.
  - **Links:** vocabulary by name; items by key or exact title only. Interpretive links without evidence are skipped; links you made are never touched.
  - **Flags:** findings without a location, and interpretive links without one.
  - Crossref and OpenAlex failures become warnings. A new DOI with no lookup and no title is a 422.
- `web/core/audit.js` (new):
  - `GET /api/audit`: counts and lists of low-confidence fields and links, empty Core and Standard fields, ungrounded findings, outdated `schema_version`, vocabulary created by Claude, and unreviewed items.
  - `POST /api/audit/accept`: fields, links or a vocabulary node become reviewed, and an item becomes `reviewed` once nothing `auto` remains. Accepted values are protected from re-runs.
- MCP:
  - New tools `get_schema` (fillable fields, enums, tiers, relations, rules, and the fields the hub fills), `save_analysis`, `search_items` and `get_item`.
  - New instructions; the version is read from `package.json` (now 0.7.0); the `describe_graph` notes are updated.
- `web/core/items.js`: per-field confidence; the creating writer owns the fields it sets; `locked` applies to owner edits only; link fields keep their text property in sync. Single-object fields also store `<field>__<part>` properties (migration `009`), so competency question 1 (sample size over N) is plain Cypher.
- The paper writer resolves authors through `vocab.resolve` on every path (closes the Task 2 author-duplicate gap). `crossref.js` and `openalex.js` get replaceable HTTP, and `openalex.lookupWork` is new.
- **Found and fixed:** `/mcp` failed every request on Node 18 ("crypto is not defined") because the MCP SDK needs the Web Crypto global, which Node only provides by default from version 20. `package.json` allows Node 18 and local runs use it; the Docker image (Node 20) was not affected. The global is now provided when missing.
- openapi (`/api/analysis`, `/api/audit`, `/api/audit/accept`, version 0.7.0), README ("Claude's analysis and the audit"), `_env.example` (`OPENALEX_EMAIL` is used for the analysis too), `schema/CHANGELOG.md`.

**Tested for real**
- Offline: about 110 new assertions over the in-memory graph with fake Crossref and OpenAlex:
  - source facts and provenance; Claude refused source and owner-only fields;
  - per-field confidence; flags;
  - links: ambiguous or unknown targets, interpretive links without evidence, owner links, endpoints;
  - idempotency: the same request twice changes nothing; the deep tier;
  - sources down; papers by URL; other collections;
  - every validation error; the audit lists, caps and accept;
  - all routes owner-only over real HTTP;
  - the MCP tools through a real MCP client against an in-process server.
  - Mutation checks: analysis, audit and MCP 55/55; items (re-run) 53/53; the object parts 3/3.
- Integration on a throwaway Neo4j 5 (fake Crossref and OpenAlex, so it is hermetic): three analysed papers, then **competency question 1** in Cypher returns exactly the empirical, quasi-experimental paper with a sample over 100. Use cases with and without a method and case study, then **competency question 4** returns exactly the orphan. Also covered: idempotency, the owner's edit surviving `force`, and the audit with accept. 10 of 10 runs passed.
- **Live Crossref and OpenAlex** (first time, from Task 0's unverified list), through `POST /api/analysis` on the real server:
  - DOI 10.1007/978-1-4757-0602-4_18: book_chapter, 1983, David Chaum, Venue "Advances in Cryptology", 3317 citations, closed, en, W1601001795.
  - DOI 10.3390/fi13050130: journal_article, 2021, three authors, Venue "Future Internet", 31 citations, gold, abstract filled, W3119626329.
  - Per-field provenance was correct.
- **Live MCP** with a real client against the running server on Node 18: all tools listed and version 0.7.0. `get_schema`, `save_analysis` (Domain "cryptography" matched to the seeded node; an unknown use case skipped, not created), `get_item`, `search_items` and `describe_graph` all work.

**Not tested / open**
- No UI for the audit or the analysis yet (Task 5).
- `describe_graph` lists the hub's own infrastructure labels (`VocabLock`, `SchemaMeta`, `Personal`) with the rest. That is harmless, but it is noise for Claude.
- Claude cannot write `doi` or `arxiv_id` for papers (source fields). A preprint known only by URL keeps those empty until a source fills them.
- Paper creation stays two steps (paper writer, then fields). A failure between them leaves a paper without Claude's fields; re-running the analysis fills them.
- Not run against your own database: migration 009 runs on the next start (additive). Take a `hub backup` first.

## Task 5. Library UI: Collections, shelves, forms, audit

**Changed**
- `web/apps/library/`: `app.js` keeps the shell, graph and paper view. New modules:
  - `model.js`: pure logic (routes, form values, change detection, provenance labels).
  - `view.js`: read-only rendering, values as text only (never HTML).
  - `forms.js`: generated forms and pickers.
  - `collections.js`: the generic list and detail.
  - `audit.js`: the audit view.
- Collections bar (All, Papers, Methods, Use cases, Case studies, Graph, Audit) and addresses `/library/<collection>?key=..&edit=1`; older `/library?key=` links redirect.
- Papers: the list, reader, file link, upload and status are unchanged. New: an **Analysis** tab (detail groups, tier badges, Claude/source/you markers with model, confidence and date, low-confidence and ungrounded flags, empty fields, links with evidence), plus Edit, Delete and + New.
- Methods, use cases, case studies:
  - **List:** schema list columns and filters (enums, and vocabulary pickers for link fields), sort, search, cursor "load more".
  - **Detail:** grouped fields, links in and out (notes and projects included), an add-link editor checked against `relation_types`, and remove link.
- Forms from the schema: text, long text, number with bounds, enum, list editor, object and list-of-object editors, vocabulary type-ahead (new names allowed), and an item picker. An edit PATCHes only the changed fields. A paper's locked fields are shown read-only.
- Audit view: every bucket with counts, one-click Accept (field, link, vocabulary or whole item) and Edit (opens the form at the field).
- Server:
  - `/api/schema` adds `collections` (fields, layout hints, relations, locked fields) and `entities`.
  - New `GET /api/vocab` (owner-only type-ahead).
  - `/api/graph` and `/api/artifact` include every vocabulary label (Topic, Domain, Venue ...).
  - `label_plural` added to the schema.
- `record_status` reflects provenance: `auto` only while unaccepted Claude values remain. Owner-created items are `reviewed`, and source facts need no review. Migration `010` recomputes it (005 had marked all of your existing data `auto`).
- Skins: `--node-*` tokens for the new types and vocabulary in both skins, light and dark, plus a test that every schema type and entity has them. New CSS in `base.css` uses tokens only.
- Shell: one toast at a time (they used to stack on top of each other).
- `web/test/browser/` (new): `seed.js`, `owner.js` and `public-mobile.js`, with a README. Run against a real hub with `playwright-core` installed outside the repo; not a project dependency.
- openapi (`/api/vocab`, `/api/schema`), README ("The Library"), `schema/CHANGELOG.md`.

**Tested for real**
- Offline: `model.js` loaded as an ES module from the suite (routes and round-trips, form values, change detection, provenance labels, safe links), the `/api/schema` collections, `/api/vocab` (owner only, normalised query, limit capped), graph labels, skin tokens, the record_status rule and migration 010. Mutation checks: UI logic and server 27/27; record_status 5/5.
- **Browser (Playwright 1.47 driving the installed Chrome) against the real server on a throwaway Neo4j 5**, with data that includes two papers analysed live through Crossref and OpenAlex:
  - **Owner, 15/15:** sign-in through the UI; Collections bar; the paper Analysis tab (provenance markers, tiers, flagged finding, empty fields); status and file link intact; method filter; create a method (list editor, enum, vocabulary type-ahead), checked in the database; edit sends only the changed field (other fields keep their provenance timestamps); add and remove a typed link with the relation picker; delete with confirmation, gone from the database; a case-study structured editor round-trip; audit Accept for a field and for vocabulary; audit Edit focusing the field; the graph with the new node types; an older link redirecting; **no console errors, CSP violations or failed requests**.
  - **Anonymous, 5/5:** only the public paper and method are listed; the abstract (not whitelisted) never appears; no Analysis tab, forms or audit; only `/api/apps`, `/api/me`, `/api/schema` and `/api/public` are called.
  - **Mobile (390x844), 4/4:** no horizontal overflow; one-line top bar; the Collections bar scrolls; detail and edit form fit.
  - Screenshots reviewed by eye (light, dark, mobile). They showed UI bugs that selector checks had missed, all fixed and re-checked:
    - stray "null", "false" and "0" text, because DOM `append` prints them; one of these, in the paper list, was older than this task;
    - stacked toasts;
    - "Edit casestudy";
    - a top bar that did not fit at 390px;
    - your own items marked "not reviewed".
  - Bugs found by the browser runs and fixed: the list did not refresh after a delete, and new vocabulary names were not trimmed. Harness issues: `waitForFunction` is blocked by the hub's CSP (no eval, as intended), so the scripts poll instead; and my test server's restart script was killing a subshell, which left an old server running. That was found and fixed before the final runs.
- `npm test` and the integration suite (fresh database) pass.

**Not tested / open**
- No automated browser runs in CI yet (Task 6). The scripts are in `web/test/browser/`.
- The sticky Save bar on long forms floats slightly above the bottom on small screens (the detail pane's padding); it stays usable.
- Graph layout and the reader with a real Google Drive file were not re-tested (unchanged code; Drive needs credentials).
- Not run against your own database. Migration 010 runs on the next start (it only changes `record_status`); take a `hub backup` first.

## Task 6. CLI, API docs, CI, docs

**Changed**
- `bin/hub`:
  - `hub item list` (filters, `--all`, `--json`/`--csv`), `item get`, `item add`, `item edit` (`--set field=value`, JSON when it parses), and `item rm` (refuses without `--yes`).
  - `item link` and `item unlink`.
  - `hub analyze <doi|url|key|file.pdf>`: stdin `{fields, links, confidence}`; `--deep`, `--force`, `--model`/`HUB_MODEL`. For a PDF, the JSON names the paper and the file is uploaded to Drive.
  - `hub audit`, and `--accept-all-unchanged [--dry-run]`, which accepts Claude values still as written, except low-confidence values and ungrounded findings.
  - `hub schema [collection]`.
- Docs that cannot drift: offline tests fail if any `/api/` route is missing from `web/openapi.json` (or documented but gone), or if a CLI command is missing from `hub help` or the README. They found four routes that had never been documented: `/api/apps`, `/api/graph`, `/api/artifact` and `/api/logout`. They are documented now.
- CI: a new `e2e` job runs the real server on Neo4j, the browser seed (with retries for live Crossref and OpenAlex), the Playwright checks, and `web/test/cli-e2e.js`, uploading the server log and screenshots on failure. The browser scripts now exit non-zero on any failed check, so CI can see failures.
- README (a command-line section covering every command), `deploy/README.md` (back up before deploying; migrations 005–010; `OPENALEX_EMAIL`; the new MCP tools; Node 20 and 18; the CI jobs), and `_env.example` (`HUB_URL`, `HUB_MODEL` for the CLI).

**Tested for real**
- Offline: the CLI runs as a child process against a fake hub server. Each command's method, path, query, body (including the raw PDF upload and its content type), output and exit code are checked, including refusals: `rm` without `--yes`, bad or non-object JSON, missing model, bad `--set`, unknown input. Plus the route/openapi and command/help/README checks. Mutation check: 23/23.
- The e2e job's steps, run locally on a fresh throwaway Neo4j: seed exit 0, owner checks 15/15, public and mobile 9/9, and the CLI end to end passed:
  - schema, add, a list with a full-text query and a vocabulary filter, edit, get, link and unlink;
  - an analysis that skips the owner's value;
  - the audit, accept-all-unchanged as a dry run and for real;
  - rm with and without `--yes`.
  - A deliberately failing browser run (wrong token) exits 1.
- `npm test` and the integration suite (fresh database) pass. `docker build .` succeeds and the image still refuses weak production settings.
- The workflow file parses (js-yaml): three jobs with the steps in order.

**Not tested / open**
- **CI itself has not run.** Nothing has been pushed (that needs the owner's go-ahead). The acceptance "CI green" is open until the first push. Risks to watch on the first run: Chrome at `/usr/bin/google-chrome` on the runner, and live Crossref and OpenAlex availability for the seed.
- `hub analyze file.pdf` upload: only the offline test (fake server) covered it; the real Drive needs credentials.

## Task 7. Hardening pass

**Reviewed, and what changed**
- **Rate limits:**
  - The heavy budget used to cover only `/api/query` and `/mcp`. It now also covers `/api/analysis` (live Crossref and OpenAlex, many writes), `/api/audit` (scans every item), backup/restore, import/export, enrich and notes sync (`HEAVY` in `core/ratelimit.js`).
  - `bin/hub` waits and retries on 429 (honouring Retry-After, at most a minute, `HUB_MAX_RETRIES`), so a long `hub restore` survives the stricter budget.
  - Sign-in already had its own limit (10 failed attempts per IP per 10 minutes); it is now documented.
  - **Found:** `trust proxy` was `true`, so any client could choose its rate-limit IP with `X-Forwarded-For`. That applies to every per-IP limit, sign-in included. It is now `TRUST_PROXY`, a hop count: 1 in production (Cloud Run) by default, loopback locally. `deploy.sh` passes 2 (the site rewrite plus Cloud Run), and production warns if it is set to `true`.
- **Request sizes:** body limits were already per endpoint (2 MB for items and analysis, 30 MB restore, 2 KB login). New caps on fan-out: an analysis takes at most 200 links and 300 fields, a link field at most 100 values (each is a vocabulary lookup), a list search at most 500 characters, and a vocabulary look-up at most 200.
- **Error messages:** REST already answered "Internal error" plus a request id in production. **Found:** MCP tools returned any error's raw message, including driver errors that can name hosts and queries. Now our own 4xx messages pass through, anything else is logged and masked in production.
- **Backup and restore:** the label and relationship whitelists already come from the schema (Task 1). An integration test now proves the round trip on real Neo4j:
  - Coverage: all four collections; Person, Concept, Topic, Domain, Venue, Organisation and Dataset; AUTHORED_BY, PUBLISHED_IN, ABOUT, USES, INTRODUCES, ADDRESSES (with evidence), INSTANCE_OF, INVOLVES and FOR; provenance, object parts and the personal layer.
  - Backup, delete it all, restore, and back up again: identical.
  - Timestamps come back as datetimes (sorting by `updated_at` still works).
- **Public export:** already per-type whitelists, with organisations kept out (Task 1). **Found:** a case study with `visibility: public` but `sensitivity: internal` or `confidential` was exported. It no longer is, and neither are its links.
- **Production config:** the existing refusals (token, default password, half-configured Drive) are re-verified. New warnings, not errors, so an upgrade cannot stop a running deployment: `TRUST_PROXY=true`, a Neo4j password under 12 characters, missing `OPENALEX_EMAIL`, and `MAX_UPLOAD_MB` above Cloud Run's 32.
  - `OPENALEX_EMAIL`, `HUB_SKIN`, `PDF_FETCH_ALLOWED_HOSTS` and the owner token were read directly from the environment in five modules. They now go through `core/config.js` (CLAUDE.md, rule 8), and a test fails if any module other than `config.js` or `env.js` touches `process.env`.
- Docs: `_env.example` (`TRUST_PROXY`, the heavy list), the `deploy/README.md` security checklist, `deploy.sh`, openapi (rate and size limits, 429 and 413), and the README "Known limits", which still said Neo4j, Crossref, OpenAlex and the Docker build had never been run.

**Tested for real**
- Offline: trust-proxy parsing and its effect on `req.ip` through Express (one hop takes the proxy-appended entry; `true` takes the client's), the production warnings, the heavy list and its wiring, the no-direct-env rule, `OPENALEX_EMAIL` reaching Crossref through config, MCP masking (production and local), every cap, the export's sensitivity rule, and the CLI retry with Retry-After timing and the give-up path. Mutation check: 21/21 of the current mutations (the login limiter mutation no longer applies).
- Integration on a fresh Neo4j 5: the round trip, 5 of 5 runs. Two deliberate breaks were caught on the real database: backing up only the old labels, and restoring timestamps as text (that one was missed at first, so I added the datetime assertion).
- The real server in production mode: start-up warnings; `/api/audit` hitting the heavy limit with 429 and `Retry-After: 60`, while `/api/items` stays in the general budget; failed sign-ins limited.
- The full e2e set again on fresh data (browser owner 15/15, public and mobile 9/9, CLI end to end), `npm test` and the integration suite.

**Not tested / open**
- The proxy hop count on the real deployment (Cloud Run plus the site rewrite) was not checked. If 2 is wrong for your hosting, every visitor shares one rate-limit bucket (too many hops) or IPs become spoofable again (too few).
- Rate limits stay per instance and in memory (documented).
- Nothing pushed; CI has not run (see Task 6).

## Task 8. Framework, Research question, Hypothesis, Ontology types

**Changed**
- `schema/schema.json`: the four collections and their fields as in the addendum (Ontology `urls` as decided: `{role, url}`, roles docs/spec/download/repository/other, C/Y, Core). Also:
  - the new relations, with `pairs` for PART_OF, EXTENDS and BUILDS_ON, and `props` for TESTS `result` and DEFINED_IN `external_iri`;
  - `PUBLISHED_BY` for the publisher link;
  - layout hints (`title_from`, `ui_more`, `ui_group`);
  - skin colours for the four types.
- `web/core/schema.js`:
  - `relTargets`, `relAllows` and `relationsFrom`: every endpoint check (items API, analysis, MCP, schema loader, UI) now goes through them;
  - object-part specs, `https` (refused, not warned) and `normalize: "iri"`;
  - start-up checks for all of the new schema keys.
- `web/core/hypotheses.js` (new): status from the TESTS results (none: untested; only inconclusive: inconclusive; supported and refuted: mixed), the owner override, and recompute on link changes and on paper deletion (hooks).
- `web/core/items.js`:
  - titles from `text` or `statement`, schema defaults on create (`status: untested`, `origin: own`);
  - hub-set values (`origin: extracted`);
  - IRI normalisation (URNs kept as written);
  - links to items by exact title, acronym or alias;
  - relation properties (TESTS `result` required), and keys capped at 80 characters.
- `web/core/analysis.js`:
  - `extract` for papers (frameworks, research questions, tested hypotheses), each matched or created, then linked;
  - a tested hypothesis needs its result and passage before anything is created;
  - TESTS links recompute the status.
- `PATCH /api/vocab` (a concept's `external_iri` and DEFINED_IN), `hub vocab iri`, and `hub item link --result`.
- MCP: `get_schema` explains `extract` and TESTS results, and `save_analysis` accepts `extract`.
- Migration `011`: `artifact_text` with `text`, `statement` and `acronym`; an index on `Hypothesis.status`.
- Library:
  - "More" menu with Frameworks, Questions and hypotheses (one entry with a switch), and Ontologies and standards;
  - links grouped by relation with readable headings (a framework lists what it frames, an ontology its modules and users);
  - TESTS results as a table with a tally;
  - a link form that asks for the result, and on the paper's Analysis tab;
  - forms do not require a title that is derived.
- **Found in the browser and fixed:** a hypothesis created through the form sent its default status as an owner value, which froze the derivation. Hub-managed defaults are no longer sent on create (`createFields`, tested).
- **Found by the offline tests and fixed:** URNs were rewritten as `urn://...`.
- Docs: README, openapi (`PATCH /api/vocab`, `extract`, the TESTS result), `schema/CHANGELOG.md`, and decisions in `docs/SCHEMA_DESIGN.md`.

**Tested for real**
- Offline: the schema checks for every new key; endpoints by pairs; the status derivation table and the owner override; creating all four types (derived titles, defaults, IRI normalisation, publisher as an Organisation, parent by acronym, https refused); TESTS links (result required) giving supported, then mixed, recomputed on unlink and on paper deletion; analysis `extract` (found by alias, created, `origin: extracted`, ASKED_IN direction, TESTS with result, flags, nothing created without a result or passage, ambiguity refused, re-run idempotent); `PATCH /api/vocab` over HTTP; the CLI; the Library bar logic; migration 011. Mutation check: 50/50, plus `createFields`.
- Integration on a fresh Neo4j 5, 4 of 4 runs:
  - **The addendum's worked example end to end:** the stablecoin question framed by three frameworks; H1 to H3 derived from them and answering it; two papers testing with opposite results; FIBO and its module; the use case.
  - **Statuses:** H1 mixed, H2 supported, H3 untested.
  - **The four competency questions** in plain Cypher return exactly the expected items.
  - **Full-text search** finds hypotheses by their statement.
  - **Round trip:** backup, delete and restore are identical, including TESTS results and derived statuses.
- Browser (Playwright on Chrome, real server, fresh data):
  - owner 21/21: More menu; a framework page listing what it frames; the questions/hypotheses switch; a hypothesis with its results table, tally and derived "mixed" status; creating a hypothesis whose title comes from its statement; a paper adding a TESTS link with a result through the form, with the hypothesis status following; an ontology with its modules and users;
  - public and mobile 9/9; the CLI end to end; no console or CSP errors. Screenshots reviewed.

**Not tested / open**
- Ontology records for FIBO, ISO 20022 and ETHON were not created from their real pages (addendum, open point 1: Claude should read them when creating the records).
- No CI run yet (nothing pushed from here).

## Task 8b. File upload beyond PDFs (ontology snapshots)

**Changed**
- `web/core/drive.js`: `upload(title, buf, {ext})` takes the type from an allow-list (`FILE_TYPES`: pdf, owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip, txt), refuses anything else (400) and empty files, and refuses a file over `MAX_UPLOAD_MB` with 413 "Store a link to it instead". It returns the MIME type too. PDFs behave as before (the default).
- `web/features/papers/files.js`: the allow-listed download (https only, redirects re-checked, size cap) is now generic (`fetchAllowed`); `fetchPdf` uses it unchanged.
- `web/features/ontologies` (new):
  - `POST /api/ontologies/snapshot?key=&name=` with the file as the body, or JSON `{url}` from `PDF_FETCH_ALLOWED_HOSTS` plus the new `SNAPSHOT_FETCH_ALLOWED_HOSTS`;
  - uploads to Drive and records `snapshot` (file_url, drive_file_id, retrieved_at, the record's version, sha256, size_bytes, mime) as an owner write;
  - trashes the previous snapshot, and trashes the upload if the graph write fails;
  - `DELETE` removes the snapshot and trashes the file; deleting the ontology trashes it too (hooks).
- `hub ontology snapshot <key> <file | https-url | none>`.
- Library: a Snapshot panel on ontology pages. Upload is disabled until a file is chosen and the license box is ticked (files are shared by link); a snapshot of an older version than the record says so.
- A request body over a limit now says "For a file, store a link to it instead".
- Docs: README, `deploy/README.md`, openapi, `_env.example`, `schema/CHANGELOG.md`, and the requirement statuses (F15 to F17, D10 to D13).

**Tested for real**
- Offline, with the fake Drive layer:
  - the allow-list (unknown type 400, empty 400), the size cap (413 with the link advice);
  - the name, MIME type and upload headers for a ttl;
  - the HTTP endpoint against the in-memory graph:
    - owner only;
    - sha256, size and type recorded, with the checksum queryable as `snapshot__sha256`;
    - the owner as writer;
    - replacement trashes the previous file;
    - bad or missing extension, a fake PDF, and a non-ontology key refused;
    - URL host not allowed, and Drive not set up (503);
    - a failed graph write trashes the upload;
    - DELETE, then 404 when there is none;
    - deleting the ontology trashes its file.
  - The CLI (file, URL, none, missing file).
  - Mutation check: 20 of 21 killed. The survivor removes the early `requireConfigured()`, which `upload` repeats with the same 503.
- Integration on a fresh Neo4j 5: a snapshot written to a real node (the parts queryable), replaced, and trashed when the ontology is deleted, against a fake Drive.
- Browser (Playwright on Chrome, fresh data):
  - owner 22/22, including the new panel: the stale-version note, and upload disabled until both a file and the license check are given;
  - public and mobile 9/9; the CLI end to end; no console or CSP errors. Screenshot reviewed.

**Not tested / open**
- A real upload to Google Drive (Drive is not configured here; the same open item as D3).
- A real download of a snapshot from a live host.

## Deployment to Google Cloud (2026-10-31)

**Done, live, in `research-hub-513302` (us-central1)**
- Neo4j on an e2-micro (free tier), Container-Optimized OS, **no public IP** (Neo4j pulled through an Artifact Registry mirror of Docker Hub over Private Google Access), nightly disk snapshots (14 days). Heap 256 MB and page cache 64 MB: 384 MB and 128 MB put the VM under constant memory pressure (requests over a minute).
- Cloud Run `research-hub`, `MIN_INSTANCES=0`, `TRUST_PROXY=1` (served on its run.app URL for now), app images cleaned to the newest 2.
- Budget guard: a $5/month budget with emails at 20/60/100%; at 100% a function stops the VM and closes the app to public traffic (nothing deleted). Wiring tested with a harmless notification (it found a bug: the function receives the plain Pub/Sub message; fixed and tested).
- Google Drive: OAuth client (Desktop app, `drive.file`, in production), secrets in Secret Manager.

**Tested live**
- `/healthz`, `/readyz` (the database over the private network), sign-in with the owner token (cookie), bearer API, 401 without a token, security headers.
- Drive: `hub drive` created the folder; a PDF copied from arXiv into Drive and linked; its link opens anonymously; deleting the paper put the file in the Drive trash (checked through the Drive API).

**Not tested / open**
- ~~`santidesimone.com/research-hub`~~: done 2026-11-01, see "Served at santidesimone.com" below.
- The claude.ai chat connector: Task 9.
- The real budget stop (it would take the hub down); behaviour of the e2-micro under a large library.

**Drive moved to the Workspace account (2026-11-01)**
- Drive now uses santi@santidesimone.com instead of the personal gmail account. No code change: same OAuth client, a new refresh token from `bin/drive-auth` in `.env` and as `google-refresh-token` version 2, then a new Cloud Run revision (`research-hub-00004`) to load it. Uploading before that revision existed still went to the gmail Drive.
- The hub's stored folder id pointed at the gmail folder; with the new login it was not visible, so the hub switched to a new "Research Hub PDFs" folder in the Workspace Drive by itself (`HubSetting {id:'drive'}` updated). Local and cloud now share that folder.
- The only hub-uploaded file (`doi:10.3390/fi13050130`) was downloaded from its public link and uploaded again through the Library upload link; `file_url` and `drive_file_id` point to the new file, which opens anonymously. No Workspace sharing setting had to change.
- Left behind: one copy in the gmail Drive's old folder, which the new login cannot trash; delete it by hand.

## Task 9. Claude chat connector: OAuth for MCP, upload link

**Changed**
- `web/core/oauth.js` (new): OAuth 2.1 for one owner, public clients with PKCE (S256), no new dependency.
  - Client ids are stateless (the registered redirect URIs, signed). Redirect URIs come from `MCP_OAUTH_REDIRECTS` (the claude.ai callbacks by default) or loopback.
  - Codes are single use and last 5 minutes (stored hashed, `(:OAuthCode)`).
  - Refresh tokens are rotated on every use (`(:OAuthGrant)` keeps only a hash); reusing an old one revokes the connection; 90 days unused, it expires.
  - Access tokens last 1 hour, work for `/mcp` only, and only while their connection exists.
  - Everything is signed with a key derived from `HUB_API_TOKEN`, so changing the token revokes it all.
- `web/features/oauth` (new): discovery documents at the domain root (a new optional `mountRoot` hook in `server.js`), registration, the approval page, the token endpoint, and listing or revoking connections.
  - The approval page has no scripts. It accepts the owner session or the owner token, with the sign-in failure limit.
  - Its CSP allows the client's origin in `form-action`, because Chrome checks the redirect after the form.
- `/mcp`: accepts OAuth access tokens; a 401 carries `WWW-Authenticate: Bearer resource_metadata=…`.
  - New tool `request_upload`; `add_paper` and `save_analysis` return `upload_url` when a paper has no file.
  - The instructions tell Claude what to do with a paper shared in the chat.
- Library: `?key=…&upload=1` shows a drop zone (click or drop, keyboard reachable) that uploads to Drive.
- Migration `012_oauth` (constraints). `hub oauth [list | revoke <id> | revoke-all]`. Config `MCP_OAUTH_REDIRECTS`, `PUBLIC_URL`.
- Docs: README, deploy/README (connecting claude.ai, the extra well-known rewrite behind a site proxy), openapi, `_env.example`.

**Tested for real**
- Offline:
  - discovery;
  - the 401 header;
  - registration (allow-list, loopback, fragments, limits);
  - forged client ids;
  - the approval page:
    - unknown client;
    - unregistered redirect;
    - no PKCE;
    - wrong resource;
    - no scripts;
    - CSP;
    - wrong token;
    - deny;
    - tampered request;
    - session cookie;
  - the token endpoint:
    - wrong verifier;
    - a code tried once even after a failure;
    - wrong redirect;
    - code reuse;
    - expired code;
    - only hashes stored;
  - access tokens work on `/mcp` with the real MCP client, and not on the REST API;
  - tampered and expired access tokens refused;
  - refresh rotation, and revocation on reuse;
  - listing and revoking connections;
  - a new owner token invalidating everything;
  - `request_upload` and `upload_url`;
  - the CLI.
  - Mutation check: 25 of 25 killed (3 survivors on the first pass got tests).
- Integration on a fresh Neo4j 5: migration 012, the stored flow (single-use code, rotation, reuse revokes, revoke all), and connections are not in a backup.
- Browser (Chrome): owner 24/24.
  - New: the drop zone from an upload link, and the approval page.
  - On the approval page, Chrome follows the redirect to a real local callback with the code and state under the page's CSP.
  - Public and mobile 9/9; the CLI end to end. Screenshot reviewed.

**Tested live (2026-10-31, deployed hub, the claude.ai chat)**
- The owner added the custom connector in claude.ai with the run.app URL. Claude discovered the OAuth endpoints from the 401, registered itself, the owner approved on the hub's page, and the connection appeared in `hub oauth`.
- From the chat, Claude added "A Digital Currency Architecture for Privacy and Owner-Custodianship" (arXiv 2101.05259, DOI 10.3390/fi13050130) in one `save_analysis` call:
  - 12 fields from sources (authors, year, venue from Crossref and OpenAlex);
  - 11 fields by Claude (`claude-sonnet-5-5`, with provenance);
  - FRAMED_BY a framework it extracted (with a location), and three topics;
  - the PDF copied from arXiv into the owner's Drive and linked (`drive_file_id` set).

**Not tested / open**
- The private-PDF path through the upload link, from the chat.
- Three `400` replies on `/mcp` during the session did not stop anything; their cause is not logged yet (MCP request bodies are not logged).

## Served at santidesimone.com (2026-11-01)

Firebase Hosting can rewrite only to Cloud Run in its own project (`santidesimone-com`), and the hub runs in `research-hub-513302` with Neo4j on a private network, so the hub was not moved: a relay forwards to it.

**Changed**
- `deploy/site-relay/` (new, no dependencies): `research-hub-relay` on Cloud Run in `santidesimone-com`, Node 24 (the buildpacks no longer offer Node 20).
  - Forwards only the hub's paths (`/research-hub/**` and the two OAuth discovery documents at the root), unchanged and streamed; anything else is 404.
  - Signs each request with its own service account (`site-relay@`) in `X-Serverless-Authorization`, so the hub's own `Authorization` header passes untouched.
  - Sends the hub only the visitor's address (`CLIENT_HOPS`, counted from the right of the X-Forwarded-For it receives).
  - `deploy.sh` deploys it and gives its service account `run.invoker` on the hub.
- The site's `firebase.json` (other repo): four `run` rewrites to the relay, before the site's own `**` rule.
- Hub: `PUBLIC_URL=https://santidesimone.com`, `TRUST_PROXY=2`, and `allUsers` removed from `run.invoker`.
- `deploy/deploy.sh`: an existing service keeps its access (it no longer passes `--allow-unauthenticated`, which would reopen the hub), and env vars are updated instead of replaced (so `PUBLIC_URL` survives a deploy).
- `npm test` also runs the relay's tests.

**Tested**
- Offline: the relay against a fake hub (path and query kept, ID token added and a client-sent one ignored, owner `Authorization` and `__session` passed, 1 MB body intact, redirects and cookies passed back and not followed, other paths refused without reaching the hub, 502 without a token or hub). Mutation-checked (4 breakages, all caught).
- Live: `/research-hub/`, `/healthz`, `/readyz`, the OAuth discovery document (issuer `https://santidesimone.com/research-hub`) through santidesimone.com; the site's own pages unchanged; the run.app URL answers 403. X-Forwarded-For at the relay is `<visitor>, <Google front end>` and a client-sent value is dropped by Firebase, so `CLIENT_HOPS=2`. The claude.ai connector reconnected at `https://santidesimone.com/research-hub/mcp`, and a paper added from the chat.

**Not tested / open**
- A PDF upload through the site near the size limit (Firebase gives a rewritten request at most 60 seconds).
- The budget stop with the relay in front (it closes the hub's ingress; the relay would then answer 502/403).

**Data**
- Production is the real library. The local database is for development (example data from `scripts/seed.py`); it is not copied to production.

## Publishing settings (2026-11-01)

The owner wanted everything public and transparent, and the choice easy to change. CLAUDE.md rule 6 (a fixed public whitelist) is now a setting the owner controls; what can never be public is listed in the rule.

**Changed**
- `web/core/publishing.js` (new): `default_visibility` (public | private) and `public_detail` (basic | full) on `(:HubSetting {id:'publishing'})`, read through a 10 s cache. Defaults keep the old behaviour (private, basic). `HIDDEN` (Drive file ids, local paths) and Drive links are never public.
- `web/features/publishing` (new): `GET`/`PUT /api/settings/publishing` and `POST /api/settings/publishing/apply` (owner), and `GET /api/public/items/<key>` (anyone, full mode and public items only; refs to private items and Drive links are removed).
- `web/apps/settings` (new, owner only): the two switches and "Make all public / private" (with a confirm click).
- Default visibility: `artifacts.upsertArtifact` sets it on create only when the input does not say; an existing item keeps its own on re-import or overwrite (it used to fall back to private). Papers read a `public` or `private` tag; Markdown notes without a `visibility:` line follow the default; `/api/schema` gives forms the owner's default.
- Public export: full mode keeps every property but the hidden ones and adds note HTML; `detail` is in the payload. Case studies are hidden only when `sensitivity` is `confidential` (internal ones used to be hidden too).
- Library, public view in full mode: open file links ("Open file"), note text, and every field of collection items laid out as on the owner's pages. Your reading status stays owner-only.

**Tested**
- Offline (`npm test`): the setting (defaults, bad stored values, validation, the write), apply-to-all, `fullProps`, the export in both modes, default visibility on create versus explicit and existing, paper tags, notes, the public item scrub, the routes (owner only; 404 in basic mode and for non-public keys). Mutation-checked: 7 breakages, all caught.
- Browser, on a throwaway Neo4j and hub: `owner.js` and `public-mobile.js` unchanged and green with the defaults; the new `web/test/browser/publishing.js` (Settings switches, a visitor sees the abstract and every method field in full mode, "Make all public" shows a private paper and a case study, the settings API is owner only, no console or CSP errors) green. A new item created with the default public is public, and `/api/schema` gives forms the public default.

**Not tested / open**
- Not deployed: production still runs the previous version (private, basic) until `deploy/deploy.sh`; then switch Settings to public and everything, and press "Make all public".
- (`npm run test:integration` passed on a throwaway Neo4j 5 after this change.)
- A visitor's browser may keep the public preview for `PUBLIC_CACHE_SECONDS` (60) after a change.

## Login page at the root (2026-11-01)

- Not signed in, the root (`/research-hub/`) is a login page (the token form, without the top bar's own Sign in button); signing in opens the Library. The public preview is still at `/library` for anyone with the link, and the sign-in dialog elsewhere is unchanged. One form (`signInForm` in `web/public/shell/shell.js`) serves both.
- Tested in Chrome on a throwaway hub (`public-mobile.js`): the root shows the form and no library, fits a 390px phone, a wrong token shows the error, the right one lands on `/library` as owner; the other browser checks unchanged and green; `npm test` green. Not deployed yet.

## Everything behind the token: PUBLIC_ACCESS (2026-11-01)

The owner wants the hub completely private for now: no public view at all, and the publishing settings not usable.

**Changed**
- `PUBLIC_ACCESS` in `web/core/config.js` (and `_env.example`), off by default. Off: `/api/public` and `/api/public/items` need the token (and `/api/public` is then `Cache-Control: private` with `Vary`, so the site's CDN never keeps it), and `PUT /api/settings/publishing` and `.../apply` answer 409. `/api/me` reports `public_access`.
- UI: with public access off, every address shows the sign-in form to anyone not signed in, with no app menu and no second Sign in button; signing in keeps you on the page you asked for (the root opens the Library). The Library hides "Public preview", and Settings says public access is off instead of showing the switches.
- The publishing code stays: `PUBLIC_ACCESS=1` brings back the public preview and Settings as they were.
- CI starts two hubs on the same database (one with public access for the existing visitor checks, one without for the new `web/test/browser/private.js`), the second after the first is ready (migrations).

**Tested**
- Offline: both modes for `/api/me`, `/api/public` (401 without the token when off, private cache header for the owner, public when on), the public item (401 when off even in full mode), and the settings (409 when off). Mutation-checked: 5 breakages, all caught.
- Browser, a public-access hub and a private hub on one throwaway database: `private.js` (every address, including the Library, a collection, Query, Settings and an unknown path, is only the form; the page asks only for session, apps and schema; data endpoints 401; sign in on a page and stay there; no Public preview toggle; Settings shows the notice; no console or CSP errors), then `owner.js`, `public-mobile.js` and `publishing.js` on the public-access hub, all green.

**Not tested / open**
- Not deployed. `deploy/deploy.sh` does not set `PUBLIC_ACCESS`, so production is private after the next deploy.
- The CI change runs on the first push.

## Task 10. Curation: reviewable change plans

The owner ran a quality analysis from the claude.ai chat (2026-11-01). Claude applied what it could (fields, links, a status), but could not merge the duplicate PET and CBDC vocabulary, and held back a DOI to avoid a second paper record. Curation closes that gap without giving Claude write access.

**Changed**
- `web/core/curation-ops.js` (new, pure): merge, unlink, delete and rename as functions from one snapshot of the touched nodes (with every relationship and the personal layer) to the next; refusals with the step number; a fingerprint that ignores property order.
- `web/core/curation.js` (new): snapshots loaded from Neo4j with their types kept through JSON (integers, datetimes), the difference between two snapshots written in one transaction (apply: before to after; revert: after to before), plans as `(:CurationPlan)` (migration `013_curation`), stale plans and late reverts refused (409), rename to a name another node has refused. After a commit: `afterWrite`/`afterRemove` hooks, hypotheses whose TESTS changed recomputed, hub-uploaded Drive files trashed (a moved file never) and untrashed on revert (`drive.untrash`, new).
- `web/features/curation` (new): `POST`/`GET /api/curation/plans`, `GET .../<id>`, `POST .../<id>/apply | reject | revert`, owner only. MCP: `propose_changes`, `apply_plan`, `revert_plan`, `list_plans`; the server instructions tell Claude to apply only after the owner says yes.
- Library: a **Curation** section (owner, next to Audit): plans to review, applied, all; each with its changes, conflicts and Drive warnings; Apply (confirm click), Reject, Undo (confirm click); keys open the item.
- Found on the way: `updated_at` written by curation used the machine's offset; now UTC like `datetime()`.

**Tested**
- Offline: every rule of every op on a fixture (moves, the duplicate link and the self-citation dropped, keep's link properties kept, copied fields with provenance and record_status, conflicts and `take`, merged_from, file moved or trashed, status moved or kept, vocabulary aliases with the matcher's fields, unlink, delete with orphans and file, rename, refusals, steps on removed keys, a pure input), fingerprints, the type codec, routes owner only, the MCP tools. Mutation-checked: 10 breakages, all caught.
- Integration on a throwaway Neo4j 5: merge two papers and revert to exactly the same graph (values, and Neo4j types compared with `valueType`), a stale plan and a late revert refused, merge two concepts (the matcher then maps the old name to the survivor) and revert, a rename collision refused, rename (the old name still finds it) and revert, delete with an orphan concept and the personal layer and revert, plans not in a backup.
- Browser: `web/test/browser/curation.js` (plans proposed through the API shown with their changes and conflicts, Reject, Apply with a confirm click merges, Undo restores, a key opens the item, no console or CSP errors), then `owner.js`, `public-mobile.js`, `publishing.js` and `private.js` green.

**Not tested / open**
- Live (2026-11-02, revision `research-hub-00009`): from a new claude.ai chat, Claude verified with `run_cypher` that `concept:privacy-enhancing-technologies` and `concept:cbdc` were linked only from `paper:a1a7425c09`, which also links to the matching Topics; proposed `plan:48ef09f4e802` (two deletes, no orphans, no files); the owner said yes; Claude applied it and confirmed the result. Reported by the owner from the chat; not re-checked from Claude Code (its old connector points at the closed run.app address).
- Learned: claude.ai keeps a connector's tool list from when it was connected; after a deploy that adds tools, reconnect the connector and start a new chat.
- Not tried live: merge, unlink, rename and Undo (all covered by the integration and browser tests).
- The cause of those duplicates: `add_paper` turned `topic:` tags into Concept nodes by slug (bypassing the matcher), while `save_analysis` puts `topics` on Topic nodes. Fixed, see "Duplicate topics" below.
- Not done: the hub's `year` is stored as a float by the paper writer (seen while testing types); harmless, but worth a migration later.
- Seen in the owner's chat run, not investigated: Claude's `topics` write on `paper:a1a7425c09` was skipped as an owner value although the field reads empty (an `ABOUT` link without provenance makes the field count as the owner's).

## Duplicate topics: tags to Topic, and merges across vocabulary kinds (2026-11-02)

The owner's chat analysis found the same idea as a Topic and a Concept (PET, CBDC). Cause: `topic:` tags on papers became Concept nodes by slug, bypassing the matcher, while the schema's `topics` field and `save_analysis` use Topic (`docs/SCHEMA_DESIGN.md`: paper topics are Topics; Concepts are ontology terms and the `concepts:` of notes and methods).

**Changed**
- `web/features/papers/type.js`, `item.js`: `topic:` tags are matched by name to Topic nodes (`vocab.resolve('Topic')`, like authors); a matched Topic keeps its own name. `private` is a tag too (it already was for visibility).
- Readers accept both (no data is rewritten): the paper list's topics, `search_papers`' topic filter and an example query read `Topic|Concept`; `get_artifact` also shows links to Topics and Domains (it showed only Concepts).
- Curation `merge` across vocabulary kinds (`web/core/curation-ops.js`): a Concept into a Topic or back, only when the schema allows every link that moves for the surviving kind (a Concept defined in an ontology cannot become a Topic); the dropped kind's own fields are listed as not carried over; `take` is refused across kinds. Snapshots now carry every key's labels for that check. Shown in the Curation view and the MCP description.

**Tested**
- Offline: tags give ABOUT to Topic (with and without the matcher), merge Concept into Topic and back, the schema refusal, kind fields not copied, `take` refused. Mutation-checked: 5 breakages, all caught.
- Integration on a throwaway Neo4j 5: a tag gives a Topic; two spellings of one tag give one Topic; topic search finds it; an older tag Concept merges into the Topic (its name then finds the Topic) and the revert is exact. The backup round trip now links its Concept explicitly (it relied on tags making Concepts).
- Browser: all six suites green on a throwaway hub.

**Not tested / open**
- Not deployed. Existing tag Concepts in production stay until merged: ask Claude in the chat to propose merging each Concept into its Topic.
- The `topics` field still counts links without provenance as the owner's (Claude's write skipped as "owner value" on `paper:a1a7425c09`); not changed here.

## Task 11. Library redesign

Approved by the owner on 2026-11-02 after three rounds on a clickable mockup (spec and link: `docs/UI_REDESIGN.md`). Built in six steps (`docs/BUILD_BRIEF.md`), deployed at the end.

### Step 1. Sidebar (2026-11-02)

**Changed**
- `schema/schema.json`: top-level `ui_sections` (Reading, Knowledge, Inquiry); every collection names its `ui_section`; `ui_more` and `ui_group` removed. `web/core/schema.js` checks both at start-up and `publicView()` gives the UI `sections` and each collection's `ui_section`.
- `web/apps/library/model.js`: `sidebarGroups` (sections in order, collections in schema order, an unknown section goes to "Other" so no type is lost) and `collectionCounts`; `barEntries`/`entryOf` removed.
- `web/apps/library/app.js`: the top row (collections bar, More menu, mode switch) became a sidebar: search everything (Enter opens All with the query), groups with counts, Graph, and Audit and Curation for the owner; the Private / Public preview switch moves to its foot when `PUBLIC_ACCESS` is on. Collapsible to a rail (`localStorage`, wrapped in try/catch). On a phone it is a drawer: ☰ opens it, a tap outside or Esc closes it, and it is `visibility: hidden` when closed so the keyboard cannot land in it. Changing collection from the sidebar clears the list search.
- `web/apps/library/collections.js`: the questions/hypotheses switch is gone (each has its own sidebar entry).
- Shell: no Owner badge in the top bar (Sign out shows you are signed in); a `menu` icon.
- `web/public/shell/base.css`: sidebar, rail and drawer styles from skin tokens; the bar and More styles removed.

**Tested**
- Offline: the schema check (unknown or missing `ui_section`, duplicate or empty `ui_sections`), `publicView` sections, the grouping (a new type lands in its group, an unknown group goes to Other, no sections still lists everything), the counts. Mutation-checked: 3 breakages, all caught.
- Browser (real Chrome, throwaway Neo4j, all six suites green): the sidebar's groups, order, counts and current entry; collapse and the remembered rail after a reload; Search everything; frameworks and hypotheses from the sidebar; on a 390 px phone the drawer opens, a tap outside closes it, and choosing an entry navigates and closes it; visitors get no Audit or Curation; no console or CSP errors.

**Not tested / open**
- Not deployed. List entries still show status pills; step 2 restyles them.
