# Progress

Update at the end of every task. For each: what changed, what was tested for real (and how), what was NOT tested.

| Task | Status | Notes |
|---|---|---|
| 0 Baseline against real services | done (2026-10-30) | See "Task 0" below. |
| 1 Schema model v3 | not started | |
| 2 Vocabulary nodes and matcher | not started | |
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
