#!/usr/bin/env bash
# Creates a small VM that runs Neo4j 5 Community in Docker, with its data on the VM's persistent disk.
# The VM has NO public IP address (a public IPv4 is billed, and nothing needs one): Cloud Run reaches it over your
# private network, and it pulls the Neo4j image from an Artifact Registry mirror of Docker Hub through Private Google
# Access. It runs Container-Optimized OS, which already has Docker, so nothing is installed from the internet.
# Usage: PROJECT=my-project ZONE=us-central1-a NEO4J_PASSWORD=... ./deploy/neo4j-vm.sh
# Default: an e2-micro with a 30 GB standard disk, inside Google's free tier (one per account, only in us-central1,
# us-east1 or us-west1). Enough for a personal library; for more headroom: MACHINE_TYPE=e2-small HEAP=768m PAGECACHE=512m
# (about $13/month) or MACHINE_TYPE=e2-medium HEAP=1g PAGECACHE=512m DISK_TYPE=pd-balanced (about $28/month).
set -euo pipefail
: "${PROJECT:?set PROJECT}"; : "${NEO4J_PASSWORD:?set NEO4J_PASSWORD}"
ZONE="${ZONE:-us-central1-a}"; NAME="${NAME:-neo4j-hub}"; REGION="${ZONE%-*}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"; DISK_TYPE="${DISK_TYPE:-pd-standard}"
HEAP="${HEAP:-256m}"; PAGECACHE="${PAGECACHE:-64m}"   # Neo4j memory. 384m+128m starved the e2-micro (1 GB, no swap on COS)
MIRROR="${REGION}-docker.pkg.dev/${PROJECT}/dockerhub"
SA=$(gcloud projects describe "$PROJECT" --format='get(projectNumber)')-compute@developer.gserviceaccount.com

# 1. Private access to Google APIs from the default subnet (free), so a VM without a public IP can pull images.
gcloud compute networks subnets update default --project "$PROJECT" --region "$REGION" --enable-private-ip-google-access

# 2. An Artifact Registry repository that mirrors Docker Hub (it stores only the images pulled through it).
gcloud artifacts repositories describe dockerhub --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create dockerhub --project "$PROJECT" --location "$REGION" \
    --repository-format docker --mode remote-repository --remote-docker-repo DOCKER-HUB \
    --description "Docker Hub mirror for the Neo4j VM (it has no public IP)"
gcloud artifacts repositories add-iam-policy-binding dockerhub --project "$PROJECT" --location "$REGION" \
  --member "serviceAccount:$SA" --role roles/artifactregistry.reader >/dev/null

# 3. The VM. Container-Optimized OS: /var is writable and survives reboots; the startup script runs at every boot.
STARTUP=$(mktemp)
cat > "$STARTUP" <<'SCRIPT'
#!/bin/bash
set -e
MD=http://metadata.google.internal/computeMetadata/v1/instance
get() { curl -s -H 'Metadata-Flavor: Google' "$MD/$1"; }
PASS=$(get attributes/neo4j-password); HEAP=$(get attributes/neo4j-heap); PAGECACHE=$(get attributes/neo4j-pagecache)
IMAGE=$(get attributes/neo4j-image)
export DOCKER_CONFIG=/var/lib/hub-docker; mkdir -p "$DOCKER_CONFIG" /var/lib/neo4j-data
get service-accounts/default/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/' |
  docker login -u oauth2accesstoken --password-stdin "https://${IMAGE%%/*}"
docker pull "$IMAGE"
docker rm -f neo4j 2>/dev/null || true
docker run -d --name neo4j --restart always -p 7687:7687 -v /var/lib/neo4j-data:/data \
  -e NEO4J_AUTH="neo4j/${PASS}" \
  -e NEO4J_server_memory_heap_initial__size="${HEAP}" -e NEO4J_server_memory_heap_max__size="${HEAP}" \
  -e NEO4J_server_memory_pagecache_size="${PAGECACHE}" \
  "$IMAGE"
SCRIPT

gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" --image-family cos-stable --image-project cos-cloud \
  --boot-disk-size 30GB --boot-disk-type "$DISK_TYPE" \
  --no-address --scopes cloud-platform \
  --metadata-from-file startup-script="$STARTUP" \
  --metadata neo4j-password="$NEO4J_PASSWORD",neo4j-heap="$HEAP",neo4j-pagecache="$PAGECACHE",neo4j-image="${MIRROR}/library/neo4j:5-community"
rm -f "$STARTUP"

IP=$(gcloud compute instances describe "$NAME" --project "$PROJECT" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')
PUBLIC=$(gcloud compute instances describe "$NAME" --project "$PROJECT" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
[ -z "$PUBLIC" ] || { echo "ERROR: the VM has a public IP ($PUBLIC). Remove it: gcloud compute instances delete-access-config $NAME --zone $ZONE"; exit 1; }
echo
echo "Neo4j VM created, no public IP. Internal address: bolt://${IP}:7687   (give it a minute or two to pull Neo4j and start)"
echo "Use that as NEO4J_URI when deploying the app."
echo
# Nightly disk snapshots, kept 14 days. Neo4j is the only copy of your library, so this is not optional.
gcloud compute resource-policies create snapshot-schedule neo4j-nightly --project "$PROJECT" --region "$REGION" \
  --max-retention-days 14 --daily-schedule --start-time 03:00 2>/dev/null || echo "(snapshot schedule neo4j-nightly already exists)"
gcloud compute disks add-resource-policies "$NAME" --project "$PROJECT" --zone "$ZONE" --resource-policies neo4j-nightly
echo "Nightly snapshots enabled (14 days). Also take your own copy any time with:  hub backup"
