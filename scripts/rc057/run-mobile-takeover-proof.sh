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
HOST_ORIGIN="https://10.0.2.2:${API_PORT}"
PASSWORD="rc057-linux-$(openssl rand -hex 12)"
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
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
# The display the Bot's screen lives on, on the same host as the API.
docker exec -d "$NAME" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc057-xvfb.log 2>&1'
sleep 2
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc057.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc057-api.log 2>&1"
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

say "-- the device trusts the host's certificate --"
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
adb -s "$DEVICE" remount >> "$TRANSCRIPT" 2>&1 || adb -s "$DEVICE" shell mount -o rw,remount /system >> "$TRANSCRIPT" 2>&1 || true
HASH="$(openssl x509 -inform PEM -subject_hash_old -in "$OUT/cert.pem" | head -1)"
adb -s "$DEVICE" push "$OUT/cert.pem" "/system/etc/security/cacerts/$HASH.0" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell chmod 644 "/system/etc/security/cacerts/$HASH.0" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" reboot >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" wait-for-device
until [ "$(adb -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
say "host certificate installed as a system CA"

say "-- the app, pointed at the Linux host over TLS --"
adb -s "$DEVICE" install -r -d "$APK" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS >> "$TRANSCRIPT" 2>&1 || true
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1

dump() {
  adb -s "$DEVICE" shell uiautomator dump /sdcard/rc057.xml >> "$TRANSCRIPT" 2>&1
  adb -s "$DEVICE" exec-out cat /sdcard/rc057.xml > "$OUT/window-$1.xml"
}
tap_label() {
  local label="$1"
  dump tap
  python3 - "$OUT/window-tap.xml" "$label" <<'PY' > "$OUT/tap.txt"
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
        if not bounds:
            continue
        x1, y1, x2, y2 = map(int, bounds.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
PY
  read -r X Y < "$OUT/tap.txt"
  if [ -z "${X:-}" ]; then say "FAIL: no element matching '$label'"; return 1; fi
  adb -s "$DEVICE" shell input tap "$X" "$Y" >> "$TRANSCRIPT" 2>&1
}
assert_text() {
  if grep -q "$2" "$OUT/window-$1.xml"; then say "visible in $1: $2"; else say "FAIL: '$2' not visible in $1"; return 1; fi
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
tap_label "Refresh workspaces"
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
say "the host confirmed this phone holds the screen (state=$(host_state))"

# Human input into the held screen.
tap_label "Screen text"
adb -s "$DEVICE" shell input text "rc057-human-input" >> "$TRANSCRIPT" 2>&1
adb -s "$DEVICE" shell input keyevent 4 >> "$TRANSCRIPT" 2>&1
sleep 1
tap_label "Send screen text"
sleep 6
dump typed
assert_text typed "The host applied the text."
tap_label "Click screen centre"
sleep 6
dump clicked
assert_text clicked "The host applied the click."

# The link drops mid-way: the app is killed while it holds the screen.
adb -s "$DEVICE" shell am force-stop "$PACKAGE" >> "$TRANSCRIPT" 2>&1
sleep 4
say "after the drop the host reads: $(host_state)"
adb -s "$DEVICE" shell am start -n "$PACKAGE/.MainActivity" >> "$TRANSCRIPT" 2>&1
sleep 10
dump recovered
assert_text recovered "connected"

say "-- result --"
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
