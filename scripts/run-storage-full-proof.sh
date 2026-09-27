#!/usr/bin/env bash
set -euo pipefail
ROOT="${RC_STORAGE_PROOF_WORK_DIR:?Set RC_STORAGE_PROOF_WORK_DIR to a private writable evidence directory}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$ROOT" == /* ]] || { echo "Proof directory must be absolute"; exit 2; }
[[ ! -L "$ROOT" && "$(stat -f '%u' "$ROOT")" == "$(id -u)" ]] || { echo 'Untrusted scratch root'; exit 2; }
RUN=$(mktemp -d "$ROOT/full-volume.XXXXXXXX")
MOUNT="$RUN/mnt"
IMAGE="$RUN/rc020.dmg"
mkdir "$MOUNT"
attached=false
DEVICE=""
# hdiutil's identity is checked by image path, mountpoint, and device; never use a volume-name match.
find_owned_device() {
  hdiutil info -plist > "$RUN/current.plist"
  python3 - "$RUN/current.plist" "$IMAGE" "$MOUNT" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'rb') as f: doc=plistlib.load(f)
image=os.path.realpath(sys.argv[2]); mount=os.path.realpath(sys.argv[3])
matching=[entity['dev-entry'] for item in doc.get('images', []) if os.path.realpath(item.get('image-path',''))==image for entity in item.get('system-entities', []) if os.path.realpath(entity.get('mount-point',''))==mount]
if len(matching)!=1: raise SystemExit('Owned mount identity is missing or ambiguous')
print(matching[0])
PY
}
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "$attached" == true ]]; then
    local actual=""
    actual=$(find_owned_device 2>/dev/null) || true
    if [[ -z "$DEVICE" && -n "$actual" ]]; then DEVICE="$actual"; fi
    if [[ -n "$actual" && "$actual" == "$DEVICE" ]]; then
      if hdiutil detach "$DEVICE" > "$ROOT/detach.log" 2>&1; then
        if ! find_owned_device >/dev/null 2>&1; then
          rm -f -- "$IMAGE"
          rmdir "$MOUNT"
          rm -f -- "$RUN/create.log" "$RUN/attach.log" "$RUN/attach.plist" "$RUN/current.plist"
          rmdir "$RUN"
          echo 'Owned disk image detached; mount and run directory removal verified' >> "$ROOT/detach.log"
        else
          echo 'Owned image still appears mounted; retain artifacts for investigation' >> "$ROOT/detach.log"
          code=1
        fi
      else
        echo 'Owned disk image detach failed; do not remove image or mountpoint' >> "$ROOT/detach.log"
        code=1
      fi
    else
      echo 'Cannot reconcile exact owned mount; no detach attempted' >> "$ROOT/detach.log"
      code=1
    fi
  else
    rm -f -- "$IMAGE"
    rmdir "$MOUNT"
    rm -f -- "$RUN/create.log" "$RUN/current.plist"
    rmdir "$RUN"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM
available=$(df -k "$ROOT" | awk 'NR==2 {print $4}')
(( available > 524288 )) || { echo 'Insufficient host headroom for 128 MiB image'; exit 2; }
hdiutil create -size 128m -type UDIF -fs HFS+ -layout NONE -volname RC020Proof -o "$IMAGE" > "$RUN/create.log" 2>&1
# Track the attempt before attachment so an ambiguous failure is reconciled by exact image identity.
attached=true
hdiutil attach -plist -noautoopen -mountpoint "$MOUNT" "$IMAGE" > "$RUN/attach.plist" 2> "$RUN/attach.log"
DEVICE=$(find_owned_device)
python3 - "$RUN/attach.plist" "$DEVICE" "$MOUNT" <<'PY'
import os, plistlib, sys
with open(sys.argv[1],'rb') as f: d=plistlib.load(f)
match=[e for e in d.get('system-entities',[]) if e.get('dev-entry')==sys.argv[2] and os.path.realpath(e.get('mount-point',''))==os.path.realpath(sys.argv[3])]
if len(match)!=1: raise SystemExit('Attach receipt does not match current image device and mount')
PY
mounted_path=$(df -P "$MOUNT" | awk 'NR==2 {print $6}')
[[ "$(cd "$mounted_path" && pwd -P)" == "$(cd "$MOUNT" && pwd -P)" ]] || { echo 'Mount is not a separate filesystem'; exit 2; }
printf 'Owned mount device %s, path %s\n' "$DEVICE" "$MOUNT"
export RC_STORAGE_PROOF_MOUNT="$MOUNT"
cd "$REPO"
bun run "$REPO/apps/api/test-support/storage-full-proof.ts"
