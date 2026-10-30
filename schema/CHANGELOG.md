# Schema changelog

Every change to `schema/schema.json`, with the reason. The spec is `docs/SCHEMA_DESIGN.md`. A per-type `schema_version` is raised when that type's fields change. Items below the current version form the audit worklist, so a change is never silently applied to old items.

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
