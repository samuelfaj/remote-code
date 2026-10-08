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
if [[ "${RC_NATIVE_TEST_JOINED_WORKSPACE:-0}" == "1" ]]; then
  [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" && "$API_PORT" == "39211" ]] || { echo "Joined proof requires FILES mode on API port 39211." >&2; exit 2; }
  for record in simulator.json joined-volume.json joined-current-container.json joined-evidence.json; do
    [[ ! -e "$WORK_DIR/$record" ]] || { echo "Use a fresh joined-proof evidence directory." >&2; exit 2; }
  done
fi
if [[ ("${RC_NATIVE_TEST_WORKSPACES:-0}" == "1" || "${RC_NATIVE_TEST_PRIVACY_EXPIRY:-0}" == "1" || "${RC_NATIVE_TEST_PRIVACY_BUSY:-0}" == "1") && "$API_PORT" != "39211" ]]; then
  echo "Selected workspace tests require API port 39211." >&2
  exit 2
fi
API_ORIGIN="http://127.0.0.1:$API_PORT"
API_PASSWORD="remote-code-native-test-passphrase"
DATABASE_PATH="$WORK_DIR/remotecode-native.sqlite"
DEVICE_ID="${RC_NATIVE_TEST_DEVICE:-}"
API_PID=""
DOCKER_ID=""
JOINED_VOLUME=""
API_DATABASE_PATH="$DATABASE_PATH"
API_TLS_CERT=""
API_TLS_KEY=""
TLS_CERT=""
TLS_KEY=""
OWNED_DEVICE_ID=""
OWNED_DEVICE_NAME=""
DERIVED_DATA_PATH="${RC_NATIVE_TEST_DERIVED_DATA:-$WORK_DIR/DerivedData}"
DERIVED_ARGS=("-derivedDataPath" "$DERIVED_DATA_PATH")

cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  if [[ -n "$JOINED_VOLUME" && -f "$WORK_DIR/joined-current-container.json" ]]; then
    local current_container
    if current_container="$(python3 -c 'import json,re,sys;r=json.load(open(sys.argv[1]));assert r["ownedDeviceId"]==sys.argv[2] and r["name"]==sys.argv[3] and re.fullmatch("[0-9a-f]{64}",r["containerId"]);print(r["containerId"],r["name"])' "$WORK_DIR/joined-current-container.json" "$OWNED_DEVICE_ID" "$DOCKER_NAME")"; then
      read -r DOCKER_ID DOCKER_NAME <<< "$current_container"
    else
      printf '{"reason":"current_container_identity_unavailable"}\n' > "$WORK_DIR/retained-linux-container.json"
      DOCKER_ID=""; TLS_CERT=""; TLS_KEY=""; status=1
    fi
  fi
  if [[ "${RC_NATIVE_TEST_STORAGE_FAILURE:-0}" == "1" && -n "$OWNED_DEVICE_ID" ]]; then
    if ! xcrun simctl list devices booted --json | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; raise SystemExit(0 if any(x["udid"]==sys.argv[1] and x["state"]=="Booted" for v in d.values() for x in v) else 1)' "$OWNED_DEVICE_ID"; then
      xcrun simctl boot "$OWNED_DEVICE_ID" || status=1
      xcrun simctl bootstatus "$OWNED_DEVICE_ID" -b || status=1
    fi
  fi
  if [[ -n "$DOCKER_ID" ]]; then
    local identity
    identity="$(docker inspect --format '{{.Id}} {{.Name}} {{index .Config.Labels "remotecode.rc029.native"}}' "$DOCKER_ID")" || status=1
    if [[ "$identity" == "$DOCKER_ID /$DOCKER_NAME $OWNED_DEVICE_ID" ]]; then
      if docker exec "$DOCKER_ID" bun -e 'import{Database}from"bun:sqlite";import{existsSync,readFileSync}from"node:fs";import{createHash}from"node:crypto";if(!existsSync(process.env.DATABASE_PATH)){console.log(JSON.stringify({databasePresent:false}));process.exit(0)}const d=new Database(process.env.DATABASE_PATH,{readonly:true,create:false});const outcomes=d.query("select request_id,workspace_id,kind,result_path,result_sha256 from file_operation_outcomes").all();const files=outcomes.map(r=>{const path="/var/lib/remotecode/workspaces/"+r.workspace_id+"/"+r.result_path;if(!existsSync(path))return{path,exists:false};const b=readFileSync(path);return{path,exists:true,sha256:createHash("sha256").update(b).digest("hex")}});console.log(JSON.stringify({databasePresent:true,outcomes,intents:d.query("select request_id,workspace_id,state from file_operation_intents").all(),files,quickCheck:d.query("pragma quick_check").all()}));d.close()' > "$WORK_DIR/linux-state-on-exit.json" 2> "$WORK_DIR/linux-state-on-exit-error.log" ; then
        docker rm -f "$DOCKER_ID" >/dev/null 2>&1 || status=1
        local remaining_containers
        remaining_containers="$(docker ps -a --no-trunc --format '{{.ID}}')" || status=1
        if grep -Fqx "$DOCKER_ID" <<< "$remaining_containers"; then echo "Task-owned Linux container remains: $DOCKER_ID" >&2; status=1; fi
      else
        printf '{"containerId":"%s","reason":"final_state_unavailable"}\n' "$DOCKER_ID" > "$WORK_DIR/retained-linux-container.json"
        echo "Final Linux state unavailable; retaining owned container and TLS material for reconciliation." >&2
        TLS_CERT=""; TLS_KEY=""
        status=1
      fi
    else
      printf '{"containerId":"%s","reason":"container_identity_unavailable_or_changed"}\n' "$DOCKER_ID" > "$WORK_DIR/retained-linux-container.json"
      echo "Container ownership unavailable or changed; retaining container and TLS material." >&2
      TLS_CERT=""; TLS_KEY=""; status=1
    fi
  fi
  if [[ -n "$JOINED_VOLUME" ]]; then
    if [[ "$status" == "0" && -n "$DOCKER_ID" ]]; then
      local volume_owner
      volume_owner="$(docker volume inspect --format '{{index .Labels "remotecode.rc021.joined"}}' "$JOINED_VOLUME")" || status=1
      if [[ "$volume_owner" == "$OWNED_DEVICE_ID" ]]; then
        docker volume rm "$JOINED_VOLUME" >/dev/null || status=1
        local remaining_volumes
        remaining_volumes="$(docker volume ls --format '{{.Name}}')" || status=1
        if grep -Fqx "$JOINED_VOLUME" <<< "$remaining_volumes"; then status=1; fi
        if [[ "$status" == "0" ]]; then printf '{"containerId":"%s","volume":"%s","removed":true}\n' "$DOCKER_ID" "$JOINED_VOLUME" > "$WORK_DIR/joined-cleanup.json"; fi
      else
        echo "Volume ownership changed; retaining it." >&2; status=1
      fi
    else
      printf '{"volume":"%s","reason":"joined_proof_not_reconciled"}\n' "$JOINED_VOLUME" > "$WORK_DIR/retained-joined-volume.json"
      status=1
    fi
  fi
  if [[ -n "$TLS_CERT" ]]; then rm -f "$TLS_CERT" "$TLS_KEY"; fi
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
if [[ "${RC_NATIVE_TEST_RECOVERY:-0}" == "1" ]]; then
  EXTRA_SKIP_ARGS+=("-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppListsOpensSavesLinuxWorkspaceFileAndRejectsStaleClient" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppRetainsUnknownCommittedSaveAndRecoversByReceiptWithoutReplay" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppCreatesMovesAndRefusesOccupiedStaleAndDirtyFiles" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppRecoversCommittedCreateAndMoveWithoutReplayingPost" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppKeepsDraftChangedDuringMovePreflightWithoutSendingPost" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppSignsOutDuringMovePreflightWithoutSendingPost" "-skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppPreparesLinuxFolderAndCreatesFileFromConfirmedState")
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
if [[ "${RC_NATIVE_TEST_NAVIGATION:-0}" == "1" ]]; then
  for mode in RC_NATIVE_TEST_RECOVERY RC_NATIVE_TEST_AUTO_ACTION RC_NATIVE_TEST_HEALTH RC_NATIVE_TEST_DEADLINE RC_NATIVE_TEST_POST_DELAY RC_NATIVE_TEST_LOGIN_DEADLINE RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE RC_NATIVE_TEST_WORKSPACES RC_NATIVE_TEST_PRIVACY_EXPIRY RC_NATIVE_TEST_PRIVACY_BUSY RC_NATIVE_TEST_STORAGE_FAILURE RC_NATIVE_TEST_FILES; do
    if [[ "${!mode:-0}" == "1" ]]; then
      echo "RC_NATIVE_TEST_NAVIGATION cannot be combined with $mode." >&2
      exit 2
    fi
  done
  API_ENTRY="apps/api/src/index.ts"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testNavigationAcrossScreensJourney"
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


if [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" ]]; then
  for mode in RC_NATIVE_TEST_RECOVERY RC_NATIVE_TEST_AUTO_ACTION RC_NATIVE_TEST_HEALTH RC_NATIVE_TEST_DEADLINE RC_NATIVE_TEST_POST_DELAY RC_NATIVE_TEST_LOGIN_DEADLINE RC_NATIVE_TEST_LOGIN_PREFLIGHT_DEADLINE RC_NATIVE_TEST_WORKSPACES RC_NATIVE_TEST_PRIVACY_EXPIRY RC_NATIVE_TEST_PRIVACY_BUSY RC_NATIVE_TEST_STORAGE_FAILURE; do
    if [[ "${!mode:-0}" == "1" ]]; then echo "RC_NATIVE_TEST_FILES cannot be combined with $mode." >&2; exit 2; fi
  done
  if [[ -n "$DEVICE_ID" ]]; then echo "RC_NATIVE_TEST_FILES creates and owns its simulator; RC_NATIVE_TEST_DEVICE is forbidden." >&2; exit 2; fi
  if [[ "${RC_NATIVE_TEST_REUSE_IOS_PROJECT:-0}" != "1" ]]; then echo "RC_NATIVE_TEST_FILES requires RC_NATIVE_TEST_REUSE_IOS_PROJECT=1; no project generation or dependency install is allowed." >&2; exit 2; fi
  LINUX_IMAGE="sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"
  API_ENTRY="apps/api/test-support/native-file-api.ts"
  API_ORIGIN="https://127.0.0.1:$API_PORT"
  API_DATABASE_PATH="/var/lib/remotecode/remotecode-native.sqlite"
  TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppListsOpensSavesLinuxWorkspaceFileAndRejectsStaleClient"
  ONLY_TEST_ARGS=("-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppRetainsUnknownCommittedSaveAndRecoversByReceiptWithoutReplay" "-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppUsesAuthenticatedSnapshotEventsAndReceipts" "-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppCreatesMovesAndRefusesOccupiedStaleAndDirtyFiles" "-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppRecoversCommittedCreateAndMoveWithoutReplayingPost")
  if [[ "${RC_NATIVE_TEST_SESSION:-0}" == "1" ]]; then
    TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppTakesOverAndReturnsTheScreenAndRefusesBotInput"
    ONLY_TEST_ARGS=()
  fi
  if [[ "${RC_NATIVE_TEST_SCREEN_LOSS:-0}" == "1" ]]; then
    TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppResolvesACommittedButLostPossessionReleaseByReceipt"
    ONLY_TEST_ARGS=()
  fi
  if [[ "${RC_NATIVE_TEST_MOVE_PREFLIGHT:-0}" == "1" ]]; then
    TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppKeepsDraftChangedDuringMovePreflightWithoutSendingPost"
    ONLY_TEST_ARGS=()
  fi
  if [[ "${RC_NATIVE_TEST_MOVE_PREFLIGHT:-0}" == "logout" ]]; then
    TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppSignsOutDuringMovePreflightWithoutSendingPost"
    ONLY_TEST_ARGS=()
  fi
  if [[ "${RC_NATIVE_TEST_FOLDER_PREP:-0}" == "1" ]]; then
    TEST_SELECTION="RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppPreparesLinuxFolderAndCreatesFileFromConfirmedState"
    ONLY_TEST_ARGS=()
  fi
  xcrun simctl list devices booted --json | python3 -c 'import json,sys; data=json.load(sys.stdin); devices={x["udid"]:{"runtime":r,"name":x["name"],"deviceTypeIdentifier":x["deviceTypeIdentifier"],"state":x["state"],"dataPath":x["dataPath"],"lastBootedAt":x.get("lastBootedAt")} for r,v in data["devices"].items() for x in v if x["state"]=="Booted"}; print(json.dumps(devices,sort_keys=True))' > "$WORK_DIR/preexisting-booted-devices.json"
  simulator_name="RC029-native-files-$$-$RANDOM"
  OWNED_DEVICE_ID="$(xcrun simctl create "$simulator_name" com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro com.apple.CoreSimulator.SimRuntime.iOS-18-5)"
  OWNED_DEVICE_NAME="$simulator_name"
  DEVICE_ID="$OWNED_DEVICE_ID"
  python3 - "$WORK_DIR/simulator.json" "$simulator_name" "$OWNED_DEVICE_ID" <<'PY'
import json,sys
with open(sys.argv[1],"x") as file: json.dump({"name":sys.argv[2],"udid":sys.argv[3],"deviceType":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-18-5"},file,indent=2)
PY
  DERIVED_DATA_PATH=""
  DERIVED_ARGS=()
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
if [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" ]]; then
  TLS_CERT="$WORK_DIR/native-proof-ca.pem"
  TLS_KEY="$WORK_DIR/native-proof-key.pem"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -keyout "$TLS_KEY" -out "$TLS_CERT" \
    -subj "/CN=RemoteCode native proof CA" -addext "basicConstraints=critical,CA:TRUE" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chmod 600 "$TLS_CERT" "$TLS_KEY"
  xcrun simctl boot "$OWNED_DEVICE_ID"
  xcrun simctl bootstatus "$OWNED_DEVICE_ID" -b
  xcrun simctl keychain "$OWNED_DEVICE_ID" add-root-cert "$TLS_CERT"
  API_TLS_CERT="/proof/native-proof-ca.pem"
  API_TLS_KEY="/proof/native-proof-key.pem"
fi
API_WEB_ORIGIN="http://localhost:5173"
CLIENT_ORIGIN="http://localhost:5173"
CURL_TLS_ARGS=()
if [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" ]]; then
  API_WEB_ORIGIN="https://localhost"
  CLIENT_ORIGIN="https://localhost"
  if [[ "${RC_NATIVE_TEST_JOINED_WORKSPACE:-0}" == "1" ]]; then
    API_WEB_ORIGIN="http://localhost:${RC_NATIVE_TEST_JOINED_WEB_PORT:-39531}"
    CLIENT_ORIGIN="$API_WEB_ORIGIN"
  fi
  CURL_TLS_ARGS=(--cacert "$TLS_CERT")
fi
if [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" ]]; then
  IMAGE_META="$(docker image inspect --format '{{.Id}} {{.Architecture}} {{.Os}}' "$LINUX_IMAGE")"
  [[ "$IMAGE_META" == "$LINUX_IMAGE arm64 linux" ]] || { echo "Approved image identity/platform mismatch." >&2; exit 2; }
  DEPENDENCY_PROJECT_ROOT="$(python3 - "$ROOT_DIR/node_modules" <<'PYDEPS'
import os,sys
print(os.path.dirname(os.path.realpath(sys.argv[1])))
PYDEPS
)"
  DEPENDENCY_MOUNT=()
  if [[ "$DEPENDENCY_PROJECT_ROOT" != "$ROOT_DIR" ]]; then
    DEPENDENCY_MOUNT=(--mount "type=bind,src=$DEPENDENCY_PROJECT_ROOT,dst=$DEPENDENCY_PROJECT_ROOT,readonly")
  fi
  DOCKER_NAME="rc029-native-files-$$-$RANDOM"
  DATA_MOUNT=(--tmpfs /var/lib/remotecode:rw,nosuid,nodev,size=64m,mode=700)
  if [[ "${RC_NATIVE_TEST_JOINED_WORKSPACE:-0}" == "1" ]]; then
    JOINED_VOLUME="rc021-joined-data-$$-$RANDOM"
    docker volume create --label "remotecode.rc021.joined=$OWNED_DEVICE_ID" "$JOINED_VOLUME" >/dev/null
    DATA_MOUNT=(--mount "type=volume,src=$JOINED_VOLUME,dst=/var/lib/remotecode")
    printf '{"name":"%s","ownedDeviceId":"%s"}\n' "$JOINED_VOLUME" "$OWNED_DEVICE_ID" > "$WORK_DIR/joined-volume.json"
  fi
  DOCKER_ID="$(docker create --platform linux/arm64 --pull never --read-only --entrypoint bun --workdir /workspace --name "$DOCKER_NAME" --label "remotecode.rc029.native=$OWNED_DEVICE_ID" -p "127.0.0.1:$API_PORT:$API_PORT" \
    --mount "type=bind,src=$ROOT_DIR,dst=/workspace,readonly" \
    ${DEPENDENCY_MOUNT[@]+"${DEPENDENCY_MOUNT[@]}"} \
    --mount "type=bind,src=$WORK_DIR,dst=/proof,readonly" \
    "${DATA_MOUNT[@]}" \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    -e API_PORT="$API_PORT" -e DATABASE_PATH="$API_DATABASE_PATH" \
    -e RC_NATIVE_TEST_TLS_CERT="$API_TLS_CERT" -e RC_NATIVE_TEST_TLS_KEY="$API_TLS_KEY" \
    -e REMOTECODE_AUTH_PASSWORD="$API_PASSWORD" -e REMOTECODE_WEB_ORIGIN="$API_WEB_ORIGIN" \
    "$LINUX_IMAGE" run /workspace/apps/api/test-support/native-file-api.ts)"
  printf '{"containerId":"%s","name":"%s","ownedDeviceId":"%s","image":"%s"}\n' "$DOCKER_ID" "$DOCKER_NAME" "$OWNED_DEVICE_ID" "$LINUX_IMAGE" > "$WORK_DIR/linux-container.json"
  docker start "$DOCKER_ID" >/dev/null
else
  if [[ "${RC_NATIVE_TEST_NAVIGATION:-0}" == "1" ]]; then
    cat > "$WORK_DIR/rc055-stub-agent.sh" <<'STUB'
#!/bin/bash
exec node "$ROOT_DIR/apps/api/src/features/runs-stub-agent.mjs"
STUB
    chmod +x "$WORK_DIR/rc055-stub-agent.sh"
    export REMOTECODE_DISTILL_BIN="$WORK_DIR/rc055-stub-agent.sh"
  fi
  API_PORT="$API_PORT" \
    DATABASE_PATH="$DATABASE_PATH" \
    RC_NATIVE_TEST_STORAGE_DEVICE_ID="$OWNED_DEVICE_ID" \
    RC_NATIVE_TEST_STORAGE_DEVICE_NAME="$OWNED_DEVICE_NAME" \
    RC_NATIVE_TEST_WORK_DIR="$WORK_DIR" \
    REMOTECODE_AUTH_PASSWORD="$API_PASSWORD" \
    REMOTECODE_WEB_ORIGIN="$API_WEB_ORIGIN" \
    bun run "$API_ENTRY" > "$WORK_DIR/api.log" 2>&1 &
  API_PID=$!
  if [[ "${RC_NATIVE_TEST_NAVIGATION:-0}" == "1" ]]; then
    unset REMOTECODE_DISTILL_BIN
  fi
fi

ready=false
for _ in $(seq 1 30); do
  if curl --silent --fail ${CURL_TLS_ARGS[@]+"${CURL_TLS_ARGS[@]}"} "$API_ORIGIN/api/health/ready" >/dev/null; then
    ready=true
    break
  fi
  if [[ -n "$DOCKER_ID" ]]; then
    if ! docker ps --no-trunc --format '{{.ID}}' | grep -Fqx "$DOCKER_ID"; then break; fi
  elif ! kill -0 "$API_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  if [[ -n "$DOCKER_ID" ]]; then docker logs "$DOCKER_ID" >&2 || true; else cat "$WORK_DIR/api.log" >&2; fi
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

if [[ "${RC_NATIVE_TEST_JOINED_WORKSPACE:-0}" == "1" ]]; then
  [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" && -n "$JOINED_VOLUME" ]] || { echo "Joined proof requires owned FILES mode and persistent volume." >&2; exit 2; }
  RC_JOINED_WORK_DIR="$WORK_DIR" RC_JOINED_CONTAINER_ID="$DOCKER_ID" RC_JOINED_VOLUME="$JOINED_VOLUME" RC_JOINED_DEVICE_ID="$DEVICE_ID" \
    RC_JOINED_API_ORIGIN="$API_ORIGIN" RC_JOINED_WEB_ORIGIN="$CLIENT_ORIGIN" RC_JOINED_PASSWORD="$API_PASSWORD" RC_JOINED_CA="$TLS_CERT" \
    RC_JOINED_API_PORT="$API_PORT" bun "$ROOT_DIR/scripts/run-joined-workspace-proof.ts"
  DOCKER_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["containerId"])' "$WORK_DIR/joined-current-container.json")"
  exit 0
else
if ! EXPO_PUBLIC_API_ORIGIN="$API_ORIGIN" \
  EXPO_PUBLIC_CLIENT_ORIGIN="$CLIENT_ORIGIN" \
  xcodebuild \
    -workspace "$ROOT_DIR/apps/mobile/ios/RemoteCodeMobileProof.xcworkspace" \
    -scheme RemoteCodeMobileProof \
    -destination "platform=iOS Simulator,id=$DEVICE_ID" \
    ${DERIVED_ARGS[@]+"${DERIVED_ARGS[@]}"} \
    RC_NATIVE_TEST_API_ORIGIN="$API_ORIGIN" \
    -skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppJoinsWebCreatedWorkspaceAndSavesSharedLinuxFile \
    -skip-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/testInstalledAppReadsJoinedWorkspaceAfterAPIContainerRecreationWithoutReplay \
    -only-testing:"$TEST_SELECTION" \
    ${SKIP_TEST_ARG:+"$SKIP_TEST_ARG"} \
    ${EXTRA_SKIP_ARGS[@]+"${EXTRA_SKIP_ARGS[@]}"} \
    ${ONLY_TEST_ARGS[@]+"${ONLY_TEST_ARGS[@]}"} \
    -resultBundlePath "$WORK_DIR/NativeTests.xcresult" \
    test > "$WORK_DIR/xcodebuild-test.log" 2>&1; then
  tail -100 "$WORK_DIR/xcodebuild-test.log" >&2
  exit 1
fi

fi

if [[ "${RC_NATIVE_TEST_FILES:-0}" == "1" && "${RC_NATIVE_TEST_JOINED_WORKSPACE:-0}" != "1" ]]; then
  if [[ ! -d "$WORK_DIR/NativeTests.xcresult" ]]; then echo "Installed native tests produced no XCResult; proof unverified." >&2; exit 1; fi
  xcrun xcresulttool get test-results summary --path "$WORK_DIR/NativeTests.xcresult" > "$WORK_DIR/xcresult-summary.json"
  docker exec "$DOCKER_ID" bun -e 'import{Database}from"bun:sqlite";import{readFileSync,lstatSync,existsSync}from"node:fs";import{createHash}from"node:crypto";const d=new Database(process.env.DATABASE_PATH,{readonly:true,create:false});const outcomes=d.query("SELECT request_id,kind,workspace_id,source_path,result_path,result_sha256 FROM file_operation_outcomes ORDER BY completed_at").all();const seen=new Set();const files=outcomes.flatMap(r=>{const key=r.workspace_id+"/"+r.result_path;if(seen.has(key))return[];seen.add(key);const path="/var/lib/remotecode/workspaces/"+key;if(!existsSync(path))return[{workspaceId:r.workspace_id,path:r.result_path,exists:false}];const b=readFileSync(path),st=lstatSync(path,{bigint:true});return[{workspaceId:r.workspace_id,path:r.result_path,exists:true,base64:b.toString("base64"),sha256:createHash("sha256").update(b).digest("hex"),device:st.dev.toString(),inode:st.ino.toString(),mode:Number(st.mode&0o777n)}]});console.log(JSON.stringify({outcomes,files,intents:d.query("select request_id,kind,workspace_id,source_path,destination_path,state,source_device,source_inode from file_operation_intents").all(),workspaces:d.query("select id,name from workspaces").all(),actions:d.query("select id,action from actions").all(),sessions:d.query("select count(*) n from sessions").get().n,folders:d.query("select workspace_id,request_id,state from workspace_folder_requests").all(),quickCheck:d.query("pragma quick_check").all()}));d.close()' > "$WORK_DIR/linux-state.json"
  docker exec "$DOCKER_ID" bun -e 'import{Database}from"bun:sqlite";const d=new Database(process.env.DATABASE_PATH,{readonly:true,create:false});console.log(JSON.stringify({possessions:d.query("select workspace_id,epoch,expires_at,released_at,superseded_count from screen_possessions").all(),observations:d.query("select count(*) n from screen_observations").get().n}));d.close()' > "$WORK_DIR/linux-session-state.json"
  python3 - "$WORK_DIR/linux-state.json" "$WORK_DIR/xcresult-summary.json" "${RC_NATIVE_TEST_MOVE_PREFLIGHT:-0}" "${RC_NATIVE_TEST_FOLDER_PREP:-0}" "$([[ "${RC_NATIVE_TEST_SCREEN_LOSS:-0}" == "1" ]] && echo 2 || ([[ "${RC_NATIVE_TEST_SESSION:-0}" == "1" ]] && echo 1 || echo 0))" "$WORK_DIR/linux-session-state.json" <<'PYFILE'
import base64,json,sys
j=json.load(open(sys.argv[1]))
report=json.load(open(sys.argv[2]))
if sys.argv[5]=="2":
    # The lost-response proof: the release committed exactly once and the client
    # resolved it from the receipt instead of replaying or failing.
    session=json.load(open(sys.argv[6]))
    assert report["result"]=="Passed" and report["passedTests"]==1 and report["failedTests"]==report["skippedTests"]==0
    assert len(j["workspaces"])==1 and j["folders"][0]["state"]=="provisioned"
    assert not j["actions"] and j["quickCheck"]==[{"quick_check":"ok"}]
    assert len(j["outcomes"])==0 and len(j["files"])==0
    assert len(session["possessions"])==1, "the release must not create a second possession row"
    possession=session["possessions"][0]
    assert possession["workspace_id"]==j["workspaces"][0]["id"]
    assert possession["released_at"] is not None, "the committed release must be durable"
    assert possession["superseded_count"]==0, "the client must not have taken the screen again"
    print("A committed-but-lost release resolved by receipt, applied exactly once")
    sys.exit(0)
if sys.argv[5]=="1":
    # The session proof: one test passed, the mobile client took and returned the
    # screen in the real Linux database, and no file operation was involved.
    session=json.load(open(sys.argv[6]))
    assert report["result"]=="Passed" and report["passedTests"]==1 and report["failedTests"]==report["skippedTests"]==0
    assert len(j["workspaces"])==1 and j["folders"][0]["state"]=="provisioned"
    assert not j["actions"] and j["quickCheck"]==[{"quick_check":"ok"}]
    assert len(j["outcomes"])==0 and len(j["files"])==0
    assert len(session["possessions"])==1
    possession=session["possessions"][0]
    assert possession["workspace_id"]==j["workspaces"][0]["id"]
    assert possession["released_at"] is not None, "the mobile client never returned the screen"
    assert possession["epoch"]>=1
    assert session["observations"]>=2, "the Bot observed before and after the human control"
    print("Mobile client took and returned the screen; the Linux database shows the released possession")
    sys.exit(0)
if sys.argv[4]=="1":
    assert report["result"]=="Passed" and report["passedTests"]==1 and report["failedTests"]==report["skippedTests"]==0
    assert len(j["workspaces"])==len(j["folders"])==len(j["intents"])==len(j["outcomes"])==len(j["files"])==1
    assert j["folders"][0]["state"]=="provisioned" and j["folders"][0]["workspace_id"]==j["workspaces"][0]["id"]
    assert j["intents"][0]["kind"]==j["outcomes"][0]["kind"]=="create" and j["intents"][0]["state"]=="completed"
    assert j["files"][0]["path"]=="rc021-prepared-native.txt" and j["files"][0]["exists"] and j["files"][0]["mode"]==0o600
    assert base64.b64decode(j["files"][0]["base64"])==b"native user-prepared folder" and j["files"][0]["sha256"]==j["outcomes"][0]["result_sha256"]
    assert not j["actions"] and j["sessions"]==0 and j["quickCheck"]==[{"quick_check":"ok"}]
    print("Actual Linux folder prepared by native user; canonical folder identity and file bytes confirmed")
    sys.exit(0)
if sys.argv[3] in ("1", "logout"):
    assert report["result"]=="Passed" and report["passedTests"]==1 and report["failedTests"]==report["skippedTests"]==0
    assert len(j["workspaces"])==1 and len(j["intents"])==len(j["outcomes"])==1
    assert j["intents"][0]["kind"]==j["outcomes"][0]["kind"]=="create" and j["intents"][0]["state"]=="completed"
    assert len(j["files"])==1 and j["files"][0]["path"]=="native-preflight.txt" and j["files"][0]["exists"]
    assert base64.b64decode(j["files"][0]["base64"])==b"" and j["files"][0]["sha256"]==j["outcomes"][0]["result_sha256"]
    assert not j["actions"] and j["sessions"]==0 and j["quickCheck"]==[{"quick_check":"ok"}]
    print("Actual Linux source unchanged; no MOVE/SAVE intent or outcome after refused preflight")
    sys.exit(0)
assert report["result"]=="Passed" and report["passedTests"]==5 and report["failedTests"]==0 and report["skippedTests"]==0
assert j["sessions"]==0 and len(j["actions"])==2
assert sum(r["action"].startswith("native-event-") for r in j["actions"])==1
assert sum(r["action"].startswith("native-submit-") for r in j["actions"])==1
assert len(j["workspaces"])==4 and len(j["outcomes"])==10 and len(j["intents"])==10
assert sum(r["kind"]=="create" for r in j["outcomes"])==5 and sum(r["kind"]=="save" for r in j["outcomes"])==3 and sum(r["kind"]=="move" for r in j["outcomes"])==2
assert all(r["state"]=="completed" for r in j["intents"]) and j["quickCheck"]==[{"quick_check":"ok"}]
expected={"native-proof.txt":b"saved by the installed native client","native-loss.txt":b"committed save after response loss","native-occupied.txt":b"keep occupied target","native-moved.txt":b"changed by second client","native-move-loss.txt":b"native CREATE after lost response"}
assert len(j["files"])==7
live={f["path"]:f for f in j["files"] if f["exists"]}
assert set(live)==set(expected)
assert {f["path"] for f in j["files"] if not f["exists"]}=={"native-create.txt","native-create-loss.txt"}
for path,f in live.items():
    assert base64.b64decode(f["base64"])==expected[path] and f["mode"]==0o600
    assert any(r["workspace_id"]==f["workspaceId"] and r["result_path"]==path and r["result_sha256"]==f["sha256"] for r in j["outcomes"])
for intent in (r for r in j["intents"] if r["kind"]=="move"):
    f=live[intent["destination_path"]]
    assert f["workspaceId"]==intent["workspace_id"] and (f["device"],f["inode"])==(intent["source_device"],intent["source_inode"])
print("Actual Linux SQLite/disk bytes/inodes verified for native SAVE/CREATE/MOVE and response-loss recovery")
PYFILE
  echo "Native file proof passed; exact Linux state: $WORK_DIR/linux-state.json"
  exit 0
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
        action_mappings = connection.execute("SELECT request_id, action_id FROM action_requests").fetchall()
        sessions = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        integrity = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    kinds = Counter(row[2] for row in receipts)
    if len(rows) != 1 or rows[0][1] != "2026-10-01T12:34:56.789Z":
        raise SystemExit(f"Expected exactly one action preserving canonical ISO-looking text: {rows!r}")
    if len(action_mappings) != 1 or action_mappings[0][1] != rows[0][0]:
        raise SystemExit(f"Expected one action request mapping to the confirmed scalar receipt: actions={rows!r}, mappings={action_mappings!r}")
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
    renamed_name = "2026-10-03T12:34:56.789Z"
    expected_a = "2026-10-01T12:34:56.789Z"
    expected_b = "2026-10-02T12:34:56.789Z"
    live_by_name = {row[1]: row for row in workspaces}
    created_by_id = {row[1]: row for row in created}
    if len(live_by_name) != 2 or set(live_by_name) != {renamed_name, expected_b}:
        raise SystemExit(f"Live workspace names do not preserve exact ISO-looking scalar text: workspaces={workspaces!r}")
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
