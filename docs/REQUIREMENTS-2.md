# Requirements: Research Hub

Owner and sole user: Santiago De Simone. Purpose: a personal research hub where papers, methods, use cases and case studies live in a knowledge graph with rich metadata, so connections can be browsed and queried, and Claude can add and analyse material quickly.

Status key: **Built** (in the current code), **Planned** (in `docs/BUILD_BRIEF.md`, with task number), **Open** (undecided or unverified).

## 1\. Functional

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| F1 | Store research items in a graph. Four collections: Papers, Methods, Use cases, Case studies. Notes and Projects stay as related content. | Connections between items are the value; types are independent content, not only paper annotations | Papers, Methods, Notes, Projects built; Use cases and Case studies Planned (T1) |
| F2 | One **Library** app to browse everything, with **Collections** inside it, search, detail view and a graph view. Collections are called "Collections", not "shelves". | One place to browse; Library is one app among several in the shell | Library built; Collections Planned (T5) |
| F3 | Adding a paper: the owner gives Claude a link, DOI or PDF. Claude analyses it and saves the complete result in **one call, with no approval step**. The item is searchable and linked immediately. | Capture must be fast; the owner does not want to produce metadata by hand or approve each item | Planned (T4) |
| F4 | Rich, schema-defined metadata per type (tiers Core/Standard/Deep), improvable without breaking existing data. See `docs/SCHEMA_DESIGN.md`. | The richer the metadata, the more useful the queries | Planned (T1) |
| F5 | Create, edit and delete Methods, Use cases and Case studies in the browser, API, CLI and MCP. | Owner wants to author this content directly | Planned (T3, T5, T6) |
| F6 | Personal layer (reading status etc.) is separate from the items and is a layer on top of the library, not part of its core. | Status is personal opinion, not a property of the paper; the system must work without it | Built |
| F7 | Query the graph over the internet with read-only Cypher: from the browser console, REST, the CLI on the owner's computer, and Claude (MCP). | Ask arbitrary questions of the data from anywhere | Built |
| F8 | Ranked full-text search over titles, abstracts, summaries, authors, venues and note text, plus topics. | Quick retrieval | Built (fixed in T0) |
| F9 | Import and export a reference-manager-compatible format (CSL JSON). **No dependency on Zotero or its API.** | Interoperability without coupling | Built |
| F10 | Markdown notes and projects synced from the owner's computer with `hub sync-notes` (dry run, prune protection). Methods, Use cases and Case studies are managed in the database and are skipped by sync. | Write notes in an editor; keep structured content in the app | Built (notes); skip rule Planned (T3) |
| F11 | Citation links between papers via OpenAlex (`hub enrich`). | Network analysis needs the citation edges | Built |
| F12 | Backup and restore of the whole library (merge by key, never deletes). | Neo4j is the only copy | Built |
| F13 | Audit view: low-confidence fields, empty Core/Standard fields, findings without a location, items on an old schema version. Optional; never blocks use. | Errors by Claude must be findable | Planned (T4, T5) |
| F14 | Reader shows a linked PDF (embedded Drive preview, or a file card for other links). | Read without leaving the app | Built |

## 2\. Data

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| D1 | **Neo4j is the only system of record.** | Single source of truth for items and relationships | Built |
| D2 | **The database stores links, never files.** A paper keeps `file_url` (and `drive_file_id` only when the hub uploaded it). | Keep the graph small and portable | Built |
| D3 | PDFs the hub uploads go to the owner's **own Google Drive**, in one dedicated folder, shared "anyone with the link". Deleting a paper trashes its hub-uploaded file. Drive is required for uploads (no local-folder fallback). The owner accepts that links are public. | Simple private cloud with embeddable links | Built; live test Open |
| D4 | Note text stays in Neo4j (`body`). | Searchable, no redeploy to change notes | Built |
| D5 | `schema/schema.json` is the single source of truth for types, fields, relations and the public whitelist. | UI, API, MCP and migrations stay in step | Built (types); fields Planned (T1) |
| D6 | **Additive schema evolution**: new fields optional, old items stay valid, renames and removals via numbered migrations, per-type `schema_version`. | Improve the schema without breaking anything | Planned (T1) |
| D7 | **Provenance on every field** written by Claude (by, date, model, confidence, status); owner edits are never overwritten. | Trust and auditability without a review gate | Planned (T3, T4) |
| D8 | Shared vocabulary nodes (Topic, Concept, Domain, Person, Venue, Organisation, Dataset); the server matches names to existing nodes. | Connections need shared nodes, not strings | Planned (T2) |
| D9 | Bibliographic facts come from sources (Crossref, OpenAlex), not from Claude. | Accuracy and speed | Planned (T4) |

## 3\. Access and security

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| S1 | One owner credential (`HUB_API_TOKEN`): Bearer token for API, CLI and MCP; signed session cookie for the UI. | Single-user system | Built |
| S2 | Anonymous visitors see only a **public preview**: items marked public, with a whitelist of fields (no statuses, abstracts, file links or note text). | Show some work publicly without leaking private data | Built |
| S3 | All write endpoints require the owner. |  | Built |
| S4 | The Cypher endpoint is read-only, enforced in three layers (text guard, EXPLAIN check, read transaction), row-capped. | A token leak must not allow writes through the query path | Built |
| S5 | Security headers, CSP with nonce, rate limits, request logging without query strings, no secrets in the repo. | Internet-facing | Built |
| S6 | Claude connects through MCP over HTTPS with the bearer token. |  | Built; the claude.ai chat connector's auth type is **Open** |

## 4\. Deployment and operations

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| P1 | Runs locally with `docker compose` (Neo4j) and Node, with no cloud account. One command: `./scripts/local.sh`. | Develop and use offline | Built |
| P2 | Deploys to Google Cloud (Cloud Run for the app, a VM for Neo4j, Secret Manager) and is served at `santidesimone.com/research-hub` through a transparent proxy (`BASE_PATH`). | Owner's domain and cloud | Built; never run live. How santidesimone.com is hosted (for the proxy rule) and VM vs Aura are **Open** |
| P3 | The same code and image run in both modes; only environment variables differ. | Easy move to the cloud | Built |
| P4 | Production refuses to start with a weak token, the default database password, or half-configured Drive. | Fail safe on the internet | Built |
| P5 | Nightly Neo4j disk snapshots; CI runs unit and integration tests and builds the image. | Recovery and regression safety | Built; CI unrun |

## 5\. User interface

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| U1 | A **shell** with an app switcher (Trello-style), sign-in and theme; **apps** are self-contained folders (Home, Library, Query). | Modular, add apps without touching the shell | Built |
| U2 | Look and feel very similar to Claude's UI, and **swappable** via skins (design tokens only). | Familiar and replaceable | Built |
| U3 | Shareable addresses per app and view; usable at phone width. |  | Built; Collections routes Planned (T5) |

## 6\. Quality

| ID | Requirement | Why | Status |
| :---- | :---- | :---- | :---- |
| Q1 | **Fast capture.** One save call; server fills facts and matches vocabulary; Core and Standard by default, Deep only on request; item live immediately. | The owner's main requirement for adding material | Planned (T4) |
| Q2 | Performance: indexes and a full-text index, pagination, slim list and graph payloads, ETag/304, gzip, cached public export. | Stay fast as the library grows | Built; list pagination for new types Planned |
| Q3 | Modularity: features are folders that can be removed without breaking the rest; changing a capability should be self-contained. | Easy to change later | Built |
| Q4 | Testability: an offline suite (fake DB, fake Google) that always passes, plus integration tests against a real Neo4j. | Safe to change | Built (T0 verified integration) |
| Q5 | Minimal custom building: prefer simple, dependency-light code. | Owner wants to minimise what he maintains | Ongoing |

## 7\. Decided not to do

- No Zotero (or any reference-manager) dependency.  
- No files, PDFs or bucket storage in or beside the database.  
- No Python in the runtime (only the optional `scripts/seed.py`).  
- No approval gate on Claude's saves (audit instead).  
- No separate databases per type; one graph.  
- No local-folder fallback for uploads; Drive is required for them.  
- Deferred, not rejected: Claim nodes (v2), embeddings and semantic search, full-text extraction from PDFs, multi-user access.

## 8\. Open items and risks

1. Whether the claude.ai chat connector can use the bearer token (it may need OAuth or an admin-entered header).  
2. First live test of Google OAuth, Drive upload, public sharing and the Drive preview embed.  
3. Crossref and OpenAlex behaviour against real data (needed by the Task 4 save).  
4. How santidesimone.com is hosted (determines the proxy rule), and whether Neo4j runs on a VM or on Aura.  
5. Whether the Drive "anyone with the link" files should stay public once the library holds anything sensitive.  
6. In-memory rate limiting is per instance; fine for one user, not for a public API.
