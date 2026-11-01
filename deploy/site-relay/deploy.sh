#!/usr/bin/env bash
# Deploys the relay that serves the hub at santidesimone.com/research-hub (deploy/README.md, step 5).
# Firebase Hosting can only rewrite to Cloud Run in its own project, so the relay runs there and forwards to the hub.
# The relay gets its own service account, which is allowed to call the hub; nothing else needs to be.
# Usage: ./deploy/site-relay/deploy.sh    (from the repo root; SITE_PROJECT, HUB_PROJECT, REGION to override)
set -euo pipefail
SITE_PROJECT="${SITE_PROJECT:-santidesimone-com}"; HUB_PROJECT="${HUB_PROJECT:-research-hub-513302}"
REGION="${REGION:-us-central1}"; HUB_SERVICE="${HUB_SERVICE:-research-hub}"; RELAY="${RELAY:-research-hub-relay}"
CLIENT_HOPS="${CLIENT_HOPS:-2}"   # where the visitor's address sits in X-Forwarded-For, counted from the right
SA="site-relay@${SITE_PROJECT}.iam.gserviceaccount.com"

HUB_URL=$(gcloud run services describe "$HUB_SERVICE" --project "$HUB_PROJECT" --region "$REGION" --format='get(status.url)')
echo "Hub: $HUB_URL"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$SITE_PROJECT"
gcloud iam service-accounts describe "$SA" --project "$SITE_PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create site-relay --project "$SITE_PROJECT" --display-name "Research Hub relay"

gcloud run deploy "$RELAY" --project "$SITE_PROJECT" --region "$REGION" --source "$(dirname "$0")" --quiet \
  --service-account "$SA" --allow-unauthenticated --memory 256Mi --cpu 1 --concurrency 80 \
  --min-instances 0 --max-instances 3 --timeout 300 \
  --set-env-vars "HUB_URL=${HUB_URL},CLIENT_HOPS=${CLIENT_HOPS},LOG_XFF=${LOG_XFF:-0}"   # LOG_XFF=1 logs X-Forwarded-For, to check CLIENT_HOPS

# The relay may call the hub (this is what lets the hub be closed to everyone else)
gcloud run services add-iam-policy-binding "$HUB_SERVICE" --project "$HUB_PROJECT" --region "$REGION" \
  --member "serviceAccount:${SA}" --role roles/run.invoker >/dev/null
echo "Relay deployed and allowed to call the hub. Next: the Firebase rewrite (deploy/README.md, step 5)."
