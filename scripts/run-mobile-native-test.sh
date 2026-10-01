#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RC_NATIVE_TEST_WORK_DIR:?Set RC_NATIVE_TEST_WORK_DIR to a private writable evidence directory}"
case "$WORK_DIR" in
  /*) ;;
  *) echo "RC_NATIVE_TEST_WORK_DIR must be an absolute path" >&2; exit 2 ;;
esac
mkdir -p "$WORK_DIR"
if [[ -L "$WORK_DIR" ]]; then
  echo "RC_NATIVE_TEST_WORK_DIR must not be a symlink." >&2
  exit 2
fi
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
python3 - "$WORK_DIR" <<'PY'
import os,stat,sys
path=sys.argv[1]
entry=os.lstat(path)
if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid(): raise SystemExit("RC_NATIVE_TEST_WORK_DIR must be an owned real directory.")
PY
chmod 700 "$WORK_DIR"
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
OWNED_DEVICE_ID=""
OWNED_DEVICE_NAME=""
DERIVED_DATA_PATH="${RC_NATIVE_TEST_DERIVED_DATA:-$WORK_DIR/DerivedData}"

cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  if [[ "${RC_NATIVE_TEST_STORAGE_FAILURE:-0}" == "1" && -n "$OWNED_DEVICE_ID" ]]; then
    if ! xcrun simctl list devices booted --json | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; raise SystemExit(0 if any(x["udid"]==sys.argv[1] and x["state"]=="Booted" for v in d.values() for x in v) else 1)' "$OWNED_DEVICE_ID"; then
      xcrun simctl boot "$OWNED_DEVICE_ID" || status=1
      xcrun simctl bootstatus "$OWNED_DEVICE_ID" -b || status=1
    fi
  fi
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" || status=1
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ "${RC_NATIVE_TEST_STORAGE_FAILURE:-0}" == "1" && -n "$OWNED_DEVICE_ID" ]]; then
    if ! python3 - "$WORK_DIR" "$OWNED_DEVICE_ID" > "$WORK_DIR/permission-restore.json" <<'PY'
import json,os,stat,subprocess,sys
work_dir,device_id=sys.argv[1:]
record_path=os.path.join(work_dir,"manifest-permissions.jsonl")
if not os.path.exists(record_path):
    print(json.dumps({"restored":True,"changed":False}))
    raise SystemExit(0)
with open(record_path,encoding="utf-8") as stream: events=[json.loads(line) for line in stream if line.strip()]
if not events: raise SystemExit("Permission audit exists but contains no records.")
key=(device_id,"com.remotecode.mobileproof","Library/Application Support/com.remotecode.mobileproof/RCTAsyncLocalStorage_V1")
if any((event["deviceId"],event["bundleId"],event["relativePath"])!=key for event in events):
    raise SystemExit("Permission audit identity did not match the runner-owned app directory.")
runner_device=json.load(open(os.path.join(work_dir,"simulator.json"),encoding="utf-8"))
if runner_device["udid"]!=device_id: raise SystemExit("Simulator cleanup target does not match the runner-owned record.")
app_root=subprocess.check_output(["xcrun","simctl","get_app_container",device_id,"com.remotecode.mobileproof","data"],text=True).strip()
app_root=os.path.realpath(app_root)
device_data=os.path.realpath(os.path.join(os.path.expanduser("~"),"Library","Developer","CoreSimulator","Devices",device_id,"data"))
app_containers=os.path.join(device_data,"Containers","Data","Application")
if not app_root.startswith(app_containers+os.sep): raise SystemExit("App container escaped the runner-owned simulator data directory.")
target=os.path.join(app_root,"Library","Application Support","com.remotecode.mobileproof","RCTAsyncLocalStorage_V1")
current=app_root
for component in ("Library","Application Support","com.remotecode.mobileproof","RCTAsyncLocalStorage_V1"):
    current=os.path.join(current,component)
    entry=os.lstat(current)
    if not stat.S_ISDIR(entry.st_mode) or stat.S_ISLNK(entry.st_mode): raise SystemExit("Permission target contains a non-directory or symlink.")
manifest=os.path.join(target,"manifest.json")
entry=os.lstat(manifest)
if not stat.S_ISREG(entry.st_mode) or stat.S_ISLNK(entry.st_mode): raise SystemExit("AsyncStorage manifest is not an initialized regular file.")
baseline=next((event for event in events if event["event"]=="before-special-bit"),None)
if baseline is None: baseline=next((event for event in events if event["event"]=="before-write-denial"),None)
if baseline is None: raise SystemExit("Permission audit has no pre-change mode/owner record.")
expected=(baseline["mode"]&0o7777,baseline["uid"],baseline["gid"])
owner=os.stat(target,follow_symlinks=False)
observed=(stat.S_IMODE(owner.st_mode)&0o7777,owner.st_uid,owner.st_gid)
if observed[1:]!=expected[1:]: raise SystemExit(f"Owned manifest UID/GID changed: expected={expected[1:]}, observed={observed[1:]}")
if observed!=expected:
    os.chmod(target,expected[0],follow_symlinks=False)
    owner=os.stat(target,follow_symlinks=False)
    observed=(stat.S_IMODE(owner.st_mode)&0o7777,owner.st_uid,owner.st_gid)
if observed!=expected: raise SystemExit(f"Owned manifest mode/owner mismatch after cleanup: expected={expected}, observed={observed}")
def count(event_name,mode,uid,gid):
    return sum(1 for event in events if event["event"]==event_name and event["mode"]==mode and event["uid"]==uid and event["gid"]==gid)
for event in events:
    if event["event"]=="before-write-denial":
        before_count=count("before-write-denial",event["mode"],event["uid"],event["gid"])
        if count("write-denied",event["mode"]&~0o222,event["uid"],event["gid"])<before_count: raise SystemExit("Native write-denial mode was not recorded exactly.")
        if count("restored",event["mode"],event["uid"],event["gid"])<before_count: raise SystemExit("Native write-denial mode was not recorded restored.")
    if event["event"]=="before-special-bit":
        before_count=count("before-special-bit",event["mode"],event["uid"],event["gid"])
        set_count=count("special-bit-set",event["mode"]|0o2000,event["uid"],event["gid"])
        unavailable_count=count("special-bit-unavailable",event["mode"],event["uid"],event["gid"])
        if set_count+unavailable_count<before_count: raise SystemExit("Set-group-ID probe outcome was not recorded.")
        if count("special-baseline-restored",event["mode"],event["uid"],event["gid"])<before_count: raise SystemExit("Set-group-ID baseline was not recorded restored.")
summary={"restored":True,"changed":True,"deviceId":device_id,"bundleId":"com.remotecode.mobileproof","relativePath":"Library/Application Support/com.remotecode.mobileproof/RCTAsyncLocalStorage_V1","mode":observed[0],"uid":observed[1],"gid":observed[2],"modeEvents":len(events)}
print(json.dumps(summary))
PY
    then
      echo "Could not verify or restore the task-owned AsyncStorage directory." >&2
      status=1
    fi
  fi
  if [[ -n "$OWNED_DEVICE_ID" ]]; then
    xcrun simctl shutdown "$OWNED_DEVICE_ID" >/dev/null 2>&1 || true
    xcrun simctl delete "$OWNED_DEVICE_ID" || status=1
    if xcrun simctl list devices available --json | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; raise SystemExit(1 if any(x["udid"] == sys.argv[1] for v in d.values() for x in v) else 0)' "$OWNED_DEVICE_ID"; then
      printf '{"ownedDeviceId":"%s","deleted":true}\n' "$OWNED_DEVICE_ID" > "$WORK_DIR/simulator-cleanup.json"
    else
      echo "Task-owned simulator $OWNED_DEVICE_ID still exists after cleanup." >&2
      status=1
    fi
    if ! xcrun simctl list devices available --json | python3 -c 'import json,sys; before=json.load(open(sys.argv[1])); data=json.load(sys.stdin); after={x["udid"]:{"runtime":r,"name":x["name"],"deviceTypeIdentifier":x["deviceTypeIdentifier"],"state":x["state"],"dataPath":x["dataPath"],"lastBootedAt":x.get("lastBootedAt")} for r,v in data["devices"].items() for x in v if x["udid"] in before}; raise SystemExit(0 if after==before else 1)' "$WORK_DIR/preexisting-booted-devices.json"; then
      echo "A pre-existing booted simulator changed during storage proof." >&2
      status=1
    else
      printf '{"unchanged":true}\n' > "$WORK_DIR/preexisting-booted-cleanup.json"
    fi
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT INT TERM
API_ENTRY="apps/api/src/index.ts"
TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppUsesAuthenticatedSnapshotEventsAndReceipts"
SKIP_TEST_ARG=""
ONLY_TEST_ARGS=()
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
  EXTRA_SKIP_ARGS=("-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionReceiptAfterLostBody" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionReceiptStallEndsUnknownWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testAutomaticActionMalformedTimestampStaysUnknownWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionDeadlineStartsAtTapAndIgnoresLateReceiptWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionPostAcceptedAfterTapDeadlineStaysUnknownUntilManualReceipt" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNativeLoginDeadlineStartsAtTapAndNeverReplays" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNativeLoginPreflightDeadlineSendsNoRequestAndAllowsManualRetry" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppCreatesAndMutatesTwoWorkspaceMetadataRecords" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testActionReceiptUnauthorizedClearsPrivateWorkspaceState" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testWorkspaceUnauthorizedClearsBusyActionAndIgnoresOldReceiptAfterRelogin" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testPendingActionAPrePostWriteFailureSendsNoActionAndBlocksSubmission" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testPendingActionZReceiptClearFailureRecoversOriginalReceiptAfterRelaunchWithoutReplay")
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
if [[ "${RC_NATIVE_TEST_STORAGE_FAILURE:-0}" == "1" ]]; then
  if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $API_PORT is already in use; leaving its process untouched." >&2
    exit 2
  fi
  if [[ -e "$DATABASE_PATH" || -e "$WORK_DIR/NativeTests.xcresult" || -e "$WORK_DIR/manifest-permissions.jsonl" || -e "$WORK_DIR/simulator.json" || -e "$WORK_DIR/preexisting-booted-devices.json" || -e "$WORK_DIR/permission-restore.json" ]]; then
    echo "Use a fresh evidence directory; existing native proof will not be overwritten." >&2
    exit 2
  fi
  for mode in RC_NATIVE_TEST_RECOVERY RC_NATIVE_TEST_AUTO_ACTION RC_NATIVE_TEST_HEALTH RC_NATIVE_TEST_DEADLINE RC_NATIVE_TEST_POST_DELAY RC_NATIVE_TEST_LOGIN_DEADLINE RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE RC_NATIVE_TEST_WORKSPACES RC_NATIVE_TEST_PRIVACY_EXPIRY RC_NATIVE_TEST_PRIVACY_BUSY; do
    if [[ "${!mode:-0}" == "1" ]]; then
      echo "RC_NATIVE_TEST_STORAGE_FAILURE cannot be combined with $mode." >&2
      exit 2
    fi
  done
  if [[ -n "$DEVICE_ID" ]]; then
    echo "RC_NATIVE_TEST_STORAGE_FAILURE creates and owns its own simulator; RC_NATIVE_TEST_DEVICE is forbidden." >&2
    exit 2
  fi
  if [[ -z "${RC_NATIVE_TEST_STORAGE_SCENARIO:-}" ]]; then
    for scenario in before-post after-receipt; do
      scenario_dir="$WORK_DIR/$scenario"
      mkdir -p "$scenario_dir"
      if ! RC_NATIVE_TEST_STORAGE_FAILURE=1 RC_NATIVE_TEST_STORAGE_SCENARIO="$scenario" RC_NATIVE_TEST_REUSE_IOS_PROJECT=1 RC_NATIVE_TEST_WORK_DIR="$scenario_dir" RC_NATIVE_TEST_DERIVED_DATA="$DERIVED_DATA_PATH" bash "$ROOT_DIR/scripts/run-mobile-native-test.sh"; then
        exit 1
      fi
    done
    exit 0
  fi
  case "$RC_NATIVE_TEST_STORAGE_SCENARIO" in
    before-post)
      TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testPendingActionAPrePostWriteFailureSendsNoActionAndBlocksSubmission"
      ONLY_TEST_ARGS=()
      ;;
    after-receipt)
      TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testPendingActionZReceiptClearFailureRecoversOriginalReceiptAfterRelaunchWithoutReplay"
      ONLY_TEST_ARGS=()
      ;;
    *) echo "Invalid RC_NATIVE_TEST_STORAGE_SCENARIO." >&2; exit 2 ;;
  esac
  xcrun simctl list devices booted --json | python3 -c 'import json,sys; data=json.load(sys.stdin); devices={x["udid"]:{"runtime":r,"name":x["name"],"deviceTypeIdentifier":x["deviceTypeIdentifier"],"state":x["state"],"dataPath":x["dataPath"],"lastBootedAt":x.get("lastBootedAt")} for r,v in data["devices"].items() for x in v if x["state"]=="Booted"}; print(json.dumps(devices,sort_keys=True))' > "$WORK_DIR/preexisting-booted-devices.json"
  simulator_name="RC018-storage-proof-$$-$RANDOM"
  OWNED_DEVICE_ID="$(xcrun simctl create "$simulator_name" com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro com.apple.CoreSimulator.SimRuntime.iOS-18-5)"
  OWNED_DEVICE_NAME="$simulator_name"
  DEVICE_ID="$OWNED_DEVICE_ID"
  python3 - "$WORK_DIR/simulator.json" "$simulator_name" "$OWNED_DEVICE_ID" <<'PY'
import json,sys
with open(sys.argv[1],"x") as file: json.dump({"name":sys.argv[2],"udid":sys.argv[3],"deviceType":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-18-5"},file,indent=2)
PY
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

if [[ -e "$DATABASE_PATH" || -e "$WORK_DIR/NativeTests.xcresult" ]]; then
  echo "Use a fresh evidence directory; existing native proof will not be overwritten." >&2
  exit 2
fi
cd "$ROOT_DIR"
API_PORT="$API_PORT" \
  DATABASE_PATH="$DATABASE_PATH" \
  RC_NATIVE_TEST_STORAGE_DEVICE_ID="$OWNED_DEVICE_ID" \
  RC_NATIVE_TEST_STORAGE_DEVICE_NAME="$OWNED_DEVICE_NAME" \
  RC_NATIVE_TEST_WORK_DIR="$WORK_DIR" \
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
    ${ONLY_TEST_ARGS[@]+"${ONLY_TEST_ARGS[@]}"} \
    -resultBundlePath "$WORK_DIR/NativeTests.xcresult" \
    test > "$WORK_DIR/xcodebuild-test.log" 2>&1; then
  tail -100 "$WORK_DIR/xcodebuild-test.log" >&2
  exit 1
fi

python3 - "$DATABASE_PATH" "${RC_NATIVE_TEST_RECOVERY:-0}" "${RC_NATIVE_TEST_HEALTH:-0}" "${RC_NATIVE_TEST_AUTO_ACTION:-0}" "${RC_NATIVE_TEST_DEADLINE:-0}" "${RC_NATIVE_TEST_POST_DELAY:-0}" "${RC_NATIVE_TEST_LOGIN_DEADLINE:-0}" "${RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE:-0}" "${RC_NATIVE_TEST_WORKSPACES:-0}" "${RC_NATIVE_TEST_PRIVACY_EXPIRY:-0}" "${RC_NATIVE_TEST_PRIVACY_BUSY:-0}" "${RC_NATIVE_TEST_STORAGE_FAILURE:-0}" "${RC_NATIVE_TEST_STORAGE_SCENARIO:-}" <<'PY'
import json
import sqlite3
import sys
from collections import Counter

connection = sqlite3.connect(sys.argv[1])
try:
    rows = connection.execute("SELECT id, action, created_at FROM actions ORDER BY sequence").fetchall()
    session_count = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    auth_rows = connection.execute("SELECT request_id, kind, target_request_id, outcome FROM auth_requests ORDER BY created_at").fetchall()
finally:
    connection.close()
if sys.argv[12] == "1":
    audit = sqlite3.connect(sys.argv[1], uri=False)
    try:
        mappings = audit.execute("SELECT request_id, action_id FROM action_requests ORDER BY request_id").fetchall()
        sessions = audit.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        integrity = audit.execute("PRAGMA quick_check").fetchone()
    finally:
        audit.close()
    auth_effects = Counter((row[1], row[3]) for row in auth_rows)
    if sys.argv[13] == "before-post":
        if rows or mappings:
            raise SystemExit(f"Pre-POST storage failure created an action or request mapping: actions={rows!r}, mappings={mappings!r}")
        expected_auth_effects = Counter({("login", "session_created"): 1})
    elif sys.argv[13] == "after-receipt":
        if len(rows) != 1 or not rows[0][1].startswith("native-storage-after-receipt-"):
            raise SystemExit(f"Expected only the one committed action from pending-ID removal failure: {rows!r}")
        if len(mappings) != 1 or mappings[0][1] != rows[0][0] or len(mappings[0][0]) != 36:
            raise SystemExit(f"Expected one canonical action-request mapping to the confirmed effect: {mappings!r}")
        expected_auth_effects = Counter({("login", "session_created"): 2})
    else:
        raise SystemExit(f"Unexpected native storage case in runner audit: {sys.argv[13]!r}")
    if sessions != 0 or integrity != ("ok",):
        raise SystemExit(f"Unexpected native storage proof database state: sessions={sessions}, quick_check={integrity!r}")
    if auth_effects != expected_auth_effects or len({row[0] for row in auth_rows}) != sum(expected_auth_effects.values()):
        raise SystemExit(f"Unexpected keyed auth-receipt effects: {auth_rows!r}")
    print(json.dumps({"scenario": sys.argv[13], "actions": rows, "actionMappings": mappings, "authEffects": {f"{kind}:{outcome}": count for (kind, outcome), count in auth_effects.items()}, "sessions": sessions, "quick_check": integrity[0]}, indent=2))
    sys.exit(0)
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
