# Requirements: Research Hub

Owner and sole user: Santiago De Simone. Purpose: a personal research hub where papers, methods, use cases and case studies live in a knowledge graph with rich metadata, so connections can be browsed and queried, and Claude can add and analyse material quickly.

Status key: **Built** (in the current code), **Planned** (in `docs/BUILD_BRIEF.md`, with task number), **Open** (undecided or unverified). Statuses as of 2026-10-31, after Tasks 0 to 8b; what was tested for real, per task, is in `docs/PROGRESS.md`. F15 to F17 and D10 to D13 come from `docs/ADDENDUM_frameworks_questions_ontologies.md`.

## 1\. Functional

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| F1 | Store research items in a graph. Four collections: Papers, Methods, Use cases, Case studies. Notes and Projects stay as related content. | Connections between items are the value; types are independent content, not only paper annotations | Built (T1) |
| F2 | One **Library** app to browse everything, with **Collections** inside it, search, detail view and a graph view. Collections are called "Collections", not "shelves". | One place to browse; Library is one app among several in the shell | Built (T5) |
| F3 | Adding a paper: the owner gives Claude a link, DOI or PDF. Claude analyses it and saves the complete result in **one call, with no approval step**. The item is searchable and linked immediately. | Capture must be fast; the owner does not want to produce metadata by hand or approve each item | Built (T4; `hub analyze` in T6) |
| F4 | Rich, schema-defined metadata per type (tiers Core/Standard/Deep), improvable without breaking existing data. See `docs/SCHEMA_DESIGN.md`. | The richer the metadata, the more useful the queries | Built (T1) |
| F5 | Create, edit and delete Methods, Use cases and Case studies in the browser, API, CLI and MCP. | Owner wants to author this content directly | Built (T3, T5, T6) |
| F6 | Personal layer (reading status etc.) is separate from the items and is a layer on top of the library, not part of its core. | Status is personal opinion, not a property of the paper; the system must work without it | Built |
| F7 | Query the graph over the internet with read-only Cypher: from the browser console, REST, the CLI on the owner's computer, and Claude (MCP). | Ask arbitrary questions of the data from anywhere | Built |
| F8 | Ranked full-text search over titles, abstracts, summaries, authors, venues and note text, plus topics. | Quick retrieval | Built (fixed in T0) |
| F9 | Import and export a reference-manager-compatible format (CSL JSON). **No dependency on Zotero or its API.** | Interoperability without coupling | Built |
| F10 | Markdown notes and projects synced from the owner's computer with `hub sync-notes` (dry run, prune protection). Methods, Use cases and Case studies are managed in the database and are skipped by sync. | Write notes in an editor; keep structured content in the app | Built (skip rule in T1) |
| F11 | Citation links between papers via OpenAlex (`hub enrich`). | Network analysis needs the citation edges | Built |
| F12 | Backup and restore of the whole library (merge by key, never deletes). | Neo4j is the only copy | Built (round trip of every type verified in T7) |
| F13 | Audit view: low-confidence fields, empty Core/Standard fields, findings without a location, items on an old schema version. Optional; never blocks use. | Errors by Claude must be findable | Built (T4, T5) |
| F14 | Reader shows a linked PDF (embedded Drive preview, or a file card for other links). | Read without leaving the app | Built |
| F15 | Store Frameworks (theoretical and conceptual) as their own items, link papers, questions and projects to them. | A paper's lens should be queryable ("every paper using path dependence"), not buried in text | Built (T8) |
| F16 | Store Research questions and Hypotheses, with the result of each test recorded on the link between a paper and a hypothesis. | One hypothesis can be supported by one paper and contradicted by another; this gives a supported-versus-contradicted view without full Claim nodes | Built (T8) |
| F17 | Store Ontologies and standards (e.g. FIBO modules, the ISO 20022 data dictionary, ETHON) as descriptive records with pointers to where they live. | These are large, externally maintained, living resources; the hub must reference them, not copy their contents | Built (T8) |
| F18 | From the claude.ai chat: drop a paper (a PDF or a link) and it ends up in the library, analysed, with its file in the owner's Drive. A public PDF is copied by the hub; a private one goes through a one-click upload link, because chat attachments do not reach tools. | Capture where the owner already reads and talks with Claude | Built (T9); tested live from the claude.ai chat (2026-10-31) |

## 2\. Data

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| D1 | **Neo4j is the only system of record.** | Single source of truth for items and relationships | Built |
| D2 | **The database stores links, never files.** A paper keeps `file_url` (and `drive_file_id` only when the hub uploaded it). | Keep the graph small and portable | Built |
| D3 | PDFs the hub uploads go to the owner's **own Google Drive**, in one dedicated folder, shared "anyone with the link". Deleting a paper trashes its hub-uploaded file. Drive is required for uploads (no local-folder fallback). The owner accepts that links are public. | Simple private cloud with embeddable links | Built; tested live 2026-10-31 (copy from arXiv, public link, trash on delete) |
| D4 | Note text stays in Neo4j (`body`). | Searchable, no redeploy to change notes | Built |
| D5 | `schema/schema.json` is the single source of truth for types, fields, relations and the public whitelist. | UI, API, MCP and migrations stay in step | Built (fields and layout hints in T1) |
| D6 | **Additive schema evolution**: new fields optional, old items stay valid, renames and removals via numbered migrations, per-type `schema_version`. | Improve the schema without breaking anything | Built (T1; migrations 005 to 010) |
| D7 | **Provenance on every field** written by Claude (by, date, model, confidence, status); owner edits are never overwritten. | Trust and auditability without a review gate | Built (T3, T4) |
| D8 | Shared vocabulary nodes (Topic, Concept, Domain, Person, Venue, Organisation, Dataset); the server matches names to existing nodes. | Connections need shared nodes, not strings | Built (T2) |
| D9 | Bibliographic facts come from sources (Crossref, OpenAlex), not from Claude. | Accuracy and speed | Built (T4; verified against the live services) |
| D10 | An ontology record stores descriptive metadata and URLs only. The ontology's classes and terms are never imported into the graph. | Avoid flooding the graph and duplicating a maintained source | Built (T8) |
| D11 | An ontology record may carry an optional snapshot (a frozen copy in the owner's Drive) with version, retrieval date and checksum. Default is no snapshot. | Ontologies change between versions; frozen copies matter only for those relied on | Built (T8b); live Drive test Open |
| D12 | A Concept may carry an external_iri pointing at a specific term in an ontology. | Connect own concepts to standard vocabularies without importing them | Built (T8) |
| D13 | The Drive upload path accepts more than PDFs (owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip), with a size cap; items over the cap stay link-only. Public-by-link sharing is applied as for PDFs, and the UI warns to check a resource's license before storing a snapshot. | Support ontology snapshots | Built (T8b); live Drive test Open |

## 3\. Access and security

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| S1 | One owner credential (`HUB_API_TOKEN`): Bearer token for API, CLI and MCP; signed session cookie for the UI. | Single-user system | Built |
| S2 | Anonymous visitors see only a **public preview**: items marked public, with a whitelist of fields (no statuses, abstracts, file links or note text). | Show some work publicly without leaking private data | Built (per-type whitelists in T1; internal and confidential case studies excluded in T7) |
| S3 | All write endpoints require the owner. |  | Built |
| S4 | The Cypher endpoint is read-only, enforced in three layers (text guard, EXPLAIN check, read transaction), row-capped. | A token leak must not allow writes through the query path | Built |
| S5 | Security headers, CSP with nonce, rate limits, request logging without query strings, no secrets in the repo. | Internet-facing | Built (rate limits hardened in T7) |
| S6 | Claude connects through MCP over HTTPS: the bearer token (Claude Code, CLI-style clients) and OAuth (the claude.ai chat connector). |  | Built (OAuth in T9) |

## 4\. Deployment and operations

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| P1 | Runs locally with `docker compose` (Neo4j) and Node, with no cloud account. One command: `./scripts/local.sh`. | Develop and use offline | Built |
| P2 | Deploys to Google Cloud (Cloud Run for the app, a VM for Neo4j, Secret Manager) and is served at `santidesimone.com/research-hub` through a transparent proxy (`BASE_PATH`). | Owner's domain and cloud | Deployed 2026-10-31 to `research-hub-513302` (Cloud Run, scaled to zero; Neo4j on a free-tier e2-micro with no public IP; budget guard). Serving at `santidesimone.com/research-hub` is still Open (Firebase rewrite needs the service in the Firebase project) |
| P3 | The same code and image run in both modes; only environment variables differ. | Easy move to the cloud | Built |
| P4 | Production refuses to start with a weak token, the default database password, or half-configured Drive. | Fail safe on the internet | Built (plus warnings for weak proxy, password and polite-pool settings in T7) |
| P5 | Nightly Neo4j disk snapshots; CI runs unit and integration tests and builds the image. | Recovery and regression safety | Built (browser and CLI checks added to CI in T6); CI unrun |

## 5\. User interface

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| U1 | A **shell** with an app switcher (Trello-style), sign-in and theme; **apps** are self-contained folders (Home, Library, Query). | Modular, add apps without touching the shell | Built |
| U2 | Look and feel very similar to Claude's UI, and **swappable** via skins (design tokens only). | Familiar and replaceable | Built |
| U3 | Shareable addresses per app and view; usable at phone width. |  | Built (Collections routes and a 390px check in T5) |

## 6\. Quality

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| Q1 | **Fast capture.** One save call; server fills facts and matches vocabulary; Core and Standard by default, Deep only on request; item live immediately. | The owner's main requirement for adding material | Built (T4) |
| Q2 | Performance: indexes and a full-text index, pagination, slim list and graph payloads, ETag/304, gzip, cached public export. | Stay fast as the library grows | Built (cursor pagination for collections in T3) |
| Q3 | Modularity: features are folders that can be removed without breaking the rest; changing a capability should be self-contained. | Easy to change later | Built |
| Q4 | Testability: an offline suite (fake DB, fake Google) that always passes, plus integration tests against a real Neo4j. | Safe to change | Built (plus browser and CLI end-to-end checks in T5, T6) |
| Q5 | Minimal custom building: prefer simple, dependency-light code. | Owner wants to minimise what he maintains | Ongoing |

## 7\. Decided not to do

- No Zotero (or any reference-manager) dependency.
- No files, PDFs or bucket storage in or beside the database.
- No Python in the runtime (only the optional `scripts/seed.py`).
- No approval gate on Claude's saves (audit instead).
- No separate databases per type; one graph.
- No local-folder fallback for uploads; Drive is required for them.
- Deferred, not rejected: Claim nodes (v2), embeddings and semantic search, full-text extraction from PDFs, multi-user access.
- Full ontology querying (a triple store or the Neo4j RDF plugin) is out of scope (addendum).

## 8\. Open items and risks

1. ~~Whether the claude.ai chat connector can use the bearer token~~: it needs OAuth; Task 9.
2. ~~First live test of Google OAuth, Drive upload, public sharing~~: done on the deployed hub (2026-10-31). Still open: the Drive preview embed in the reader. A trashed file stays reachable by its link until the trash is emptied (Drive empties it after 30 days).
3. ~~Crossref and OpenAlex behaviour against real data~~: verified live in Task 4.
4. ~~How santidesimone.com is hosted, and VM or Aura~~: decided, Firebase Hosting and a VM. Still open: whether `TRUST_PROXY=2` matches the deployed proxy chain.
5. Whether the Drive "anyone with the link" files should stay public once the library holds anything sensitive.
6. In-memory rate limiting is per instance; fine for one user, not for a public API.
7. The Ontology `urls` field lost part of its definition in the addendum's Word file. Decided for Task 8: a list of {role, url} with roles docs, spec, download, repository, other; filled by Claude or the owner; tier Core.
