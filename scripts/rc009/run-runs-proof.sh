#!/usr/bin/env bash
# RC-009 executable proof: the backend starts, observes and reconciles a real
# Distill run. It starts a long run, kills the host API process, restarts it on
# the same database, and proves the run is interrupted (never "in progress")
# with no replayed effect.
#
# Requires: bun, curl, a logged-in host Distill home (~/.distill/auth.json).
# Usage: scripts/rc009/run-runs-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc009-runs}"
PORT="${RC009_PORT:-3119}"
DB="$OUTDIR/remotecode.sqlite"
WORKSPACE="$OUTDIR/workspace"
PASSWORD="rc009-local-password-longenough"
DISTILL="${RC009_DISTILL:-$HOME/.local/share/distill/bin/distill}"

mkdir -p "$OUTDIR" "$WORKSPACE"
TRANSCRIPT="$OUTDIR/rc009-runs.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
rm -f "$DB"

export DATABASE_PATH="$DB" REMOTECODE_AUTH_PASSWORD="$PASSWORD"
export REMOTECODE_DISTILL_BIN="$DISTILL" REMOTECODE_RUNS_CWD="$WORKSPACE"
export API_PORT="$PORT"

start_api() {
  ( cd "$ROOT" && exec bun apps/api/src/index.ts ) >"$OUTDIR/api-$1.log" 2>&1 &
  echo $! >"$OUTDIR/api.pid"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  say "FAIL API did not become ready"; tail -20 "$OUTDIR/api-$1.log" | tee -a "$TRANSCRIPT"; exit 1
}

login() {
  for _ in $(seq 1 20); do
    if curl -fsS -c "$OUTDIR/cookies-$1.txt" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
      -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" >/dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  say "FAIL login $1"; exit 1
}

say "== RC-009 run supervision proof =="
say "distill=$DISTILL port=$PORT db=$DB"

say "-- start API (1) --"
start_api 1
login 1

WS=$(curl -fsS -b "$OUTDIR/cookies-1.txt" -X POST "http://127.0.0.1:$PORT/api/workspaces" \
  -H 'content-type: application/json' -d '{"name":"rc009"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
say "workspace=$WS"

python3 - "$WS" "$OUTDIR/run1.json" <<'PY'
import json, sys
ws, path = sys.argv[1], sys.argv[2]
prompt = ("Create files one at a time in the current directory: for i in 01 02 03 04 05 06 07 08 09 10, "
          "create rc009-step-$i.txt containing step-$i, and after each file run the shell command sleep 3. Then stop.")
open(path, "w").write(json.dumps({"workspaceId": ws, "prompt": prompt}))
PY
RUN=$(curl -fsS -b "$OUTDIR/cookies-1.txt" -X POST "http://127.0.0.1:$PORT/api/runs" \
  -H 'content-type: application/json' --data-binary "@$OUTDIR/run1.json" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
say "run=$RUN"

state() { curl -fsS -b "$OUTDIR/cookies-1.txt" "http://127.0.0.1:$PORT/api/runs/$RUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])'; }

say "-- wait for the run to be observed as running --"
for _ in $(seq 1 120); do
  S=$(state || echo unknown)
  [ "$S" = "running" ] && break
  sleep 0.5
done
say "observed state=$S"
[ "$S" = "running" ] || { say "FAIL run never became running"; exit 1; }

sleep 20
say "-- partial effect before the kill --"
( ls "$WORKSPACE" || true ) | tr '\n' ' ' | tee -a "$TRANSCRIPT"; echo | tee -a "$TRANSCRIPT"
BEFORE_HASH=$( (cat "$WORKSPACE"/rc009-step-*.txt 2>/dev/null || true) | shasum -a 256 | awk '{print $1}')
BEFORE_COUNT=$( (ls "$WORKSPACE"/rc009-step-*.txt 2>/dev/null || true) | wc -l | tr -d ' ')
say "before: count=$BEFORE_COUNT hash=$BEFORE_HASH"

say "-- kill the host API process --"
kill -9 "$(cat "$OUTDIR/api.pid")" 2>/dev/null || true
for _ in $(seq 1 40); do
  kill -0 "$(cat "$OUTDIR/api.pid")" 2>/dev/null || break
  sleep 0.25
done

say "-- restart API (2) on the same database --"
start_api 2
login 2

AFTER=""
for _ in $(seq 1 20); do
  AFTER=$(curl -fsS -b "$OUTDIR/cookies-2.txt" "http://127.0.0.1:$PORT/api/runs/$RUN" 2>/dev/null || true)
  [ -n "$AFTER" ] && break
  sleep 0.3
done
say "reconciled run: $AFTER"
RECON_STATE=$(printf '%s' "$AFTER" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
RECON_REASON=$(printf '%s' "$AFTER" | python3 -c 'import sys,json;print(json.load(sys.stdin)["stopReason"])')
[ "$RECON_STATE" = "interrupted" ] || { say "FAIL run is $RECON_STATE after restart"; exit 1; }
[ "$RECON_REASON" = "host_restart" ] || { say "FAIL stopReason=$RECON_REASON"; exit 1; }

ROWS=$(python3 -c "import sqlite3;print(sqlite3.connect('$DB').execute('SELECT COUNT(*) FROM runs WHERE id=?',('$RUN',)).fetchone()[0])")
sleep 8
AFTER_HASH=$( (cat "$WORKSPACE"/rc009-step-*.txt 2>/dev/null || true) | shasum -a 256 | awk '{print $1}')
AFTER_COUNT=$( (ls "$WORKSPACE"/rc009-step-*.txt 2>/dev/null || true) | wc -l | tr -d ' ')
say "after: rows=$ROWS count=$AFTER_COUNT hash=$AFTER_HASH"
[ "$ROWS" = "1" ] || { say "FAIL run row count=$ROWS"; exit 1; }
[ "$BEFORE_HASH" = "$AFTER_HASH" ] || { say "FAIL effect changed after restart (replay?)"; exit 1; }

say "-- stop a second run through the API --"
python3 - "$WS" "$OUTDIR/run2.json" <<'PY'
import json, sys
ws, path = sys.argv[1], sys.argv[2]
open(path, "w").write(json.dumps({"workspaceId": ws, "prompt": "Run the shell command sleep 300, then stop."}))
PY
RUN2=$(curl -fsS -b "$OUTDIR/cookies-2.txt" -X POST "http://127.0.0.1:$PORT/api/runs" \
  -H 'content-type: application/json' --data-binary "@$OUTDIR/run2.json" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
for _ in $(seq 1 120); do
  S2=$(curl -fsS -b "$OUTDIR/cookies-2.txt" "http://127.0.0.1:$PORT/api/runs/$RUN2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])' || echo unknown)
  [ "$S2" = "running" ] && break
  sleep 0.5
done
curl -fsS -b "$OUTDIR/cookies-2.txt" -X POST "http://127.0.0.1:$PORT/api/runs/$RUN2/stop" >/dev/null
for _ in $(seq 1 60); do
  FIN=$(curl -fsS -b "$OUTDIR/cookies-2.txt" "http://127.0.0.1:$PORT/api/runs/$RUN2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
  [ "$FIN" != "running" ] && [ "$FIN" != "starting" ] && break
  sleep 0.5
done
say "stopped run state=$FIN"
[ "$FIN" = "interrupted" ] || { say "FAIL stop gave $FIN"; exit 1; }

kill -9 "$(cat "$OUTDIR/api.pid")" 2>/dev/null || true
pkill -f "rc009-step" 2>/dev/null || true
say ""
say "PASS rc009: running->host kill->restart=interrupted(host_restart), rows=$ROWS, effect frozen (count $BEFORE_COUNT->$AFTER_COUNT), stop=interrupted"