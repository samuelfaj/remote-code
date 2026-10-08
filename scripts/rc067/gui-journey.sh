#!/usr/bin/env bash
# RC-067's Linux-GUI journey, run inside the published host image: the container's
# own X display is the screen, and the API is reached over the container's
# loopback. It prints one JSON line so the proof can assert what the host said.
set -euo pipefail

: "${RC067_PASSWORD:?set RC067_PASSWORD to the host passphrase}"
BASE="https://127.0.0.1:3000"
COOKIE_JAR=/tmp/rc067-gui-cookies.txt

json() { python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"; }

curl -sk --fail -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"password\":\"$RC067_PASSWORD\"}" \
  -c "$COOKIE_JAR" -o /dev/null

WORKSPACE=$(curl -sk --fail -X POST "$BASE/api/workspaces" \
  -H 'content-type: application/json' -b "$COOKIE_JAR" \
  -d '{"name":"rc067-published-gui"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

# The take answers with the possession token in the body and sets the possession
# cookie; the jar has to receive it or the next read sees no holder.
TOKEN=$(curl -sk --fail -X POST "$BASE/api/workspaces/$WORKSPACE/screen/possession" \
  -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))')
HELD=$(curl -sk --fail "$BASE/api/workspaces/$WORKSPACE/screen/possession" -b "$COOKIE_JAR" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("state",""))')

# The screen itself: a capture of the container's own display, so the journey is
# not only an API conversation.
DISPLAY=:99 import -window root /tmp/rc067-screen.png
SCREEN_BYTES=$(stat -c '%s' /tmp/rc067-screen.png)

RELEASED=$(curl -sk --fail -X POST "$BASE/api/workspaces/$WORKSPACE/screen/possession/release" \
  -H 'content-type: application/json' -b "$COOKIE_JAR" \
  -d "{\"token\":\"$TOKEN\"}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("released" if "releasedAt" in d else d.get("error",""))')

AFTER=$(curl -sk --fail "$BASE/api/workspaces/$WORKSPACE/screen/possession" -b "$COOKIE_JAR" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("state",""))')

python3 - "$WORKSPACE" "$HELD" "$SCREEN_BYTES" "$RELEASED" "$AFTER" <<'PY'
import json, sys
workspace, held, screen_bytes, released, after = sys.argv[1:6]
print(json.dumps({
    "workspaceId": workspace,
    "takeState": held,
    "screenBytes": int(screen_bytes),
    "releaseStatus": released,
    "stateAfterRelease": after,
}))
PY