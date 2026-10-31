#!/usr/bin/env bash
# A $5/month budget for the project with email alerts, and a soft stop when it is reached (deploy/budget-guard/):
# the Neo4j VM is stopped and the app closed to public traffic. Nothing is deleted. Costs nothing to run.
# Usage: PROJECT=my-project BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX ./deploy/budget-guard.sh
# Optional: AMOUNT=5 (in the billing account's currency), REGION, ZONE, VM, SERVICE.
set -euo pipefail
: "${PROJECT:?set PROJECT}"; : "${BILLING_ACCOUNT:?set BILLING_ACCOUNT (gcloud billing projects describe \$PROJECT)}"
AMOUNT="${AMOUNT:-5}"; REGION="${REGION:-us-central1}"; ZONE="${ZONE:-us-central1-a}"; VM="${VM:-neo4j-hub}"; SERVICE="${SERVICE:-research-hub}"
SA=$(gcloud projects describe "$PROJECT" --format='get(projectNumber)')-compute@developer.gserviceaccount.com
cd "$(dirname "$0")"

gcloud services enable billingbudgets.googleapis.com pubsub.googleapis.com cloudfunctions.googleapis.com eventarc.googleapis.com --project "$PROJECT"
gcloud pubsub topics describe budget-alerts --project "$PROJECT" >/dev/null 2>&1 || gcloud pubsub topics create budget-alerts --project "$PROJECT"

gcloud functions deploy budget-guard --gen2 --quiet --project "$PROJECT" --region "$REGION" --runtime nodejs20 \
  --source budget-guard --entry-point guard --trigger-topic budget-alerts --service-account "$SA" \
  --memory 256Mi --max-instances 1 \
  --set-env-vars "PROJECT=${PROJECT},ZONE=${ZONE},VM=${VM},REGION=${REGION},SERVICE=${SERVICE}"

# Emails go to the billing account's admins (you) at 20%, 60% and 100%; every notification also reaches the topic.
EXISTING=$(gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --format='value(name)' --filter="displayName='research-hub guard'" 2>/dev/null | head -1)
if [ -n "$EXISTING" ]; then echo "(budget 'research-hub guard' already exists: $EXISTING)"; else
  gcloud billing budgets create --billing-account "$BILLING_ACCOUNT" --display-name "research-hub guard" \
    --budget-amount "${AMOUNT}" --filter-projects "projects/${PROJECT}" \
    --threshold-rule percent=0.2 --threshold-rule percent=0.6 --threshold-rule percent=1.0 \
    --notifications-rule-pubsub-topic "projects/${PROJECT}/topics/budget-alerts"
fi
echo "Budget guard on: alerts by email, and at ${AMOUNT} the VM stops and the app closes. To resume, see deploy/README.md."
