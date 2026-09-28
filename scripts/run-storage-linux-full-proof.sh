#!/usr/bin/env bash
set -euo pipefail

ROOT="${RC_STORAGE_LINUX_WORK_DIR:?Set RC_STORAGE_LINUX_WORK_DIR to a caller-owned absolute directory}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$ROOT" == /* && -d "$ROOT" && ! -L "$ROOT" ]] || { echo 'Proof directory must be an existing absolute non-symlink directory' >&2; exit 2; }
OWNER="$(stat -f '%u' "$ROOT" 2>/dev/null || stat -c '%u' "$ROOT")"
[[ "$OWNER" == "$(id -u)" ]] || { echo 'Proof directory owner differs from caller' >&2; exit 2; }
IMAGE='remotecode-rc010-final-20260925:local'
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')" || { echo 'Required local image is unavailable; no pull attempted' >&2; exit 2; }
IMAGE_PLATFORM="$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')"
[[ "$IMAGE_PLATFORM" == 'linux/amd64' ]] || { echo "Unexpected image platform: $IMAGE_PLATFORM" >&2; exit 2; }
RUN="$(mktemp -d "$ROOT/storage-linux.XXXXXXXX")"
NAME="rc020-linux-${RUN##*/storage-linux.}"
CIDFILE="$RUN/container.cid"
LABEL="rc020-linux-proof=$NAME"
cleanup() {
  local code=$? cid='' found='' actual_name='' actual_label=''
  trap - EXIT INT TERM
  if [[ -f "$CIDFILE" ]]; then cid="$(cat "$CIDFILE")"; fi
  found="$(docker container inspect "$NAME" --format '{{.Id}}' 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    actual_name="$(docker container inspect "$found" --format '{{.Name}}' 2>/dev/null || true)"
    actual_label="$(docker container inspect "$found" --format '{{index .Config.Labels "rc020-linux-proof"}}' 2>/dev/null || true)"
    if { [[ -z "$cid" ]] || [[ "$found" == "$cid" ]]; } && [[ "$actual_name" == "/$NAME" && "$actual_label" == "$NAME" ]]; then
      docker rm -f "$found" >/dev/null || code=1
    else
      echo 'Container identity mismatch; refusing removal' >&2
      code=1
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    echo 'Docker unavailable; container cleanup cannot be verified' >&2
    code=1
  elif docker container inspect "$NAME" >/dev/null 2>&1 || { [[ -n "$cid" ]] && docker container inspect "$cid" >/dev/null 2>&1; }; then
    echo 'Task-owned container removal not verified' >&2
    code=1
  else
    echo "Owned container $NAME absent"
  fi
  rm -f -- "$CIDFILE"
  rmdir "$RUN" || code=1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'source_commit=%s image_tag=%s image_digest=%s image_platform=%s host=%s docker_server=%s container=%s\n' \
  "$(git -C "$REPO" rev-parse HEAD)" "$IMAGE" "$IMAGE_ID" "$IMAGE_PLATFORM" \
  "$(uname -s)/$(uname -m)" "$(docker info --format '{{.OSType}}/{{.Architecture}}')" "$NAME"
printf 'Linux/amd64 under Docker host architecture above; not a production Linux-host or RC-002 proof.\n'
docker run --rm --cidfile "$CIDFILE" --name "$NAME" --label "$LABEL" \
  --platform linux/amd64 --pull never --network none --entrypoint bun --read-only \
  --tmpfs /var/lib/remotecode:rw,size=48m,mode=0700 \
  --mount "type=bind,src=$REPO/apps/api/src,dst=/workspace/apps/api/src,readonly" \
  --mount "type=bind,src=$REPO/apps/api/test-support/storage-linux-full-proof.ts,dst=/workspace/apps/api/test-support/storage-linux-full-proof.ts,readonly" \
  --env DATABASE_PATH=/var/lib/remotecode/remotecode.sqlite \
  "$IMAGE_ID" /workspace/apps/api/test-support/storage-linux-full-proof.ts
