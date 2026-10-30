#!/usr/bin/env bash
# Creates a small VM that runs Neo4j 5 Community in Docker, with its data on the VM's persistent disk.
# Neo4j is only reachable from inside your Google Cloud network (default firewall rules do not open port 7687 to the internet).
# Usage: PROJECT=my-project ZONE=us-central1-a NEO4J_PASSWORD=... ./deploy/neo4j-vm.sh
set -euo pipefail
: "${PROJECT:?set PROJECT}"; : "${NEO4J_PASSWORD:?set NEO4J_PASSWORD}"
ZONE="${ZONE:-us-central1-a}"; NAME="${NAME:-neo4j-hub}"

STARTUP=$(mktemp)
cat > "$STARTUP" <<'SCRIPT'
#!/bin/bash
set -e
if ! command -v docker >/dev/null; then apt-get update && apt-get install -y docker.io; fi
PASS=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/neo4j-password)
mkdir -p /var/lib/neo4j
docker rm -f neo4j 2>/dev/null || true
docker run -d --name neo4j --restart always -p 7687:7687 -v /var/lib/neo4j:/data \
  -e NEO4J_AUTH="neo4j/${PASS}" \
  -e NEO4J_server_memory_heap_initial__size=512m -e NEO4J_server_memory_heap_max__size=1g \
  -e NEO4J_server_memory_pagecache_size=512m \
  neo4j:5-community
SCRIPT

gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --machine-type e2-medium --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-balanced \
  --metadata-from-file startup-script="$STARTUP" \
  --metadata neo4j-password="$NEO4J_PASSWORD"
rm -f "$STARTUP"

IP=$(gcloud compute instances describe "$NAME" --project "$PROJECT" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')
echo
echo "Neo4j VM created. Internal address: bolt://${IP}:7687   (give it a minute or two to install Docker and start)"
echo "Use that as NEO4J_URI when deploying the app."
echo
# Nightly disk snapshots, kept 14 days. Neo4j is the only copy of your library, so this is not optional.
REGION="${ZONE%-*}"
gcloud compute resource-policies create snapshot-schedule neo4j-nightly --project "$PROJECT" --region "$REGION" \
  --max-retention-days 14 --daily-schedule --start-time 03:00 2>/dev/null || echo "(snapshot schedule neo4j-nightly already exists)"
gcloud compute disks add-resource-policies "$NAME" --project "$PROJECT" --zone "$ZONE" --resource-policies neo4j-nightly
echo "Nightly snapshots enabled (14 days). Also take your own copy any time with:  hub backup"
