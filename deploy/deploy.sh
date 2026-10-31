#!/usr/bin/env bash
# Builds the container with Cloud Build and deploys it to Cloud Run.
# Required: PROJECT, NEO4J_URI (from neo4j-vm.sh).
# Secrets that must exist first: hub-api-token, neo4j-password. Optional (for PDF uploads): google-client-id, google-client-secret, google-refresh-token.
# Usage: PROJECT=my-project NEO4J_URI=bolt://10.128.0.2:7687 ./deploy/deploy.sh
set -euo pipefail
: "${PROJECT:?set PROJECT}"; : "${NEO4J_URI:?set NEO4J_URI}"
REGION="${REGION:-us-central1}"; SERVICE="${SERVICE:-research-hub}"; BASE_PATH="${BASE_PATH:-/research-hub}"; SKIN="${SKIN:-paper}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"   # 0 scales to zero (about free; the first request after idle waits a few seconds); 1 keeps one warm (~$8-10/month)
TRUST_PROXY="${TRUST_PROXY:-2}"       # proxies in front: 2 = your site's rewrite (step 5) + Cloud Run. Use 1 if you serve the run.app URL directly

SECRETS="HUB_API_TOKEN=hub-api-token:latest,NEO4J_PASSWORD=neo4j-password:latest"
if gcloud secrets describe google-refresh-token --project "$PROJECT" >/dev/null 2>&1; then
  SECRETS="$SECRETS,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,GOOGLE_REFRESH_TOKEN=google-refresh-token:latest"
  echo "Google Drive secrets found: PDF uploads will be enabled."
else
  echo "No google-refresh-token secret: PDF uploads stay off (links still work). See deploy/README.md, step 3."
fi

gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
  --allow-unauthenticated --port 8080 --memory 512Mi --cpu 1 --cpu-boost --concurrency 40 \
  --min-instances "$MIN_INSTANCES" --max-instances 3 --timeout 300 \
  --network default --subnet default --vpc-egress private-ranges-only \
  --set-env-vars "BASE_PATH=${BASE_PATH},NEO4J_URI=${NEO4J_URI},NEO4J_USER=neo4j,HUB_SKIN=${SKIN},TRUST_PROXY=${TRUST_PROXY}" \
  --set-secrets "$SECRETS"

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='get(status.url)')
echo
echo "Deployed. Direct URL (for testing):  ${URL}${BASE_PATH}/"
echo "Health check:                        ${URL}${BASE_PATH}/healthz   (readiness incl. database: /readyz)"
echo "Next: point santidesimone.com${BASE_PATH} at ${URL} (see deploy/README.md, step 5)."
