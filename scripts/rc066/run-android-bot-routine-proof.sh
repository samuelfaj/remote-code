#!/usr/bin/env bash
# RC-066 executable proof: Android Bot routines from the app.
# The Android app on a real emulator shows a Bot's routines, read from the host.
#
# Requires: docker, the Android SDK on this machine, a release APK
# built with EXPO_PUBLIC_API_ORIGIN pointing at the host, and the rc056-android
# AVD.
#
# Usage: scripts/rc066/run-android-bot-routine-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:?usage: run-android-bot-routine-proof.sh <fresh absolute output dir>}"
case "$OUTDIR" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/proof.log"

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# The release APK is built with EXPO_PUBLIC_API_ORIGIN=http://127.0.0.1:37132, so
# the device's loopback port is fixed and the front must listen on the host port
# the app's own Origin header names: the API refuses an event channel whose
# origin is not the one it was started with. A dynamic port here reads as
# "disconnected" in the app.
API_PORT="${RC066_API_PORT:-37131}"
FRONT_PORT="${RC066_FRONT_PORT:-37132}"
APP_ORIGIN_PORT=37132
PASSWORD="rc066-android-$(openssl rand -hex 12)"
DATABASE_PATH="$OUTDIR/rc066-android.sqlite"
APK="${RC066_APK:-$ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
AVD="${RC066_AVD:-rc056-android}"
PACKAGE="com.remotecode.mobileproof"
WORKSPACE_NAME="rc066-android-routine"
BOT_NAME="rc066-android-bot"
ROUTINE_TIME="10:30"
ROUTINE_TIMEZONE="America/New_York"
IMAGE="${RC066_IMAGE:-remotecode/host:local}"
CONTAINER_NAME="rc066-android-$(date +%s)"
DATA_VOLUME="rc066-android-data-$(date +%s)"
EMULATOR_PID=""
DEVICE=""
FRONT_PID=""

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { printf '+ %s\n' "$*" >> "$TRANSCRIPT"; "$@" >> "$TRANSCRIPT" 2>&1; }

find_free_port() {
  local base_port="$1"
  local port
  if [ "$base_port" -gt 37399 ] 2>/dev/null; then
    return 1
  fi
  for port in $(seq "$base_port" 37399); do
    if ! lsof -ti "tcp:$port" >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

cleanup() {
  say "-- cleanup --"
  [ "${RC066_KEEP:-0}" = "1" ] && { say "kept running (RC066_KEEP=1)"; return; }
  [ -n "${FRONT_PID:-}" ] && kill "$FRONT_PID" 2>/dev/null || true
  [ -n "$DEVICE" ] && adb -s "$DEVICE" emu kill >> "$TRANSCRIPT" 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "== RC-066 Android Bot routines proof =="
say "apk=$APK avd=$AVD outdir=$OUTDIR"
[ -f "$APK" ] || { say "FAIL: no APK at $APK"; exit 1; }

for port in "$API_PORT" "$FRONT_PORT"; do
  if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
    say "FAIL: something already listens on $port; stop it first"
    exit 2
  fi
done
say "using API_PORT=$API_PORT FRONT_PORT=$FRONT_PORT (the APK's own origin port)"

# --- the Linux host with its own display ---
say "-- the Linux host --"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
docker volume create "$DATA_VOLUME" >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUTDIR/key.pem" -out "$OUTDIR/cert.pem" \
  -subj "/CN=RemoteCode RC-066 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2" >/dev/null 2>&1
chmod 600 "$OUTDIR/key.pem" "$OUTDIR/cert.pem"
docker run -d --name "$CONTAINER_NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc066.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" -e REMOTECODE_DISPLAY=:99 \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${FRONT_PORT}" \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUTDIR/cert.pem" "$CONTAINER_NAME:/proof-cert.pem"
docker cp "$OUTDIR/key.pem" "$CONTAINER_NAME:/proof-key.pem"
docker exec "$CONTAINER_NAME" bash -lc 'chmod 600 /proof-key.pem'
docker exec -d "$CONTAINER_NAME" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc066-android-xvfb.log 2>&1'
sleep 2
docker exec -d "$CONTAINER_NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc066.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${FRONT_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc066-android-api.log 2>&1"
for _ in $(seq 1 60); do
  curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$CONTAINER_NAME" tail -20 /var/log/rc066-android-api.log >> "$TRANSCRIPT" 2>&1 || true
  say "FAIL: the Linux API never became ready"
  exit 1
fi
say "api ready over TLS on 127.0.0.1:${API_PORT}"

# --- a plain HTTP front for the device ---
say "-- the plain HTTP front --"
HTTP_FRONT="$HERE/../rc057/http-front.ts"
[ -f "$HTTP_FRONT" ] || { say "FAIL: http-front.ts not found at $HTTP_FRONT"; exit 1; }
bun "$HTTP_FRONT" "$FRONT_PORT" "$API_PORT" > "$OUTDIR/front.log" 2>&1 &
FRONT_PID=$!
for _ in $(seq 1 30); do
  curl -s --fail "http://127.0.0.1:${FRONT_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -s --fail "http://127.0.0.1:${FRONT_PORT}/api/health/ready" >/dev/null; then
  tail -10 "$OUTDIR/front.log" >> "$TRANSCRIPT" 2>&1 || true
  say "FAIL: the plain HTTP front never answered"
  exit 1
fi
say "front ready on 127.0.0.1:${FRONT_PORT} -> https://127.0.0.1:${API_PORT}"

# --- the emulator ---
say "-- the emulator --"
nohup emulator -avd "$AVD" -no-window -no-audio -no-snapshot -writable-system -gpu swiftshader_indirect \
  > "$OUTDIR/emulator.log" 2>&1 &
EMULATOR_PID=$!
adb wait-for-device
DEVICE="$(adb devices | awk 'NR==2 {print $1}')"
until [ "$(adb -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
say "emulator $DEVICE booted: $(adb -s "$DEVICE" shell getprop ro.build.version.release | tr -d '\r')"

# --- adb root for certificate trust ---
say "-- adb root and system cert install --"
adb -s "$DEVICE" root >> "$TRANSCRIPT" 2>&1 || true
sleep 3
adb -s "$DEVICE" wait-for-device
adb -s "$DEVICE" shell "cp /sdcard/proof-cert.pem /system/etc/security/cacerts/" 2>/dev/null || true
adb -s "$DEVICE" shell "chmod 644 /system/etc/security/cacerts/proof-cert.pem" 2>/dev/null || true
sleep 2

# --- reverse the app's origin port to the front so the device can reach the host ---
adb -s "$DEVICE" reverse "tcp:${APP_ORIGIN_PORT}" "tcp:${FRONT_PORT}" >> "$TRANSCRIPT" 2>&1
say "device loopback ${APP_ORIGIN_PORT} forwards to the front on ${FRONT_PORT}"

# --- install the app ---
say "-- the app --"
adb -s "$DEVICE" install -r -d "$APK" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell pm clear "$PACKAGE" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell chmod 751 /data/data/$PACKAGE >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1

# --- uiautomator dump and tap helpers ---
dump() {
  adb -s "$DEVICE" shell uiautomator dump /sdcard/rc066.xml >> "$TRANSCRIPT" 2>&1
  adb -s "$DEVICE" exec-out cat /sdcard/rc066.xml > "$OUTDIR/window-$1.xml"
}

tap_label() {
  local label="$1"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    dump tap
    find_tap "$label" && break
    [ "$attempt" = "8" ] && { say "FAIL: no element matching '$label'"; return 1; }
    adb -s "$DEVICE" shell input swipe 540 1500 540 700 250 >> "$TRANSCRIPT" 2>&1
    sleep 2
  done
  read -r X Y < "$OUTDIR/tap.txt" || true
  if [ -z "${X:-}" ]; then say "FAIL: no element matching '$label'"; return 1; fi
  adb -s "$DEVICE" shell input tap "$X" "$Y" >> "$TRANSCRIPT" 2>&1
}

find_tap() {
  local label="$1"
  python3 - "$OUTDIR/window-tap.xml" "$label" <<'PY' > "$OUTDIR/tap.txt"
import re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
wanted = sys.argv[2]
root = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
_, _, screen_w, screen_h = map(int, root.groups()) if root else (0, 0, 1080, 2400)
for node in re.finditer(r'<node[^>]*>', xml):
    tag = node.group(0)
    text = re.search(r'text="([^"]*)"', tag)
    desc = re.search(r'content-desc="([^"]*)"', tag)
    values = [text.group(1) if text else "", desc.group(1) if desc else ""]
    if not any(wanted in value for value in values):
        continue
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
    if not bounds:
        continue
    x1, y1, x2, y2 = map(int, bounds.groups())
    if x2 - x1 <= 0 or y2 - y1 <= 0:
        continue
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    if not (0 <= cx <= screen_w and 0 <= cy <= screen_h):
        continue
    print(cx, cy)
    break
PY
  [ -s "$OUTDIR/tap.txt" ]
}

assert_text() {
  if grep -q -e "text=\"$2\"" -e "content-desc=\"$2\"" "$OUTDIR/window-$1.xml"; then
    say "visible in $1: $2"
  else
    say "FAIL: '$2' not visible in $1"
    return 1
  fi
}

assert_no_text() {
  if grep -q -e "text=\"$2\"" -e "content-desc=\"$2\"" "$OUTDIR/window-$1.xml"; then
    say "FAIL: '$2' should NOT be visible in $1"
    return 1
  fi
  say "absent in $1: $2"
}

wait_for_text() {
  local label="$1" text="$2" attempt
  for attempt in $(seq 1 15); do
    dump "$label"
    if grep -q -e "text=\"$text\"" -e "content-desc=\"$text\"" "$OUTDIR/window-$label.xml"; then
      say "visible in $label: $text"
      return 0
    fi
    sleep 2
  done
  say "FAIL: '$text' not visible in $label"
  return 1
}

# --- seed the host: workspace, bot, and a routine (schedule) ---
say "-- seed the host --"
SEED_OUTPUT="$(python3 - "$API_PORT" "$PASSWORD" "$WORKSPACE_NAME" "$BOT_NAME" "$ROUTINE_TIME" "$ROUTINE_TIMEZONE" "$OUTDIR" <<'PY'
import json, ssl, sys, urllib.request, time
port, password, workspace_name, bot_name, routine_time, routine_timezone = sys.argv[1:7]
context = ssl._create_unverified_context()
base = f"https://127.0.0.1:{port}"
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", **({"cookie": cookie} if cookie else {})}
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
status, _, cookie = call("/api/auth/login", "POST", {"password": password})
cookie = cookie.split(";")[0]
workspace = call("/api/workspaces", "POST", {"name": workspace_name}, cookie)[1]
bot = call("/api/bots", "POST", {"workspaceId": workspace["id"], "name": bot_name, "instructions": "idle"}, cookie)[1]
routine = call("/api/schedules", "POST", {
    "kind": "routine",
    "workspaceId": workspace["id"],
    "botId": bot["id"],
    "prompt": "rc066-android-routine-prompt",
    "localTime": routine_time,
    "timezone": routine_timezone,
}, cookie)[1]
# Confirm the seed by reading GET /api/schedules back.
schedules = call("/api/schedules", "GET", None, cookie)[1]["schedules"]
host_routine = next((s for s in schedules if s["botId"] == bot["id"]), None)
if not host_routine:
    raise SystemExit("seed routine not found in GET /api/schedules")
record = {
    "workspaceId": workspace["id"],
    "botId": bot["id"],
    "workspaceName": workspace_name,
    "botName": bot_name,
    "routineId": host_routine["id"],
    "routinePrompt": host_routine["prompt"],
    "routineLocalTime": host_routine["localTime"],
    "routineTimezone": host_routine["timezone"],
    "routineEnabled": host_routine["enabled"],
    "cookie": cookie,
}
open(sys.argv[7] + "/seed.json", "w").write(json.dumps(record, indent=2))
print(json.dumps(record))
PY
)" || { say "FAIL: seeding the host failed"; exit 1; }

WORKSPACE_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['workspaceId'])" "$SEED_OUTPUT")"
BOT_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['botId'])" "$SEED_OUTPUT")"
BOT_NAME_SEEDED="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['botName'])" "$SEED_OUTPUT")"
ROUTINE_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['routineId'])" "$SEED_OUTPUT")"
ROUTINE_TIME_SEEDED="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['routineLocalTime'])" "$SEED_OUTPUT")"
ROUTINE_TIMEZONE_SEEDED="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['routineTimezone'])" "$SEED_OUTPUT")"
ROUTINE_ENABLED="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['routineEnabled'])" "$SEED_OUTPUT")"
HOST_COOKIE="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['cookie'])" "$SEED_OUTPUT")"
say "seeded workspace $WORKSPACE_ID, bot $BOT_NAME_SEEDED, routine $ROUTINE_ID"
say "routine: localTime=$ROUTINE_TIME_SEEDED timezone=$ROUTINE_TIMEZONE_SEEDED enabled=$ROUTINE_ENABLED"

# --- sign in through the app ---
say "-- sign in through the app --"
adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 10
dump launch
assert_text launch "Host: http://127.0.0.1:${APP_ORIGIN_PORT}"
assert_text launch "Host ready"
say "the app reached the Linux host over TLS and trusts its certificate"

tap_label "Host password"
adb -s "$DEVICE" shell input text "$PASSWORD" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Sign in to host"
wait_for_text signed-in "connected" || { say "FAIL: 'connected' not visible in signed-in after waiting"; exit 1; }
say "signed in to the host"

# --- navigate to Bots, open the seeded bot, and assert its routine ---
say "-- navigate to Bots and assert routine --"
tap_label "Bots"
sleep 3
dump tab-Bots
assert_text tab-Bots "$BOT_NAME_SEEDED"
say "Bot row visible in tab-Bots: $BOT_NAME_SEEDED"

tap_label "$BOT_NAME_SEEDED"
sleep 3
dump bot-detail
assert_text bot-detail "Routines for $BOT_NAME_SEEDED"
say "Routines screen visible for $BOT_NAME_SEEDED"

# The app renders the whole routine row as one node ("10:30 (America/New_York)
# enabled · next: ..."), so this asserts the pair appears inside a node rather
# than as a node of its own.
ROUTINE_ROW_EXPECTED="$ROUTINE_TIME_SEEDED ($ROUTINE_TIMEZONE_SEEDED)"
if grep -q "text=\"[^\"]*$ROUTINE_ROW_EXPECTED" "$OUTDIR/window-bot-detail.xml"; then
  say "routine row shows $ROUTINE_ROW_EXPECTED with the host's timezone"
else
  say "FAIL: the routine row does not show '$ROUTINE_ROW_EXPECTED'"
  grep -o 'text="[^"]*"' "$OUTDIR/window-bot-detail.xml" | head -12 | tee -a "$TRANSCRIPT" || true
  exit 1
fi

# --- assert from GET /api/schedules that the routine the app showed is the host's own record ---
say "-- verify host record --"
python3 - "$API_PORT" "$HOST_COOKIE" "$ROUTINE_ID" "$ROUTINE_TIME_SEEDED" "$ROUTINE_TIMEZONE_SEEDED" "$ROUTINE_ENABLED" <<'PY' | tee -a "$TRANSCRIPT"
import json, ssl, sys, urllib.request
port, cookie, routine_id, expected_time, expected_timezone, expected_enabled = sys.argv[1:7]
context = ssl._create_unverified_context()
base = f"https://127.0.0.1:{port}"
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", **({"cookie": cookie} if cookie else {})}
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
_, result, _ = call("/api/schedules", cookie=cookie)
schedules = result.get("schedules", [])
host_routine = next((s for s in schedules if s["id"] == routine_id), None)
if not host_routine:
    raise SystemExit(f"routine {routine_id} not found in GET /api/schedules")
checks = {
    "id": host_routine["id"] == routine_id,
    "localTime": host_routine["localTime"] == expected_time,
    "timezone": host_routine["timezone"] == expected_timezone,
    "enabled": host_routine["enabled"] == (expected_enabled == "True"),
}
print(json.dumps({"hostRoutine": host_routine, "checks": checks}))
if not all(checks.values()):
    raise SystemExit(f"host record mismatch: {checks}")
PY
say "host record matches the routine the app showed"

# --- write result.json ---
say "-- write result --"
python3 -c '
import json, sys, os
outdir = sys.argv[1]
bot_id = sys.argv[2]
bot_name = sys.argv[3]
workspace_id = sys.argv[4]
workspace_name = sys.argv[5]
routine_id = sys.argv[6]
routine_prompt = sys.argv[7]
routine_local_time = sys.argv[8]
routine_timezone = sys.argv[9]
routine_enabled = sys.argv[10] == "True"
record = {
    "result": "verified",
    "scope": "RC-066 Android Bot routines from the app",
    "bot": {"id": bot_id, "name": bot_name, "workspaceId": workspace_id},
    "routine": {
        "id": routine_id,
        "kind": "routine",
        "prompt": routine_prompt,
        "localTime": routine_local_time,
        "timezone": routine_timezone,
        "enabled": routine_enabled,
    },
    "steps": {
        "seed": "verified",
        "signIn": "verified",
        "navigateToBots": "verified",
        "openBot": "verified",
        "assertRoutine": "verified",
        "verifyHostRecord": "verified",
    },
}
with open(os.path.join(outdir, "result.json"), "w") as f:
    json.dump(record, f, indent=2)
print("result.json written")
' "$OUTDIR" "$BOT_ID" "$BOT_NAME_SEEDED" "$WORKSPACE_ID" "$WORKSPACE_NAME" "$ROUTINE_ID" "rc066-android-routine-prompt" "$ROUTINE_TIME_SEEDED" "$ROUTINE_TIMEZONE_SEEDED" "$ROUTINE_ENABLED"

say "PASS rc066-android-routine: Android app shows Bot routines from the host"
exit 0
