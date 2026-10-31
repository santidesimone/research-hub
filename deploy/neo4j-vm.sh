#!/usr/bin/env bash
# Creates a small VM that runs Neo4j 5 Community in Docker, with its data on the VM's persistent disk.
# Neo4j is only reachable from inside your Google Cloud network (default firewall rules do not open port 7687 to the internet).
# Usage: PROJECT=my-project ZONE=us-central1-a NEO4J_PASSWORD=... ./deploy/neo4j-vm.sh
# Default: an e2-micro with a 30 GB standard disk, inside Google's free tier (one per account, only in us-central1,
# us-east1 or us-west1). Enough for a personal library; for more headroom: MACHINE_TYPE=e2-small HEAP=768m PAGECACHE=512m
# (about $13/month) or MACHINE_TYPE=e2-medium HEAP=1g PAGECACHE=512m DISK_TYPE=pd-balanced (about $28/month).
set -euo pipefail
: "${PROJECT:?set PROJECT}"; : "${NEO4J_PASSWORD:?set NEO4J_PASSWORD}"
ZONE="${ZONE:-us-central1-a}"; NAME="${NAME:-neo4j-hub}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"; DISK_TYPE="${DISK_TYPE:-pd-standard}"
HEAP="${HEAP:-384m}"; PAGECACHE="${PAGECACHE:-128m}"   # Neo4j memory; together well under the machine's RAM

STARTUP=$(mktemp)
cat > "$STARTUP" <<'SCRIPT'
#!/bin/bash
set -e
if ! command -v docker >/dev/null; then apt-get update && apt-get install -y docker.io; fi
MD=http://metadata.google.internal/computeMetadata/v1/instance/attributes
PASS=$(curl -s -H 'Metadata-Flavor: Google' $MD/neo4j-password)
HEAP=$(curl -s -H 'Metadata-Flavor: Google' $MD/neo4j-heap); PAGECACHE=$(curl -s -H 'Metadata-Flavor: Google' $MD/neo4j-pagecache)
# a small machine gets 2 GB of swap so a memory spike slows Neo4j down instead of killing it
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 3000000 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
mkdir -p /var/lib/neo4j
docker rm -f neo4j 2>/dev/null || true
docker run -d --name neo4j --restart always -p 7687:7687 -v /var/lib/neo4j:/data \
  -e NEO4J_AUTH="neo4j/${PASS}" \
  -e NEO4J_server_memory_heap_initial__size="${HEAP}" -e NEO4J_server_memory_heap_max__size="${HEAP}" \
  -e NEO4J_server_memory_pagecache_size="${PAGECACHE}" \
  neo4j:5-community
SCRIPT

gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type "$DISK_TYPE" \
  --metadata-from-file startup-script="$STARTUP" \
  --metadata neo4j-password="$NEO4J_PASSWORD",neo4j-heap="$HEAP",neo4j-pagecache="$PAGECACHE"
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
