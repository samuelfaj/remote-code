#!/usr/bin/env bash
# RC-067 executable proof: install the published v0.1.0 artifact from the
# public GitHub release, create a paid test account via signed billing
# webhooks, drive a real journey from a browser and from the Linux GUI,
# end the test billing, and verify everything.
#
# Requires: docker, curl, openssl, python3, bun
# Usage: scripts/rc067/run-publish-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:?usage: run-publish-proof.sh <fresh absolute output dir>}"
case "$OUTDIR" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUTDIR"

WORKDIR="$(mktemp -d)"
CLONE_DIR="$WORKDIR/remote-code"
TRANSCRIPT="$OUTDIR/proof.log"
IMAGE="remotecode/host:rc067"
CONTAINER="rc067-linux-$(date +%s)"
DATA_VOLUME="rc067-data-$(date +%s)"
API_PORT=37400
WEB_PORT=37401
PASSWORD="rc067-linux-$(openssl rand -hex 16)"
WEBHOOK_SECRET="rc067-billing-$(openssl rand -hex 16)"
VITE_PID=""

declare -a CMD_HISTORY=()
CMD_COUNT=0

log_cmd() {
  CMD_COUNT=$((CMD_COUNT + 1))
  CMD_HISTORY+=("$CMD_COUNT: $*")
}

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

cleanup() {
  say "-- cleanup --"
  [[ -n "${VITE_PID:-}" ]] && kill "$VITE_PID" 2>/dev/null || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

write_result() {
  local result="$1"
  local error="${2:-}"
  local steps_json="${3:-{}}"
  python3 - "$OUTDIR" "$result" "$error" "$steps_json" <<'PY'
import json, sys
out, result, error, steps_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
record = {
  "result": result,
  "scope": "RC-067 published artifact: install, paid test account, journeys, billing ended",
  "release": "v0.1.0",
  "steps": json.loads(steps_json),
}
if error:
  record["error"] = error
with open(out + "/result.json", "w") as f:
  json.dump(record, f, indent=2)
PY
}

say "== RC-067 published artifact proof =="
say "outdir=$OUTDIR workdir=$WORKDIR"

# --- 1. clone the public artifact -----------------------------------------
say "-- clone --"
log_cmd "git clone --depth 1 --branch v0.1.0 https://github.com/samuelfaj/remote-code.git $CLONE_DIR"
git clone --depth 1 --branch v0.1.0 https://github.com/samuelfaj/remote-code.git "$CLONE_DIR" 2>&1 | tee -a "$TRANSCRIPT"
say "cloned into $CLONE_DIR"

# --- 2. build the image ---------------------------------------------------
say "-- build image --"
log_cmd "docker build -t $IMAGE -f prototype/Dockerfile $CLONE_DIR"
docker build -t "$IMAGE" -f "$CLONE_DIR/prototype/Dockerfile" "$CLONE_DIR" 2>&1 | tee -a "$TRANSCRIPT"
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE" | tee -a "$TRANSCRIPT")
say "image id=${IMAGE_ID:0:19}"

# --- 3. record INSTALL.md version section --------------------------------
INSTALL_MD_VERSION=$(sed -n '/^## 3b\./,/^## [0-9]/{/^## [0-9]/d;p;}' "$CLONE_DIR/INSTALL.md" | tee -a "$TRANSCRIPT")
say "INSTALL.md version section recorded"

# --- 4. TLS certificate (rc054 pattern) -----------------------------------
say "-- TLS certificate --"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUTDIR/key.pem" -out "$OUTDIR/cert.pem" \
  -subj "/CN=RemoteCode RC-067 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUTDIR/key.pem" "$OUTDIR/cert.pem"
say "cert and key written"

# --- 5. start the host container ------------------------------------------
say "-- container --"
log_cmd "docker volume create $DATA_VOLUME"
docker volume create "$DATA_VOLUME" >/dev/null

log_cmd "docker run -d --name $CONTAINER -p 127.0.0.1:${API_PORT}:3000 -v $DATA_VOLUME:/var/lib/remotecode -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc067.sqlite -e REMOTECODE_AUTH_PASSWORD=$PASSWORD -e REMOTECODE_BILLING_WEBHOOK_SECRET=$WEBHOOK_SECRET -e REMOTECODE_WEB_ORIGIN=http://127.0.0.1:${WEB_PORT} -e REMOTECODE_DISPLAY=:99 $IMAGE sleep infinity"
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${API_PORT}:3000" \
  -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 \
  -e DATABASE_PATH=/var/lib/remotecode/rc067.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_BILLING_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}" \
  -e REMOTECODE_DISPLAY=:99 \
  "$IMAGE" sleep infinity >/dev/null

CONTAINER_ID=$(docker inspect -f '{{.Id}}' "$CONTAINER" | tee -a "$TRANSCRIPT")
say "container id=${CONTAINER_ID:0:19}"

# Copy TLS cert and key into the container
docker cp "$OUTDIR/cert.pem" "$CONTAINER:/proof-cert.pem"
docker cp "$OUTDIR/key.pem" "$CONTAINER:/proof-key.pem"
docker exec "$CONTAINER" bash -lc 'chmod 600 /proof-key.pem'

# Start the API inside the container
log_cmd "docker exec -d $CONTAINER bash -lc 'cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc067.sqlite REMOTECODE_AUTH_PASSWORD=$PASSWORD REMOTECODE_BILLING_WEBHOOK_SECRET=$WEBHOOK_SECRET REMOTECODE_WEB_ORIGIN=http://127.0.0.1:${WEB_PORT} REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc067-api.log 2>&1'"
docker exec -d "$CONTAINER" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc067.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_BILLING_WEBHOOK_SECRET='$WEBHOOK_SECRET' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc067-api.log 2>&1"

# --- 6. wait for API health -----------------------------------------------
say "-- wait for API --"
for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1; then
  docker exec "$CONTAINER" tail -20 /var/log/rc067-api.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the API never became ready"
  write_result "failed" "api_never_became_ready"
  exit 1
fi
say "API ready over TLS on 127.0.0.1:${API_PORT}"

# --- 7. the GUI half of the image -----------------------------------------
say "-- start the container GUI --"
# Detached, because a foreground exec waits on the children that hold its pipes.
docker exec "$CONTAINER" bash -lc 'rm -f /tmp/.X99-lock' || true
docker exec -d "$CONTAINER" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc067-xvfb.log 2>&1'
sleep 2
docker exec -d "$CONTAINER" bash -lc 'DISPLAY=:99 openbox --sm-disable > /var/log/rc067-openbox.log 2>&1'
sleep 1
docker exec -d "$CONTAINER" bash -lc 'DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --remote-debugging-port=9222 --user-data-dir=/var/lib/rc067-gui about:blank > /var/log/rc067-chromium.log 2>&1'
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" curl -fsS "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker exec "$CONTAINER" curl -fsS "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
  docker exec "$CONTAINER" tail -5 /var/log/rc067-chromium.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the image's guest Chromium did not start"
  write_result "failed" "chromium_not_started"
  exit 1
fi
say "guest Chromium is running in the published image"

# --- 8. create a paid test account ----------------------------------------
say "-- paid test account --"

# Helper: sign a webhook body with HMAC-SHA256
sign_webhook() {
  printf '%s' "$1" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary | xxd -p -c 64
}

# Log in to get the session and userId
COOKIE_JAR="$WORKDIR/rc067-cookies.txt"
curl -sk --fail -X POST "https://127.0.0.1:${API_PORT}/api/auth/login" \
  -H "content-type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" -c "$COOKIE_JAR" -o /dev/null
if ! grep -q remotecode "$COOKIE_JAR"; then
  say "FAIL: the published host refused the passphrase"
  write_result "failed" "login_failed"
  exit 1
fi
COOKIE=$(awk '/remotecode/ {print $6"="$7}' "$COOKIE_JAR" | head -1)
say "login cookie obtained"

# Get userId from session
SESSION_RESP=$(curl -sk --fail "https://127.0.0.1:${API_PORT}/api/auth/session" \
  -H "cookie: $COOKIE" 2>&1)
USER_ID=$(printf '%s' "$SESSION_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("userId",""))' 2>/dev/null || true)
if [[ -z "$USER_ID" ]]; then
  say "FAIL: could not get userId from session"
  write_result "failed" "session_user_missing"
  exit 1
fi
say "userId=$USER_ID"

# Deliver signed checkout webhook
CHECKOUT_EVENT=$(python3 -c "
import json, uuid, datetime
event = {
    'eventId': str(uuid.uuid4()),
    'kind': 'checkout.completed',
    'sequence': 1,
    'userId': '$USER_ID',
    'plan': 'hosted-basic',
    'hostedAccountId': str(uuid.uuid4()),
    'occurredAt': datetime.datetime.utcnow().isoformat() + 'Z'
}
print(json.dumps(event))
")
CHECKOUT_SIG=$(sign_webhook "$CHECKOUT_EVENT")
CHECKOUT_RESULT=$(curl -sk -X POST "https://127.0.0.1:${API_PORT}/api/billing/webhook" \
  -H "content-type: application/json" \
  -H "x-rc-signature: $CHECKOUT_SIG" \
  -d "$CHECKOUT_EVENT" 2>&1)
CHECKOUT_STATUS=$(printf '%s' "$CHECKOUT_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status",0))' 2>/dev/null || echo "0")
CHECKOUT_APPLIED=$(printf '%s' "$CHECKOUT_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("applied",False))' 2>/dev/null || echo "False")
say "checkout webhook status=$CHECKOUT_STATUS applied=$CHECKOUT_APPLIED"

if [[ "$CHECKOUT_APPLIED" != "True" ]]; then
  say "FAIL: checkout webhook was not applied"
  write_result "failed" "checkout_not_applied"
  exit 1
fi

# Retry subscription read for bounded time
SUBSCRIPTION_STATE=""
for _ in $(seq 1 30); do
  SUB_RESP=$(curl -sk --fail "https://127.0.0.1:${API_PORT}/api/billing/subscription" \
    -H "cookie: $COOKIE" 2>&1)
  SUBSCRIPTION_STATE=$(printf '%s' "$SUB_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("state",""))' 2>/dev/null || true)
  if [[ "$SUBSCRIPTION_STATE" == "active" ]]; then break; fi
  sleep 1
done
say "subscription state after checkout: $SUBSCRIPTION_STATE"

if [[ "$SUBSCRIPTION_STATE" != "active" ]]; then
  say "FAIL: subscription is not active after checkout"
  write_result "failed" "subscription_not_active_after_checkout"
  exit 1
fi

SUBSCRIPTION_PLAN=$(printf '%s' "$SUB_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("plan",""))' 2>/dev/null || true)
say "subscription plan: $SUBSCRIPTION_PLAN"

# --- 9. serve clone's web app via Vite ------------------------------------
say "-- the clone's own dependencies --"
# The clone is the published artifact, so its own lockfile decides what runs
# in front of the published host.
( cd "$CLONE_DIR" && bun install --frozen-lockfile >/dev/null 2>&1 ) || { say "FAIL: the clone's dependencies did not install"; write_result "failed" "clone_install_failed"; exit 1; }

say "-- Vite server --"
REMOTECODE_WEB_PROXY_TARGET="https://127.0.0.1:${API_PORT}" WEB_PORT="$WEB_PORT" \
  bunx vite --config "$CLONE_DIR/apps/web/vite.config.ts" --host 127.0.0.1 \
  > "$OUTDIR/vite.log" 2>&1 &
VITE_PID=$!
for _ in $(seq 1 60); do
  if curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
  tail -20 "$OUTDIR/vite.log" | tee -a "$TRANSCRIPT" >&2
  say "FAIL: the Vite server never became ready"
  write_result "failed" "vite_never_ready"
  exit 1
fi
say "Vite ready on http://127.0.0.1:${WEB_PORT}"

# --- 10. browser journey (e2e test) --------------------------------------
say "-- browser journey --"
BROWSER_STATUS=0
set +e
# The journey runs from the clone against the Vite in front of the published
# host, so the clone's own Playwright config finds it: RC003_WEB_URL stops the
# config from starting a second API of its own.
cp "$HERE/rc067-client.spec.ts" "$CLONE_DIR/apps/web/e2e/rc067-published-client.spec.ts"
( cd "$CLONE_DIR" && RC054_LINUX_HOST=1 \
  RC003_WEB_URL="http://127.0.0.1:${WEB_PORT}" \
  RC003_API_URL="http://127.0.0.1:${WEB_PORT}" \
  RC003_AUTH_PASSWORD="$PASSWORD" \
  bun run test:e2e -- "apps/web/e2e/rc067-published-client.spec.ts" 2>&1 | tee -a "$TRANSCRIPT" | tail -12 )
BROWSER_STATUS=${PIPESTATUS[0]}
set -e
say "browser spec exit status: $BROWSER_STATUS"

if [[ "$BROWSER_STATUS" != "0" ]]; then
  say "FAIL: browser journey failed"
  write_result "failed" "browser_journey_failed"
  exit 1
fi
say "browser journey passed"

# --- 11. Linux GUI journey inside the container ---------------------------
say "-- Linux GUI journey --"

# The journey runs inside the published container, where the GUI lives, so its
# commands go in as a file rather than through nested shell quoting.
docker exec "$CONTAINER" bash -lc 'pgrep -x Xvfb >/dev/null 2>&1 || (Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc067-xvfb.log 2>&1 &)' >/dev/null 2>&1 || true
sleep 2
docker cp "$HERE/gui-journey.sh" "$CONTAINER:/tmp/rc067-gui.sh"
GUI_LINE=$(docker exec "$CONTAINER" bash -lc "RC067_PASSWORD='$PASSWORD' bash /tmp/rc067-gui.sh" | tail -1)
say "GUI journey: $GUI_LINE"
GUI_TAKE=$(printf '%s' "$GUI_LINE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("takeState",""))' 2>/dev/null || echo "")
GUI_AFTER=$(printf '%s' "$GUI_LINE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("stateAfterRelease",""))' 2>/dev/null || echo "")
GUI_SCREEN=$(printf '%s' "$GUI_LINE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("screenBytes",0))' 2>/dev/null || echo "0")

if [[ "$GUI_TAKE" != "holder" ]]; then
  say "FAIL: the host did not record holder after the GUI took the screen"
  write_result "failed" "gui_take_possession_failed"
  exit 1
fi
if [[ "$(printf '%s' "$GUI_LINE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("releaseStatus",""))' 2>/dev/null)" != "released" ]]; then
  say "FAIL: the GUI's release was not accepted by the host"
  write_result "failed" "gui_release_rejected"
  exit 1
fi
if [[ "$GUI_AFTER" != "none" ]]; then
  say "FAIL: the host did not record none after the GUI released the screen"
  write_result "failed" "gui_release_possession_failed"
  exit 1
fi
if [[ "${GUI_SCREEN:-0}" -lt 1000 ]]; then
  say "FAIL: the container's own display produced no real capture ($GUI_SCREEN bytes)"
  write_result "failed" "gui_screen_capture_empty"
  exit 1
fi
say "Linux GUI journey passed: holder -> none, ${GUI_SCREEN} bytes captured from the container's display"

# --- 12. end test billing ------------------------------------------------
say "-- end test billing --"
CANCEL_EVENT=$(python3 -c "
import json, uuid, datetime
event = {
    'eventId': str(uuid.uuid4()),
    'kind': 'subscription.canceled',
    'sequence': 5,
    'userId': '$USER_ID',
    'occurredAt': datetime.datetime.utcnow().isoformat() + 'Z'
}
print(json.dumps(event))
")
CANCEL_SIG=$(sign_webhook "$CANCEL_EVENT")
CANCEL_RESULT=$(curl -sk -X POST "https://127.0.0.1:${API_PORT}/api/billing/webhook" \
  -H "content-type: application/json" \
  -H "x-rc-signature: $CANCEL_SIG" \
  -d "$CANCEL_EVENT" 2>&1)
CANCEL_STATUS=$(printf '%s' "$CANCEL_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status",0))' 2>/dev/null || echo "0")
CANCEL_APPLIED=$(printf '%s' "$CANCEL_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("applied",False))' 2>/dev/null || echo "False")
say "cancel webhook status=$CANCEL_STATUS applied=$CANCEL_APPLIED"

if [[ "$CANCEL_APPLIED" != "True" ]]; then
  say "FAIL: cancel webhook was not applied"
  write_result "failed" "cancel_not_applied"
  exit 1
fi

# Retry subscription read for bounded time
FINAL_STATE=""
for _ in $(seq 1 30); do
  FINAL_RESP=$(curl -sk --fail "https://127.0.0.1:${API_PORT}/api/billing/subscription" \
    -H "cookie: $COOKIE" 2>&1)
  FINAL_STATE=$(printf '%s' "$FINAL_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("state",""))' 2>/dev/null || true)
  if [[ "$FINAL_STATE" == "canceled" ]]; then break; fi
  sleep 1
done
say "subscription state after cancel: $FINAL_STATE"

if [[ "$FINAL_STATE" != "canceled" ]]; then
  say "FAIL: subscription is not canceled after cancel webhook"
  write_result "failed" "subscription_not_canceled"
  exit 1
fi
say "Billing ended: subscription is canceled"

# --- 13. write result.json and exit ---------------------------------------
say "-- proof complete --"
# Written straight to the file: the steps carry the ids this run observed, and
# passing them through a shell variable is what corrupted the JSON before.
python3 - "$OUTDIR" "$IMAGE_ID" <<'PY'
import json, sys
out, image_id = sys.argv[1], sys.argv[2]
record = {
  "result": "passed",
  "scope": "RC-067 published artifact: install, paid test account, journeys, billing ended",
  "release": "v0.1.0",
  "steps": {
    "install": {"status": "passed", "imageId": image_id[:19], "installMdVersion": "recorded"},
    "paid_account": {"status": "passed", "plan": "hosted-basic"},
    "browser_journey": {"status": "passed"},
    "linux_gui": {"status": "passed"},
    "billing_ended": {"status": "passed"},
  },
}
json.dump(record, open(out + "/result.json", "w"), indent=2)
PY
say "PASS rc067-publish: published artifact install, paid test account, journeys, billing ended"
exit 0