# CLAUDE.md: Research Hub

Personal research hub: a Neo4j knowledge graph of papers, methods, use cases and case studies, with a web UI (Library app), REST API, CLI (`bin/hub`) and an MCP server for Claude. Node.js only at runtime (Express, `neo4j-driver`, plain JS, CommonJS). Python is used only by the optional `scripts/seed.py`. Owner: Santiago De Simone (codes Python, Node.js, Rust).

## Read first
- `docs/SCHEMA_DESIGN.md`: the approved metadata model. This is the spec.
- `docs/BUILD_BRIEF.md`: ordered tasks with acceptance criteria. Work through them in order; one task per commit/PR.
- `docs/ADDENDUM_frameworks_questions_ontologies.md`: Frameworks, Research questions and Hypotheses, Ontologies (Tasks 8 and 8b; requirements in `docs/REQUIREMENTS.md`). Self-contained; the Word file of the same name is its original.
- `README.md`: how the project is organised today, and `deploy/README.md` for Google Cloud.

## Run it
```bash
./scripts/local.sh            # one command: .env, Neo4j (Docker), npm install, app on http://127.0.0.1:3000, example data
./scripts/local.sh stop|logs
cd web && npm test            # offline unit tests, no database needed (must always pass)
HUB_INTEGRATION=1 NEO4J_URI=bolt://127.0.0.1:7687 NEO4J_PASSWORD=... npm run test:integration   # needs a THROWAWAY Neo4j
```
Use `127.0.0.1`, not `localhost` (Node resolves localhost to ::1 first and the server listens on IPv4).

## Architecture rules (do not break)
1. **Neo4j is the only system of record. Files are links.** Never store PDFs or file bytes in the database. PDFs live in the owner's Google Drive; the paper keeps `file_url` (and `drive_file_id` only if the hub uploaded it).
2. `schema/schema.json` is the single source of truth for types, fields, relations and `public_props`. UI, API validation, MCP tool descriptions and migrations read it. Do not hard-code type lists elsewhere.
3. **Cypher safety.** Labels and relationship types only through `safeLabel` / `safeRel` allow-lists in `web/core/schema.js`. Never interpolate user input into Cypher; use parameters. The `/api/query` endpoint is read-only (text guard + EXPLAIN check + `executeRead`); keep it that way.
4. **Feature folders** under `web/features/*` are auto-mounted by `web/server.js` (an `index.js` exporting a `mount`/register function; follow an existing one such as `web/features/papers`). Cross-feature communication goes through the hooks bus (`web/core/hooks.js`: `afterWrite`, `beforeRemove`, `afterRemove`). A failing hook is logged, never fatal.
5. **Migrations** are numbered files in `web/migrations/` (`NNN_name.js`, `{id, description, async up(db)}`), idempotent, recorded on `(:SchemaMeta {id:'graph'})`. Schema changes are **additive**: new fields optional, nothing destructive without a migration that copies data first.
6. **Auth.** One owner token `HUB_API_TOKEN` (Bearer, or the HMAC `__session` cookie plus `X-Hub: 1`). Without `PUBLIC_ACCESS=1` (the default) anonymous users get nothing but the sign-in page, and every data endpoint, `/api/public` included, needs the token. With it, they see the public preview: items with `visibility: public` (never case studies marked `confidential`), shown either with the `public_props` whitelist or with every field, as the owner chooses in Settings (`web/core/publishing.js`). Even in full mode, `publishing.HIDDEN` (Drive file ids, local paths), links into the owner's Drive and the personal layer (reading status, priority) are never public; keep it that way. New write endpoints require the owner.
7. **Security headers and CSP** are set in `web/core/security.js` and `web/core/shell.js` (per-request nonce). No inline scripts without the nonce; no inline event handlers; render untrusted text with the existing escaping helpers in the UI (`web/public/shell/ui.js`).
8. **Config** is read in one place, `web/core/config.js`. Local mode warns; `NODE_ENV=production` fails fast on weak settings. Add new settings there and to `_env.example`.
9. **Provenance.** Every field written by Claude records `by`, `at`, `model`, `confidence`, `status` (see the design doc). Owner edits are never overwritten by re-runs.
10. The UI follows the shell/app/skin split: apps in `web/apps/<id>/`, structural CSS in `web/public/shell/base.css`, colours only from skin tokens (`web/skins/*/skin.css`). No framework or build step; keep it dependency-free.

## Working with Claude Code
- Slash commands in `.claude/commands/`: `/verify` (full offline check plus boot), `/next` (start the next task in `docs/BUILD_BRIEF.md`), `/status` (what is done, tested, untested).
- Progress is tracked in `docs/PROGRESS.md`. Update it at the end of every task: what changed, what was tested for real, what was not.
- Never read or print `.env` (it holds the owner token and Google secrets). Use `grep -c` style checks if you need to know a key exists.
- Ask before adding a dependency or changing an architecture rule above.

## Testing expectations
- Every change keeps `npm test` green and adds offline tests (the suite uses a fake DB and a fake Google HTTP layer; see `web/test/run.js`). Mutation-check new assertions: break the code and confirm the test fails.
- **Important: the following were never run against live services** and are the first thing to verify (Task 0): Neo4j (migrations, fulltext index `artifact_text`, notes sync, backup/restore), `web/test/integration.js`, the Docker image build, Google OAuth and Drive upload/sharing, Crossref, OpenAlex, Cloud Run. Fix what breaks, and report what you could not run.
- UI changes: verify in a real browser (Playwright/Chromium is fine) and check there are no console or CSP errors.

## Conventions
- Small focused commits; commit messages explain why. Keep `README.md`, `web/openapi.json`, `docs/` and `_env.example` in sync with code.
- Do not add dependencies lightly; justify each. Do not commit `.env` or secrets.
- Prefer explicit errors with `HttpError(status, message)` from `web/core/errors.js`.
