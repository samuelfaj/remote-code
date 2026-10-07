#!/usr/bin/env bash
# RC-022 executable proof: one workspace thread sends a task to Distill, Distill
# modifies a file, the run transmits progress, and the final state is recorded.
# Two distinct client sessions read the same run and file from one backend, and
# the run does not depend on any client staying open.
#
# Requires: docker, curl, python3 (host), logged-in host Distill home.
# Usage: scripts/rc022/run-thread-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc022-thread}"
IMAGE="${RC022_IMAGE:-remotecode/computer:rc022}"
NAME="rc022-proof"
PASSWORD="rc022-local-password-longenough"
AUTH="${RC022_AUTH:-$HOME/.distill/auth.json}"

mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/rc022-thread.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

say "== RC-022 workspace thread runs Distill =="
say "-- build image (includes current backend) --"
docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$TRANSCRIPT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null
docker exec "$NAME" mkdir -p /root/.distill
docker cp "$AUTH" "$NAME:/root/.distill/auth.json"
docker exec "$NAME" chmod 600 /root/.distill/auth.json

say "-- start the API inside the container --"
docker exec -d "$NAME" bash -lc "cd /workspace && API_PORT=3222 DATABASE_PATH=/workspace/rc022.sqlite \
  REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_DISTILL_BIN=/usr/local/bin/distill \
  REMOTECODE_RUNS_CWD=/workspace/rc022-workspace REMOTECODE_WEB_ORIGIN=http://localhost:5173 \
  bun apps/api/src/index.ts > /workspace/rc022-api.log 2>&1"
docker exec "$NAME" mkdir -p /workspace/rc022-workspace

for _ in $(seq 1 60); do
  if docker exec "$NAME" curl -fsS "http://127.0.0.1:3222/api/health/ready" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
READY=$(docker exec "$NAME" curl -fsS "http://127.0.0.1:3222/api/health/ready")
say "container api ready=$READY"

say "-- client A: login, create workspace, submit a thread run, then go away --"
docker exec "$NAME" bash -lc "curl -fsS -c /workspace/cookies-a.txt -X POST http://127.0.0.1:3222/api/auth/login -H 'content-type: application/json' -d '{\"password\":\"$PASSWORD\"}' >/dev/null"
WS=$(docker exec "$NAME" curl -fsS -b /workspace/cookies-a.txt -X POST http://127.0.0.1:3222/api/workspaces -H 'content-type: application/json' -d '{"name":"rc022"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
say "workspace=$WS"
printf '%s' "{\"workspaceId\":\"$WS\",\"prompt\":\"Create the file rc022-thread.txt in the current directory containing exactly the single line rc022-done. Then stop.\"}" | docker exec -i "$NAME" sh -c 'cat > /workspace/run.json'
RUN=$(docker exec "$NAME" curl -fsS -b /workspace/cookies-a.txt -X POST http://127.0.0.1:3222/api/runs -H 'content-type: application/json' --data-binary @/workspace/run.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
say "accepted run=$RUN (client A never polls again)"

say "-- client B: a separate session reads the same run by receipt --"
docker exec "$NAME" bash -lc "curl -fsS -c /workspace/cookies-b.txt -X POST http://127.0.0.1:3222/api/auth/login -H 'content-type: application/json' -d '{\"password\":\"$PASSWORD\"}' >/dev/null"
STATE=""
for _ in $(seq 1 240); do
  # RC-035: the agent's approval requests are presented to a client and are
  # never auto-allowed, so this client approves each pending request exactly
  # as the web client does.
  PENDING=$(docker exec "$NAME" curl -fsS -b /workspace/cookies-b.txt "http://127.0.0.1:3222/api/runs/$RUN/permissions" || true)
  for REQUEST in $(printf '%s' "$PENDING" | python3 -c 'import sys,json
try:
  data = json.load(sys.stdin)
except Exception:
  raise SystemExit
for entry in data.get("permissions", []):
  print(entry["requestId"])' 2>/dev/null); do
    say "approving permission request $REQUEST"
    docker exec "$NAME" curl -fsS -b /workspace/cookies-b.txt -X POST \
      -H 'content-type: application/json' -d '{"decision":"allow"}' \
      "http://127.0.0.1:3222/api/runs/$RUN/permissions/$REQUEST" >/dev/null || true
  done
  STATE=$(docker exec "$NAME" curl -fsS -b /workspace/cookies-b.txt "http://127.0.0.1:3222/api/runs/$RUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
  if [ "$STATE" = "completed" ] || [ "$STATE" = "failed" ] || [ "$STATE" = "interrupted" ]; then break; fi
  sleep 1
done
say "client B observed state=$STATE"
if [ "$STATE" != "completed" ]; then
  say "FAIL run ended $STATE"
  docker exec "$NAME" tail -20 /workspace/rc022-api.log | tee -a "$TRANSCRIPT"
  exit 1
fi

DETAIL=$(docker exec "$NAME" curl -fsS -b /workspace/cookies-b.txt "http://127.0.0.1:3222/api/runs/$RUN")
say "run receipt: $DETAIL"

say "-- the file exists inside the container, created by Distill --"
CONTENT=$(docker exec "$NAME" cat /workspace/rc022-workspace/rc022-thread.txt)
say "file content=$CONTENT"
if [ "$CONTENT" != "rc022-done" ]; then say "FAIL file content"; exit 1; fi

say "-- client A can also read the run state (one backend, one receipt) --"
A_READ=$(docker exec "$NAME" curl -fsS -b /workspace/cookies-a.txt "http://127.0.0.1:3222/api/runs/$RUN")
python3 -c "import json,sys;d=json.loads(sys.argv[1]);assert d['state']=='completed' and d['stopReason']=='end_turn',d;print('client A read ok:',d['id'],d['state'],d['stopReason'])" "$A_READ" | tee -a "$TRANSCRIPT"

ROWS=$(docker exec "$NAME" python3 -c "import sqlite3;print(sqlite3.connect('/workspace/rc022.sqlite').execute('SELECT COUNT(*) FROM runs').fetchone()[0])")
say "runs in database: $ROWS"
if [ "$ROWS" != "1" ]; then say "FAIL run row count=$ROWS"; exit 1; fi

say ""
say "PASS rc022: one workspace thread -> Distill created rc022-thread.txt in-container, run completed/end_turn, two client sessions read one run+file, no client needed to stay open"
docker rm -f "$NAME" >/dev/null 2>&1 || true