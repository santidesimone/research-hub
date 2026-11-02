# Research Hub

A self-hosted personal research hub built around a knowledge graph. **Neo4j is the system of record**: paper metadata, note text, relationships and your personal layer. **Files are links** (your Google Drive, arXiv, a publisher); the database never holds a PDF. A small Node.js app gives you a library (master/detail with a PDF reader), a graph view, a read-only Cypher console, and a token-protected API, CLI and MCP server so scripts and AI agents can use it too.

```
  browser (shell + apps) ─┐
  CLI  bin/hub ───────────┼──► web app (Node.js, mounted at BASE_PATH) ──► Neo4j  (metadata, notes, links, personal layer)
  Claude (MCP) ───────────┤                    │
  scripts / curl (REST) ──┘                    └──► your Google Drive (PDFs you upload; optional)
  notes/*.md on your computer ──► hub sync-notes ──► Neo4j
```

Everything runs inside a **shell** (top bar with an app switcher, sign-in, theme). **Apps** are folders (`web/apps/<id>/`): Home, **Library** (papers list, reader and graph view) and **Query** (Cypher console). The look is a **skin** (`web/skins/<name>/`: a file of design tokens). Everything is behind your token: anyone not signed in gets only the sign-in page, on every address. Signed in, you land in the Library (or on the page you asked for). A public preview for visitors exists but is off unless the server runs with `PUBLIC_ACCESS=1`.

**One codebase, two modes.** Locally you run `docker compose up` for Neo4j and `npm start`. On Google Cloud the same image runs on Cloud Run. Only environment variables differ (`_env.example`); `web/core/config.js` reads them in one place and is forgiving locally but strict in production (see "Local and cloud").

**Reference managers.** The hub does the job of a reference manager itself. If you also use a desktop one, `POST /api/import` loads its CSL JSON export and `GET /api/export` produces a CSL JSON file it can import.

## Requirements

Docker (for Neo4j), Node.js 18+. Python 3 only if you want `scripts/seed.py` (`pip install requests`). The page loads two web fonts from Google Fonts; offline it falls back to system fonts. Everything else is bundled.

**Fastest path:** `./scripts/local.sh` does all of the steps below in one go (creates `.env` with a token, starts Neo4j, installs, starts the app, loads the example library and notes).

## Setup (local)

1. **Environment.**
   ```bash
   cp _env.example .env
   openssl rand -hex 32     # paste the result as HUB_API_TOKEN in .env
   ```
2. **Start Neo4j and the app.**
   ```bash
   docker compose up -d
   cd web && npm install && npm start        # keep this running
   ```
3. **In a second terminal, load the example library.**
   ```bash
   pip install requests
   python scripts/seed.py --with-pdfs
   ```
   This adds 12 items (10 papers by Geoffrey Goodell and a 2025 talk by him, plus David Chaum's "Blind Signatures for Untraceable Payments") with a link to each open PDF. Nothing is downloaded. Existing papers are skipped, so re-running is safe. To remove one: `DELETE /api/papers?key=<paper key>`.
4. Open http://localhost:3000. Optionally push the example notes: `./bin/hub config --url http://localhost:3000 --token <token>` then `./bin/hub sync-notes ./content`.

## Local and cloud

| | Local (default) | Production (`NODE_ENV=production`, set by the Dockerfile) |
|---|---|---|
| Startup checks | Problems are warnings | A token under 24 characters, the default database password, or half-configured Drive **stop the server** |
| Listens on | 127.0.0.1:3000 | 0.0.0.0:8080 |
| Logs | Readable text | JSON with `severity` (Cloud Logging) |
| Database | `docker compose` Neo4j | Neo4j on a VM (or AuraDB) via `NEO4J_URI` |
| Secrets | `.env` | Secret Manager |
| PDF uploads | Off until you add the three Google values to `.env` | Same, from secrets |
| Public preview | Computed from the graph, cached 60 s | Same |
| Path | `/` | `BASE_PATH=/research-hub` behind your proxy |

The same features work in both: links, notes sync, search, backup, MCP, CLI. Moving from one to the other means setting variables, not changing code. Move your data with `hub backup` and `hub restore`.

## Using it

Open http://localhost:3000/ : it asks for your `HUB_API_TOKEN` and then opens the Library.

- **Apps menu** (grid icon, top left): Home, Library, Query. Each app has its own address: `/library`, `/library?view=graph&key=<key>`, `/console`. Links are shareable and survive a reload. (With `BASE_PATH=/research-hub` they all live under `/research-hub/...`.)
- **Library, Papers view**: searchable list on the left (title, author, topic, venue; sort and status filter); on the right the paper with two tabs: **Info** (metadata, abstract, topics, DOI link, what cites it, your notes about it, and the **file link**) and **Reader**. A Google Drive link is embedded in the reader; other links open in a new tab, with a "try to show it here" button for sites that allow embedding. In Info you can paste a link, **Upload PDF** (to your Drive) or remove the link. Up/down arrows move through the list. The dropdown next to the title sets **your status** (personal layer).
- **Library, Graph view**: node size follows connections; click a node to highlight its neighbours and see its detail. **Filter** opens a popover of node types grouped like the sidebar (plus Vocabulary), with counts, All / None overall and per group, and a type search; it closes with a tap outside or Esc, and this browser remembers the choice. Concepts, people, organisations and venues start hidden. "Open in library" jumps to the list.
- **Private / Public preview** (owner only): the preview shows exactly what visitors see: nodes marked public, with what **Settings** allows (below).
- **Settings** (owner only; only with `PUBLIC_ACCESS=1`, otherwise it says public access is off): whether new items are public or private by default, and whether visitors see *basic details* (title, authors, year, venue, DOI, link, summary) or *everything* (abstracts, Claude's analysis, note text, open file links such as arXiv). Copies in your Google Drive, Drive file ids, paths on your computer and your reading status are never shown. It also has *Make all public* / *Make all private* for the items you already have. The same switches are `GET`/`PUT /api/settings/publishing` and `POST /api/settings/publishing/apply`.
- **Query app** (owner): read-only Cypher with a results table and example queries.
- **Neo4j Browser** (graph pictures of query results): http://localhost:7474 (login `neo4j` / `hubpassword`).

## Querying the graph from anywhere

One read-only query engine, three ways in (all need the owner token): the **Query app**, **REST**, the **CLI**, and **Claude (MCP)**.

```bash
# REST
curl -X POST http://localhost:3000/api/query -H "Authorization: Bearer $HUB_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"cypher":"MATCH (p:Paper) RETURN p.title, p.year ORDER BY p.year DESC LIMIT 5"}'
curl http://localhost:3000/api/query/schema -H "Authorization: Bearer $HUB_API_TOKEN"   # labels, relationships, conventions, examples

# CLI (Node 18+, no install): bin/hub
./bin/hub config --url http://localhost:3000 --token $HUB_API_TOKEN      # saved to ~/.config/research-hub.json
./bin/hub query "MATCH (a:Person)<-[:AUTHORED_BY]-(p:Paper) RETURN a.name, count(p) AS papers ORDER BY papers DESC"
./bin/hub search blind signatures      # also: schema, get <key>, add, link, pdf, status, sync-notes, enrich, backup (hub help)
```

**Claude (MCP)**: the server exposes `POST <base>/mcp` (Streamable HTTP, bearer token). Tools: `describe_graph`, `run_cypher`, `search_papers`, `get_artifact`, `add_paper`, `add_artifact`, `set_file_link`, `copy_pdf_to_drive`, `remove_file_link`, `set_status`. Plus `request_upload` (Task 9). With Claude Code: `claude mcp add --transport http research-hub http://localhost:3000/mcp --header "Authorization: Bearer $HUB_API_TOKEN"`.

**The claude.ai chat (OAuth).** In claude.ai: *Settings → Connectors → Add custom connector*, URL `https://<your hub>/research-hub/mcp`, no client id or secret. Claude finds the hub's OAuth endpoints, opens the hub's approval page (sign in, or type the owner token, then *Allow*) and connects. Its tokens work for `/mcp` only, expire after an hour and are refreshed (rotated) automatically; `hub oauth` lists connections and `hub oauth revoke <id>` or `revoke-all` stops them at once. Changing `HUB_API_TOKEN` also revokes every connection.
Then drop a paper into the chat: Claude finds the DOI, saves its analysis in one call, and for the file either copies a public PDF (arXiv) into your Drive or, since chat attachments do not reach the hub, replies with an upload link (`…/library/papers?key=…&upload=1`) where you drop the PDF once.

Queries are limited to a single read-only statement without procedure calls, 15 s, 500 rows. This is enforced by a text check, a query-plan check and a read transaction, but Neo4j Community has no read-only user, so treat the token as full access.

Neo4j Browser examples:

```cypher
MATCH (n)-[r]->(m) RETURN n, r, m
MATCH (p:Paper)-[:AUTHORED_BY]->(x:Person) RETURN x.name, count(p) AS papers ORDER BY papers DESC
MATCH (s:Personal {status:'to-read'})-[:FOR]->(p:Paper) RETURN p.title
```

## Adding papers

**Through the API** (scripts, AI agents, you with curl). Send the item in the format below; the hub writes it to Neo4j.

```bash
export HUB_API_TOKEN=...   # same value as on the server

curl -X POST http://localhost:3000/api/papers \
  -H "Authorization: Bearer $HUB_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "itemType": "preprint",
    "title": "Example Paper",
    "creators": ["Ada Lovelace"],
    "date": "2024-05",
    "DOI": "10.48550/arXiv.0000.00000",
    "url": "https://arxiv.org/abs/0000.00000",
    "repository": "arXiv",
    "abstractNote": "...",
    "tags": ["status:to-read", "topic:privacy"],
    "file_url": "https://arxiv.org/pdf/0000.00000"
  }'
# 201 {"paper_key":"doi:10.48550/arxiv.0000.00000","created":true,"file_url":"https://arxiv.org/pdf/0000.00000"}
```

- **DOI only works too**: `{"DOI": "10.1007/978-1-4757-0602-4_18"}` makes the server look up title, authors, venue and date on Crossref (needs outbound internet; untested here).
- Creators and tags may be plain strings. Tag conventions: `topic:<name>` (matched by name to a Topic, the vocabulary of the `topics` field, so "zk-proofs" and "ZK proof" land on the same one), `public` or `private`, and `status:<value>` (which is handed to the personal layer, see below; it is not stored on the paper). Papers imported before 2026-11-02 may have their tags as Concept nodes; the hub reads both, and curation can merge a Concept into its Topic.
- Paper identity (`paper_key`) is `doi:<lowercase doi>`, or `paper:<hash of title+year>` without a DOI. `409` if it already exists; add `?overwrite=true` to replace its metadata.
- **Import / export**: `POST /api/import` takes a CSL JSON array; `GET /api/export` returns the library as CSL JSON.
- Machine-readable spec: **`/openapi.json`**. The MCP server (`/mcp`) is the better way to give Claude these abilities; for other tool-using models expose `add_paper` and forward its input as the body of `POST /api/papers`.

**Security.** `HUB_API_TOKEN` is the one credential. Without it nothing private works. With it you can sign in to the UI (a signed, HttpOnly session cookie named `__session`), call the API or MCP (`Authorization: Bearer ...`), and use the CLI. Anonymous requests only get the public preview. Use a long random token (`openssl rand -hex 32`); production refuses to start with a short one. Details and the deploy steps: **deploy/README.md**.

## Files are links

The hub stores a `file_url` on the paper and nothing else. Where the PDF lives is up to you.

- **A link you already have**: `hub add <doi> --file <url>`, `hub link <key> <url>`, the field in the Library, or `file_url` in `POST /api/papers`. Any https URL is accepted; Google Drive share links in any form are normalised to one canonical `.../file/d/<id>/view` so the Reader can embed them. Nothing is downloaded.
- **Upload a PDF to your Google Drive**: `hub pdf <key> ./paper.pdf` (or the "Upload PDF" button, or `POST /api/papers/file?key=` with the PDF as the body). The hub sends it to a folder called "Research Hub PDFs" in your Drive, makes that file readable by anyone with the link, and stores the link plus `drive_file_id`. This needs Drive set up once (below). Limit 30 MB (`MAX_UPLOAD_MB`).
- **Copy a PDF from a URL into Drive**: `hub add <doi> --file https://arxiv.org/pdf/... --copy`, `hub pdf <key> https://arxiv.org/pdf/...`, or Claude's `copy_pdf_to_drive`. The server downloads it from an allow-listed host (`PDF_FETCH_ALLOWED_HOSTS`: arXiv and UCL Discovery by default) and uploads it. If that fails the original link is kept and the response says why.
- **Keep a frozen copy of an ontology or standard**: `hub ontology snapshot <key> ./fibo.ttl` (or a URL, or the Snapshot panel on the ontology's page). Allowed types: pdf, owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip, txt; same `MAX_UPLOAD_MB` limit (larger resources stay link-only). The record keeps the Drive link, retrieval date, version, sha256, size and type; a new snapshot trashes the previous one, and so does deleting the ontology. The copy is shared by link, so check the resource's license first. URLs are downloaded only from `PDF_FETCH_ALLOWED_HOSTS` plus `SNAPSHOT_FETCH_ALLOWED_HOSTS`.
- **Housekeeping**: a Drive file the hub uploaded is moved to the Drive trash when you replace it, remove the link, or delete the paper. A link the hub did not upload is never touched.
- **Public links**: anyone who has a file's URL can open it, even if the paper is private in the hub. That is the trade-off of "uploaded to my Drive but made public".
- **Large PDFs cannot travel through the Claude chat window**, because a file would have to be written out inside the conversation. Give Claude a URL, or upload with `hub pdf` from your computer.

**Setting up Drive uploads (optional, once).** A service account cannot do this (it has no Drive storage), so the hub uses your own Google login with the narrow `drive.file` scope (it can only see files it created). Create an OAuth client of type "Desktop app" in a Google Cloud project, publish the consent screen "In production" (a "Testing" app expires its token after 7 days), then run:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node bin/drive-auth     # prints GOOGLE_REFRESH_TOKEN
```

Put the three values in `.env`, restart, and run `./bin/hub drive` to check. Full steps, including Secret Manager for Cloud Run: **deploy/README.md**, step 3. Without these values the hub still stores links.

Papers that an earlier version stored in a bucket keep their old reference as `legacy_pdf_uri` (migration `003`; nothing is deleted); the UI shows a hint to re-upload them.

## Markdown notes and projects

Keep one file per note or project on your computer, ideally in a git repo (this project's `content/` folder is an example): `notes/`, `projects/`. Push them to the hub:

```bash
./bin/hub sync-notes ./content --dry-run     # what would be created / updated / removed
./bin/hub sync-notes ./content               # one atomic batch; files you deleted are removed from the graph
```

**Methods, use cases and case studies are database-managed** (schema v3): create and edit them in the Library, the API (`POST /api/artifacts/<type>`), MCP or the CLI. `sync-notes` skips files in `methods/` (or with `kind: method`) with a message and never prunes a database-managed item. Methods that came from Markdown were moved into the database by migration `005` (they keep `source_path` and get `imported_from: markdown`), so the files in `content/methods/` are now only a historical copy.

The node key is `<kind>:<filename>`. The file's text is stored on the node as `body`, so notes need no redeploy and are searchable. Front matter:

```yaml
---
title: Critique of X
visibility: private          # or public
summary: One line.
critiques: ["doi:10.1109/cvpr.2016.90"]
uses: ["method:snowballing"]
concepts: ["evaluation"]
---
```

Relationship fields: `about uses extends supports contradicts critiques annotates inspired builds_on replicates introduces addresses instance_of variant_of alternative_to requires`. Papers are `doi:` plus the lowercase DOI (or the `paper:<hash>` key returned when you added them). **Quote values containing a colon.** Unknown targets are reported in `warnings` and skipped. A `status:` line is ignored (status is personal; set it with `hub status`). `sync-notes` refuses to prune when no usable file is found, so an empty or wrong folder cannot wipe your notes. `--no-prune` only adds and updates.

Any type can also be created without files: `POST /api/artifacts/<type>` or Claude's `add_artifact`. Input is checked against the type's fields in `schema/schema.json`: a missing title is a 400; empty Core fields, values outside an enum, bad numbers, dates, lists or objects come back as `warnings` (the value is stored as sent); fields the schema does not know are kept.

```bash
curl -X POST http://localhost:3000/api/artifacts/method \
  -H "Authorization: Bearer $HUB_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Citation chaining","level":"technique","domain":"research","summary":"Follow references and citations.",
       "body":"# Citation chaining\n\n1. Pick seeds ...","uses":[],"concepts":["literature review"],"visibility":"public"}'
# 201 {"key":"method:citation-chaining","created":true,"warnings":["tldr is empty (Core field)", ...]}

curl -X POST http://localhost:3000/api/artifacts/case_study -H "Authorization: Bearer $HUB_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Lisbon CBDC pilot","case_type":"pilot","sources":[{"url":"https://example.org/report","note":"final report"}]}'
# 201 {"key":"case:lisbon-cbdc-pilot", ...}   use cases get usecase:<slug> keys
```

**Citations.** `./bin/hub enrich` adds `(:Paper)-[:CITES]->(:Paper)` edges between papers in your library using OpenAlex (set `OPENALEX_EMAIL` for the polite pool).

## Search

`search_papers` (MCP) and the API use a Neo4j full-text index (`artifact_text`, created by migration `004`) over title, TL;DR, abstract, summary, authors, venue and note text of every type (rebuilt by migration `005`), ranked, with topic matches added. If the index is missing it falls back to a plain scan.

## The Library

Open `/library`. The **sidebar** groups the collections by purpose, as the schema's `ui_sections` say: **Reading** (Papers), **Knowledge** (Methods, Use cases, Case studies, Frameworks, Ontologies and standards) and **Inquiry** (Research questions, Hypotheses), each with a count. Below them are Graph and, when you are signed in, **Review** with the number of things waiting. **Search everything** at the top searches every collection. The « button hides the sidebar to a thin rail (remembered in this browser); on a phone it is a drawer behind ☰ that closes with a tap outside. A new type appears in its group once it names a `ui_section`. Addresses are shareable: `/library/methods?key=method:snowballing`, `/library/case-studies?key=...&edit=1`, `/library/audit`; older `/library?key=...` links still open the item.

- **Papers:**
  - The list, PDF reader, file link, upload and your status are unchanged.
  - The **Analysis** tab shows every schema field grouped as in the schema, with a tier badge and who wrote it: Claude, source or you (hover for model, confidence and date).
  - It also shows low-confidence values, ungrounded findings, empty fields and links with their evidence.
- **Methods, use cases, case studies:**
  - The list shows the schema's columns and filters (vocabulary filters by name), with sort, search and "load more".
  - The detail shows grouped fields and links in both directions, and lets you add or remove typed links (evidence, location, confidence).
- **Forms:**
  - **+ New** and **Edit** use forms generated from the schema: text, numbers, enums, list editors, structured editors (outcomes, actors, key findings ...), vocabulary pickers with type-ahead (a new name is matched or created server-side), and item pickers for links.
  - An edit sends only the fields you changed, and those become yours (`by: owner`, reviewed).
  - A paper's DOI, authors and venue come from the source and are read-only.
- **Review** (`/library/review`) has two tabs. **Check Claude's work** (the audit): Claude's low-confidence values and links, ungrounded findings, new vocabulary, older schema versions, empty fields and unreviewed items, with one-click **Accept** and **Edit** (opens the form at that field). **Proposed fixes** (`?tab=fixes`): curation plans (below). The old `/library/audit` and `/library/curation` addresses open these tabs.
- **Anonymous visitors** get only the sign-in page. With `PUBLIC_ACCESS=1` they see the public preview instead: public items, with basic details or every field as Settings says, and no forms or audit.

**Frameworks, research questions, hypotheses, ontologies** (`docs/ADDENDUM_frameworks_questions_ontologies.md`):
- A paper, question, project or case study is `FRAMED_BY` a framework, and a framework's page lists everything framed by it.
- A hypothesis is `DERIVED_FROM` a framework and `ANSWERS` a question. Papers test it (`TESTS`, with a result: supported, refuted, mixed or inconclusive).
- **Hypothesis status is derived from all the tests:** one paper supporting and one refuting give "mixed". If you set the status yourself, that stands until you clear it.
- Questions and hypotheses take their title from their text when none is given.
- An ontology or standard is a descriptive record: name, acronym, IRI, https links (stored, never fetched), publisher, version and licence. It can be `PART_OF` another (a FIBO module) and `USED_BY` use cases, case studies, papers and projects. Its classes and terms are never imported.
- A concept can point at a term in an ontology: `hub vocab iri concept:x <iri> --ontology ontology:y`.

An item counts as "not reviewed" only while it holds Claude values nobody has accepted. Your own values and source facts (Crossref, OpenAlex) need no review.

Browser checks for all of this (Playwright against a real hub; not part of `npm test`) are in `web/test/browser/`.

## Collections API (`/api/items`)

Papers, methods, use cases and case studies, driven by the fields in `schema/schema.json`. Owner only; keys are URL-encoded (`encodeURIComponent`), because DOI keys contain `/`.

```bash
H="Authorization: Bearer $HUB_API_TOKEN"
curl -H "$H" "http://127.0.0.1:3000/api/items?collection=method&kind=technique,tool&domain=payments&q=sampling&sort=title&limit=20"
curl -H "$H" -H "Content-Type: application/json" -X POST http://127.0.0.1:3000/api/items \
  -d '{"collection":"use_case","fields":{"title":"Offline payments","status":"idea","domain":["payments"],"actors":[{"role":"payer"}]}}'
curl -H "$H" "http://127.0.0.1:3000/api/items/usecase%3Aoffline-payments"          # fields, provenance, links in and out
curl -H "$H" -H "Content-Type: application/json" -X PATCH http://127.0.0.1:3000/api/items/usecase%3Aoffline-payments -d '{"fields":{"goal":"Pay with no network"}}'
curl -H "$H" -H "Content-Type: application/json" -X PUT http://127.0.0.1:3000/api/items/method%3Asnowballing/links \
  -d '{"rel":"ADDRESSES","target":"usecase:offline-payments","evidence":"section 2","location":"p. 3","confidence":"medium"}'
```

- **List:**
  - Filters are the collection's `filters` in the schema; comma means OR.
  - Link filters take vocabulary names or keys.
  - `q` is full-text, and `sort` is `title`, `created_at`, `updated_at` or a scalar list column (prefix `-` to reverse).
  - Pages hold up to 100 items; follow `next_cursor`.
- **Storage:** scalars and lists are node properties; objects go in `<field>_json`. Link fields are edges: names go through the vocabulary matcher (below), and other items are referenced by key. Each field's provenance is stored in `provenance_json`.
- **Owner edits win:**
  - POST and PATCH mark each field `by: owner, status: reviewed`.
  - Other writers (Claude's analysis, source lookups) only fill empty fields of their kind.
  - They never touch an owner or reviewed value; `force` replaces only values that writer wrote itself.
  - Clearing a field with PATCH keeps it the owner's, so Claude does not refill it.
- **Papers:** POST through `/api/items` uses the paper writer (DOI lookup, authors, `file_url`). PATCH cannot change a paper's `doi`, `authors` or `venue`. `/api/papers`, `/api/artifacts`, import and export are unchanged.
- Your reading status is not an item field; set it with `/api/personal`.

## Claude's analysis and the audit

Claude analyses a paper, method, use case or case study and saves the whole result in **one call, with no approval step** (MCP `save_analysis`, or `POST /api/analysis`). In Claude: call `get_schema` for the collection, then `save_analysis` once.

```bash
curl -H "$H" -H "Content-Type: application/json" -X POST http://127.0.0.1:3000/api/analysis -d '{
  "collection": "paper", "doi": "10.3390/fi13050130", "model": "claude-opus-5-5",
  "fields": { "contribution_type": "methodological", "research_problem": "...",
              "key_findings": [{ "text": "...", "location": "s. 4" }], "evidence": { "type": "design", "n": 1 } },
  "confidence": { "research_problem": "high" },
  "links": [{ "rel": "ABOUT", "target": "digital currency", "kind": "Domain" },
            { "rel": "BUILDS_ON", "target": "doi:10.1007/978-1-4757-0602-4_18", "evidence": "\"we extend Chaum's scheme\"", "location": "s. 2" }] }'
# 201 {key, url, created, filled, skipped, links, links_skipped, empty_core_standard, warnings, flagged}
```

- **Identifying the item:** use `key`, or a paper's `doi` or `url`, or a new item's `fields.title`. An existing item is re-analysed: only its empty fields are filled.
- **Papers:**
  - Source facts come from Crossref and OpenAlex, server-side: title, authors (Person nodes), year, venue (a Venue node), abstract, citation count, open access, language.
  - Claude cannot write them; the schema's `by` decides who may fill what.
  - Set `OPENALEX_EMAIL` to use the polite pools.
- **Claude's fields** record `by: claude`, the model and a confidence (default medium). They never overwrite your edits or reviewed values; `force` replaces only Claude's own.
- **Empty beats wrong:**
  - Vocabulary names are matched (or created, flagged `by: claude`).
  - Other items are linked only by key or exact title, never created from a name.
  - Interpretive links (builds_on, critiques, contradicts, supports, replicates) need the justifying passage as `evidence`.
- **Every finding needs a location.** Findings without one are saved but come back in `flagged` and appear in the audit.
- **What a paper contains** goes in `extract`:
  - the frameworks it uses;
  - the research questions it states;
  - the hypotheses it tests, each with its result, the passage and a location.

  Each is matched to an existing item by its exact title, or created (questions and hypotheses get `origin: extracted`), then linked (`FRAMED_BY`, `ASKED_IN`, `TESTS`). A tested hypothesis without a result or a passage is not created.
- **The audit** (`GET /api/audit`): counts and lists of low-confidence fields and links, empty Core and Standard fields, ungrounded findings, items below their type's `schema_version`, vocabulary Claude created, and unreviewed items. `POST /api/audit/accept` (`{key, fields?, links?}` or `{vocab}`) marks values reviewed, which protects them from re-runs like your own edits.
- **Single-object fields** (`evidence`, `period`, `threats_to_validity` ...) also keep each part as a plain property for Cypher: `MATCH (p:Paper) WHERE p.evidence__n > 100`.

## Curation: fixing the graph with Claude

Analysis fills fields and adds links; curation fixes what is already there. In the claude.ai chat, ask Claude to check the graph (it reads it with `describe_graph`, `get_schema` and read-only `run_cypher`), then to propose fixes:

> Assess the quality of my research hub: duplicate concepts, authors and venues; items missing core fields; links that don't fit the schema; nodes with no links; unreviewed or low-confidence Claude fields. Then propose fixes for the duplicates and wrong links.

Claude never edits directly. It calls `propose_changes` with a **plan**, a list of operations, and shows it to you:
- `merge {keep, drop, take?}`: two items or two vocabulary nodes of the same kind, or two vocabulary nodes of different kinds (a Concept into a Topic) when the schema allows every link that moves; the dropped kind's own fields are listed, not carried over. Links, empty fields (with their provenance), the file link and your status move to `keep`; conflicting fields keep `keep`'s value unless listed in `take`; vocabulary keeps `drop`'s name as an alias, so the matcher does not create the duplicate again; `drop` is deleted.
- `unlink {from, rel, to}`, `delete {key}` (with the concepts and people only it used), `rename {key, name}` (vocabulary; the old name stays an alias).

Nothing changes until the plan is applied: by Claude (`apply_plan`) after you say yes, or by you in the Library's **Review › Proposed fixes** tab, which lists plans with every change, field conflict and Drive file affected (Apply, Reject, Undo). A plan applies in one transaction and is refused if the data changed since it was proposed. **Undo** (`revert_plan`) puts everything back exactly, including the Drive files it trashed, and is refused if something changed it again since. The plans are the curation log; they are not part of backups. REST: `/api/curation/plans` (owner).

## Command line (`bin/hub`)

Node 18+, nothing to install. `hub config --url <base url> --token <token>` saves the connection, or set `HUB_URL` and `HUB_API_TOKEN`. `hub help` prints this list.

| Command | What it does |
|---|---|
| `hub query "<cypher>"` (or `-f file.cypher`), `--json` / `--csv` | read-only Cypher |
| `hub schema [collection]` | the graph's labels and relations; with a collection, its fields (type, tier, who fills it, values) |
| `hub search <text>` | find papers by title, author or venue |
| `hub get <key>` | one node with its links |
| `hub add <doi \| file.json \| ->` `[--file <url>] [--copy] [--status s]` | add a paper (a DOI alone is looked up) |
| `hub link <key> <url>`, `hub unlink <key>`, `hub pdf <key> <file.pdf \| url>` | a paper's file link; `pdf` uploads to your Drive |
| `hub status <key> <value\|none>` | your personal reading status |
| `hub drive` | check the Google Drive connection |
| `hub item list <collection>` `[--q text] [--sort f\|-f] [--limit n] [--all] [--<filter> value]` | list papers, methods, use cases or case studies, filtered by the schema's filters (`--kind technique`, `--domain payments`); `--json`, `--csv` |
| `hub item get <key>` | every field, with who wrote it (you, Claude, source), and links |
| `hub item add <collection> [file.json \| -]` `[--set f=v] [--slug s]` | create an item from a JSON object of fields |
| `hub item edit <key> [file.json \| -]` `[--set field=value ...]` | change only these fields (they become yours); values are JSON when they parse (`--set year=2024`, `--set 'tags=["a"]'`), text otherwise |
| `hub item rm <key> --yes` | delete (refuses without `--yes`) |
| `hub item link <key> <rel> <target>` `[--evidence t] [--location p] [--confidence c] [--result r]`, `hub item unlink <key> <rel> <target>` | typed links; `TESTS` (paper to hypothesis) needs `--result supported\|refuted\|mixed\|inconclusive` |
| `hub vocab iri <concept> <iri \| none>` `[--ontology <key \| none>]` | point a concept at a term in an ontology (`external_iri` and `DEFINED_IN`); nothing is imported |
| `hub oauth [list \| revoke <id> \| revoke-all]` | MCP clients connected with OAuth (the claude.ai chat connector): list them, or revoke one or all; their tokens stop working at once |
| `hub ontology snapshot <key> <file \| https-url \| none>` | a frozen copy of an ontology in your Drive (owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip, txt, pdf; at most `MAX_UPLOAD_MB`), recorded with its sha256, size and retrieval date; replaces and trashes the previous one. URLs only from `PDF_FETCH_ALLOWED_HOSTS` or `SNAPSHOT_FETCH_ALLOWED_HOSTS`. Check the license first: the copy is shared by link |
| `hub analyze <doi \| url \| key \| file.pdf>` `[--deep] [--force] [--model m] [--collection c] < analysis.json` | save an analysis in one call (stdin: `{fields, links, confidence}`; the model from `--model`, the JSON or `HUB_MODEL`). For a PDF, the JSON names the paper (`doi` or `url`) and the file is uploaded to your Drive |
| `hub audit [--json]` | what is worth reviewing, with counts |
| `hub audit --accept-all-unchanged [--dry-run]` | accept every Claude value nobody changed, except low-confidence values and ungrounded findings (listed as skipped) |
| `hub sync-notes [dir] [--dry-run] [--no-prune]` | push Markdown notes and projects |
| `hub enrich` | citation edges from OpenAlex |
| `hub backup [file]`, `hub restore <file>` | the whole graph to and from one JSON file |
| `hub export`, `hub sync` | papers as CSL JSON; rebuild the public preview |
| `hub config --url u --token t` | save the connection |

```bash
echo '{"fields": {"contribution_type": "empirical", "key_findings": [{"text": "...", "location": "p. 4"}]}}' \
  | ./bin/hub analyze 10.3390/fi13050130 --model claude-opus-5-5
./bin/hub item list method --kind technique --sort title
./bin/hub item edit method:snowballing --set level=intermediate
./bin/hub audit --accept-all-unchanged --dry-run
```

## Vocabulary and name matching

People, concepts, topics, domains, venues, organisations and datasets are shared nodes, not strings. Callers pass names; `web/core/vocab.js` `resolve(kind, name, { create, aliases, by, model })` finds the node that name means or creates one (flagged `by: claude` by default) and returns `{ key, name, created, match }`. A match is one of:

- **exact**: same normalised form as the node's name or an alias. Case, punctuation, accents and (for topics, concepts and domains) plurals are ignored, and `Lovelace, Ada` reads as `Ada Lovelace`.
- **acronym**: upper-case acronyms line up letter by letter, so `ZKP`, `ZK proofs` and `zero-knowledge proofs` are one node. A match needs a shared ordinary word or at least three letters, so `AI` alone matches nothing.
- **typo**: one edit in one word of 8+ letters.

Different word order, partial overlaps and short-word typos never match: an empty match beats a wrong one. A non-exact match records the spelling as an alias. Creating a node takes a short per-type lock (`(:VocabLock {label})`), so parallel calls with different spellings still create one node. Lookups use indexes on the derived `norm` and `letters` fields and the `vocab_text` full-text index (migration `006`, which also backfilled existing nodes). How each type is normalised is its `match` entry in `schema/schema.json`.

## Backup and restore

Neo4j is the only copy of your library, so back it up:

```bash
./bin/hub backup                  # research-hub-backup-<date>.json: every artifact, link and vocabulary node (people, concepts, topics, domains ...), your personal layer
./bin/hub restore backup.json     # merges by key, in batches; never deletes; safe to run twice
```

On Google Cloud, `deploy/neo4j-vm.sh` also schedules nightly disk snapshots. The files themselves are not part of the backup, only their links.

## How it is organised (and how to change it)

```
schema/schema.json        the graph model: types and their fields, vocabulary, relations, public fields (history: schema/CHANGELOG.md)
bin/hub                   command-line client;  bin/drive-auth  one-time Google login for Drive uploads
web/server.js             config check, middleware, mounts everything under BASE_PATH, loads web/features/*, runs graph migrations
web/core/                 config, log, security headers, rate limit, db, schema, auth, links, drive, generic artifact writer,
                          type registry, notes (Markdown -> graph), openalex, backup, public export, read-only query engine, migrations runner
web/features/             API pieces, one folder each:
    papers/ (everything about papers and their files)  personal/ (your status layer)  artifacts/ (generic API for every type)
    graph/ (read side)  query/ (read-only Cypher)  mcp/ (Claude)  session/ (sign-in)  apps/ (app list)
    notes/ (sync-notes)  enrich/ (OpenAlex)  backup/  drive/  sync/
web/public/index.html     the page template; web/public/shell/  the shell (routing, top bar, sign-in) + base.css (structure) + ui.js
web/apps/<id>/            one folder per app: app.json + app.js (home, library, console)
web/skins/<name>/         one folder per look: skin.json + skin.css (design tokens only)
web/migrations/           numbered graph migrations (NNN_name.js); features may carry their own in features/<dir>/migrations/
web/test/                 run.js (offline, no database) and integration.js (needs a throwaway Neo4j; CI runs it)
```

- **Add an app**: create `web/apps/<id>/app.json` (`{id,title,description,icon,auth:"public"|"owner",order}`) and `app.js` (`export default { mount(ctx) {...}, onRoute?(ctx) }`). It appears in the apps menu and is served at `/<id>`. It gets `ctx.el`, `ctx.api`, `ctx.navigate`, `ctx.route` (path, query) and shared helpers; it uses only CSS classes from `base.css` and colours from tokens, so it follows whatever skin is active.
- **Change the look**: copy `web/skins/paper` to `web/skins/mine`, edit the tokens, run with `HUB_SKIN=mine` (or try one live with `?skin=slate` in the URL). A skin that loads fonts from another host lists it in `skin.json` under `"csp": {"style": [...], "font": [...]}`. A test checks that every skin defines every token the app uses.
- **Change how papers work**: edit only `web/features/papers/`. Remove the folder and papers disappear from the API; nothing else breaks.
- **Add a new artifact type** (say `dataset`): add it to `schema/schema.json` (label, colour, `managed` (`db`, `markdown` with a `folder`, or `api`), `schema_version`, optional `key_prefix`, legacy `props`, and for a Library collection `"collection": true` with `fields` and layout hints). That alone gives you `POST /api/artifacts/dataset` with validation (and `hub sync-notes` support if it is Markdown-managed), and the UI legend and colour. Only write `web/features/<name>/type.js` if the type needs special input handling (like papers do). The schema is checked at start-up: an unknown field type, a `ref` to a label that does not exist or a type `public_props` entry outside the global whitelist stops the server. Record the change in `schema/CHANGELOG.md`; raise the type's `schema_version` when its fields change.
- **Add a relationship type**: add it to `relation_types` (with its endpoints) in `schema/schema.json`; add it to `relations` as well if it should be a front-matter and API field.
- **Change stored data (a migration)**: add `web/migrations/00N_what_it_does.js` exporting `{ id, description, async up(db) }` where `db.run(cypher, params)` writes. On the next start it runs once, and its id is recorded on a `(:SchemaMeta {id:'graph'})` node. Write migrations so they are safe to run twice. `002` to `005` are real examples. `GET /api/schema` lists what has been applied.
- **Tests**: `cd web && npm test` (offline: parsing, the Cypher issued, Drive calls against a fake Google, notes sync, backup, public whitelist, config checks, security policy). `npm run test:integration` runs against a real Neo4j and refuses to start unless `HUB_INTEGRATION=1` (it prunes and restores data, so use a throwaway database).

## The personal layer (status)

A paper's **metadata** (title, authors, DOI, venue, abstract, file link) is a fact about the paper. Your **status** (`to-read`, `reading`, `read`, `canonical`, `critique-target`, or anything you invent) is an opinion about your own workflow. They are stored apart:

- Status lives on a separate `(:Personal {key:'personal:<artifact key>', status})-[:FOR]->(:Artifact)` node, never on the paper.
- The public export, the graph view and the artifact API only read `Artifact`, `Person` and `Concept` nodes, so personal data cannot reach them. That is true by construction, not because a field list happens to exclude it.
- The core code never imports `web/features/personal/`. Delete that folder and the hub works as before; the badges and status filter just disappear from the UI.
- This is separate from public/private: `visibility` decides what visitors of your site may see; the personal layer is data that is never shown to them at all.

API (writes need the token):

```bash
curl http://localhost:3000/api/personal                         # all states: {"items": {"doi:...": {"status": "read"}}}  (also your backup of this layer)
curl -X PUT "http://localhost:3000/api/personal?key=doi:10.1007/978-1-4757-0602-4_18" \
  -H "Authorization: Bearer $HUB_API_TOKEN" -H "Content-Type: application/json" -d '{"status":"read"}'
curl -X DELETE "http://localhost:3000/api/personal?key=..." -H "Authorization: Bearer $HUB_API_TOKEN"   # clear
```

New papers start as `to-read` unless a `status:` tag or `status` field is sent with them (that policy is a constant in `features/personal/index.js`). A `status:` line in a Markdown file's front matter is ignored by `sync-notes`; set it through this API. When you are signed in, the dropdown beside a paper's title in the Library sets it (that is the only place the UI writes).

To keep more private things per artifact (a rating, a private comment), add the field name to `FIELDS` in that file.

## Deploying to Google Cloud

See **deploy/README.md**: Cloud Run for the app, a small VM for Neo4j (with nightly snapshots), optional Google Drive uploads, secrets, and the proxy rule that serves it at `santidesimone.com/research-hub`. `Dockerfile`, `deploy/deploy.sh`, `deploy/neo4j-vm.sh`, `deploy/cloudbuild.yaml` and `.github/workflows/ci.yml` are included.

## About the example data

DOIs, authors, venues and arXiv IDs were checked against arXiv, publisher and UCL pages. Dates for arXiv-only items are the month or version date shown there. The `abstractNote` fields are **my short paraphrases, labelled as such**, not the original abstracts. The statuses and topic tags (and which items are `public`) are placeholders; change them by re-posting with `?overwrite=true`. One item, "Protocol-Embedded Compliance…", lists Santiago De Simone as first author, taken from its arXiv page.

## Known limits

- Notes and projects are edited as Markdown files (`hub sync-notes`), not in the Library; papers, methods, use cases and case studies are edited in the Library, the API, the CLI or through Claude.
- The chat-window connector needs OAuth or an admin-entered header depending on your plan; the MCP server only accepts the bearer token.
- Public Drive links are readable by anyone who has the URL, by your choice. Sites other than Google Drive may refuse to be embedded in the Reader; they open in a new tab.
- Rate limiting is per instance, in memory. That is enough for one person, not for a public API.
- Paper authors and venue come from the source (Crossref, OpenAlex) and cannot be edited through `/api/items`; a paper known only by URL keeps `doi` and `arxiv_id` empty.
- **What has been run, and what has not** (details per task in `docs/PROGRESS.md`):
  - **Run against real services:** Neo4j 5 (all migrations, the full-text indexes, notes sync, backup and restore, and the integration suite), live Crossref and OpenAlex, the Docker image build, and the Library in Chrome (Playwright: owner, anonymous visitor, mobile width).
  - **Not run:** Google OAuth and Drive uploads and sharing, Cloud Run and the proxy rule, and the GitHub Actions workflow itself.

## Layout

```
docker-compose.yml      Neo4j 5 Community (local development)
Dockerfile, deploy/     container, deploy scripts, deployment guide
.github/workflows/      CI: offline tests + integration tests against Neo4j + image build
_env.example            all settings
schema/ scripts/ data/ content/ bin/ web/    see "How it is organised"
```
