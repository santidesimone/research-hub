# Addendum: Frameworks, Research questions and hypotheses, Ontologies

> Markdown copy of `ADDENDUM_frameworks_questions_ontologies.md.docx` (the Word file is the original). The text is
> unchanged except for one table cell that was already damaged in the Word file: see the note on `urls` in 2.4.

Self-contained. Everything needed to build this is in this file. It extends docs/REQUIREMENTS.md, docs/SCHEMA_DESIGN.md and docs/BUILD_BRIEF.md. It depends on Tasks 1 to 3 of the brief (schema model with fields, vocabulary matcher, generic items API) and should be built after them, as Task 8 (plus the file-upload generalisation in Task 8b).

Context for the reader: Research Hub is a Neo4j-backed personal research library (Node.js). Collections hold independent content types with their own schema (see SCHEMA_DESIGN). Files are never stored in the database, only links (Google Drive links for hub-uploaded files). Claude saves analyses directly with no approval step; every Claude-written field carries provenance. "Empty beats wrong."

## 1. New requirements

| ID | Requirement | Why | Status |
|---|---|---|---|
| F15 | Store Frameworks (theoretical and conceptual) as their own items, link papers, questions and projects to them. | A paper's lens should be queryable ("every paper using path dependence"), not buried in text | Planned (T8) |
| F16 | Store Research questions and Hypotheses, with the result of each test recorded on the link between a paper and a hypothesis. | One hypothesis can be supported by one paper and contradicted by another; this gives a supported-versus-contradicted view without full Claim nodes | Planned (T8) |
| F17 | Store Ontologies and standards (e.g. FIBO modules, the ISO 20022 data dictionary, ETHON) as descriptive records with pointers to where they live. | These are large, externally maintained, living resources; the hub must reference them, not copy their contents | Planned (T8) |
| D10 | An ontology record stores descriptive metadata and URLs only. The ontology's classes and terms are never imported into the graph. | Avoid flooding the graph and duplicating a maintained source | Planned (T8) |
| D11 | An ontology record may carry an optional snapshot (a frozen copy in the owner's Drive) with version, retrieval date and checksum. Default is no snapshot. | Ontologies change between versions; frozen copies matter only for those relied on | Planned (T8b) |
| D12 | A Concept may carry an external_iri pointing at a specific term in an ontology. | Connect own concepts to standard vocabularies without importing them | Planned (T8) |
| D13 | The Drive upload path accepts more than PDFs (owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip), with a size cap; items over the cap stay link-only. Public-by-link sharing is applied as for PDFs, and the UI warns to check a resource's license before storing a snapshot. | Support ontology snapshots | Planned (T8b) |

## 2. New types (add to schema/schema.json; same field format as the other types)

Legend: By S source / C Claude / Y owner. Tier Core / Standard / Deep. Common fields (key, title, tldr, summary, body, topics, tags, visibility, record_status, schema_version, provenance, timestamps) apply as for every item. Key prefixes: framework:, question:, hypothesis:, ontology:.

### 2.1 Framework (framework, managed: db)

| Field | Type | By | Tier |
|---|---|---|---|
| name, aliases | text, text list | Y/C | Core |
| framework_kind | enum theoretical, conceptual | Y/C | Core |
| tldr | text | C | Core |
| originators | text list (people) | C | Standard |
| year_first_proposed | integer | C | Standard |
| core_propositions | text list | C | Standard |
| key_constructs | links to Concept | C | Standard |
| explains | text list (phenomena it applies to) | C | Standard |
| domains | links to Domain | C/Y | Standard |
| assumptions | text list | C | Standard |
| limitations_critiques | text list | C | Deep |
| conceptual_model | text (for conceptual frameworks: the variables and relationships; may hold a diagram link) | Y/C | Deep |

Notes: "theoretical" means borrowed from existing theory; "conceptual" means the owner's own synthesis of variables and relationships, often combining theories.

### 2.2 Research question (research_question, managed: db)

| Field | Type | By | Tier |
|---|---|---|---|
| text | text (the question) | Y/C | Core |
| kind | enum descriptive, explanatory, exploratory, evaluative | Y/C | Core |
| origin | enum own, extracted | Sys/Y | Core (extracted = taken from a paper) |
| status | enum open, partly_answered, answered, dropped | Y | Standard |
| scope | text | Y/C | Standard |
| rationale | text | Y/C | Deep |

### 2.3 Hypothesis (hypothesis, managed: db)

| Field | Type | By | Tier |
|---|---|---|---|
| statement | text | Y/C | Core |
| independent_variables, dependent_variables | text lists | Y/C | Standard |
| direction | enum positive, negative, no_effect, non_directional | Y/C | Standard |
| status | enum untested, supported, refuted, mixed, inconclusive | derived/Y | Standard (derived from its TESTS links; the owner can override) |
| origin | enum own, extracted | Sys/Y | Core |
| operationalisation | text | Y/C | Deep |

### 2.4 Ontology / standard (ontology, managed: db)

| Field | Type | By | Tier |
|---|---|---|---|
| name, acronym | text | Y/C | Core |
| kind | enum ontology, data_dictionary, standard, taxonomy | Y/C | Core |
| publisher | link to Organisation | C/Y | Core |
| iri | text (base namespace; the stable machine identifier) | C/Y | Core |
| urls | list of `{role: docs \| spec \| download …` (see note) | (lost) | (lost) |
| parent | link to another Ontology (e.g. a FIBO module to FIBO), via PART_OF | C/Y | Standard |
| version, version_date | text, date | C/Y | Standard |
| scope | text (what it models) | C | Standard |
| domains | links to Domain | C/Y | Standard |
| format | enum owl_rdf, xml, json_ld, json_schema, spreadsheet, html_only, other | C | Standard |
| license | text | C/Y | Standard |
| language | text list | C | Deep |
| approx_size | text (e.g. "about N classes") | C | Deep |
| maturity | enum draft, stable, standard, deprecated | C/Y | Standard |
| how_i_use_it | text | Y | Standard |
| snapshot | optional {file_url, drive_file_id, retrieved_at, version, sha256, size_bytes, mime} | Sys/Y | Deep |

> **Note on `urls` (damaged in the source).** In the Word file this row is cut at the `|` characters inside its type:
> the cells read only "urls", "list of `{role: docs", "spec", "download". The remaining role values (if any), the closing
> part of the type (presumably a `url` per entry), and this field's By and Tier are lost.
> **Decided by the owner (2026-10-31):** a list of `{role, url}` with roles docs, spec, download, repository, other;
> filled by Claude or the owner (C/Y); tier Core.

Rules: URLs are stored, never fetched on read. The snapshot is created only on request. sha256 and retrieved_at let the UI show "snapshot older than the current version" when version differs. The ontology's contents (classes, properties) are not stored.

## 3. New relations

| Relation | From to | Notes |
|---|---|---|
| FRAMED_BY | Paper, Research question, Project, Case study to Framework | Replaces the free-text theoretical_framework on Paper with a link (keep the old text field readable for one schema version) |
| BUILDS_ON, COMPETES_WITH | Framework to Framework | e.g. Chartalism competes with Metallism |
| SUB_QUESTION_OF | Research question to Research question | |
| ASKED_IN | Research question to Paper | for extracted questions |
| ADDRESSED_BY | Research question to Paper, Method, Case study | |
| PART_OF | Research question to Project; Ontology to Ontology | |
| DERIVED_FROM | Hypothesis to Framework | |
| ANSWERS | Hypothesis to Research question | |
| TESTS | Paper to Hypothesis | Carries properties: result (supported, refuted, mixed, inconclusive), evidence (short text), location, confidence, plus provenance. The hypothesis status is derived from the set of TESTS results. |
| ALIGNS_WITH, EXTENDS | Ontology to Ontology | |
| USED_BY | Ontology to Use case, Case study, Paper, Project | |
| DEFINED_IN | Concept to Ontology | with property external_iri |

Add all to relations in schema/schema.json, to the safeRel allow-list, to web/core/backup.js whitelists, and to the audit and public-export handling (none of the new types are public by default).

## 4. Tasks

### Task 8. Framework, Research question, Hypothesis, Ontology types

- Add the four types and relations to the schema (fields, tiers, enums, versions, managed: db); migration NNN_frameworks_questions_ontologies.js for constraints and indexes on the new keys and for the fulltext index (add the new types' name/text/statement fields to artifact_text).
- Items API and MCP: reuse the generic layer (Task 3). save_analysis accepts these collections. Add a derivation hook: when a TESTS link is created, changed or removed, recompute the hypothesis status (unless the owner overrode it).
- Paper analysis: Claude identifies frameworks used and links FRAMED_BY; extracts stated research questions (origin=extracted) and tested hypotheses (TESTS with result, evidence, location). Findings without a location are flagged, as in Task 4.
- Ontology intake: the owner or Claude supplies a URL; Claude reads the page and fills the descriptive fields; the server validates that URLs are https and stores them without fetching. iri is normalised; parent and part_of are resolved.
- Concept external_iri and DEFINED_IN (optional fields; no import).
- UI: extend the Collections bar with Frameworks, Questions and hypotheses, Ontologies and standards. With seven collections the bar groups the less-used ones under a "More" menu. Detail views show linked items (e.g. a hypothesis lists the tests with results as a small table; a framework lists papers framing on it; an ontology shows its modules and users).
- Acceptance: CRUD for all four types; TESTS results derive hypothesis status (offline and integration tests, including a hypothesis supported by one paper and refuted by another giving mixed); a framework page lists all papers using it; the stablecoin example below can be created end to end; backup and restore round-trips the new labels and relations.

### Task 8b. Generalise file upload beyond PDFs

- web/core/drive.js upload currently assumes application/pdf. Make the MIME type a parameter, restricted to an allow-list (pdf, owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip, plain text), size-capped by MAX_UPLOAD_MB (default 30; Cloud Run limit is 32 MB). Over the cap, return a clear error suggesting a link.
- Ontology snapshot endpoint and CLI: hub ontology snapshot <key> <file|url> downloads (allow-listed hosts or a local file) or reads a local file, uploads to Drive, records file_url, drive_file_id, retrieved_at, sha256, size_bytes, mime, and trashes the previous snapshot of that record. Deleting an ontology trashes its hub-uploaded snapshot, as for papers.
- UI warning when creating a snapshot: files are shared by link; check the resource's license first.
- Acceptance: tests with the fake Drive layer for allow-list, size cap, checksum, replacement and deletion; existing PDF behaviour unchanged.

## 5. Worked example (must be creatable after Task 8)

Research question: "Why do stablecoins struggle to replace card payments?" (own, explanatory, open), framed by three Frameworks: two-sided market theory, path dependence, Diamond-Dybvig bank-run model. Hypotheses derived from them, each DERIVED_FROM a framework and ANSWERS the question: H1 adoption requires simultaneous merchant and consumer growth; H2 entrenched interchange and acquiring relationships raise switching costs; H3 redemption risk reduces trust in stablecoins. Papers TEST hypotheses with results. An Ontology record for a financial-industry ontology is USED_BY the use case that needs a shared legal-entity vocabulary.

Cypher the model must answer:
- Papers using a given framework.
- Hypotheses with conflicting test results (mixed).
- Open research questions with no addressing paper.
- Ontologies used by no item, and use cases that reference an ontology.

## 6. Open points

- Descriptions of FIBO, the ISO 20022 data dictionary and ETHON in this addendum came from general knowledge and were not verified against their sites. Claude should read the actual pages when creating those records.
- Whether the Collections bar should show all seven collections or group some under "More": decide when building the UI.
- Whether hypothesis status should ever be overridden by the owner when TESTS exist (assumed yes, flagged as owner-set).
- Full ontology querying (triple store or Neo4j RDF plugin) is deliberately out of scope.
