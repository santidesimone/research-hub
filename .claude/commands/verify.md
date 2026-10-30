---
description: Run the full offline check, boot the server against the fake DB or real Neo4j, and report
---
Verify the project end to end and report briefly:
1. `cd web && npm test` (must pass).
2. If Docker is running, run `./scripts/local.sh` and check `curl -s http://127.0.0.1:3000/readyz`; then `HUB_INTEGRATION=1 npm run test:integration` against the local Neo4j only if it is the throwaway docker-compose database.
3. Grep for leftovers of removed concepts (`pdf_uri`, `has_pdf`, `runSync`, `ingest.py`).
4. Report: what passed, what failed (with the first error), what could not be run and why. Do not fix anything unless I ask.
