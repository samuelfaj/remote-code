#!/usr/bin/env bash
# RC-065 executable proof: after a real API restart inside the Linux host
# container, the UI still shows the correct file content and confirmed
# receipts, and the backend record shows exactly one create and one save
# (not duplicated by the restart). The proof also captures the API's own
# log across both runs, sanitizes it, and asserts the host passphrase and
# any gateway token never appear in the raw captured log.
#
# Requires: docker, curl, bun, a logged-in host Distill home.
# Usage: scripts/rc065/run-restart-log-ui-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:?usage: run-restart-log-ui-proof.sh <fresh absolute output dir>}"
case "$OUTDIR" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUTDIR"

IMAGE="${RC065_IMAGE:-remotecode/host:local}"
NAME="rc065-linux-$(date +%s)"
API_PORT="${RC065_API_PORT:-37125}"
WEB_PORT="${RC065_WEB_PORT:-37126}"
PASSWORD="rc065-linux-$(openssl rand -hex 12)"
DATA_VOLUME="rc065-data-$(date +%s)"
STATE_FILE="$OUTDIR/rc065-state.json"
RAW_LOG="$OUTDIR/rc065-api-raw.log"
SANITIZED_LOG="$OUTDIR/rc065-api-sanitized.log"
RESULT_JSON="$OUTDIR/result.json"
PROOF_DIR="$OUTDIR"

export RC065_STATE_FILE="$STATE_FILE"
export RC003_WEB_URL="http://127.0.0.1:${WEB_PORT}"
export RC003_API_URL="http://127.0.0.1:${WEB_PORT}"
export RC003_AUTH_PASSWORD="$PASSWORD"

cleanup() {
  [[ -n "${VITE_PID:-}" ]] && kill "$VITE_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$OUTDIR/proof.log"; }

say "== RC-065 restart-log-ui proof =="

# -- build image if absent --
say "-- build image --"
if [[ "${RC065_REBUILD:-0}" == "1" ]]; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$OUTDIR/proof.log"
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
say "image=$(docker image inspect -f '{{.Id}}' "$IMAGE")"

# -- TLS certificate --
say "-- TLS certificate --"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUTDIR/key.pem" -out "$OUTDIR/cert.pem" \
  -subj "/CN=RemoteCode RC-065 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUTDIR/key.pem" "$OUTDIR/cert.pem"

# -- start the Linux host container --
say "-- start the Linux host --"
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 \
  -e DATABASE_PATH=/var/lib/remotecode/rc065.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}" \
  -e REMOTECODE_DISPLAY=:99 \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUTDIR/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUTDIR/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'

# -- start the API inside the container, capturing stdout to a single log file --
say "-- start the API (first run) --"
docker exec -d "$NAME" bash -lc \
  "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc065.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc065-api.log 2>&1"

# -- wait for the API to become ready (bounded loop) --
say "-- wait for API ready --"
for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1; then
  say "FAIL API never became ready"; exit 1
fi
say "API ready over TLS on 127.0.0.1:${API_PORT}"

# -- start the local Vite proxy in front of the API --
say "-- start local Vite proxy --"
REMOTECODE_WEB_PROXY_TARGET="https://127.0.0.1:${API_PORT}" WEB_PORT="$WEB_PORT" \
  bunx vite --config "$ROOT/apps/web/vite.config.ts" --host 127.0.0.1 \
  > "$OUTDIR/vite.log" 2>&1 &
VITE_PID=$!
for _ in $(seq 1 60); do
  if curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
  tail -20 "$OUTDIR/vite.log" | tee -a "$OUTDIR/proof.log" >&2
  say "FAIL the web origin never became ready"; exit 1
fi
say "web ready on 127.0.0.1:${WEB_PORT}"

# -- PHASE: before --
say "-- phase: before --"
RC065_PHASE=before bun run test:e2e -- "apps/web/e2e/rc065-restart-log-ui.spec.ts" 2>&1 | tee -a "$OUTDIR/proof.log" | tail -5
BEFORE_EXIT=${PIPESTATUS[0]}
if [[ "$BEFORE_EXIT" -ne 0 ]]; then
  say "FAIL before phase exited $BEFORE_EXIT"; exit 1
fi
say "before phase passed"

# -- restart the API inside the container --
say "-- restart the API --"
API_PID=$(docker exec "$NAME" pgrep -f "apps/api/src/index.ts" | head -1 || true)
if [[ -n "$API_PID" ]]; then
  docker exec "$NAME" kill -9 "$API_PID" 2>/dev/null || true
  # Wait for the process to die.
  for _ in $(seq 1 20); do
    docker exec "$NAME" kill -0 "$API_PID" 2>/dev/null || break
    sleep 0.25
  done
fi

# Restart the API, appending to the same log so both runs are captured.
docker exec -d "$NAME" bash -lc \
  "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc065.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts >> /var/log/rc065-api.log 2>&1"

# -- wait for the API to become ready again (bounded loop) --
say "-- wait for API ready after restart --"
READY=0
for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 1
done
if [[ "$READY" -ne 1 ]]; then
  say "FAIL API did not become ready after restart"; exit 1
fi
say "API ready after restart"

# -- copy the captured log from the container to the host --
docker cp "$NAME:/var/log/rc065-api.log" "$RAW_LOG"

# -- PHASE: after --
say "-- phase: after --"
RC065_PHASE=after bun run test:e2e -- "apps/web/e2e/rc065-restart-log-ui.spec.ts" 2>&1 | tee -a "$OUTDIR/proof.log" | tail -5
AFTER_EXIT=${PIPESTATUS[0]}
if [[ "$AFTER_EXIT" -ne 0 ]]; then
  say "FAIL after phase exited $AFTER_EXIT"; exit 1
fi
say "after phase passed"

# -- sanitize the captured log --
say "-- sanitize log --"
# Filter: remove the host passphrase, any x-rc-* header values, and Bearer tokens.
# This is a documented filter that redacts secrets from the raw API log.
perl -pe "s/\Q$PASSWORD\E/REDACTED/g" "$RAW_LOG" \
  | perl -pe 's/(x-rc-[^:\s]+:\s*)[^\s]+/\1REDACTED/gi' \
  | perl -pe 's/Bearer\s+[a-zA-Z0-9._-]+/Bearer REDACTED/g' \
  > "$SANITIZED_LOG"

# -- assert the passphrase and any gateway token never appear in the raw log --
say "-- assert raw log has no secrets --"
if grep -qF "$PASSWORD" "$RAW_LOG"; then
  say "FAIL host passphrase found in raw API log"; exit 1
fi
say "passphrase not in raw log: ok"

if grep -qP 'Bearer\s+[a-zA-Z0-9._-]+' "$RAW_LOG"; then
  say "FAIL Bearer token found in raw API log"; exit 1
fi
say "Bearer token not in raw log: ok"

if grep -qPi 'x-rc-[^:]+:\s*\S+' "$RAW_LOG"; then
  say "FAIL x-rc-* header value found in raw API log"; exit 1
fi
say "x-rc-* header values not in raw log: ok"

# -- check the API's SQLite database directly with bun:sqlite to assert
#    one create and one save for the file, not two (no duplicate effect) --
say "-- check database with bun:sqlite --"
DB_PATH="/var/lib/remotecode/rc065.sqlite"
# Read the workspace name from the state file to look up the workspace ID.
WORKSPACE_NAME=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['workspaceName'])")

# Use bun:sqlite inside the container to count create and save intents for the file.
# The API does not expose a route to list all file receipts for a workspace,
# so we read the SQLite database directly.
DB_CHECK=$(docker exec "$NAME" bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('$DB_PATH');
const ws = db.query('SELECT id FROM workspaces WHERE name = ?').get('$WORKSPACE_NAME');
if (!ws) { console.log(JSON.stringify({error: 'workspace not found'})); process.exit(1); }
const rows = db.query('SELECT kind, COUNT(*) as count FROM file_operation_intents WHERE workspace_id = ? AND destination_path = ? GROUP BY kind').all(ws.id, '/rc065-test-file.txt');
console.log(JSON.stringify(rows));
db.close();
" 2>/dev/null)

say "database check result: $DB_CHECK"
CREATE_COUNT=$(printf '%s' "$DB_CHECK" | python3 -c "import json,sys;rows=json.load(sys.stdin);print(sum(r['count'] for r in rows if r['kind']=='create'))")
SAVE_COUNT=$(printf '%s' "$DB_CHECK" | python3 -c "import json,sys;rows=json.load(sys.stdin);print(sum(r['count'] for r in rows if r['kind']=='save'))")

if [[ "$CREATE_COUNT" -ne 1 ]]; then
  say "FAIL expected 1 create intent, got $CREATE_COUNT"; exit 1
fi
if [[ "$SAVE_COUNT" -ne 1 ]]; then
  say "FAIL expected 1 save intent, got $SAVE_COUNT"; exit 1
fi
say "database check ok: one create and one save, no duplicate effect"

# -- write result.json --
say "-- write result --"
python3 - "$OUTDIR" <<'PY'
import json, sys, os
out = sys.argv[1]
result = {
  "result": "verified",
  "scope": "RC-065 restart-log-ui: file content and receipts persist after API restart; no duplicate effect; raw log contains no passphrase or gateway token",
  "log": {
    "rawLog": os.path.join(out, "rc065-api-raw.log"),
    "sanitizedLog": os.path.join(out, "rc065-api-sanitized.log"),
    "sanitization": "passphrase replaced with REDACTED; x-rc-* header values replaced with REDACTED; Bearer tokens replaced with REDACTED",
  },
  "ui": {
    "beforePhase": "passed",
    "afterPhase": "passed",
    "connectionStatusAfterReload": "Live updates connected",
  },
}
with open(os.path.join(out, "result.json"), "w") as f:
  json.dump(result, f, indent=2)
print("result.json written")
PY

say ""
say "PASS rc065-restart-log-ui: file content and receipts persist after API restart; no duplicate effect; raw log contains no passphrase or gateway token"
exit 0
