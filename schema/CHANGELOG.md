# Schema changelog

Every change to `schema/schema.json`, with the reason. The spec is `docs/SCHEMA_DESIGN.md`. A per-type `schema_version` is raised when that type's fields change. Items below the current version form the audit worklist, so a change is never silently applied to old items.

## v5, books; papers, reports and books read alike (2026-11-03)

Why: books are the other kind of reading the owner does, and reports, papers and books should read the same way in the Library: one list, one page, a Reader tab.
- Types may set `reader: true` (checked: a boolean, collections only): `paper`, `report` and the new `book`. A reader item has a file link (`file_url`, `drive_file_id` when the hub uploaded it); the file endpoints (`/api/papers/file`, MCP `set_file_link`, `copy_pdf_to_drive`, `request_upload`, `remove_file_link`) work for any of them, and `GET /api/papers?collection=report|book` lists them as the papers list does. The Library shows them with the papers' list and page (Info, Analysis, Connections, Reader; Reader is disabled while there is no file).
- New collection **book** (`book:`, database-managed, sidebar group `reading`): `authors` (Person, AUTHORED_BY), `editors`, `year`, `edition`, `publisher` (Organisation, PUBLISHED_BY), `isbn`, `url`, `language`, `abstract` (the publisher's description), `book_kind` (textbook, monograph, handbook, edited_volume, practitioner_guide, trade_book, reference, other), `domain`, `main_claim`, `chapters` ({number, title, pages}), `key_findings` ({text, location}), `limitations_observed`, and the owner's `relevance`, `relevance_reason`, `reading_depth`. Bibliographic fields may be written by a source, Claude or the owner (no Crossref for books).
- Relations: a book may be ABOUT, AUTHORED_BY, PUBLISHED_BY, FRAMED_BY, INFORMS, SUPPORTS, CRITIQUES and CONTRADICTS (papers, reports, books); papers, reports and thoughts may support a book, reports and thoughts may critique or contradict one; a thought may ANNOTATE a book and be TURNED_INTO one.
- Migration `017_books` rebuilds the `artifact_text` full-text index to cover the Book label.
- Global `version` 4 to 5.

## v4, reports (2026-11-02)

Why: grey literature (vendor and consultancy surveys, whitepapers, policy briefs) is not a paper: it has a publisher with an interest, a sample instead of a venue, and claims that are often expectations rather than measurements. It needs its own fields to be appraised.
- New collection **report** (`report:`, database-managed, sidebar group `reading`). Shared with paper: title, tldr, summary, topics, `domain`, `key_findings` ({text, location}, location needed), `limitations_stated`, `limitations_observed`, `conflicts_funding`, `peer_review` (default `grey`). Its own: `authors` (Person, AUTHORED_BY), `publisher` (Organisation, PUBLISHED_BY; core), `publisher_type`, `report_kind`, `published_date` (date: YYYY, YYYY-MM or YYYY-MM-DD), `url`, `intended_audience`, `commercial_interest`, `sample` ({n, respondent_profile, countries, industries, field_period}), `methodology`, `claim_basis` (list of measured, self_reported, expectation, modeled, unspecified), `recommendations` ({text, location}), `credibility_tier` (usable_source, use_with_caveats, directional_only; core) and `credibility_reason` (core).
- Relations: Report may be ABOUT, AUTHORED_BY, PUBLISHED_BY, FRAMED_BY, INFORMS, CITES (Paper, Report), SUPPORTS, CRITIQUES, CONTRADICTS (Paper, Report, UseCase; interpretive: evidence required, flagged without a location). A paper or a thought may now SUPPORT, CRITIQUE or CONTRADICT a report; `pairs` keep the old combinations otherwise (a paper still cites only papers and critiques no use case). A thought may ANNOTATE a report and be TURNED_INTO one.
- `common_fields.collection` lists every collection (it had fallen behind at the first four).
- Analyses (`save_analysis`, `POST /api/analysis`) take an optional `slug` for a new non-paper item (its key becomes `<prefix><slug>`), and flag recommendations without a location as they do findings.
- Migration `016_reports` rebuilds the `artifact_text` full-text index over every type label (Report, and Thought, which 015 did not add) plus `methodology` and `credibility_reason`, and indexes `report_kind` and `credibility_tier`.
- Global `version` 3 to 4.

## v3, thoughts replace notes; projects retired (2026-11-02)

Why: Task 11 step 6 (`docs/UI_REDESIGN.md` sections 4 and 7). Notes as Markdown files in git were clumsy, and projects organise work, which the hub is not for.
- New collection **thought** (`thought:`, database-managed): `text` (title from it), `state` (waiting, turned, kept; default waiting), `suggested_as` and `suggested_reason` (Claude's). Sidebar group `capture` (a group without a heading, first), counted while waiting (`ui_count`, new and checked: an enum field of the type and one of its values).
- `ui_sections` labels may be empty (a group without a heading).
- **TURNED_INTO** (Thought to the item it became). A thought may ANNOTATE (now also frameworks, questions, hypotheses, ontologies), CRITIQUE, SUPPORT, CONTRADICT and be ABOUT, as notes could.
- Types may be `retired` (true, or the type that replaces it; checked; never a collection): **note** (by thought) and **project**. They stay readable; the API and Claude refuse to make new ones (410), and no relation offers them as a target (a relation left without a live target, such as a question PART_OF a project, is not offered).
- Migration `015_thoughts` copies every note into a kept thought with its links and proposes one curation plan deleting the old notes and all projects. `PUT /api/notes/sync` and `hub sync-notes` answer that they are retired; `hub import-notes` turns Markdown notes into thoughts once.

## v3, questions and hypotheses are the owner's (2026-11-02)

Why: Task 11 step 5 (`docs/UI_REDESIGN.md` section 3). Questions and hypotheses are created by the owner and informed by sources; a paper's own question is a fact about the paper.
- New relation **INFORMS** (Paper, Method, CaseStudy, UseCase, Framework, Ontology, Note to ResearchQuestion, Hypothesis), optional `role` (background, supports, challenges). Field-map key `informs`.
- **ASKED_IN** and **ADDRESSED_BY** are `retired` (new key: names the replacement, checked at start-up): kept for old data and backups, never offered or created (400 on the API, skipped in analyses). Migration `014_informs` turns each into an INFORMS with the same properties, writes the questions' text into their papers' `stated_question` (as Claude's value), and proposes, in one curation plan, deleting extracted questions nothing else uses.
- **paper** gets `stated_question` (longtext, Claude or owner, standard; in Content). `schema_version` 1 to 2, so existing papers appear under "Older schema version" until re-analysed.
- `origin` on questions and hypotheses is hub-set provenance only (`by: Sys`): out of forms, lists and filters.

## v3, plural names for vocabulary (2026-11-02)

Why: Task 11 step 4. Connections and the graph filter group links by type and need a plural heading ("People", not "Persons").
- Entities may set `label_plural` (checked at start-up); all seven do. `GET /api/schema` gives it as `plural` on the entity labels. No data change.

## v3, Library sidebar groups (2026-11-02)

Why: Task 11 step 1 (`docs/UI_REDESIGN.md`). The Library's single row of collections becomes a sidebar grouped by purpose.
- New top-level `ui_sections`: `reading`, `knowledge`, `inquiry` (id and label, in order).
- Every collection names its `ui_section` (checked at start-up). `ui_more` and `ui_group` are removed; they were layout hints only, so no data changes and no migration.
- `GET /api/schema` gives `sections`, and each collection's `ui_section`.

## v3, ontology snapshots (2026-10-31)

Why: D11 and D13 (Task 8b). No schema change: the ontology `snapshot` field (`file_url`, `drive_file_id`, `retrieved_at`, `version`, `sha256`, `size_bytes`, `mime`; by Sys and the owner) was already defined in Task 8. It is now filled by `POST /api/ontologies/snapshot` and cleared by `DELETE` (the owner's write, so re-runs never touch it).

## v3, frameworks, questions, hypotheses, ontologies (2026-10-31)

Why: `docs/ADDENDUM_frameworks_questions_ontologies.md` (requirements F15 to F17, D10, D12; Task 8). A paper's lens, its questions and the hypotheses it tests become queryable; ontologies and standards are referenced, not copied.

- New collections, all database-managed, `schema_version` 1, none public by default:
  - `framework` (`framework:`)
  - `research_question` (`question:`)
  - `hypothesis` (`hypothesis:`)
  - `ontology` (`ontology:`)
- New relations: FRAMED_BY, COMPETES_WITH, SUB_QUESTION_OF, ASKED_IN, ADDRESSED_BY, PART_OF, DERIVED_FROM, ANSWERS, TESTS, ALIGNS_WITH, USED_BY and DEFINED_IN. BUILDS_ON also joins framework to framework, and EXTENDS also joins ontology to ontology.
- **PUBLISHED_BY** (ontology to Organisation) is an addition: the addendum's `publisher` field is a link and needed a relationship.
- New schema features, all checked at start-up:
  - Relations may declare `pairs` (endpoints per source label: PART_OF joins question to project and ontology to ontology, never question to ontology) and `props` (TESTS `result`, required, one of supported, refuted, mixed, inconclusive).
  - Object parts may be specs (`{type: "enum", enum: [...]}`).
  - Url fields and parts may be `https: true`. A non-https value is refused, not just warned about.
  - Text fields may be `normalize: "iri"`.
  - Types may set `title_from` (a question's title from its text), `ui_more` and `ui_group` (Library layout).
- A hypothesis's `status` is derived from its TESTS results (provenance `by: derived`). An owner value stands until cleared.
- Concepts may carry `external_iri` and a DEFINED_IN link (`PATCH /api/vocab`).
- Migration `011` rebuilds `artifact_text` with `text`, `statement` and `acronym`, and indexes `Hypothesis.status`.
- `Paper.theoretical_framework` (free text) stays readable alongside FRAMED_BY, as the addendum asks.

## v3, Library UI (2026-10-30)

Why: the Library builds its collections, lists, forms and filters from the schema (Task 5).

- Types may set `label_plural` (Papers, Methods, Use cases, Case studies). The Library uses it for the Collections bar and addresses (`/library/case-studies`).
- `record_status` is now derived from provenance on every write: `auto` while the item holds Claude values nobody has accepted, otherwise `reviewed`. Owner and source values need no review. Migration `010` recomputes it for existing items, because migration `005` had set `auto` on all of them, including the owner's own data.

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
