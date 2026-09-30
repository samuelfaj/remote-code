#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RC_NATIVE_TEST_WORK_DIR:?Set RC_NATIVE_TEST_WORK_DIR to a private writable evidence directory}"
case "$WORK_DIR" in
  /*) ;;
  *) echo "RC_NATIVE_TEST_WORK_DIR must be an absolute path" >&2; exit 2 ;;
esac
mkdir -p "$WORK_DIR"
API_PORT="${RC_NATIVE_TEST_API_PORT:-39211}"
if [[ ("${RC_NATIVE_TEST_WORKSPACES:-0}" == "1" || "${RC_NATIVE_TEST_PRIVACY_EXPIRY:-0}" == "1" || "${RC_NATIVE_TEST_PRIVACY_BUSY:-0}" == "1") && "$API_PORT" != "39211" ]]; then
  echo "Selected workspace tests require API port 39211." >&2
  exit 2
fi
API_ORIGIN="http://127.0.0.1:$API_PORT"
API_PASSWORD="remote-code-native-test-passphrase"
DATABASE_PATH="$WORK_DIR/remotecode-native.sqlite"
DEVICE_ID="${RC_NATIVE_TEST_DEVICE:-}"
API_PID=""
DERIVED_DATA_PATH="${RC_NATIVE_TEST_DERIVED_DATA:-$WORK_DIR/DerivedData}"
API_ENTRY="apps/api/src/index.ts"
TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppUsesAuthenticatedSnapshotEventsAndReceipts"
SKIP_TEST_ARG=""
if [[ "${RC_NATIVE_TEST_PRIVACY_EXPIRY:-0}" == "1" ]]; then
  for mode in RC_NATIVE_TEST_RECOVERY RC_NATIVE_TEST_AUTO_ACTION RC_NATIVE_TEST_HEALTH RC_NATIVE_TEST_DEADLINE RC_NATIVE_TEST_POST_DELAY RC_NATIVE_TEST_LOGIN_DEADLINE RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE RC_NATIVE_TEST_WORKSPACES RC_NATIVE_TEST_PRIVACY_BUSY; do
    if [[ "${!mode:-0}" == "1" ]]; then
      echo "RC_NATIVE_TEST_PRIVACY_EXPIRY cannot be combined with $mode." >&2
      exit 2
    fi
  done
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionReceiptUnauthorizedClearsPrivateWorkspaceState"
fi
if [[ "${RC_NATIVE_TEST_PRIVACY_BUSY:-0}" == "1" ]]; then
  for mode in RC_NATIVE_TEST_RECOVERY RC_NATIVE_TEST_AUTO_ACTION RC_NATIVE_TEST_HEALTH RC_NATIVE_TEST_DEADLINE RC_NATIVE_TEST_POST_DELAY RC_NATIVE_TEST_LOGIN_DEADLINE RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE RC_NATIVE_TEST_WORKSPACES RC_NATIVE_TEST_PRIVACY_EXPIRY; do
    if [[ "${!mode:-0}" == "1" ]]; then
      echo "RC_NATIVE_TEST_PRIVACY_BUSY cannot be combined with $mode." >&2
      exit 2
    fi
  done
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testWorkspaceUnauthorizedClearsBusyActionAndIgnoresOldReceiptAfterRelogin"
fi
if [[ "${RC_NATIVE_TEST_WORKSPACES:-0}" == "1" ]]; then
  for mode in RC_NATIVE_TEST_RECOVERY RC_NATIVE_TEST_AUTO_ACTION RC_NATIVE_TEST_HEALTH RC_NATIVE_TEST_DEADLINE RC_NATIVE_TEST_POST_DELAY RC_NATIVE_TEST_LOGIN_DEADLINE RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE; do
    if [[ "${!mode:-0}" == "1" ]]; then
      echo "RC_NATIVE_TEST_WORKSPACES cannot be combined with $mode." >&2
      exit 2
    fi
  done
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppCreatesAndMutatesTwoWorkspaceMetadataRecords"
fi
EXTRA_SKIP_ARGS=()
if [[ "${RC_NATIVE_TEST_RECOVERY:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests"
  SKIP_TEST_ARG="-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testReadinessShowsRealSQLiteLockAndRecoversWithoutBlockingLogin"
  EXTRA_SKIP_ARGS=("-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionReceiptAfterLostBody" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionReceiptStallEndsUnknownWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionMalformedTimestampStaysUnknownWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionDeadlineStartsAtTapAndIgnoresLateReceiptWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionPostAcceptedAfterTapDeadlineStaysUnknownUntilManualReceipt" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNativeLoginDeadlineStartsAtTapAndNeverReplays" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNativeLoginPreflightDeadlineSendsNoRequestAndAllowsManualRetry" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppCreatesAndMutatesTwoWorkspaceMetadataRecords" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionReceiptUnauthorizedClearsPrivateWorkspaceState" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testWorkspaceUnauthorizedClearsBusyActionAndIgnoresOldReceiptAfterRelogin")
fi
if [[ "${RC_NATIVE_TEST_AUTO_ACTION:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionReceiptAfterLostBody"
  SKIP_TEST_ARG="-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionReceiptStallEndsUnknownWithoutReplay"
  EXTRA_SKIP_ARGS=("-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionMalformedTimestampStaysUnknownWithoutReplay")
fi
if [[ "${RC_NATIVE_TEST_HEALTH:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testReadinessShowsRealSQLiteLockAndRecoversWithoutBlockingLogin"
  SKIP_TEST_ARG=""
fi
if [[ "${RC_NATIVE_TEST_DEADLINE:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionDeadlineStartsAtTapAndIgnoresLateReceiptWithoutReplay"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
fi
if [[ "${RC_NATIVE_TEST_POST_DELAY:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionPostAcceptedAfterTapDeadlineStaysUnknownUntilManualReceipt"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
fi
if [[ "${RC_NATIVE_TEST_LOGIN_DEADLINE:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNativeLoginDeadlineStartsAtTapAndNeverReplays"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
fi
if [[ "${RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNativeLoginPreflightDeadlineSendsNoRequestAndAllowsManualRetry"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
fi
if [[ "${RC_NATIVE_TEST_WORKSPACES:-0}" == "1" ]]; then
  API_ENTRY="apps/api/src/index.ts"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
fi
if [[ "${RC_NATIVE_TEST_PRIVACY_EXPIRY:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
fi
if [[ "${RC_NATIVE_TEST_PRIVACY_BUSY:-0}" == "1" ]]; then
  API_ENTRY="apps/api/test-support/native-recovery.ts"
  SKIP_TEST_ARG=""
  EXTRA_SKIP_ARGS=()
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

if [[ -e "$DATABASE_PATH" || -e "$WORK_DIR/NativeTests.xcresult" ]]; then
  echo "Use a fresh evidence directory; existing native proof will not be overwritten." >&2
  exit 2
fi
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

if [[ "${RC_NATIVE_TEST_REUSE_IOS_PROJECT:-0}" == "1" ]]; then
  if [[ ! -d "$ROOT_DIR/apps/mobile/ios/RemoteCodeMobileProof.xcworkspace" ]]; then
    echo "RC_NATIVE_TEST_REUSE_IOS_PROJECT=1 requires an existing generated iOS workspace." >&2
    exit 2
  fi
else
  (
    cd "$ROOT_DIR/apps/mobile"
    bunx expo prebuild --platform ios --no-install
  ) > "$WORK_DIR/expo-prebuild.log" 2>&1 || { cat "$WORK_DIR/expo-prebuild.log" >&2; exit 1; }
  (
    cd "$ROOT_DIR/apps/mobile/ios"
    pod install
  ) > "$WORK_DIR/pod-install.log" 2>&1 || { tail -100 "$WORK_DIR/pod-install.log" >&2; exit 1; }
fi

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
    -derivedDataPath "$DERIVED_DATA_PATH" \
    RC_NATIVE_TEST_API_ORIGIN="$API_ORIGIN" \
    -only-testing:"$TEST_SELECTION" \
    ${SKIP_TEST_ARG:+"$SKIP_TEST_ARG"} \
    ${EXTRA_SKIP_ARGS[@]+"${EXTRA_SKIP_ARGS[@]}"} \
    -resultBundlePath "$WORK_DIR/NativeTests.xcresult" \
    test > "$WORK_DIR/xcodebuild-test.log" 2>&1; then
  tail -100 "$WORK_DIR/xcodebuild-test.log" >&2
  exit 1
fi

python3 - "$DATABASE_PATH" "${RC_NATIVE_TEST_RECOVERY:-0}" "${RC_NATIVE_TEST_HEALTH:-0}" "${RC_NATIVE_TEST_AUTO_ACTION:-0}" "${RC_NATIVE_TEST_DEADLINE:-0}" "${RC_NATIVE_TEST_POST_DELAY:-0}" "${RC_NATIVE_TEST_LOGIN_DEADLINE:-0}" "${RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE:-0}" "${RC_NATIVE_TEST_WORKSPACES:-0}" "${RC_NATIVE_TEST_PRIVACY_EXPIRY:-0}" "${RC_NATIVE_TEST_PRIVACY_BUSY:-0}" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
try:
    rows = connection.execute("SELECT id, action, created_at FROM actions ORDER BY sequence").fetchall()
    session_count = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    auth_rows = connection.execute("SELECT request_id, kind, target_request_id, outcome FROM auth_requests ORDER BY created_at").fetchall()
finally:
    connection.close()
if sys.argv[10] == "1" or sys.argv[11] == "1":
    connections = sqlite3.connect(sys.argv[1])
    try:
        workspaces = connections.execute("SELECT id, name, archived FROM workspaces ORDER BY created_at, id").fetchall()
        creates = connections.execute("SELECT request_id, workspace_id FROM workspace_requests").fetchall()
        workspace_receipts = connections.execute("SELECT request_id, workspace_id, kind, name, archived FROM workspace_receipts").fetchall()
        changes = connections.execute("SELECT request_id, workspace_id, kind FROM workspace_change_requests").fetchall()
        action_mappings = connections.execute("SELECT request_id, action_id FROM action_requests").fetchall()
        sessions = connections.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        integrity = connections.execute("PRAGMA quick_check").fetchone()
    finally:
        connections.close()
    if len(rows) != 1 or not rows[0][1].startswith("native-privacy-action-"):
        raise SystemExit(f"Expected exactly one committed privacy-regression action: {rows!r}")
    run_id = rows[0][1].removeprefix("native-privacy-action-")
    if len(run_id) != 36 or len(action_mappings) != 1 or action_mappings[0][1] != rows[0][0]:
        raise SystemExit(f"Expected exactly one matching action request mapping: actions={rows!r}, mappings={action_mappings!r}")
    expected_workspace = f"native-privacy-workspace-{run_id}"
    if len(workspaces) != 1 or workspaces[0][1:] != (expected_workspace, 0):
        raise SystemExit(f"Private workspace must remain durable and unchanged after UI privacy clearing: {workspaces!r}")
    if len(creates) != 1 or creates[0][1] != workspaces[0][0]:
        raise SystemExit(f"Expected exactly one durable creation mapping and no new workspace writes: {creates!r}")
    if len(workspace_receipts) != 1 or workspace_receipts[0][1:] != (workspaces[0][0], "create", expected_workspace, 0):
        raise SystemExit(f"Expected one immutable create receipt for the retained workspace: {workspace_receipts!r}")
    if changes or sessions != 0 or integrity != ("ok",):
        raise SystemExit(f"Privacy regression left unexpected state: changes={changes!r}, sessions={sessions}, integrity={integrity!r}")
    if sys.argv[11] == "1":
        from collections import Counter
        auth_effects = Counter((row[1], row[3]) for row in auth_rows)
        expected_auth_effects = Counter({("login", "session_created"): 2, ("logout", "sessions_revoked"): 1})
        if auth_effects != expected_auth_effects or len({row[0] for row in auth_rows}) != 3:
            raise SystemExit(f"Expected two real native logins and one explicit UI logout receipt: {auth_rows!r}")
    print(json.dumps({"actions": rows, "actionMappings": len(action_mappings), "workspaces": workspaces, "creationMappings": len(creates), "workspaceReceipts": len(workspace_receipts), "changeMappings": len(changes), "authEffects": {f"{kind}:{outcome}": count for (kind, outcome), count in Counter((row[1], row[3]) for row in auth_rows).items()} if sys.argv[11] == "1" else None, "remainingSessions": sessions, "quick_check": integrity[0]}, indent=2))
    sys.exit(0)
if sys.argv[9] == "1":
    from collections import Counter
    connection = sqlite3.connect(sys.argv[1])
    try:
        workspaces = connection.execute("SELECT id, name, archived FROM workspaces ORDER BY created_at, id").fetchall()
        creates = connection.execute("SELECT request_id, workspace_id FROM workspace_requests").fetchall()
        receipts = connection.execute("SELECT request_id, workspace_id, kind, name, archived FROM workspace_receipts").fetchall()
        changes = connection.execute("SELECT request_id, workspace_id, kind FROM workspace_change_requests").fetchall()
        sessions = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        integrity = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    kinds = Counter(row[2] for row in receipts)
    if len(workspaces) != 2 or len({row[0] for row in workspaces}) != 2:
        raise SystemExit(f"Expected exactly two distinct workspace records: {workspaces!r}")
    if len(creates) != 2 or {row[1] for row in creates} != {row[0] for row in workspaces}:
        raise SystemExit(f"Expected two creation mappings for the retained workspace IDs: {creates!r}")
    if len(receipts) != 4 or kinds != Counter({"create": 2, "rename": 1, "archive": 1}):
        raise SystemExit(f"Expected two creation and two immutable change receipts: {receipts!r}")
    if len(changes) != 2 or Counter(row[2] for row in changes) != Counter({"rename": 1, "archive": 1}):
        raise SystemExit(f"Expected two persisted change acceptance markers: {changes!r}")
    if {(row[0], row[1], row[2]) for row in changes} != {(row[0], row[1], row[2]) for row in receipts if row[2] in ("rename", "archive")}:
        raise SystemExit(f"Change acceptance markers must target their immutable operation receipts: markers={changes!r}, receipts={receipts!r}")
    created = [row for row in receipts if row[2] == "create"]
    renamed = [row for row in receipts if row[2] == "rename"]
    archived_receipt = [row for row in receipts if row[2] == "archive"]
    if len(created) != 2 or len(renamed) != 1 or len(archived_receipt) != 1:
        raise SystemExit("Workspace receipts do not contain the expected immutable create/rename/archive history")
    renamed_name = renamed[0][3]
    prefix = "native-workspace-A-renamed-"
    if not renamed_name.startswith(prefix):
        raise SystemExit(f"Rename receipt must preserve the accepted A name: {renamed!r}")
    run_id = renamed_name.removeprefix(prefix)
    expected_a = f"native-workspace-A-{run_id}"
    expected_b = f"native-workspace-B-{run_id}"
    live_by_name = {row[1]: row for row in workspaces}
    created_by_id = {row[1]: row for row in created}
    if len(run_id) != 36 or len(live_by_name) != 2 or set(live_by_name) != {renamed_name, expected_b}:
        raise SystemExit(f"Live workspace names do not match this native run: run_id={run_id!r}, workspaces={workspaces!r}")
    live_a = live_by_name[renamed_name]
    live_b = live_by_name[expected_b]
    if set(created_by_id) != {live_a[0], live_b[0]}:
        raise SystemExit(f"Creation receipts do not map exactly to live A/B IDs: created={created!r}, workspaces={workspaces!r}")
    if created_by_id[live_a[0]][3:5] != (expected_a, 0) or created_by_id[live_b[0]][3:5] != (expected_b, 0):
        raise SystemExit(f"Original create names/states were not preserved for this run: {created!r}")
    if (renamed[0][1], renamed[0][3], renamed[0][4]) != (live_a[0], renamed_name, 0):
        raise SystemExit(f"Rename receipt must target A and preserve its active renamed state: {renamed!r}")
    if (archived_receipt[0][1], archived_receipt[0][3], archived_receipt[0][4]) != (live_b[0], expected_b, 1):
        raise SystemExit(f"Archive receipt must target B and retain its data/state: {archived_receipt!r}")
    if live_a[2] != 0 or live_b[2] != 1 or sessions != 0 or integrity != ("ok",):
        raise SystemExit(f"Workspace UI proof left invalid final state: A={live_a!r}, B={live_b!r}, sessions={sessions}, integrity={integrity!r}")
    print(json.dumps({"workspaces": workspaces, "creationMappings": len(creates), "workspaceReceipts": kinds, "changeMarkers": len(changes), "remainingSessions": sessions, "quick_check": integrity[0]}, indent=2))
    sys.exit(0)
if sys.argv[8] == "1":
    from collections import Counter
    kinds = Counter(row[1] for row in auth_rows)
    outcomes = sorted((row[1], row[3]) for row in auth_rows)
    connection = sqlite3.connect(sys.argv[1])
    try:
        integrity = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    expected_kinds = Counter({"login": 1, "logout": 1})
    if rows or session_count != 0 or kinds != expected_kinds or outcomes != [("login", "session_created"), ("logout", "sessions_revoked")] or integrity != ("ok",):
        raise SystemExit(f"Native login preflight deadline proof left unexpected state: actions={rows!r}, sessions={session_count}, auth={dict(kinds)!r}, outcomes={outcomes!r}, integrity={integrity!r}")
    print(json.dumps({"actions": len(rows), "remainingSessions": session_count, "authKinds": dict(kinds), "authOutcomes": outcomes, "quick_check": integrity[0]}))
    sys.exit(0)
if sys.argv[7] == "1":
    from collections import Counter
    kinds = Counter(row[1] for row in auth_rows)
    connection = sqlite3.connect(sys.argv[1])
    try:
        integrity = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    expected_kinds = Counter({"login": 2, "logout": 1, "revoke_login": 1})
    if rows or session_count != 0 or kinds != expected_kinds or integrity != ("ok",):
        raise SystemExit(f"Native login deadline proof left unexpected state: actions={rows!r}, sessions={session_count}, auth_kinds={dict(kinds)!r}, integrity={integrity!r}")
    print(json.dumps({"actions": len(rows), "remainingSessions": session_count, "authKinds": dict(kinds), "quick_check": integrity[0]}))
    sys.exit(0)
if sys.argv[6] == "1":
    if len(rows) != 1 or not rows[0][1].startswith("native-postdeadline-") or session_count != 0:
        raise SystemExit(f"Expected one delayed native action and no remaining sessions: actions={rows!r}, sessions={session_count}")
    connection = sqlite3.connect(sys.argv[1])
    try:
        mappings = connection.execute("SELECT request_id, action_id FROM action_requests WHERE action_id = ?", (rows[0][0],)).fetchall()
        integrity = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    if len(mappings) != 1 or mappings[0][1] != rows[0][0] or integrity != ("ok",):
        raise SystemExit(f"Expected one matching durable late-action receipt and healthy SQLite: mappings={mappings!r}, integrity={integrity!r}")
    print(json.dumps({"actionAfterDeadline": rows[0], "mapping": mappings[0], "quick_check": integrity[0]}))
    sys.exit(0)
if sys.argv[5] == "1":
    if len(rows) != 1 or not rows[0][1].startswith("native-deadline-") or session_count != 0:
        raise SystemExit(f"Expected one recovered native deadline action and no remaining sessions: actions={rows!r}, sessions={session_count}")
    connection = sqlite3.connect(sys.argv[1])
    try:
        mappings = connection.execute("SELECT request_id, action_id FROM action_requests WHERE action_id = ?", (rows[0][0],)).fetchall()
        integrity = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    if len(mappings) != 1 or mappings[0][1] != rows[0][0] or integrity != ("ok",):
        raise SystemExit(f"Expected one matching durable deadline receipt and healthy SQLite: mappings={mappings!r}, integrity={integrity!r}")
    print(json.dumps({"deadlineAction": rows[0], "mapping": mappings[0], "quick_check": integrity[0]}))
    sys.exit(0)
if sys.argv[4] == "1":
    if len(rows) != 3 or any(not row[1].startswith("native-auto-") for row in rows):
        raise SystemExit(f"Expected three distinct automatic native actions: {rows!r}")
    connection = sqlite3.connect(sys.argv[1])
    try:
        mappings = connection.execute("SELECT request_id, action_id FROM action_requests").fetchall()
    finally:
        connection.close()
    if len(mappings) != 3 or len({m[0] for m in mappings}) != 3:
        raise SystemExit(f"Expected exactly three action receipts: {mappings!r}")
    print(json.dumps({"automaticActions": rows, "mappings": mappings}))
    sys.exit(0)
if sys.argv[3] == "1":
    connection = sqlite3.connect(sys.argv[1])
    try:
        health_mappings = connection.execute("SELECT request_id, action_id FROM action_requests WHERE action_id = ?", (rows[0][0],)).fetchall() if rows else []
    finally:
        connection.close()
    if len(rows) != 1 or not rows[0][1].startswith("native-health-") or len(health_mappings) != 1 or session_count != 0 or len(auth_rows) != 2 or sorted(row[1] for row in auth_rows) != ["login", "logout"]:
        raise SystemExit(f"Native health proof left unexpected persisted state: actions={rows!r}, mappings={health_mappings!r}, sessions={session_count}, auth={auth_rows!r}")
    print(json.dumps({"healthNativeActions": rows, "requestMapping": health_mappings, "remainingSessions": session_count, "authKinds": [row[1] for row in auth_rows]}))
    sys.exit(0)
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
if sys.argv[2] == "1":
    from collections import Counter
    kinds = Counter(row[1] for row in auth_rows)
    if kinds != {"login": 14, "logout": 8, "revoke_login": 5}:
        raise SystemExit(f"Unexpected keyed native auth effects: {dict(kinds)!r}")
    fenced = [row for row in auth_rows if row[3] == "closed_before_acceptance"]
    if len(fenced) != 1:
        raise SystemExit("Expected exactly one delayed login fenced before acceptance")
    for row in auth_rows:
        if row[1] == "revoke_login" and not any(login[0] == row[2] and login[1] == "login" for login in auth_rows):
            raise SystemExit("Native revocation does not target its durable original login")
    print(json.dumps({"authReceipts": [{"requestId": row[0], "kind": row[1], "targetRequestId": row[2], "outcome": row[3]} for row in auth_rows]}, indent=2))
if session_count != 0:
    raise SystemExit(f"Native logout left {session_count} persisted session(s)")
print(json.dumps({"actions": [{"id": row[0], "action": row[1], "createdAt": row[2]} for row in rows], "remainingSessions": session_count}, indent=2))
PY

echo "Native iOS UI test and SQLite readback passed on simulator $DEVICE_ID. Evidence: $WORK_DIR"
