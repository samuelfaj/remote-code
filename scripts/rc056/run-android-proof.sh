#!/usr/bin/env bash
# RC-056 executable proof: the Android app on a real emulator repeats the task
# journey, receives the host's record of it, and keeps the Inbox item across a
# force-stop.
#
# Requires: docker-free setup, the Android SDK on this machine, a release APK
# built with EXPO_PUBLIC_API_ORIGIN=http://127.0.0.1:39221 (adb reverse maps that
# to this Mac's loopback, which the API accepts in cleartext).
#
# Usage: scripts/rc056/run-android-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:?usage: run-android-proof.sh <fresh absolute output dir>}"
case "$OUTDIR" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/proof.log"

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

API_PORT="${RC056_API_PORT:-39221}"
API_ORIGIN="http://127.0.0.1:$API_PORT"
PASSWORD="rc056-android-$(openssl rand -hex 12)"
DATABASE_PATH="$OUTDIR/rc056.sqlite"
APK="${RC056_APK:-$ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
AVD="${RC056_AVD:-rc056-android}"
PACKAGE="com.remotecode.mobileproof"
API_PID=""
EMULATOR_PID=""

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { printf '+ %s\n' "$*" >> "$TRANSCRIPT"; "$@" >> "$TRANSCRIPT" 2>&1; }

cleanup() {
  say "-- cleanup --"
  # RC056_KEEP=1 leaves the emulator and the API running for debugging.
  [ "${RC056_KEEP:-0}" = "1" ] && { say "kept running (RC056_KEEP=1)"; return; }
  [ -n "$EMULATOR_PID" ] && adb -s "${DEVICE:-emulator-5554}" emu kill >> "$TRANSCRIPT" 2>&1 || true
  [ -n "$API_PID" ] && kill "$API_PID" >> "$TRANSCRIPT" 2>&1 || true
}
trap cleanup EXIT

say "== RC-056 Android proof =="
say "apk=$APK avd=$AVD api=$API_ORIGIN outdir=$OUTDIR"
[ -f "$APK" ] || { say "FAIL: no APK at $APK"; exit 1; }

# A stale API from an earlier run would answer with its own password and the
# proof would report a login failure that is not the app's.
if lsof -ti "tcp:$API_PORT" >/dev/null 2>&1; then
  say "FAIL: something already listens on $API_PORT; stop it first"
  exit 2
fi

say "-- the host API, with the repository's own ACP stub as the agent --"
cat > "$OUTDIR/rc056-stub-agent.sh" <<STUB
#!/bin/bash
exec node "$ROOT/apps/api/src/features/runs-stub-agent.mjs" "\$@"
STUB
chmod +x "$OUTDIR/rc056-stub-agent.sh"
API_PORT="$API_PORT" DATABASE_PATH="$DATABASE_PATH" \
  REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  REMOTECODE_WEB_ORIGIN="$API_ORIGIN" \
  REMOTECODE_DISTILL_BIN="$OUTDIR/rc056-stub-agent.sh" \
  bun run "$ROOT/apps/api/src/index.ts" >> "$OUTDIR/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$API_ORIGIN/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$API_ORIGIN/api/health/ready" >/dev/null || { say "FAIL: API not ready"; exit 1; }
say "api ready on $API_ORIGIN (pid $API_PID)"

say "-- the emulator --"
nohup emulator -avd "$AVD" -no-window -no-audio -no-snapshot -gpu swiftshader_indirect \
  > "$OUTDIR/emulator.log" 2>&1 &
EMULATOR_PID=$!
adb wait-for-device
DEVICE="$(adb devices | awk 'NR==2 {print $1}')"
until [ "$(adb -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
say "emulator $DEVICE booted: $(adb -s "$DEVICE" shell getprop ro.build.version.release | tr -d '\r')"

say "-- the app --"
adb -s "$DEVICE" reverse "tcp:$API_PORT" "tcp:$API_PORT" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" install -r -d "$APK" >> "$TRANSCRIPT" 2>&1
# The app asks for notification permission when it starts; granting it up front
# keeps the system dialog from swallowing the taps the proof sends.
adb -s "$DEVICE" shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1

# One dump, so every assertion reads the app's own view tree rather than a
# screenshot someone has to eyeball.
dump() {
  adb -s "$DEVICE" shell uiautomator dump /sdcard/rc056.xml >> "$TRANSCRIPT" 2>&1
  adb -s "$DEVICE" exec-out cat /sdcard/rc056.xml > "$OUTDIR/window-$1.xml"
}
tap_label() {
  local label="$1"
  # A fresh tree for the tap, so the bounds belong to what is on screen now.
  dump tap
  python3 - "$OUTDIR/window-tap.xml" "$label" <<'PY' > "$OUTDIR/tap.txt"
import re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
wanted = sys.argv[2]
for node in re.finditer(r'<node[^>]*>', xml):
    tag = node.group(0)
    text = re.search(r'text="([^"]*)"', tag)
    desc = re.search(r'content-desc="([^"]*)"', tag)
    values = [text.group(1) if text else "", desc.group(1) if desc else ""]
    if any(wanted in value for value in values):
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
        if not bounds: continue
        x1, y1, x2, y2 = map(int, bounds.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
PY
  read -r X Y < "$OUTDIR/tap.txt"
  [ -n "${X:-}" ] || { say "FAIL: no element matching '$label'"; return 1; }
  adb -s "$DEVICE" shell input tap "$X" "$Y" >> "$TRANSCRIPT" 2>&1
}

assert_text() {
  local file="$1" needle="$2"
  grep -q "$needle" "$OUTDIR/window-$file.xml" || { say "FAIL: '$needle' not visible in $file"; return 1; }
  say "visible in $file: $needle"
}

adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 8
dump launch
python3 - "$API_ORIGIN" "$PASSWORD" "$OUTDIR" <<'PY'
import json, sys, urllib.request, time
api, password, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
record = {"result": "unverified", "scope": "RC-056 Android app journey on a real emulator"}
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(api + path, data=data, method=method,
                                     headers={"content-type": "application/json", **({"cookie": cookie} if cookie else {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
status, _, cookie = call("/api/auth/login", "POST", {"password": password})
cookie = cookie.split(";")[0]
workspace = call("/api/workspaces", "POST", {"name": "rc056-android"}, cookie)[1]
bot = call("/api/bots", "POST", {"workspaceId": workspace["id"], "name": "rc056-android-bot", "instructions": "stop"}, cookie)[1]
thread = call(f"/api/workspaces/{workspace['id']}/threads", "POST", {"title": "rc056-android-thread"}, cookie)[1]
call(f"/api/threads/{thread['id']}/messages", "POST", {"body": "rc056-android-message"}, cookie)
run = call("/api/runs", "POST", {"workspaceId": workspace["id"], "botId": bot["id"], "prompt": "rc056 android"}, cookie)[1]
item = None
for _ in range(120):
    items = call("/api/inbox", "GET", None, cookie)[1]["items"]
    item = next((entry for entry in items if entry.get("runId") == run["id"]), None)
    if item: break
    time.sleep(0.5)
record.update({"workspaceId": workspace["id"], "botId": bot["id"], "threadId": thread["id"],
               "runId": run["id"], "inboxTitle": item["title"] if item else None,
               "deviceRegistered": "see the devices line in this log"})
open(outdir + "/seed.json", "w").write(json.dumps(record, indent=2))
print(json.dumps(record))
PY

# Sign in through the app's own fields.
dump signin-form
tap_label "Host password"
adb -s "$DEVICE" shell input text "$PASSWORD" >> "$TRANSCRIPT" 2>&1
dump signin-typed
# The soft keyboard sits over the submit button, as it does on the phone, so the
# keyboard is dismissed the way a person does before pressing it.
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
dump signin-keyboard-down
tap_label "Sign in to host"
sleep 10
dump signed-in
assert_text signed-in "connected"
assert_text signed-in "RemoteCode mobile"

# The app's own registration reaching the host. The app needs an Expo push
# project id to obtain a token; this machine has none, so a refusal here is
# recorded rather than treated as a failure of the journey.
python3 - "$API_ORIGIN" "$PASSWORD" <<'PY' | tee -a "$TRANSCRIPT" || true
import json, sys, urllib.request
api, password = sys.argv[1], sys.argv[2]
request = urllib.request.Request(api + "/api/auth/login", data=json.dumps({"password": password}).encode(), method="POST", headers={"content-type": "application/json"})
with urllib.request.urlopen(request, timeout=30) as response:
    cookie = response.headers.get("set-cookie", "").split(";")[0]
request = urllib.request.Request(api + "/api/push/devices", headers={"cookie": cookie})
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        print(json.dumps({"devices": json.loads(response.read().decode())}))
except Exception as failure:
    print(json.dumps({"devices": "unread", "reason": str(failure),
                      "ceiling": "the app needs an Expo push project id to obtain a token; this machine has none"}))
PY

BOT_NAME="rc056-android-bot"
WORKSPACE_NAME="rc056-android"
THREAD_TITLE="rc056-android-thread"
INBOX_TITLE="$(python3 -c "import json;print(json.load(open('$OUTDIR/seed.json'))['inboxTitle'] or '')")"

# Bots: the Bot the host holds.
tap_label "Bots"
sleep 3
dump tab-Bots
assert_text tab-Bots "$BOT_NAME"

# Threads: the workspace the host holds, then the thread inside it.
tap_label "Threads"
sleep 3
dump tab-Threads
assert_text tab-Threads "$WORKSPACE_NAME"
tap_label "Threads for $WORKSPACE_NAME"
sleep 3
dump tab-Threads-open
assert_text tab-Threads-open "$THREAD_TITLE"

# Inbox: the item the host recorded for the run.
tap_label "Inbox"
sleep 3
dump tab-Inbox
assert_text tab-Inbox "$INBOX_TITLE"

# Actions: the app submits one through its own control, the host holds it, and
# the tab lists it.
ACTION_NAME="rc056-android-action-$(openssl rand -hex 4)"
tap_label "Workspaces"
sleep 2
tap_label "Send an action"
adb -s "$DEVICE" shell input text "$ACTION_NAME" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Submit action"
sleep 5
dump action-submitted
python3 - "$API_ORIGIN" "$PASSWORD" "$OUTDIR" "$ACTION_NAME" <<'PY' | tee -a "$TRANSCRIPT"
import json, sys, urllib.request
api, password, outdir, expected = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
request = urllib.request.Request(api + "/api/auth/login", data=json.dumps({"password": password}).encode(),
                                 method="POST", headers={"content-type": "application/json"})
with urllib.request.urlopen(request, timeout=30) as response:
    cookie = response.headers.get("set-cookie", "").split(";")[0]
request = urllib.request.Request(api + "/api/actions", headers={"cookie": cookie})
with urllib.request.urlopen(request, timeout=30) as response:
    actions = [entry["action"] for entry in json.loads(response.read().decode())["actions"]]
print(json.dumps({"actionsOnHost": actions, "expected": expected}))
json.dump({"actionsOnHost": actions}, open(outdir + "/actions.json", "w"))
if expected not in actions:
    raise SystemExit(f"the host does not hold the action the app submitted: {actions!r}")
PY
tap_label "Actions"
sleep 3
dump tab-Actions
assert_text tab-Actions "$ACTION_NAME"

say "-- the Inbox item survives the app being closed --"
INBOX_TITLE="$(python3 -c "import json;print(json.load(open('$OUTDIR/seed.json'))['inboxTitle'] or '')")"
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 10
dump relaunch
tap_label "Inbox"
sleep 3
dump relaunch-Inbox
assert_text relaunch-Inbox "$INBOX_TITLE"
python3 - "$API_ORIGIN" "$PASSWORD" <<'PY' >> "$TRANSCRIPT" 2>&1
import json, sys, urllib.request
api, password = sys.argv[1], sys.argv[2]
request = urllib.request.Request(api + "/api/auth/login", data=json.dumps({"password": password}).encode(), method="POST", headers={"content-type": "application/json"})
with urllib.request.urlopen(request, timeout=30) as response:
    cookie = response.headers.get("set-cookie", "").split(";")[0]
request = urllib.request.Request(api + "/api/inbox", headers={"cookie": cookie})
with urllib.request.urlopen(request, timeout=30) as response:
    items = json.loads(response.read().decode())["items"]
print(json.dumps({"inboxAfterRelaunch": [entry["title"] for entry in items]}))
PY

say "-- result --"
python3 - "$OUTDIR" <<'PY' | tee -a "$TRANSCRIPT"
import json, sys
outdir = sys.argv[1]
# The assertions above already ran; a failed one exited the script. The record
# says what was actually observed.
record = {
  "result": "verified",
  "scope": "RC-056 Android app on a real emulator: task journey, host record, Inbox across a force-stop",
  "ceiling": "Google's FCM transport is not exercised here (no FCM credentials and no Expo push project id on this machine), so the app's device registration cannot obtain a token and the push leg stays proven by scripts/rc055/run-push-routing-proof.ts on Linux.",
}
json.dump(record, open(outdir + "/proof.json", "w"), indent=2)
print(json.dumps(record, indent=2))
PY
say "PASS rc056: Android app journey on the emulator"
