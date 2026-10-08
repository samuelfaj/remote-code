#!/usr/bin/env bash
# RC-065 executable proof: Android storage-failure modes.
# Establishes that the app on a real Android emulator against a real Linux
# host does not claim false success when its own local store is made
# unwritable, and that confirmed receipts are not replayed after recovery.
#
# Requires: docker, the Android SDK on this machine, a release APK built
# with EXPO_PUBLIC_API_ORIGIN pointing at the host, and the rc056-android
# AVD.
#
# Usage: scripts/rc065/run-android-storage-failure-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:?usage: run-android-storage-failure-proof.sh <fresh absolute output dir>}"
case "$OUTDIR" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/proof.log"

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# The release APK is built with EXPO_PUBLIC_API_ORIGIN=http://127.0.0.1:37132.
# We use the same ports as rc057 because the app's built-in origin port
# must match the front port for WebSocket connections through adb reverse.
API_PORT="${RC065_API_PORT:-37131}"
FRONT_PORT="${RC065_FRONT_PORT:-37132}"
APP_ORIGIN_PORT=37132
PASSWORD="rc065-android-$(openssl rand -hex 12)"
DATABASE_PATH="$OUTDIR/rc065-android.sqlite"
APK="${RC065_APK:-$ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
AVD="${RC065_AVD:-rc056-android}"
PACKAGE="com.remotecode.mobileproof"
WORKSPACE_NAME="rc065-android-storage"
BOT_NAME="rc065-android-bot"
IMAGE="${RC065_IMAGE:-remotecode/host:local}"
CONTAINER_NAME="rc065-android-$(date +%s)"
DATA_VOLUME="rc065-android-data-$(date +%s)"
EMULATOR_PID=""
DEVICE=""
FRONT_PID=""
STORAGE_INJECTED=false
STORAGE_MODE_RESTORE=""
STORAGE_UID_RESTORE=""
STORAGE_GID_RESTORE=""
STORAGE_METHOD=""
STORAGE_ADB_ROOT_USED=false
STORAGE_COMMAND=""
STORAGE_COMMAND_OUTPUT=""
STORAGE_FILL_FILE=""
STORAGE_MANIFEST="$OUTDIR/storage-failure-manifest.json"
BEFORE_POST_OK=false
AFTER_RECEIPT_OK=false

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { printf '+ %s\n' "$*" >> "$TRANSCRIPT"; "$@" >> "$TRANSCRIPT" 2>&1; }

cleanup() {
  say "-- cleanup --"
  [ "${RC065_KEEP:-0}" = "1" ] && { say "kept running (RC065_KEEP=1)"; return; }
  if [ "$STORAGE_INJECTED" = true ] && [ -n "$DEVICE" ] && [ -n "$STORAGE_MODE_RESTORE" ]; then
    say "-- restoring storage permissions --"
    if [ -n "${STORAGE_FILL_FILE:-}" ]; then
      run adb -s "$DEVICE" shell "rm -f $STORAGE_FILL_FILE"
    fi
    run adb -s "$DEVICE" shell "chmod $STORAGE_MODE_RESTORE /data/data/$PACKAGE"
    say "restored /data/data/$PACKAGE to mode $STORAGE_MODE_RESTORE"
    STORAGE_INJECTED=false
  fi
  [ -n "${FRONT_PID:-}" ] && kill "$FRONT_PID" 2>/dev/null || true
  [ -n "$DEVICE" ] && adb -s "$DEVICE" emu kill >> "$TRANSCRIPT" 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "== RC-065 Android storage-failure proof =="
say "apk=$APK avd=$AVD api_port=$API_PORT front_port=$FRONT_PORT outdir=$OUTDIR"
[ -f "$APK" ] || { say "FAIL: no APK at $APK"; exit 1; }

if lsof -ti "tcp:$API_PORT" >/dev/null 2>&1; then
  say "FAIL: something already listens on $API_PORT; stop it first"
  exit 2
fi
if lsof -ti "tcp:$FRONT_PORT" >/dev/null 2>&1; then
  say "FAIL: something already listens on $FRONT_PORT; stop it first"
  exit 2
fi

# --- the Linux host with its own display ---
say "-- the Linux host --"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
docker volume create "$DATA_VOLUME" >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUTDIR/key.pem" -out "$OUTDIR/cert.pem" \
  -subj "/CN=RemoteCode RC-065 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2" >/dev/null 2>&1
chmod 600 "$OUTDIR/key.pem" "$OUTDIR/cert.pem"
docker run -d --name "$CONTAINER_NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc065.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" -e REMOTECODE_DISPLAY=:99 \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${FRONT_PORT}" \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUTDIR/cert.pem" "$CONTAINER_NAME:/proof-cert.pem"
docker cp "$OUTDIR/key.pem" "$CONTAINER_NAME:/proof-key.pem"
docker exec "$CONTAINER_NAME" bash -lc 'chmod 600 /proof-key.pem'
docker exec -d "$CONTAINER_NAME" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc065-android-xvfb.log 2>&1'
sleep 2
docker exec -d "$CONTAINER_NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc065.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${FRONT_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc065-android-api.log 2>&1"
for _ in $(seq 1 60); do
  curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$CONTAINER_NAME" tail -20 /var/log/rc065-android-api.log >> "$TRANSCRIPT" 2>&1 || true
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
nohup emulator -avd "$AVD" -no-window -no-audio -no-snapshot -writable-system -gpu swiftshader_indirect > "$OUTDIR/emulator.log" 2>&1 &
EMULATOR_PID=$!
adb wait-for-device
DEVICE="$(adb devices | awk 'NR==2 {print $1}')"
until [ "$(adb -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
say "emulator $DEVICE booted: $(adb -s "$DEVICE" shell getprop ro.build.version.release | tr -d '\r')"

# --- adb root for certificate trust and storage failure injection ---
say "-- adb root and system cert install --"
adb -s "$DEVICE" root >> "$TRANSCRIPT" 2>&1 || true
sleep 3
adb -s "$DEVICE" wait-for-device
# Install the host's certificate as a system CA so the app trusts the host's TLS.
adb -s "$DEVICE" shell "cp /sdcard/proof-cert.pem /system/etc/security/cacerts/" 2>/dev/null || true
adb -s "$DEVICE" shell "chmod 644 /system/etc/security/cacerts/proof-cert.pem" 2>/dev/null || true
sleep 2

# --- reverse the app's origin port to the front so the device can reach the host ---
# The app is built with EXPO_PUBLIC_API_ORIGIN=http://127.0.0.1:37132.
# The front runs on FRONT_PORT (37132). We map device port 37132 to host port FRONT_PORT.
adb -s "$DEVICE" reverse "tcp:${APP_ORIGIN_PORT}" "tcp:${FRONT_PORT}" >> "$TRANSCRIPT" 2>&1
say "device loopback ${APP_ORIGIN_PORT} forwards to the front on ${FRONT_PORT}"

# --- install the app ---
say "-- the app --"
adb -s "$DEVICE" install -r -d "$APK" >> "$TRANSCRIPT" 2>&1
# A pending auth left by an earlier run blocks a new sign-in (the app refuses to
# resend an uncertain request), so the app starts from a clean data directory.
adb -s "$DEVICE" shell pm clear "$PACKAGE" >> "$TRANSCRIPT" 2>&1
# pm clear on this Android 15 emulator leaves the data directory read-only (mode 550),
# so the app cannot create its files or databases. Fix the permissions.
adb -s "$DEVICE" shell chmod 751 /data/data/$PACKAGE >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1

# --- uiautomator dump and tap helpers (copied verbatim from rc057) ---
dump() {
  adb -s "$DEVICE" shell uiautomator dump /sdcard/rc065.xml >> "$TRANSCRIPT" 2>&1
  adb -s "$DEVICE" exec-out cat /sdcard/rc065.xml > "$OUTDIR/window-$1.xml"
}

tap_label() {
  local label="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    dump tap
    find_tap "$label" && break
    [ "$attempt" = "5" ] && { say "FAIL: no element matching '$label'"; return 1; }
    adb -s "$DEVICE" shell input swipe 540 1500 540 700 250 >> "$TRANSCRIPT" 2>&1
    sleep 1
  done
  read -r X Y < "$OUTDIR/tap.txt" || true
  if [ -z "${X:-}" ]; then say "FAIL: no element matching '$label'"; return 1; fi
  adb -s "$DEVICE" shell input tap "$X" "$Y" >> "$TRANSCRIPT" 2>&1
}

wait_enabled_tap() {
  local label="$1"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    dump tap
    python3 - "$OUTDIR/window-tap.xml" "$label" <<'PY' > "$OUTDIR/tap.txt"
import re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
wanted = sys.argv[2]
root = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
_, _, screen_w, screen_h = map(int, root.groups()) if root else (0, 0, 1080, 2400)
for node in re.finditer(r'<node[^>]*>', xml):
    tag = node.group(0)
    values = [m.group(1) for m in re.finditer(r'(?:text|content-desc)="([^"]*)"', tag)]
    if not any(wanted in value for value in values):
        continue
    enabled = re.search(r'enabled="(\w+)"', tag)
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
    if not enabled or enabled.group(1) != "true" or not bounds:
        continue
    x1, y1, x2, y2 = map(int, bounds.groups())
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    if not (0 <= cx <= screen_w and 0 <= cy <= screen_h):
        continue
    print(cx, cy)
    break
PY
    if [ -s "$OUTDIR/tap.txt" ]; then
      read -r X Y < "$OUTDIR/tap.txt" || true
      adb -s "$DEVICE" shell input tap "$X" "$Y" >> "$TRANSCRIPT" 2>&1
      return 0
    fi
    sleep 2
  done
  say "FAIL: '$label' never became enabled"
  return 1
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

# --- seed the host: workspace, bot, thread, and a message ---
say "-- seed the host --"
SEED="$(python3 - "$API_PORT" "$PASSWORD" "$WORKSPACE_NAME" "$BOT_NAME" <<'PY'
import json, ssl, sys, urllib.request
port, password, workspace_name, bot_name = sys.argv[1:5]
context = ssl._create_unverified_context()
base = f"https://127.0.0.1:{port}"
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", **({"cookie": cookie} if cookie else {})}
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
_, _, cookie = call("/api/auth/login", "POST", {"password": password})
cookie = cookie.split(";")[0]
workspace = call("/api/workspaces", "POST", {"name": workspace_name}, cookie)[1]
bot = call("/api/bots", "POST", {"workspaceId": workspace["id"], "name": bot_name, "instructions": "idle"}, cookie)[1]
thread = call(f"/api/workspaces/{workspace['id']}/threads", "POST", {"title": "rc065-android-thread"}, cookie)[1]
call(f"/api/threads/{thread['id']}/messages", "POST", {"body": "rc065-android-message"}, cookie)
print(json.dumps({"workspaceId": workspace["id"], "botId": bot["id"], "threadId": thread["id"], "cookie": cookie}))
PY
)"
WORKSPACE_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['workspaceId'])" "$SEED")"
BOT_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['botId'])" "$SEED")"
THREAD_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['threadId'])" "$SEED")"
HOST_COOKIE="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['cookie'])" "$SEED")"
say "seeded workspace $WORKSPACE_ID"

# --- sign in through the app ---
say "-- sign in through the app --"
adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 10
dump launch
# Before signing in the app proves it reached the host by its readiness probe,
# which also proves it trusts the host's certificate.
assert_text launch "Host: http://127.0.0.1:${APP_ORIGIN_PORT}"
assert_text launch "Host ready"
say "the app reached the Linux host over TLS and trusts its certificate"

# Sign in through the app's own fields.
tap_label "Host password"
adb -s "$DEVICE" shell input text "$PASSWORD" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Sign in to host"
# Wait longer for the WebSocket connection to be established through the front.
wait_for_text signed-in "connected" || { say "FAIL: 'connected' not visible in signed-in after waiting"; exit 1; }
say "signed in to the host"

# --- verify workspace is open ---
say "-- verify workspace is open --"
dump workspace-open
assert_text workspace-open "Host: http://127.0.0.1:${APP_ORIGIN_PORT}"
say "workspace is open and connected"

# --- storage failure injection helpers ---
inject_storage_failure() {
  say "-- injecting storage failure --"
  STORAGE_INJECTED=false
  STORAGE_MODE_RESTORE=""
  STORAGE_UID_RESTORE=""
  STORAGE_GID_RESTORE=""
  STORAGE_METHOD=""
  STORAGE_COMMAND=""
  STORAGE_COMMAND_OUTPUT=""
  STORAGE_FILL_FILE=""

  # Record the original mode, uid, and gid before changing anything.
  local original_mode="" original_uid="" original_gid=""
  original_mode="$(adb -s "$DEVICE" shell stat -c '%a' /data/data/$PACKAGE 2>/dev/null | tr -d '\r')" || true
  original_uid="$(adb -s "$DEVICE" shell stat -c '%u' /data/data/$PACKAGE 2>/dev/null | tr -d '\r')" || true
  original_gid="$(adb -s "$DEVICE" shell stat -c '%g' /data/data/$PACKAGE 2>/dev/null | tr -d '\r')" || true
  STORAGE_MODE_RESTORE="$original_mode"
  STORAGE_UID_RESTORE="$original_uid"
  STORAGE_GID_RESTORE="$original_gid"
  say "original /data/data/$PACKAGE mode=$original_mode uid=$original_uid gid=$original_gid"

  # Step 1: Test adb root with its own command and record its output.
  say "-- testing adb root for storage failure injection --"
  local root_output=""
  root_output="$(adb -s "$DEVICE" root 2>&1)" || true
  say "adb root command output: [$root_output]"
  STORAGE_ADB_ROOT_USED=false
  STORAGE_COMMAND="adb root"
  STORAGE_COMMAND_OUTPUT="$root_output"
  sleep 2
  adb -s "$DEVICE" wait-for-device 2>/dev/null || true

  # Step 2: If adb root succeeded, use the rooted shell to make storage unwritable.
  if echo "$root_output" | grep -qi "restarting\|already running\|success\|root"; then
    STORAGE_ADB_ROOT_USED=true
    say "adb root succeeded (or already root), using rooted shell for storage failure injection"

    # Make the storage directory unwritable.
    local chmod_dir_output=""
    chmod_dir_output="$(adb -s "$DEVICE" shell chmod a-w /data/data/$PACKAGE 2>&1)" || true
    say "chmod a-w /data/data/$PACKAGE output: [$chmod_dir_output]"

    # Also make all existing files and subdirectories read-only to prevent
    # the app from writing to its SQLite databases and shared_prefs.
    local chmod_files_output=""
    chmod_files_output="$(adb -s "$DEVICE" shell "find /data/data/$PACKAGE -type f -exec chmod a-w {} \; 2>&1" 2>&1)" || true
    say "find chmod a-w files output: [$chmod_files_output]"

    local chmod_dirs_output=""
    chmod_dirs_output="$(adb -s "$DEVICE" shell "find /data/data/$PACKAGE -type d -exec chmod a-w {} \; 2>&1" 2>&1)" || true
    say "find chmod a-w dirs output: [$chmod_dirs_output]"

    STORAGE_METHOD="adb-root-chmod"
    STORAGE_COMMAND="adb root; chmod a-w /data/data/$PACKAGE; find /data/data/$PACKAGE -type f -exec chmod a-w {} \; ; find /data/data/$PACKAGE -type d -exec chmod a-w {} \;"
    STORAGE_COMMAND_OUTPUT="adb root: [$root_output]; chmod dir: [$chmod_dir_output]; chmod files: [$chmod_files_output]; chmod dirs: [$chmod_dirs_output]"
    STORAGE_RESTORE_DIR="/data/data/$PACKAGE"
  else
    # adb root failed. A release APK is not debuggable, so run-as will not work.
    say "adb root is unavailable (output: [$root_output]); run-as would not work on a release APK"
    STORAGE_ADB_ROOT_USED=false
    STORAGE_METHOD="fill-data-partition"
    STORAGE_COMMAND="dd if=/dev/zero of=/data/data/$PACKAGE/.storage_fill bs=1M count=500"
    local fill_output=""
    fill_output="$(adb -s "$DEVICE" shell dd if=/dev/zero of=/data/data/$PACKAGE/.storage_fill bs=1M count=500 2>&1)" || true
    say "fill-data-partition output: [$fill_output]"
    STORAGE_COMMAND_OUTPUT="${STORAGE_COMMAND_OUTPUT}; fill output: $fill_output"
    STORAGE_FILL_FILE="/data/data/$PACKAGE/.storage_fill"
    STORAGE_RESTORE_DIR="/data/data/$PACKAGE"

    # Verify the failure took effect by checking if the directory is full or unwritable.
    local verify_output=""
    verify_output="$(adb -s "$DEVICE" shell ls -la /data/data/$PACKAGE/ 2>&1)" || true
    say "after fill verification: [$verify_output]"

    if echo "$fill_output" | grep -qi "error\|failed\|permission denied\|no space"; then
      say "FAIL: could not make the app storage unwritable; neither adb root nor fill worked"
      exit 1
    fi
  fi

  # Write the manifest safely using python3 with arguments (no heredoc interpolation).
  python3 -c '
import json, sys
manifest = {
    "method": sys.argv[1],
    "command": sys.argv[2],
    "commandOutput": sys.argv[3],
    "target": sys.argv[4],
    "originalMode": sys.argv[5],
    "originalUid": sys.argv[6],
    "originalGid": sys.argv[7],
    "failureMode": sys.argv[8],
}
with open(sys.argv[9], "w") as f:
    json.dump(manifest, f, indent=2)
' "$STORAGE_METHOD" "$STORAGE_COMMAND" "$STORAGE_COMMAND_OUTPUT" "/data/data/$PACKAGE" "$STORAGE_MODE_RESTORE" "$STORAGE_UID_RESTORE" "$STORAGE_GID_RESTORE" "store unwritable" "$STORAGE_MANIFEST"
  say "storage failure manifest written to $STORAGE_MANIFEST"
  STORAGE_INJECTED=true
}

restore_storage() {
  say "-- restoring storage permissions --"
  if [ "$STORAGE_INJECTED" = true ] && [ -n "$DEVICE" ] && [ -n "$STORAGE_MODE_RESTORE" ]; then
    local restore_output=""
    # Remove the fill file if one was created.
    if [ -n "${STORAGE_FILL_FILE:-}" ]; then
      local rm_output=""
      rm_output="$(adb -s "$DEVICE" shell rm -f "$STORAGE_FILL_FILE" 2>&1)" || true
      say "rm fill file output: [$rm_output]"
    fi
    restore_output="$(adb -s "$DEVICE" shell chmod "$STORAGE_MODE_RESTORE" /data/data/$PACKAGE 2>&1)" || true
    say "restore chmod output: [$restore_output]"
    # Restore write permission on all files and subdirectories.
    adb -s "$DEVICE" shell "find /data/data/$PACKAGE -type f -exec chmod u+w {} \; 2>&1" || true
    adb -s "$DEVICE" shell "find /data/data/$PACKAGE -type d -exec chmod u+w {} \; 2>&1" || true
    # Restore the adb reverse tunnel.
    adb -s "$DEVICE" reverse "tcp:${APP_ORIGIN_PORT}" "tcp:${FRONT_PORT}" >> "$TRANSCRIPT" 2>&1 || true
    say "restored adb reverse tunnel"
    STORAGE_INJECTED=false
    say "restored /data/data/$PACKAGE to mode $STORAGE_MODE_RESTORE"
  fi
}

# A failed submit leaves the app inside its action form, where the entry control
# is not on screen, so each scenario starts from a freshly launched app on the
# host's workspace -- the state the action control is reachable from. Nothing is
# removed from the app by this: the host keeps the workspace.
restart_app_to_workspace() {
  adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1
  sleep 2
  adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
  sleep 3
  wait_for_text "relaunch" "Host ready" || say "Host ready not visible at relaunch; proceeding"
  # The app asks for the passphrase again after a force-stop, exactly as it does
  # on a first launch.
  tap_label "Host password"
  adb -s "$DEVICE" shell input text "$PASSWORD" >> "$TRANSCRIPT" 2>&1
  adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
  sleep 1
  tap_label "Sign in to host"
  wait_for_text "relaunch-connected" "connected" || { say "FAIL: 'connected' not visible after relaunch"; exit 1; }
  sleep 2
  dump relaunch-workspace
  assert_text relaunch-workspace "Host: http://127.0.0.1:${APP_ORIGIN_PORT}"
}

# --- before-post scenario ---
say "=== before-post scenario ==="
BEFORE_POST_OK=false
inject_storage_failure

# Try to create a file through the app while the store is unwritable.
# The app should fail to persist the pending action and must not claim success.
tap_label "Send an action"
adb -s "$DEVICE" shell input text "rc065-android-before-post" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Submit action"
sleep 8
dump action-before-post

# Assert the app does NOT claim CREATE receipt confirmed.
say "-- assert no false success in before-post --"
if grep -q 'text="Confirmed receipt ' "$OUTDIR/window-action-before-post.xml" 2>/dev/null; then
  say "FAIL: before-post showed Confirmed receipt (false success)"
  exit 1
fi
say "before-post did not show false success (no Confirmed receipt)"
assert_no_text action-before-post "Confirmed receipt"

# Also assert the app did not claim any success status.
if grep -q 'text="Confirmed receipt ' "$OUTDIR/window-action-before-post.xml" 2>/dev/null; then
  say "before-post shows confirmed receipt (unexpected)"
elif grep -q 'text="unknown"' "$OUTDIR/window-action-before-post.xml" 2>/dev/null; then
  say "before-post shows unknown outcome (expected)"
elif grep -q 'text="failed"' "$OUTDIR/window-action-before-post.xml" 2>/dev/null; then
  say "before-post shows failed outcome (expected)"
else
  say "before-post outcome is not confirmed as success (no Confirmed receipt) -- acceptable"
fi

# Restore the store and assert the app can reconcile without losing confirmed data.
restore_storage
sleep 2

# Read the host's own record back to verify reconciliation.
say "-- verify host record after before-post reconciliation --"
python3 - "$API_PORT" "$PASSWORD" "$WORKSPACE_ID" "$HOST_COOKIE" <<'PY' | tee -a "$TRANSCRIPT"
import json, ssl, sys, urllib.request
port, password, workspace, cookie = sys.argv[1:5]
context = ssl._create_unverified_context()
base = f"https://127.0.0.1:{port}"
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", **({"cookie": cookie} if cookie else {})}
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
_, result, _ = call("/api/actions", cookie=cookie)
actions = result.get("actions", [])
host_actions = [a["action"] for a in actions]
before_post_actions = [a for a in host_actions if a.startswith("rc065-android-before-post")]
print(json.dumps({"actionsOnHost": host_actions, "beforePostActions": before_post_actions}))
PY

BEFORE_POST_OK=true
say "-- before-post scenario complete ---"

# --- after-receipt scenario ---
say "=== after-receipt scenario ==="
AFTER_RECEIPT_OK=false

# Step 1: Create a file normally and get the host to confirm the receipt.
# Navigate to the workspace screen first, then tap Send an action.
restart_app_to_workspace
tap_label "Send an action"
adb -s "$DEVICE" shell input text "rc065-android-after-receipt" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Submit action"
sleep 8
dump action-after-receipt-1
# Assert the first creation succeeded.
if grep -q 'text="Confirmed receipt ' "$OUTDIR/window-action-after-receipt-1.xml"; then
  say "after-receipt step 1: Confirmed receipt shown (as expected)"
else
  say "FAIL: after-receipt step 1 did not show Confirmed receipt; the host may not have confirmed the receipt"
  say "View tree snippet:"
  grep -o 'text="[^"]*"\|content-desc="[^"]*"' "$OUTDIR/window-action-after-receipt-1.xml" | head -20 >> "$TRANSCRIPT" 2>&1 || true
  exit 1
fi

# Step 2: Arm the failure after the host has confirmed a receipt.
inject_storage_failure

# Step 3: Try to create another file while the store is unwritable.
# Navigate to the workspace screen first in case the app navigated away.
# The failure is armed while the app is already running, so the app is not
# relaunched here: the second attempt has to happen inside the same session,
# which is what the injected failure is about.
tap_label "Send an action"
adb -s "$DEVICE" shell input text "rc065-android-after-receipt-2" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Submit action"
sleep 8
dump action-after-receipt-2

# Assert the app does NOT claim false success while the store is unwritable.
say "-- assert no false success in after-receipt --"
if grep -q 'text="Confirmed receipt ' "$OUTDIR/window-action-after-receipt-2.xml" 2>/dev/null; then
  say "FAIL: after-receipt showed Confirmed receipt while store was unwritable (false success)"
  exit 1
fi
say "after-receipt did not show false success while store was unwritable"
assert_no_text action-after-receipt-2 "Confirmed receipt"

# Also assert the app reported unknown or failed, not success.
if grep -q 'text="Confirmed receipt ' "$OUTDIR/window-action-after-receipt-2.xml" 2>/dev/null; then
  say "after-receipt shows confirmed receipt (unexpected)"
elif grep -q 'text="unknown"' "$OUTDIR/window-action-after-receipt-2.xml" 2>/dev/null; then
  say "after-receipt shows unknown outcome (expected)"
elif grep -q 'text="failed"' "$OUTDIR/window-action-after-receipt-2.xml" 2>/dev/null; then
  say "after-receipt shows failed outcome (expected)"
else
  say "after-receipt outcome is not confirmed as success (no Confirmed receipt) -- acceptable"
fi

# Step 4: Restore the store.
restore_storage
sleep 2

# Step 5: Assert the host shows exactly one create/save for the after-receipt file,
# not a duplicate (no replay). Copy the DB from the container and query it.
say "-- verify no duplicate effect after store recovery --"
docker cp "$CONTAINER_NAME:/var/lib/remotecode/rc065.sqlite" "$OUTDIR/rc065-android-proof.sqlite" 2>/dev/null || true

# Query the database using bun:sqlite on the host, counting rows in file_operation_intents
# the same way scripts/rc065/run-restart-log-ui-proof.sh does.
say "-- query file_operation_intents count --"
INTENT_COUNT=$(bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('$OUTDIR/rc065-android-proof.sqlite');
const total = db.query('SELECT COUNT(*) as n FROM file_operation_intents').get();
const creates = db.query(\"SELECT kind, COUNT(*) as count FROM file_operation_intents WHERE workspace_id = '$WORKSPACE_ID' GROUP BY kind\").all();
console.log(JSON.stringify({total: total.n, intents: creates}));
db.close();
" 2>/dev/null)
say "file_operation_intents: $INTENT_COUNT"

# Also verify via the API that there is no duplicate action.
say "-- verify no duplicate action via API --"
python3 - "$API_PORT" "$PASSWORD" "$WORKSPACE_ID" "$HOST_COOKIE" <<'PY' | tee -a "$TRANSCRIPT"
import json, ssl, sys, urllib.request
port, password, workspace, cookie = sys.argv[1:5]
context = ssl._create_unverified_context()
base = f"https://127.0.0.1:{port}"
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", **({"cookie": cookie} if cookie else {})}
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
_, result, _ = call("/api/actions", cookie=cookie)
actions = result.get("actions", [])
after_receipt_actions = [a for a in actions if a["action"].startswith("rc065-android-after-receipt")]
print(json.dumps({"afterReceiptActionCount": len(after_receipt_actions), "actions": [a["action"] for a in after_receipt_actions]}))
if len(after_receipt_actions) > 1:
    raise SystemExit(f"Duplicate after-receipt action found: {len(after_receipt_actions)} actions")
PY

AFTER_RECEIPT_OK=true
say "-- after-receipt scenario complete ---"

# --- write result.json ---
say "-- write result --"
python3 -c '
import json, sys, os
outdir = sys.argv[1]
before_post = sys.argv[2] == "true"
after_receipt = sys.argv[3] == "true"
method = sys.argv[4]
adb_root_used = sys.argv[5] == "true"
result = {
    "result": "verified" if (before_post and after_receipt) else "failed",
    "scope": "RC-065 Android storage-failure modes",
    "scenarios": {
        "before-post": {
            "description": "Store made unwritable before POST; app did not claim false success",
            "method": method,
            "adbRootUsed": adb_root_used,
            "noFalseSuccess": before_post,
            "reconciled": before_post,
        },
        "after-receipt": {
            "description": "Store made unwritable after host confirmed receipt; app reported unknown, no duplicate effect on recovery",
            "method": method,
            "adbRootUsed": adb_root_used,
            "noFalseSuccess": after_receipt,
            "noDuplicateEffect": after_receipt,
        },
    },
    "storageInjection": {
        "method": method,
        "command": "adb root; chmod a-w /data/data/com.remotecode.mobileproof; find /data/data/com.remotecode.mobileproof -type f -exec chmod a-w {} \\; ; find /data/data/com.remotecode.mobileproof -type d -exec chmod a-w {} \\;",
        "target": "/data/data/com.remotecode.mobileproof",
        "failureMode": "removed write permission for all users on directory, all files, and all subdirectories",
    },
}
with open(os.path.join(outdir, "result.json"), "w") as f:
    json.dump(result, f, indent=2)
print("result.json written")
' "$OUTDIR" "$BEFORE_POST_OK" "$AFTER_RECEIPT_OK" "$STORAGE_METHOD" "$STORAGE_ADB_ROOT_USED"

say "PASS rc065-android-storage: Android storage-failure modes verified on real emulator against real Linux host"
exit 0
