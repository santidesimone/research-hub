# Build brief: Collections, schema-driven items, Claude analysis

Goal: turn the Library into one app with **Collections** (Papers, Methods, Use cases, Case studies), where each type has its own schema-defined fields, list and detail views, create/edit forms, and where Claude can analyse a paper and save the complete result in **one call with no approval step**. The spec is `docs/SCHEMA_DESIGN.md`. Work in order. After each task: `npm test` green, README/openapi updated, short note of what could not be tested.

## Task 0. Baseline against real services (do this first)
- Bring up Neo4j with docker compose (or `./scripts/local.sh`). Run the app, run `npm run test:integration` on a throwaway database, fix every failure (migrations 001 to 004, fulltext index and Lucene query in `web/core/query.js`, notes sync in `web/core/notes.js`, backup/restore).
- Build the Docker image (`docker build .`) and run it with `NODE_ENV=production` and a real token to confirm the strict config works.
- Smoke-test the CLI: `hub add`, `hub search`, `hub sync-notes ./content`, `hub backup`, `hub restore`.
- Acceptance: integration suite passes against real Neo4j; list in the PR what remains unverified (Google OAuth/Drive, Crossref, OpenAlex).

## Task 1. Schema model v3 (fields, tiers, versions)
- Extend `schema/schema.json`: types `paper`, `method`, `use_case`, `case_study` get a `fields` map (`type`, `enum` values, `list`, `ref` to a vocabulary, `by`, `tier`, `label`, `help`), `schema_version`, `managed` (`db` or `markdown` or `api`), and list/detail layout hints (`list_columns`, `filters`, `detail_groups`). Add vocabulary entities (Topic, Concept, Domain, Person, Venue, Organisation, Dataset) and the typed relations in `docs/SCHEMA_DESIGN.md`. Keep `note` and `project` as Markdown-managed.
- Add `schema/CHANGELOG.md`. Add a validator in `web/core/schema.js`: required Core fields enforced on write, other problems returned as warnings, unknown fields preserved.
- Migration `005_collections.js`: constraints/indexes for new labels and keys, set `managed`/`schema_version` on existing nodes, seed the Domain list from the design doc. Existing methods from Markdown keep working and become database-managed (set a `source` property so nothing is lost).
- Update the public whitelist handling so new types export only whitelisted fields.
- Acceptance: unit tests for the validator and the schema loader; the old API still works for existing data.

## Task 2. Vocabulary nodes and name matcher
- `web/core/vocab.js`: `resolve(kind, name, {create:true})` normalises (case, punctuation, diacritics), checks aliases, falls back to a fulltext lookup, returns an existing key or creates a node flagged `by=claude`. Idempotent under concurrent calls (use MERGE on the key).
- Acceptance: tests with variants ("Zero-knowledge proof", "ZK proofs", "zero knowledge proofs") resolving to one node; no duplicate creation under parallel calls (integration test).

## Task 3. Generic items API with provenance
- New feature `web/features/items/`: `GET /api/items?collection=&q=&filter...&sort=&limit=&cursor=`, `GET /api/items/:key`, `POST /api/items` (create), `PATCH /api/items/:key` (owner edit: sets `by=owner,status=reviewed`), `DELETE /api/items/:key`, `PUT/DELETE /api/items/:key/links` (typed relations with `evidence`, `location`, `confidence`). Schema-driven validation, pagination, filters from `filters` in the schema.
- Store scalars and lists as node properties, structured values (evidence, outcomes, timeline, requirements, key_findings) as JSON strings in `<field>_json`, and `provenance_json` for the provenance map. Expose them parsed in the API.
- `hub sync-notes` (`web/core/notes.js`) must skip `managed:db` types and never prune them. Add tests.
- Keep `/api/papers` (existing, used by the UI and import/export) working; it can delegate to the new layer.
- Acceptance: CRUD for all four collections; owner edits are never overwritten; list endpoint supports filters declared in the schema; offline tests plus integration tests.

## Task 4. Claude analysis: single-call save, audit
- `POST /api/analysis` and MCP tool `save_analysis` (owner only). Input: `collection`, identity (`doi` or `url` or `key`), `fields` (only the fields Claude is confident about), `links` (relation, target name or key, evidence, location, confidence), `model`, optional `tier` (`standard` default, `deep`), optional `file_url` and `copy_to_drive`. One request does everything:
  1. For papers, resolve the DOI and fill **source fields** from Crossref and OpenAlex server-side (Claude does not write authors/year/venue/abstract); write Person and Venue nodes.
  2. Validate against the schema; resolve vocabulary names through `vocab.resolve`; create typed links.
  3. Merge rules: fill empty fields only; never overwrite `by=owner` or `status=reviewed`; `force` overrides Claude values only.
  4. Findings without a `location` are saved but flagged `ungrounded`.
  5. Save immediately, with `record_status=auto` and full provenance. Return `{key, url, created, filled[], skipped[], empty_core_standard[], warnings[], flagged[]}`.
- MCP `get_schema` (returns the current fields/enums/tiers for a collection with short instructions: "leave a field empty rather than guess; every finding needs a location"), plus `save_analysis`, `search_items`, `get_item`. Update the MCP version, tool descriptions and `describe_graph` overview.
- `GET /api/audit`: low-confidence fields, empty Core/Standard fields, ungrounded findings, items below current `schema_version`, vocabulary nodes created by Claude, with counts. `POST /api/audit/accept` marks fields reviewed.
- Re-analysis: `POST /api/analysis` on an existing key fills only empty fields.
- Acceptance: tests with fake Crossref/OpenAlex; idempotency; merge rules; an end-to-end integration test (save analysis, then query the competency question 1 and 4 from the design doc in Cypher).

## Task 5. Library UI: Collections, shelves, forms, audit
- Library keeps its shell and graph view. Add a **Collections bar** (from the schema): Papers, Methods, Use cases, Case studies, plus All. Addresses: `/library/<collection>` and `/library/<collection>?key=...`.
- Papers keep their reader, file link, upload and status. Add an **Analysis** tab (grouped by the schema's `detail_groups`, tier badges, provenance markers: Claude / source / you, confidence, ungrounded flags).
- Generic list and detail for Methods, Use cases, Case studies built from the schema: columns, filters, sorting, grouped fields, related items from any collection (including Notes and Projects).
- Create/edit forms generated from the schema (text, enum, list editor, structured editors, vocabulary pickers with type-ahead, relation picker). Saving an edit marks the field `by=owner, reviewed`.
- Audit view listing the `GET /api/audit` buckets with one-click "accept" and "edit".
- Acceptance: browser-verified with Playwright (list, create, edit, delete, filter, audit, a paper analysis display); no CSP errors; mobile width usable; works for anonymous visitors only through the public whitelist.

## Task 6. CLI, API docs, CI, docs
- `bin/hub`: `item list|get|add|edit|rm`, `analyze <doi|url|pdf> [--deep]` (calls the hub's save endpoint with fields supplied via stdin JSON, for scripts), `audit [--accept-all-unchanged]`, `schema [collection]`.
- Update `web/openapi.json`, `README.md`, `deploy/README.md`, `_env.example`. Add the integration test to CI (it already runs against a Neo4j service) and cover the new endpoints.
- Acceptance: CI green; docs match behaviour.

## Task 7. Hardening pass
- Review rate limits for `/api/analysis` (heavy bucket), request size limits, error messages, backup/restore coverage of the new labels and relation types (`web/core/backup.js` whitelists), the public export for new types. Verify production config checks.
- Acceptance: backup and restore round-trip includes all four collections and vocabulary nodes.

## Task 8. Framework, Research question, Hypothesis, Ontology types
Source and full detail: `docs/ADDENDUM_frameworks_questions_ontologies.md` (requirements F15 to F17, D10, D12; model in `docs/SCHEMA_DESIGN.md`, section "Addendum (Task 8)"). Depends on Tasks 1 to 3.
- Add the four types and relations to the schema (fields, tiers, enums, versions, managed: db); migration NNN_frameworks_questions_ontologies.js for constraints and indexes on the new keys and for the fulltext index (add the new types' name/text/statement fields to artifact_text).
- Items API and MCP: reuse the generic layer (Task 3). save_analysis accepts these collections. Add a derivation hook: when a TESTS link is created, changed or removed, recompute the hypothesis status (unless the owner overrode it).
- Paper analysis: Claude identifies frameworks used and links FRAMED_BY; extracts stated research questions (origin=extracted) and tested hypotheses (TESTS with result, evidence, location). Findings without a location are flagged, as in Task 4.
- Ontology intake: the owner or Claude supplies a URL; Claude reads the page and fills the descriptive fields; the server validates that URLs are https and stores them without fetching. iri is normalised; parent and part_of are resolved.
- Concept external_iri and DEFINED_IN (optional fields; no import).
- UI: extend the Collections bar with Frameworks, Questions and hypotheses, Ontologies and standards. With seven collections the bar groups the less-used ones under a "More" menu. Detail views show linked items (e.g. a hypothesis lists the tests with results as a small table; a framework lists papers framing on it; an ontology shows its modules and users).
- Ontology `urls` (its row was damaged in the addendum's Word source), decided: a list of {role, url}, roles docs, spec, download, repository, other; by C/Y; Core. Open points in the addendum, section 6, are settled while building.
- Acceptance: CRUD for all four types; TESTS results derive hypothesis status (offline and integration tests, including a hypothesis supported by one paper and refuted by another giving mixed); a framework page lists all papers using it; the stablecoin example (addendum, section 5) can be created end to end; backup and restore round-trips the new labels and relations.

## Task 8b. Generalise file upload beyond PDFs
Source: `docs/ADDENDUM_frameworks_questions_ontologies.md` (requirements D11, D13).
- web/core/drive.js upload currently assumes application/pdf. Make the MIME type a parameter, restricted to an allow-list (pdf, owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip, plain text), size-capped by MAX_UPLOAD_MB (default 30; Cloud Run limit is 32 MB). Over the cap, return a clear error suggesting a link.
- Ontology snapshot endpoint and CLI: hub ontology snapshot <key> <file|url> downloads (allow-listed hosts or a local file) or reads a local file, uploads to Drive, records file_url, drive_file_id, retrieved_at, sha256, size_bytes, mime, and trashes the previous snapshot of that record. Deleting an ontology trashes its hub-uploaded snapshot, as for papers.
- UI warning when creating a snapshot: files are shared by link; check the resource's license first.
- Acceptance: tests with the fake Drive layer for allow-list, size cap, checksum, replacement and deletion; existing PDF behaviour unchanged.

## Out of scope for now
Claim nodes (v2), embeddings and semantic search, multi-user access, full-text extraction from PDFs.
