#!/usr/bin/env bash
# RC-027 executable proof: in a real container, the Distill supervisor
# correctly records host_restart when the container is killed mid-command,
# and correctly records stalled when the agent makes no progress.
#
# Requires: docker, curl, python3 (host).
# Usage: scripts/rc027/run-stuck-run-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc027-stuck}"
IMAGE="${RC027_IMAGE:-remotecode/computer:rc027}"
NAME="rc027-proof"
PASSWORD="rc027-local-password-longenough"

mkdir -p "$OUTDIR"

TRANSCRIPT="$OUTDIR/rc027-session.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { docker exec "$NAME" "$@"; }

json_field() {
  # Usage: <command> | json_field <field-name>
  # Reads JSON from stdin, prints the value of the field.
  python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"
}

# The image has no pgrep/ps, so read /proc directly.
agent_pids() {
  # Match only the agent's own argv[0]; the API's launcher shell also carries
  # the path in REMOTECODE_DISTILL_BIN.
  run bash -lc 'for d in /proc/[0-9]*; do
    c=$(tr "\0" " " < "$d/cmdline" 2>/dev/null)
    case "$c" in "/workspace/rc027-blocking-agent"*) basename "$d" ;; esac
  done' 2>/dev/null || true
}

kill_api() {
  run bash -lc 'for d in /proc/[0-9]*; do
    tr "\0" " " < "$d/cmdline" 2>/dev/null | grep -q "apps/api/src/index.ts" && kill "$(basename "$d")"
  done; true' >/dev/null 2>&1 || true
}

say "== RC-027 blocking agent stuck-run proof =="

say "-- build image --"
docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$TRANSCRIPT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
say "-- run container --"
docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null

say "-- copy blocking agent --"
docker cp "$ROOT/scripts/rc027/blocking-agent" "$NAME:/workspace/rc027-blocking-agent"
run chmod 0755 /workspace/rc027-blocking-agent

run mkdir -p /workspace/rc027-workspace

say "-- start API --"
run bash -lc "cd /workspace && API_PORT=3227 DATABASE_PATH=/workspace/rc027.sqlite \
  REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_DISTILL_BIN=/workspace/rc027-blocking-agent \
  REMOTECODE_RUNS_CWD=/workspace/rc027-workspace REMOTECODE_WEB_ORIGIN=http://localhost:5173 \
  RC027_EFFECT_FILE=/workspace/rc027-effect.txt \
  bun apps/api/src/index.ts > /workspace/rc027-api.log 2>&1 &"

say "-- wait for API ready --"
for _ in $(seq 1 60); do
  if run curl -fsS http://127.0.0.1:3227/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
done
say "api ready=$(run curl -fsS http://127.0.0.1:3227/api/health/ready)"

say "-- sign in --"
run bash -lc "curl -fsS -c /workspace/rc027-cookies.txt -X POST http://127.0.0.1:3227/api/auth/login \
  -H 'content-type: application/json' -d '{\"password\":\"$PASSWORD\"}' >/dev/null"

say "-- create workspace --"
WS=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt -X POST http://127.0.0.1:3227/api/workspaces \
  -H 'content-type: application/json' -d '{\"name\":\"rc027\"}'" | json_field "id")
say "workspace=$WS"

# ── Scenario 1: kill host during command ──
say ""
say "== Scenario 1: host restart mid-command =="

RUN1=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt -X POST http://127.0.0.1:3227/api/runs \
  -H 'content-type: application/json' -d '{\"workspaceId\":\"$WS\",\"prompt\":\"Block this run until the host is killed.\"}'" | json_field "id")
say "run1=$RUN1"

say "-- wait for run to be running and effect file to have one line --"
for _ in $(seq 1 60); do
  BODY1=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt http://127.0.0.1:3227/api/runs/$RUN1")
  STATE1=$(printf '%s' "$BODY1" | json_field "state")
  LINES1=$(run bash -lc "wc -l < /workspace/rc027-effect.txt" 2>/dev/null || echo 0)
  say "scenario1 poll: state=$STATE1 lines=$LINES1"
  if [ "$STATE1" = "running" ] && [ "$LINES1" = "1" ]; then break; fi
  sleep 1
done

say "-- verify run is running and effect file has one line before restart --"
[ "$STATE1" = "running" ] || { say "FAIL run1 not running before restart: $BODY1"; exit 1; }
[ "$LINES1" = "1" ] || { say "FAIL effect file does not have 1 line before restart: $LINES1"; exit 1; }

say "-- restart container (kills API and agent mid-command) --"
docker restart rc027-proof >/dev/null

say "-- wait for container to be running again --"
for _ in $(seq 1 30); do
  if docker inspect -f '{{.State.Running}}' rc027-proof 2>/dev/null | grep -q 'true'; then break; fi
  sleep 1
done

say "-- restart API on same database --"
run bash -lc "cd /workspace && API_PORT=3227 DATABASE_PATH=/workspace/rc027.sqlite \
  REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_DISTILL_BIN=/workspace/rc027-blocking-agent \
  REMOTECODE_RUNS_CWD=/workspace/rc027-workspace REMOTECODE_WEB_ORIGIN=http://localhost:5173 \
  RC027_EFFECT_FILE=/workspace/rc027-effect.txt \
  bun apps/api/src/index.ts > /workspace/rc027-api2.log 2>&1 &"

say "-- wait for API ready --"
for _ in $(seq 1 60); do
  if run curl -fsS http://127.0.0.1:3227/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
done
say "api ready=$(run curl -fsS http://127.0.0.1:3227/api/health/ready)"

say "-- assert run1 is interrupted with host_restart --"
BODY1_AFTER=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt http://127.0.0.1:3227/api/runs/$RUN1")
STATE1_AFTER=$(printf '%s' "$BODY1_AFTER" | json_field "state")
STOP_REASON1=$(printf '%s' "$BODY1_AFTER" | json_field "stopReason")
say "run1 after restart: state=$STATE1_AFTER stopReason=$STOP_REASON1"

if [ "$STATE1_AFTER" != "interrupted" ]; then
  say "FAIL run1 not interrupted after restart: $BODY1_AFTER"; exit 1
fi
if [ "$STOP_REASON1" != "host_restart" ]; then
  say "FAIL run1 stopReason not host_restart: $BODY1_AFTER"; exit 1
fi

say "-- assert no agent process for run1 is running --"
AGENT_PIDS1=$(agent_pids)
if [ -n "$AGENT_PIDS1" ]; then
  say "FAIL agent still running after restart: pids=$AGENT_PIDS1"; exit 1
fi

say "-- assert effect file still has exactly one line --"
LINES1_AFTER=$(run bash -lc "wc -l < /workspace/rc027-effect.txt" 2>/dev/null || echo 0)
say "effect file lines after restart: $LINES1_AFTER"
if [ "$LINES1_AFTER" != "1" ]; then
  say "FAIL effect file does not have 1 line after restart: $LINES1_AFTER"; exit 1
fi

say "Scenario 1 PASSED: host_restart recorded correctly"

# ── Scenario 2: stall watchdog ──
say ""
say "== Scenario 2: stall watchdog =="

say "-- restart API with stall watchdog (3000ms) and second effect file --"
kill_api
sleep 1
run bash -lc "cd /workspace && API_PORT=3227 DATABASE_PATH=/workspace/rc027.sqlite \
  REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_DISTILL_BIN=/workspace/rc027-blocking-agent \
  REMOTECODE_RUNS_CWD=/workspace/rc027-workspace REMOTECODE_WEB_ORIGIN=http://localhost:5173 \
  REMOTECODE_RUN_STALL_MS=3000 RC027_EFFECT_FILE=/workspace/rc027-effect2.txt \
  bun apps/api/src/index.ts > /workspace/rc027-api3.log 2>&1 &"

say "-- wait for API ready --"
for _ in $(seq 1 60); do
  if run curl -fsS http://127.0.0.1:3227/api/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
done
say "api ready=$(run curl -fsS http://127.0.0.1:3227/api/health/ready)"

say "-- create a fresh run in the same workspace --"
RUN2=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt -X POST http://127.0.0.1:3227/api/runs \
  -H 'content-type: application/json' -d '{\"workspaceId\":\"$WS\",\"prompt\":\"Block this run until the stall watchdog fires.\"}'" | json_field "id")
say "run2=$RUN2"

say "-- wait for run2 to be running and effect2 file to have one line --"
for _ in $(seq 1 60); do
  BODY2=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt http://127.0.0.1:3227/api/runs/$RUN2")
  STATE2=$(printf '%s' "$BODY2" | json_field "state")
  LINES2=$(run bash -lc "wc -l < /workspace/rc027-effect2.txt" 2>/dev/null || echo 0)
  say "scenario2 poll: state=$STATE2 lines=$LINES2"
  if [ "$STATE2" = "running" ] && [ "$LINES2" = "1" ]; then break; fi
  sleep 1
done

say "-- verify run2 is running and effect2 file has one line --"
[ "$STATE2" = "running" ] || { say "FAIL run2 not running before stall: $BODY2"; exit 1; }
[ "$LINES2" = "1" ] || { say "FAIL effect2 file does not have 1 line before stall: $LINES2"; exit 1; }

say "-- poll until run2 is interrupted with stalled (bound 60s) --"
STALL_START=$(date +%s)
STALL_DONE=false
for _ in $(seq 1 60); do
  BODY2_STALL=$(run bash -lc "curl -fsS -b /workspace/rc027-cookies.txt http://127.0.0.1:3227/api/runs/$RUN2")
  STATE2_STALL=$(printf '%s' "$BODY2_STALL" | json_field "state")
  STOP_REASON2=$(printf '%s' "$BODY2_STALL" | json_field "stopReason")
  NOW=$(date +%s)
  ELAPSED=$((NOW - STALL_START))
  say "scenario2 stall poll: state=$STATE2_STALL stopReason=$STOP_REASON2 elapsed=${ELAPSED}s"
  if [ "$STATE2_STALL" = "interrupted" ] && [ "$STOP_REASON2" = "stalled" ]; then
    STALL_DONE=true
    break
  fi
  if [ "$ELAPSED" -ge 60 ]; then
    say "FAIL stall timeout after 60s: state=$STATE2_STALL stopReason=$STOP_REASON2 body=$BODY2_STALL"
    exit 1
  fi
  sleep 1
done

if [ "$STALL_DONE" = "false" ]; then
  say "FAIL run2 did not reach interrupted/stalled within 60s"; exit 1
fi

say "-- assert no agent process for run2 is running --"
AGENT_PIDS2=$(agent_pids)
if [ -n "$AGENT_PIDS2" ]; then
  say "FAIL agent still running after stall: pids=$AGENT_PIDS2"; exit 1
fi

say "-- assert effect2 file still has exactly one line --"
LINES2_AFTER=$(run bash -lc "wc -l < /workspace/rc027-effect2.txt" 2>/dev/null || echo 0)
say "effect2 file lines after stall: $LINES2_AFTER"
if [ "$LINES2_AFTER" != "1" ]; then
  say "FAIL effect2 file does not have 1 line after stall: $LINES2_AFTER"; exit 1
fi

say "Scenario 2 PASSED: stalled recorded correctly"

say ""
say "PASS rc027: host_restart and stalled scenarios both verified"

docker rm -f rc027-proof >/dev/null 2>&1 || true
