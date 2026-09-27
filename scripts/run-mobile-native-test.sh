#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RC_NATIVE_TEST_WORK_DIR:?Set RC_NATIVE_TEST_WORK_DIR to a private writable evidence directory}"
case "$WORK_DIR" in
  /*) ;;
  *) echo "RC_NATIVE_TEST_WORK_DIR must be an absolute path" >&2; exit 2 ;;
esac
mkdir -p "$WORK_DIR"
API_PORT=39211
API_ORIGIN="http://127.0.0.1:$API_PORT"
API_PASSWORD="remote-code-native-test-passphrase"
DATABASE_PATH="$WORK_DIR/remotecode-native.sqlite"
DEVICE_ID="${RC_NATIVE_TEST_DEVICE:-}"
API_PID=""
API_ENTRY="apps/api/src/index.ts"
TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppUsesAuthenticatedSnapshotEventsAndReceipts"
if [[ "${RC_NATIVE_TEST_RECOVERY:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests"
fi

if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="$(xcrun simctl list devices booted --json | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((x["udid"] for k,v in d.items() if "iOS" in k for x in v if x["state"] == "Booted"), ""))')"
fi
if [[ -z "$DEVICE_ID" ]]; then
  echo "Boot an iOS simulator or set RC_NATIVE_TEST_DEVICE to an available simulator UDID." >&2
  exit 2
fi
if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $API_PORT is already in use; leaving its process untouched." >&2
  exit 2
fi

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID"
    wait "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

rm -f "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
cd "$ROOT_DIR"
API_PORT="$API_PORT" \
  DATABASE_PATH="$DATABASE_PATH" \
  REMOTECODE_AUTH_PASSWORD="$API_PASSWORD" \
  REMOTECODE_WEB_ORIGIN="http://localhost:5173" \
  bun run "$API_ENTRY" > "$WORK_DIR/api.log" 2>&1 &
API_PID=$!

ready=false
for _ in $(seq 1 30); do
  if curl --silent --fail "$API_ORIGIN/api/health/ready" >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  cat "$WORK_DIR/api.log" >&2
  echo "The isolated API did not become ready." >&2
  exit 1
fi

(
  cd "$ROOT_DIR/apps/mobile"
  bunx expo prebuild --platform ios --no-install
) > "$WORK_DIR/expo-prebuild.log" 2>&1 || { cat "$WORK_DIR/expo-prebuild.log" >&2; exit 1; }
(
  cd "$ROOT_DIR/apps/mobile/ios"
  pod install
) > "$WORK_DIR/pod-install.log" 2>&1 || { tail -100 "$WORK_DIR/pod-install.log" >&2; exit 1; }

python3 - "$ROOT_DIR/apps/mobile/ios/RemoteCodeMobileProof.xcodeproj/xcshareddata/xcschemes/RemoteCodeMobileProof.xcscheme" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
entries = root.findall("./BuildAction/BuildActionEntries/BuildActionEntry")
archive_settings = {
    entry.find("BuildableReference").get("BuildableName"): entry.get("buildForArchiving")
    for entry in entries
}
if archive_settings.get("RemoteCodeMobileProof.app") != "YES":
    raise SystemExit("The XCUITest scheme must preserve the app's archive participation")
if archive_settings.get("RemoteCodeMobileProofUITests.xctest") != "NO":
    raise SystemExit("The UI-test bundle must not be archived as the application")
test_targets = root.findall("./TestAction/Testables/TestableReference/BuildableReference")
if [target.get("BuildableName") for target in test_targets] != ["RemoteCodeMobileProofUITests.xctest"]:
    raise SystemExit("The shared scheme must execute the native UI-test target")
print("Generated scheme includes one UI-test target and retains the app Archive entry.")
PY

if ! EXPO_PUBLIC_API_ORIGIN="$API_ORIGIN" \
  EXPO_PUBLIC_CLIENT_ORIGIN="http://localhost:5173" \
  xcodebuild \
    -workspace "$ROOT_DIR/apps/mobile/ios/RemoteCodeMobileProof.xcworkspace" \
    -scheme RemoteCodeMobileProof \
    -destination "platform=iOS Simulator,id=$DEVICE_ID" \
    -derivedDataPath "$WORK_DIR/DerivedData" \
    RC_NATIVE_TEST_API_ORIGIN="$API_ORIGIN" \
    -only-testing:"$TEST_SELECTION" \
    -resultBundlePath "$WORK_DIR/NativeTests.xcresult" \
    test > "$WORK_DIR/xcodebuild-test.log" 2>&1; then
  tail -100 "$WORK_DIR/xcodebuild-test.log" >&2
  exit 1
fi

python3 - "$DATABASE_PATH" "${RC_NATIVE_TEST_RECOVERY:-0}" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
try:
    rows = connection.execute("SELECT id, action, created_at FROM actions ORDER BY sequence").fetchall()
    session_count = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
finally:
    connection.close()
expected_count = 3 if sys.argv[2] == "1" else 2
if len(rows) != expected_count or len({row[1] for row in rows}) != expected_count:
    raise SystemExit(f"Expected exactly {expected_count} distinct native test actions, observed: {rows!r}")
event, submitted = [row for row in rows if row[1].startswith(("native-event-", "native-submit-"))]
if expected_count == 3:
    recovered = [row for row in rows if row[1].startswith("native-recover-")]
    if len(recovered) != 1:
        raise SystemExit("Expected one recovered native action")
    connection = sqlite3.connect(sys.argv[1])
    try:
        mappings = connection.execute("SELECT request_id FROM action_requests WHERE action_id = ?", (recovered[0][0],)).fetchall()
    finally:
        connection.close()
    if len(mappings) != 1:
        raise SystemExit("Recovered action must have one durable request mapping")
    print(json.dumps({"recoveredRequestId": mappings[0][0], "recoveredReceiptId": recovered[0][0]}))
if not event[1].startswith("native-event-") or not submitted[1].startswith("native-submit-"):
    raise SystemExit(f"Unexpected native test action sequence: {rows!r}")
if event[1].removeprefix("native-event-") != submitted[1].removeprefix("native-submit-"):
    raise SystemExit(f"Native event and submitted action IDs do not belong to the same test run: {rows!r}")
if session_count != 0:
    raise SystemExit(f"Native logout left {session_count} persisted session(s)")
print(json.dumps({"actions": [{"id": row[0], "action": row[1], "createdAt": row[2]} for row in rows], "remainingSessions": session_count}, indent=2))
PY

echo "Native iOS UI test and SQLite readback passed on simulator $DEVICE_ID. Evidence: $WORK_DIR"
