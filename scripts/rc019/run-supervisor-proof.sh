#!/usr/bin/env bash
# RC-019 executable proof: the host supervisor detects a frozen API, a dead GUI
# and a blocked Docker daemon with bounded probes; it restarts a limited number
# of times, reports a lock instead of a false healthy state, and never deletes
# the data volume.
#
# Requires: docker, curl, python3 (host), logged-in host Distill home.
# Usage: scripts/rc019/run-supervisor-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc019-supervisor}"
IMAGE="${RC019_IMAGE:-remotecode/computer:rc019}"
NAME="rc019-proof"
VOLUME="rc019-data"
PASSWORD="rc019-local-password-longenough"
AUTH="${RC019_AUTH:-$HOME/.distill/auth.json}"
SUP="$HERE/host-supervisor.sh"

mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/rc019-supervisor.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { docker exec "$NAME" "$@"; }

export RC019_CONTAINER="$NAME"
export RC019_API_URL="http://127.0.0.1:3000/api/health/ready"
export RC019_PROBE_TIMEOUT=3
export RC019_MAX_RESTARTS=1
export RC019_RESTART_SETTLE=60
STATE="$OUTDIR/state.json"
export RC019_STATE_FILE="$STATE"

say "== RC-019 host supervisor =="
say "-- build image --"
docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$TRANSCRIPT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -v "$VOLUME:/var/lib/remotecode" -e REMOTECODE_BACKGROUND=1 \
  -e DATABASE_PATH=/var/lib/remotecode/rc019.sqlite -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null
docker exec "$NAME" mkdir -p /root/.distill
docker cp "$AUTH" "$NAME:/root/.distill/auth.json"

say "-- wait for the services-ready marker --"
for _ in $(seq 1 90); do run test -f /var/log/remotecode-services-ready 2>/dev/null && break; sleep 2; done
run test -f /var/log/remotecode-services-ready || { say "FAIL services never ready"; run tail -20 /var/log/rc003-api.log | tee -a "$TRANSCRIPT"; exit 1; }

say "-- 1. healthy pass --"
bash "$SUP" | tee -a "$TRANSCRIPT"
python3 -c "import json,sys;d=json.load(open('$STATE'));assert d['state']=='healthy' and d['action']=='none',d;print('healthy state ok')" | tee -a "$TRANSCRIPT"

say "-- 2. freeze the API, expect detection + one bounded restart --"
API_PID=$(run pgrep -f "apps/api/src/index.ts" | head -1)
run kill -STOP "$API_PID"
bash "$SUP" | tee -a "$TRANSCRIPT"
RC=$?
[ "$RC" -eq 0 ] || { say "FAIL supervisor did not recover the frozen API (exit $RC)"; exit 1; }
python3 -c "import json;d=json.load(open('$STATE'));assert d['state']=='healthy' and d['restarts']==1,d;print('frozen-api recovery ok: restarts=',d['restarts'])" | tee -a "$TRANSCRIPT"

say "-- 3. kill the GUI, expect detection + one bounded restart --"
rm -f "$STATE"
run pkill -9 -f "chromium|Xvfb" || true
bash "$SUP" | tee -a "$TRANSCRIPT"
RC=$?
[ "$RC" -eq 0 ] || { say "FAIL supervisor did not recover the GUI (exit $RC)"; exit 1; }
python3 -c "import json;d=json.load(open('$STATE'));assert d['state']=='healthy',d;print('gui recovery ok: restarts=',d['restarts'])" | tee -a "$TRANSCRIPT"

say "-- 4. block the Docker daemon, expect a bounded lock, no volume deletion --"
FAKE="$OUTDIR/fake-docker"
printf '#!/bin/sh\nsleep 3600\n' > "$FAKE"; chmod +x "$FAKE"
rm -f "$STATE"
START=$(date +%s)
set +e
RC019_DOCKER="$FAKE" RC019_RESTART_TIMEOUT=6 RC019_RESTART_SETTLE=4 bash "$SUP" | tee -a "$TRANSCRIPT"
RC=$?
set -e
ELAPSED=$(( $(date +%s) - START ))
say "blocked-docker supervisor exit=$RC elapsed=${ELAPSED}s"
[ "$RC" -eq 2 ] || { say "FAIL blocked docker did not report a lock (exit $RC)"; exit 1; }
[ "$ELAPSED" -lt 120 ] || { say "FAIL supervisor hung on the blocked daemon (${ELAPSED}s)"; exit 1; }
python3 -c "import json;d=json.load(open('$STATE'));assert d['state']=='locked' and d['action']=='reported_lock' and d['volume']=='preserved',d;print('locked state ok: action=',d['action'])" | tee -a "$TRANSCRIPT"

docker volume inspect "$VOLUME" >/dev/null 2>&1 || { say "FAIL data volume was deleted"; exit 1; }
say "data volume $VOLUME still present"

say ""
say "PASS rc019: bounded probes detect frozen API and dead GUI and recover with a limited restart; a blocked Docker daemon ends as a reported lock without deleting the volume"
docker rm -f "$NAME" >/dev/null 2>&1 || true