# Schema changelog

Every change to `schema/schema.json`, with the reason. The spec is `docs/SCHEMA_DESIGN.md`. A per-type `schema_version` is raised when that type's fields change. Items below the current version form the audit worklist, so a change is never silently applied to old items.

## v3, analysis (2026-10-30)

Why: Claude's single-call analysis (Task 4), and the design's competency question 1 (sample size), which must be answerable in plain Cypher.

- Single-object fields also store each declared part as `<field>__<part>` (for example `evidence__n`, `period__from`). Migration `009` backfills them from `<field>_json`. They are not fields and cannot be written directly.
- Links saved by an analysis carry `evidence`, `location`, `confidence`, `by`, `model`, `at`, `status` and `source: 'analysis'`. `status: reviewed` (set by the audit) protects them like owner links.
- Vocabulary nodes and items gain `reviewed_at` when accepted in the audit.

## v3, items storage (2026-10-30)

Why: the collections API (Task 3) needs one storage convention and per-field provenance.

- Object fields and lists of objects are stored as JSON text in `<field>_json`, not in the field itself. Migration `007` copies values written the earlier way, then removes the old property.
- Each item stores its per-field provenance map in `provenance_json`.
- Link-field edges carry `field`, `position` and `source: 'items'`.
- The loader also checks two things for every link field: it has a `rel`, and no other link field in the same type uses the same relationship and target. Its relationship must also allow that type to that target in `relation_types`. Together these make link fields read back unambiguously.
- Vocabulary nodes gain `letters_plain`, and aliases store every letter signature. A word written in capitals next to lowercase text ("ZERO KNOWLEDGE PROOF rollup") is tried both as an acronym and as a word. Migration `008` adds the index and recomputes these fields. This fixes a duplicate-node race in Task 2's matcher.

## v3, name matching (2026-10-30)

Why: Claude passes vocabulary names, and the server must link them to one node per meaning (Task 2).

- Every entity has a `match` mode for `web/core/vocab.js`: `term` (Topic, Concept, Domain: plurals singularised), `name` (Venue, Organisation, Dataset), or `person` (also reads "Last, First"). The loader rejects other values.
- Vocabulary nodes carry derived fields: `norm`, `letters` (the acronym signature), `aliases_norm`, `aliases_letters` and `aliases_text`. Matcher-created nodes also carry `by`, `model` and `record_status`. These are not schema fields: the matcher maintains them, and migration `006` backfilled them on existing nodes. Existing keys are unchanged.

## v3 (2026-10-30): Collections

Why: the Library becomes four collections (Paper, Method, Use case, Case study), each with its own fields, and Claude needs a precise field list to fill. See `docs/SCHEMA_DESIGN.md`.

- `common_fields` (key, collection, title, tldr, summary, body, topics, tags, visibility, record_status, schema_version, provenance, created_at, updated_at) are shared by every collection. Each collection type adds its own `fields`. A field records its `type`, `enum`, `list`, `ref`/`rel`, `by`, `tier`, `required`, `default`, `label` and `help`.
- New types `use_case` (`usecase:` keys, label `UseCase`) and `case_study` (`case:` keys, label `CaseStudy`), both database-managed.
- Each type now declares:
  - `managed`: `db` for method, use_case and case_study; `api` for paper; `markdown` for note and project.
  - `schema_version`: 1 for every type.
  - Layout hints: `list_columns`, `filters` and `detail_groups`.
- **Methods move from Markdown to the database.** Migration `005` sets `source: 'hub'` and `imported_from: 'markdown'` (keeping `source_path`), and moves their Markdown edges to `source: 'hub'`. `hub sync-notes` now skips `methods/` files and never prunes a database-managed item.
- New vocabulary entities: Topic, Domain, Venue, Organisation and Dataset, joining Person and Concept. Each has a key prefix.
  - `public` says whether the entity may appear in the public preview. Organisation is not public, because case-study organisations can be sensitive.
  - `prune_orphans` limits the "delete unlinked nodes" clean-up to Person and Concept, so seeded Domains survive.
  - Migration `005` seeds the ten Domains from the design doc.
- `relation_types` lists every relationship type with its allowed endpoints. It adds BUILDS_ON, REPLICATES, INTRODUCES, ADDRESSES, INSTANCE_OF, VARIANT_OF, ALTERNATIVE_TO, REQUIRES, PUBLISHED_IN, INVOLVES and BROADER. The front-matter/API relation fields in `relations` gained the artifact-to-artifact ones.
- Public preview:
  - A type may narrow the global `public_props` with its own list. Use cases and case studies export only key, title and summary.
  - Vocabulary nodes export `entity_public_props` (key, name).
  - No field was added to the global whitelist.
- Validation (`web/core/schema.js`): a malformed schema stops start-up. On write, missing required fields are an error; everything else is a warning. Unknown fields are kept.
- The full-text index `artifact_text` is rebuilt over every type label and now includes `tldr`.

Known gaps, deliberately left for later tasks:
- Existing method values are not reshaped: `level: technique` is outside the new `level` enum, and `domain` is still a string rather than a Domain link. They produce validator warnings.
- `paper.item_type` in the schema uses the design's snake_case values. Stored papers still use the reference-manager values (`journalArticle` ...). Papers are not run through the validator yet (their input is reference-manager JSON); Task 3 maps them.
- `ref` fields are stored as text until the vocabulary matcher (Task 2) and the items API (Task 3) turn them into links.

## v2

Artifact types paper, method, note and project, entities Person and Concept, and the `relations` map and `public_props` whitelist.
