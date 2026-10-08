#!/usr/bin/env bash
# RC-057 executable proof: a phone takes over the Bot's own screen on a Linux
# host, types and clicks into it, returns control, and recovers after the link
# drops mid-way.
#
# The device reaches the host over TLS (the API requires it for a non-loopback
# peer); the host's certificate is installed as a system CA on the emulator,
# which needs `adb root`.
#
# Usage: scripts/rc057/run-mobile-takeover-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: run-mobile-takeover-proof.sh <fresh absolute output dir>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"
TRANSCRIPT="$OUT/proof.log"

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

IMAGE="${RC057_IMAGE:-remotecode/host:local}"
NAME="rc057-linux-$(date +%s)"
DATA_VOLUME="rc057-data-$(date +%s)"
API_PORT="${RC057_API_PORT:-37131}"
FRONT_PORT="${RC057_FRONT_PORT:-37132}"
# The device talks plain HTTP to its own loopback, which `adb reverse` carries
# to this Mac; the Mac is the loopback peer the API accepts and speaks TLS to
# the host. That keeps the device out of the certificate-trust question.
HOST_ORIGIN="http://127.0.0.1:${FRONT_PORT}"
# A fixed password is allowed so a failing run can be poked at afterwards.
PASSWORD="${RC057_PASSWORD:-rc057-linux-$(openssl rand -hex 12)}"
AVD="${RC057_AVD:-rc056-android}"
PACKAGE="com.remotecode.mobileproof"
WORKSPACE_NAME="rc057-takeover"
BOT_NAME="rc057-bot"
APK="${RC057_APK:-$ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
EMULATOR_PID=""
DEVICE=""

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { printf '+ %s\n' "$*" >> "$TRANSCRIPT"; "$@" >> "$TRANSCRIPT" 2>&1; }

cleanup() {
  say "-- cleanup --"
  if [ "${RC057_KEEP:-0}" = "1" ]; then say "kept running (RC057_KEEP=1)"; return; fi
  [ -n "${FRONT_PID:-}" ] && kill "$FRONT_PID" 2>/dev/null || true
  [ -n "$DEVICE" ] && adb -s "$DEVICE" emu kill >> "$TRANSCRIPT" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "== RC-057 mobile takeover proof =="
[ -f "$APK" ] || { say "FAIL: no APK at $APK"; exit 1; }
if lsof -ti "tcp:$API_PORT" >/dev/null 2>&1; then
  say "FAIL: something already listens on $API_PORT; stop it first"
  exit 2
fi

say "-- the Linux host with its own display --"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
docker volume create "$DATA_VOLUME" >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-057 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc057.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" -e REMOTECODE_DISPLAY=:99 \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${FRONT_PORT}" \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
# The display the Bot's screen lives on, on the same host as the API.
docker exec -d "$NAME" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc057-xvfb.log 2>&1'
sleep 2
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc057.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${FRONT_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc057-api.log 2>&1"
for _ in $(seq 1 60); do
  curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$NAME" tail -20 /var/log/rc057-api.log >> "$TRANSCRIPT" 2>&1 || true
  say "FAIL: the Linux API never became ready"
  exit 1
fi
say "api ready over TLS on 127.0.0.1:${API_PORT}"

say "-- the host holds a workspace with a Bot --"
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
print(json.dumps({"workspaceId": workspace["id"], "botId": bot["id"], "cookie": cookie}))
PY
)"
WORKSPACE_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['workspaceId'])" "$SEED")"
say "seeded workspace $WORKSPACE_ID"

say "-- a plain HTTP front for the device, speaking TLS to the host --"
if lsof -ti "tcp:$FRONT_PORT" >/dev/null 2>&1; then
  say "FAIL: something already listens on $FRONT_PORT; stop it first"
  exit 2
fi
bun "$HERE/http-front.ts" "$FRONT_PORT" "$API_PORT" > "$OUT/front.log" 2>&1 &
FRONT_PID=$!
for _ in $(seq 1 30); do
  curl -s --fail "http://127.0.0.1:${FRONT_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -s --fail "http://127.0.0.1:${FRONT_PORT}/api/health/ready" >/dev/null; then
  tail -10 "$OUT/front.log" >> "$TRANSCRIPT" 2>&1 || true
  say "FAIL: the plain HTTP front never answered"
  exit 1
fi
say "front ready on 127.0.0.1:${FRONT_PORT} -> https://127.0.0.1:${API_PORT}"

say "-- the device reaches the host through the front --"
# -writable-system is what lets this image take the host's certificate into the
# system store; without it /system is read-only and the app would refuse the
# host's self-signed certificate.
nohup emulator -avd "$AVD" -no-window -no-audio -no-snapshot -writable-system -gpu swiftshader_indirect > "$OUT/emulator.log" 2>&1 &
EMULATOR_PID=$!
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
DEVICE="$(adb devices | awk 'NR==2 {print $1}')"
say "emulator $DEVICE booted"
adb -s "$DEVICE" root >> "$TRANSCRIPT" 2>&1 || true
sleep 3
adb -s "$DEVICE" wait-for-device
adb -s "$DEVICE" reverse "tcp:${FRONT_PORT}" "tcp:${FRONT_PORT}" >> "$TRANSCRIPT" 2>&1
say "device loopback ${FRONT_PORT} forwards to the front"

say "-- the app, pointed at the Linux host over TLS --"
adb -s "$DEVICE" install -r -d "$APK" >> "$TRANSCRIPT" 2>&1
# A pending auth left by an earlier run blocks a new sign-in (the app refuses to
# resend an uncertain request), so the app starts from a clean data directory.
# The grant comes after the clear, because clearing the app also clears the
# permission and the system dialog would then swallow every tap.
adb -s "$DEVICE" shell pm clear "$PACKAGE" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1

dump() {
  adb -s "$DEVICE" shell uiautomator dump /sdcard/rc057.xml >> "$TRANSCRIPT" 2>&1
  adb -s "$DEVICE" exec-out cat /sdcard/rc057.xml > "$OUT/window-$1.xml"
}
# The screen is longer than the window, so a control is looked for as it is
# scrolled into view rather than assumed to be laid out already.
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
  read -r X Y < "$OUT/tap.txt" || true
  if [ -z "${X:-}" ]; then say "FAIL: no element matching '$label'"; return 1; fi
  adb -s "$DEVICE" shell input tap "$X" "$Y" >> "$TRANSCRIPT" 2>&1
}

# A control is only tapped once the app itself says it is enabled: the panel
# disables its controls while a request is in flight, and a tap that lands in
# that window does nothing.
wait_enabled_tap() {
  local label="$1"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    dump tap
    python3 - "$OUT/window-tap.xml" "$label" <<'PY' > "$OUT/tap.txt"
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
    if [ -s "$OUT/tap.txt" ]; then
      read -r X Y < "$OUT/tap.txt" || true
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
  python3 - "$OUT/window-tap.xml" "$label" <<'PY' > "$OUT/tap.txt"
import re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
wanted = sys.argv[2]
# A match only counts when it is inside the window: uiautomator reports bounds
# for controls scrolled out of view too, and tapping those coordinates would hit
# whatever is really there.
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
  [ -s "$OUT/tap.txt" ]
}
# The dump carries each value as its own attribute, so the match is exact:
# "connected" must not be satisfied by "disconnected".
assert_text() {
  if grep -q -e "text=\"$2\"" -e "content-desc=\"$2\"" "$OUT/window-$1.xml"; then
    say "visible in $1: $2"
  else
    say "FAIL: '$2' not visible in $1"
    return 1
  fi
}
# The host's own answer, read by the emulator's session cookie.
host_state() {
  python3 - "$API_PORT" "$PASSWORD" "$WORKSPACE_ID" <<'PY'
import json, ssl, sys, urllib.request
port, password, workspace = sys.argv[1:4]
context = ssl._create_unverified_context()
def call(path, method="GET", body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", **({"cookie": cookie} if cookie else {})}
    request = urllib.request.Request(f"https://127.0.0.1:{port}" + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        payload = response.read().decode()
    return response.status, (json.loads(payload) if payload else None), response.headers.get("set-cookie", "")
_, _, cookie = call("/api/auth/login", "POST", {"password": password})
print(call(f"/api/workspaces/{workspace}/screen/possession", cookie=cookie.split(";")[0])[1]["state"])
PY
}

adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 10
dump launch
# Before signing in the app proves it reached the host by its readiness probe,
# which also proves it trusts the host's certificate.
assert_text launch "Host: $HOST_ORIGIN"
assert_text launch "Host ready"
say "the app reached the Linux host over TLS and trusts its certificate"

# Sign in through the app's own fields.
tap_label "Host password"
adb -s "$DEVICE" shell input text "$PASSWORD" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Sign in to host"
sleep 10
dump signed-in
assert_text signed-in "connected"

# The workspace the host holds, then its screen takeover.
# The list is already loaded when the app signs in, so refreshing is offered
# rather than required.
tap_label "Refresh workspaces" || true
sleep 3
dump lists
assert_text lists "$WORKSPACE_NAME"
tap_label "Open workspace $WORKSPACE_NAME"
sleep 3
dump workspace-open
assert_text workspace-open "$WORKSPACE_NAME"

tap_label "Take over screen"
sleep 6
dump taken
assert_text taken "Possession: holder"
# Possession is reported per client, so a session of this Mac reads "none" here:
# that is the host answering about itself, not about the phone.
say "the app's own panel reads holder; this Mac's own session reads $(host_state), as possession is per client"

# Human input into the held screen.
# The app only enables the send control once its field holds the text, so the
# typing is confirmed from the app's own view before anything is sent.
typed_ok=0
for attempt in 1 2 3; do
  tap_label "Screen text"
  adb -s "$DEVICE" shell input text "rc057-human-input" >> "$TRANSCRIPT" 2>&1
  sleep 1
  dump typed-field
  if grep -q 'text="rc057-human-input' "$OUT/window-typed-field.xml"; then typed_ok=1; break; fi
done
[ "$typed_ok" = "1" ] || { say "FAIL: the screen text field never held the typed text"; exit 1; }
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
wait_enabled_tap "Send screen text"
sleep 6
dump typed
assert_text typed "The host applied the text."
wait_enabled_tap "Click screen centre"
sleep 6
dump clicked
assert_text clicked "The host applied the click."

REACHED=1
# The link drops mid-way: the app is killed while it holds the screen.
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1
sleep 4
say "after the drop the host reads: $(host_state)"
adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 10
dump recovered
assert_text recovered "connected"

say "-- result --"
if [ "${REACHED:-}" != "1" ]; then
  say "FAIL: the journey did not reach the end"
  exit 1
fi
python3 - "$OUT" "$HOST_ORIGIN" <<'PY'
import json, sys
json.dump({
  "result": "verified",
  "scope": "RC-057 a phone takes over the Bot's screen on a Linux host, sends input, returns control and recovers after a drop",
  "host": sys.argv[2],
  "ceiling": "the emulator reaches the host over TLS with its certificate installed as a system CA; Apple's APNs and Google's FCM transports are not exercised here",
}, open(sys.argv[1] + "/proof.json", "w"), indent=2)
print("proof.json written")
PY
say "PASS rc057: the phone took over the screen, sent input and recovered after a drop"
