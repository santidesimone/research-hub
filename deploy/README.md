# Deploying to Google Cloud (Cloud Run + a Neo4j VM)

Result: the hub runs at `https://santidesimone.com/research-hub/...`. The path stays in the address bar (a proxy, not a redirect),
and every page works as a direct link: `/research-hub/library?key=doi:...`, `/research-hub/console`, `/research-hub/mcp`.

The same code runs on your laptop and here; only environment variables differ (`_env.example` lists them). There is **no bucket**:
files are links (your Google Drive, arXiv, publishers) and Neo4j holds only metadata, note text and your personal layer.

Costs, roughly, with the defaults: **about $1-3 a month**. Cloud Run scales to zero (`MIN_INSTANCES=0`; the first request after a quiet spell waits a few seconds while it starts). The Neo4j VM is an e2-micro with a 30 GB standard disk, which Google's free tier covers (one per account, in us-central1, us-east1 or us-west1). Snapshots are cents.

Bigger, if you need it: `MIN_INSTANCES=1` keeps one instance warm (about $8-10/month). For the VM, `MACHINE_TYPE=e2-small HEAP=768m PAGECACHE=512m` costs about $13/month, and `MACHINE_TYPE=e2-medium HEAP=1g PAGECACHE=512m DISK_TYPE=pd-balanced` about $28. To resize an existing VM, stop it, run `gcloud compute instances set-machine-type neo4j-hub --machine-type e2-small`, start it again, and update its `neo4j-heap` and `neo4j-pagecache` metadata. The data stays on the disk.

## 0. One time

```bash
export PROJECT=your-gcp-project-id REGION=us-central1 ZONE=us-central1-a
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com compute.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com drive.googleapis.com
SA=$(gcloud projects describe $PROJECT --format='get(projectNumber)')-compute@developer.gserviceaccount.com   # the account Cloud Run runs as
```

## 1. Secrets (never put these in files)

`HUB_API_TOKEN` is the key to everything private (UI sign-in, API, CLI, Claude). In production the server **refuses to start** with a token shorter than 24 characters or with the default database password.

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create hub-api-token --data-file=-
openssl rand -hex 16 | tr -d '\n' | gcloud secrets create neo4j-password --data-file=-
for s in hub-api-token neo4j-password; do gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done
gcloud secrets versions access latest --secret hub-api-token      # copy this somewhere safe: it is what you type to sign in
```

## 2. Neo4j

Cloud Run cannot host a database (no persistent disk), so Neo4j runs on a small VM reachable only inside your network. The VM has **no public IP** (Google bills public IPv4 addresses, and nothing needs one): it runs Container-Optimized OS, which has Docker built in, and pulls Neo4j from an Artifact Registry mirror of Docker Hub (`dockerhub`) through Private Google Access, which the script turns on for the default subnet. With no public IP you cannot SSH in directly; read its log with `gcloud compute instances get-serial-port-output neo4j-hub --zone us-central1-a`:

```bash
NEO4J_PASSWORD=$(gcloud secrets versions access latest --secret neo4j-password) ./deploy/neo4j-vm.sh
```

It prints `bolt://10.x.x.x:7687` and turns on **nightly disk snapshots (kept 14 days)**. Neo4j is the only copy of your library, so keep that on, and also run `hub backup` now and then (step 7).
Alternative: Neo4j AuraDB (managed, with its own backups). Skip this step and use its `neo4j+s://...` address, user and password as `NEO4J_URI` / the `neo4j-password` secret.

## 3. Google Drive for PDF uploads (optional)

Skip this if you only store links: adding papers, linking Drive/arXiv URLs and reading all work without it. You need it for `hub pdf`, the "Upload PDF" button and `copy_pdf_to_drive`, which put a PDF into **your own Drive** (folder "Research Hub PDFs", created by the hub, files shared as "anyone with the link").

A service account cannot do this (it has no Drive storage of its own, and personal accounts have no Shared Drives), so the hub uses your own Google login, authorised once:

1. **Consent screen.** In the Cloud console open *APIs & Services > OAuth consent screen* (menus are being renamed "Google Auth Platform"). User type **External**, app name "Research Hub", your email. Add the scope `https://www.googleapis.com/auth/drive.file` (it only lets the hub touch files it created) and add yourself as a test user.
2. **Publish it.** Set the publishing status to **In production**. If you leave it in *Testing*, Google expires the refresh token after 7 days and uploads silently stop. `drive.file` needs no Google review for personal use; you will see an "unverified app" screen once, click *Advanced* and continue.
3. **Credentials.** *APIs & Services > Credentials > Create credentials > OAuth client ID*, application type **Desktop app**. Copy the client ID and secret.
4. **Log in once, on your computer:**
   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node bin/drive-auth
   ```
   Open the link it prints, allow access, and it prints three lines. (If it says no refresh token came back, remove the app at https://myaccount.google.com/permissions and run it again.)
5. **Store them as secrets:**
   ```bash
   printf %s "<client id>"     | gcloud secrets create google-client-id --data-file=-
   printf %s "<client secret>" | gcloud secrets create google-client-secret --data-file=-
   printf %s "<refresh token>" | gcloud secrets create google-refresh-token --data-file=-
   for s in google-client-id google-client-secret google-refresh-token; do gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done
   ```
   `deploy.sh` enables uploads automatically when `google-refresh-token` exists. For local use put the same three lines in `.env`.

Public links are the trade-off you chose: anyone who has a file's URL can open it, even if the paper is private in the hub. If the refresh token is ever revoked or expires, uploads fail with a clear message; run `bin/drive-auth` again and add a new secret version.

## 4. Deploy the app

```bash
NEO4J_URI=bolt://10.x.x.x:7687 ./deploy/deploy.sh
```

**Before deploying a new version, take a backup** (`hub backup`, step 7). Each start applies any new graph migrations once, in order (`web/migrations/`, recorded on the `SchemaMeta` node; `GET /api/schema` lists them). Version 0.7.0 brings 005 to 010:
- methods move into the database (005);
- vocabulary matching fields and indexes (006, 008);
- objects in `<field>_json` and queryable parts (007, 009);
- `record_status` from provenance (010).

They only add or copy data, but they do change it, so back up first. Set `OPENALEX_EMAIL` (a secret or plain env var) so Crossref and OpenAlex put Claude's analyses in their polite pools.

Open the printed URL (`.../research-hub/`). First start applies the graph migrations. `.../research-hub/healthz` says the process is up; `.../research-hub/readyz` also checks the database.
Sign in with the token, then load data from your computer: `hub add 10.1007/978-1-4757-0602-4_18 --file https://arxiv.org/pdf/...`, or `python scripts/seed.py` with `HUB_URL` set to the deployed address.
`MIN_INSTANCES=1` in front of the command keeps one instance warm (no wait on the first request, about $8-10/month). Check Drive with `hub drive`.

Your Markdown notes are not in the image. Keep them in a folder (ideally a git repo) and push them with `hub sync-notes ./content`.

## 4b. Budget guard (recommended, free)

Google budgets only alert; they never stop spending. `deploy/budget-guard.sh` creates a budget for the project (default $5 a month; emails at 20%, 60% and 100%) and a small function (`deploy/budget-guard/`) that, once the month's cost reaches the budget, **stops the Neo4j VM and closes the app to public traffic**. Nothing is deleted: the disk and its snapshots stay.

```bash
BILLING_ACCOUNT=$(gcloud billing projects describe $PROJECT --format='value(billingAccountName)' | cut -d/ -f2) ./deploy/budget-guard.sh
```

Billing data reaches the budget a few hours late, so this bounds spending; it is not an instant cap. To resume after it fired (raise the budget first, or it fires again):

```bash
gcloud compute instances start neo4j-hub --zone $ZONE
gcloud run services update research-hub --region $REGION --ingress all
```

## 4c. Connect the claude.ai chat

In claude.ai: *Settings → Connectors → Add custom connector*, URL `<your hub>/research-hub/mcp` (the run.app URL works). Leave the OAuth client fields empty: the hub supports dynamic registration. Claude opens the hub's approval page; sign in or type the owner token, then *Allow*. Check with `hub oauth`.
OAuth discovery uses `/.well-known/oauth-protected-resource/research-hub/mcp` and `/.well-known/oauth-authorization-server/research-hub` at the **domain root**. On the run.app URL the app serves them. Behind santidesimone.com, also rewrite `/.well-known/oauth-*/research-hub/**` to the service, and set `PUBLIC_URL=https://santidesimone.com` if the proxy does not pass the original host.

## 5. Make santidesimone.com/research-hub reach it (transparent proxy)

A **redirect** (301/302) would change the address bar to the run.app URL, so use a **proxy / rewrite**: the request path is forwarded unchanged
(the app is mounted at `/research-hub`) and the response is returned as if it came from santidesimone.com. Pick the recipe that matches how santidesimone.com is hosted:

**Firebase Hosting** (`firebase.json` of the santidesimone.com project; Firebase only forwards the `__session` cookie, which is the name this app uses):
```json
{ "hosting": { "rewrites": [
  { "source": "/research-hub",    "run": { "serviceId": "research-hub", "region": "us-central1" } },
  { "source": "/research-hub/**", "run": { "serviceId": "research-hub", "region": "us-central1" } }
] } }
```

**Vercel** (`vercel.json`):
```json
{ "rewrites": [{ "source": "/research-hub/:path*", "destination": "https://YOUR-RUN-APP-URL/research-hub/:path*" }] }
```

**Netlify** (`_redirects`, the `200` makes it a proxy):
```
/research-hub/*  https://YOUR-RUN-APP-URL/research-hub/:splat  200
```

**A Node/Express site** (`npm i http-proxy-middleware`):
```js
const { createProxyMiddleware } = require('http-proxy-middleware');
app.use(createProxyMiddleware({ target: 'https://YOUR-RUN-APP-URL', changeOrigin: true, xfwd: true, pathFilter: '/research-hub' }));
```

**nginx / Caddy**: `location /research-hub/ { proxy_pass https://YOUR-RUN-APP-URL; proxy_set_header Host YOUR-RUN-HOST; proxy_set_header X-Forwarded-Proto https; }` (no trailing path on `proxy_pass`, so the path is kept).

**Google Cloud load balancer** (if the site is also on GCP behind one): add a path matcher `/research-hub/*` to a backend service whose backend is a serverless NEG for the `research-hub` Cloud Run service. No path rewrite.

Test: `curl -I https://santidesimone.com/research-hub/healthz` should be `200`.

## 6. Use it from your terminal

```bash
./bin/hub config --url https://santidesimone.com/research-hub --token <your token>
./bin/hub query "MATCH (p:Paper) RETURN p.title, p.year ORDER BY p.year DESC LIMIT 5"
./bin/hub add 10.1007/978-1-4757-0602-4_18 --file https://arxiv.org/pdf/... --status reading
./bin/hub pdf <paper key> ./paper.pdf        # uploads to your Drive and links it
./bin/hub sync-notes ./content               # Markdown notes, methods, projects
```

## 7. Back up (Neo4j is the only copy)

```bash
./bin/hub backup                  # one JSON file: papers, notes, links, your personal statuses
./bin/hub restore backup.json     # merges it back in by key; never deletes, safe to run twice
```
Run `hub backup` weekly (cron or a Cloud Scheduler job calling `GET /api/backup` with the token) and keep the file outside Google Cloud as well. Disk snapshots are the fast path; the JSON backup is the portable one. The files themselves live in Drive and are not part of the backup, only their links.

## 8. Use it from Claude

The MCP endpoint is `https://santidesimone.com/research-hub/mcp` (Streamable HTTP, `Authorization: Bearer <token>`).
- **Claude Code**: `claude mcp add --transport http research-hub https://santidesimone.com/research-hub/mcp --header "Authorization: Bearer <token>"`
- **Claude chat window (custom connector)**: add the URL in Connectors. The chat app signs in with OAuth or an admin-entered fixed header, depending on your plan; this server accepts the bearer token only (no OAuth server yet). If your plan only offers OAuth, that is the next piece to build.

Tools offered:
- **Analysis:** `get_schema`, then `save_analysis`. One call saves an analysis directly, with provenance; it never overwrites your edits.
- **Collections:** `search_items` and `get_item`.
- **Graph:** `describe_graph` and `run_cypher` (read-only), plus `search_papers` and `get_artifact`.
- **Writes:** `add_paper`, `add_artifact`, `set_file_link`, `copy_pdf_to_drive`, `remove_file_link` and `set_status`.

The image runs Node 20. If you run the server yourself on Node 18, it still works; the MCP endpoint provides the Web Crypto global it needs.

Review what Claude saved in the Library's **Audit** view or with `hub audit` (and `hub audit --accept-all-unchanged`).
Large PDFs cannot travel through chat. Give Claude a URL (`copy_pdf_to_drive` with an arXiv/UCL link), or upload with `hub pdf` from your computer.

## CI/CD (optional)

`.github/workflows/ci.yml` runs on every push:
- **test:** the offline tests, and the integration test against a real Neo4j container.
- **e2e:** the real server on Neo4j, Playwright browser checks of the Library (owner, anonymous visitor, mobile width) and the CLI end to end. The seed analyses two papers through the live Crossref and OpenAlex APIs.
- **image:** the Docker build.

On failure, the e2e job uploads the server log and screenshots. `deploy/cloudbuild.yaml` builds and deploys on a Cloud Build trigger (see the comment at the top of that file).

## Security checklist
- Rate limits are per client IP. `deploy.sh` sets `TRUST_PROXY=2` (your site's rewrite plus Cloud Run), so the IP comes from what the proxies saw, not from headers a client can write. If you serve the run.app URL directly, deploy with `TRUST_PROXY=1`. Expensive endpoints (query, MCP, analysis, audit, backup and restore, import and export, enrich, notes sync) share a smaller budget (`HEAVY_RATE_LIMIT_PER_MIN`, 120/min), and sign-in allows 10 failed attempts per IP per 10 minutes. `bin/hub` waits and retries when it is rate limited.
- In production, unexpected errors reach clients (REST and MCP) only as "Internal error" with a request id; the details go to the log.
- The public preview is a whitelist: public items and whitelisted fields only. A case study marked `internal` or `confidential` never appears, even with `visibility: public`, and organisations never do.
- Production start-up refuses a missing or short `HUB_API_TOKEN`, the default Neo4j password and a half-configured Drive. It warns about `TRUST_PROXY=true`, a Neo4j password under 12 characters, a missing `OPENALEX_EMAIL` and `MAX_UPLOAD_MB` above 32.
- Server-side downloads (PDF copies, ontology snapshots) are https only, from allow-listed hosts (`PDF_FETCH_ALLOWED_HOSTS`, `SNAPSHOT_FETCH_ALLOWED_HOSTS`), with every redirect re-checked. Uploads to Drive accept only the listed file types (pdf, owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip, txt) and are shared by link.

- The UI and API reject everything private without the token; anonymous visitors only get the public preview.
- `/mcp` and `/api/*` need the token; sessions are a signed cookie (HttpOnly, SameSite=Lax, Secure over https); changes made with the cookie also need an `X-Hub` header.
- Ten wrong sign-in attempts from one address blocks that address for ten minutes; every `/api` route is rate limited per address (`RATE_LIMIT_PER_MIN`).
- The page is served with a Content-Security-Policy (per-request nonce) and the usual security headers; production refuses to start with a weak token.
- Read-only Cypher is enforced three ways (text guard, query-plan check, read transaction), but Neo4j Community has no read-only user: treat the token as full access.
- Google access is the narrow `drive.file` scope. Files the hub uploads are public by link (your choice); the hub trashes only files it uploaded.
- Rotate the token: `echo -n NEWVALUE | gcloud secrets versions add hub-api-token --data-file=-`, then redeploy (or restart) the service.
