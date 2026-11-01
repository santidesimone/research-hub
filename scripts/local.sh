#!/usr/bin/env bash
# One command to run the whole hub on your own machine.
#   ./scripts/local.sh          set everything up (safe to re-run) and start it
#   ./scripts/local.sh stop     stop the app (Neo4j keeps running; `docker compose down` stops it)
#   ./scripts/local.sh logs     follow the app log
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PIDFILE=$ROOT/.hub.pid
LOGFILE=$ROOT/.hub.log
URL=http://127.0.0.1:3000

stop_app() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PIDFILE"
}

case "${1:-start}" in
  stop) stop_app; echo "app stopped"; exit 0 ;;
  logs) exec tail -n 50 -f "$LOGFILE" ;;
  start) ;;
  *) echo "usage: $0 [start|stop|logs]"; exit 2 ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1; }; }
need docker "Install and start Docker Desktop."
need node "Install Node.js 18+ (https://nodejs.org)."
need npm "Install Node.js 18+ (https://nodejs.org)."
need python3 "Install Python 3 (only used to load the example library)."
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker Desktop and re-run."; exit 1; }

# A HUB_API_TOKEN already exported (even empty) in your shell would override .env, so drop it.
unset HUB_API_TOKEN NEO4J_PASSWORD NEO4J_URI NEO4J_USER

echo "1/6 configuration"
[ -f .env ] || cp _env.example .env
if ! grep -Eq '^HUB_API_TOKEN=.{24,}' .env; then
  TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  grep -v '^HUB_API_TOKEN=' .env > .env.new || true
  echo "HUB_API_TOKEN=$TOKEN" >> .env.new
  mv .env.new .env
  echo "    generated a new access token in .env"
fi
chmod 600 .env
TOKEN=$(grep '^HUB_API_TOKEN=' .env | head -1 | cut -d= -f2-)
NEO_PW=$(grep '^NEO4J_PASSWORD=' .env | head -1 | cut -d= -f2-); NEO_PW=${NEO_PW:-hubpassword}

echo "2/6 database (Neo4j in Docker)"
NEO4J_PASSWORD=$NEO_PW docker compose up -d >/dev/null
for i in $(seq 1 90); do
  if docker exec research-hub-neo4j cypher-shell -u neo4j -p "$NEO_PW" "RETURN 1" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "${ready:-0}" = 1 ] || { echo "Neo4j did not become ready in 3 minutes. Check: docker logs research-hub-neo4j"; exit 1; }

echo "3/6 dependencies"
( cd web && npm install --no-audit --no-fund --loglevel=error )

echo "4/6 app"
stop_app
if command -v lsof >/dev/null 2>&1 && lsof -ti :3000 >/dev/null 2>&1; then
  echo "    port 3000 is in use by an older process; stopping it"
  lsof -ti :3000 | xargs kill 2>/dev/null || true
  sleep 2
fi
( cd web && nohup npm start >"$LOGFILE" 2>&1 & echo $! > "$PIDFILE" )
for i in $(seq 1 60); do
  if curl -fsS "$URL/readyz" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "${up:-0}" != 1 ]; then echo "App did not start. Last log lines:"; tail -n 30 "$LOGFILE"; exit 1; fi

if ! curl -fsS -H "Authorization: Bearer $TOKEN" "$URL/api/drive" >/dev/null 2>&1; then
  echo "The app is running but rejected the token in .env (another process may own port 3000). Run: lsof -i :3000"; exit 1
fi

echo "5/6 example library and notes"
# seed.py needs requests. A Homebrew or system Python refuses pip installs (PEP 668), so fall back to a project virtualenv.
PY=python3
if ! $PY -c "import requests" 2>/dev/null; then
  [ -x .venv/bin/python ] || python3 -m venv .venv
  PY=.venv/bin/python
  $PY -c "import requests" 2>/dev/null || $PY -m pip install -q requests
fi
export HUB_API_TOKEN=$TOKEN
$PY scripts/seed.py --with-pdfs
./bin/hub config --url "$URL" --token "$TOKEN" >/dev/null
./bin/hub sync-notes ./content

echo "6/6 check"
./bin/hub search blind signatures | head -5

cat <<MSG

Ready.
  Open:   $URL        (click Sign in, paste the token)
  Token:  $TOKEN
  CLI:    ./bin/hub help      (already configured)
  Stop:   ./scripts/local.sh stop      Logs: ./scripts/local.sh logs
MSG
