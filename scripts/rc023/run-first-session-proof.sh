#!/usr/bin/env bash
# RC-023 executable proof: in a real container, the linux-use MCP observes and
# controls the correct X11 window (screenshot + click + typing with state-token
# validation), rejects an obsolete target, and leaves the login page open. The
# main Distill project then uses the same local tools.
#
# Requires: docker, curl, python3 (host), logged-in host Distill home.
# Usage: scripts/rc023/run-first-session-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc023-session}"
IMAGE="${RC023_IMAGE:-remotecode/computer:rc023}"
NAME="rc023-proof"
AUTH="${RC023_AUTH:-$HOME/.distill/auth.json}"
PASSWORD="rc023-local-password-longenough"

mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/rc023-session.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { docker exec "$NAME" "$@"; }

say "== RC-023 first Linux session =="
say "-- build image (linux-use @ ee0231c + imagemagick/x11-apps) --"
docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$TRANSCRIPT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null

say "-- start an X11 desktop with a test login page in Chromium --"
run mkdir -p /var/www/rc023
run bash -lc 'cat > /var/www/rc023/index.html <<HTML
<!doctype html><html><head><title>RC023 login</title>
<style>body{margin:0;font:17px sans-serif}
input{position:absolute;left:20px;top:100px;width:860px;height:400px;font-size:22px;caret-color:transparent;border:1px solid #999;background:#fff;outline:none}
input:hover,input:focus{background:#fff;border-color:#999;outline:none;box-shadow:none}
button{position:absolute;left:20px;top:520px;width:200px;height:60px}</style></head>
<body><h1 style="margin:60px 0 0 20px;font-size:15px">Sign in</h1>
<input id="user" oninput="document.title=\x27RC023 user=\x27+this.value">
<button id="go" onclick="document.title=\x27RC023 clicked\x27">Continue</button></body></html>
HTML
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1024x700x24 -ac -nolisten tcp >/var/log/rc023-xvfb.log 2>&1 &
sleep 1
DISPLAY=:99 openbox --sm-disable >/var/log/rc023-openbox.log 2>&1 &
DISPLAY=:99 python3 -m http.server 8081 --directory /var/www/rc023 >/var/log/rc023-http.log 2>&1 &
sleep 1
DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run \
  --user-data-dir=/var/lib/rc023 --app=http://127.0.0.1:8081/ --window-size=900,600 \
  >/var/log/rc023-chromium.log 2>&1 &
sleep 4
DISPLAY=:99 wmctrl -l'

for _ in $(seq 1 30); do
  if run bash -lc 'DISPLAY=:99 wmctrl -l | grep -q "RC023"'; then break; fi
  sleep 1
done
run bash -lc 'DISPLAY=:99 wmctrl -l | grep -q "RC023"' || { say "FAIL no RC023 window"; run tail -5 /var/log/rc023-chromium.log | tee -a "$TRANSCRIPT"; exit 1; }
say "-- first-session observation and input via the linux-use MCP --"
SESSION=$(run bash -lc 'cd /workspace && DISPLAY=:99 XDG_SESSION_TYPE=x11 LINUX_USE_SERVER=/opt/linux-use/server.py python3 scripts/rc023/linux-use-session.py' || true)
say "$SESSION"
printf '%s' "$SESSION" | grep -q '"ok": true' || { say "FAIL linux-use session"; exit 1; }

say "-- the login page is still open after the session --"
OPEN=$(run bash -lc 'DISPLAY=:99 wmctrl -l')
say "$OPEN"
printf '%s' "$OPEN" | grep -q "RC023" || { say "FAIL login page closed"; exit 1; }

say "-- the main Distill project uses the same local linux-use tools --"
run mkdir -p /root/.distill
docker cp "$AUTH" "$NAME:/root/.distill/auth.json"
run bash -lc 'cd /workspace && distill mcp add --scope user linux-use -- python3 /opt/linux-use/server.py >/dev/null 2>&1 || true'
AGENT=$(run bash -lc 'cd /workspace && DISPLAY=:99 python3 scripts/rc002/acp_client.py \
  --bin /usr/local/bin/distill --cwd /workspace --timeout 240 \
  --transcript /tmp/rc023-agent.jsonl \
  --prompt "Use the linux-use MCP tool list_windows to list the X11 windows, then write the JSON result to the file /workspace/rc023-agent-windows.json. Then stop."' 2>&1)
printf '%s' "$AGENT" | tail -1 | tee -a "$TRANSCRIPT"
STOP=$(printf '%s' "$AGENT" | sed -n 's/.*"stopReason": "\([^"]*\)".*/\1/p' | head -1)
say "distill agent stopReason=$STOP"
[ "$STOP" = "end_turn" ] || { say "FAIL Distill agent did not finish"; exit 1; }
AGENT_FILE=$(run cat /workspace/rc023-agent-windows.json 2>/dev/null || true)
printf '%s' "$AGENT_FILE" | grep -q "RC023" || { say "FAIL Distill did not observe the window via linux-use: $AGENT_FILE"; exit 1; }
say "Distill via linux-use saw: $(printf '%s' "$AGENT_FILE" | head -c 200)"

say ""
say "-- the run is recorded as waiting for the user, with the session id --"
run bash -lc "cd /workspace && API_PORT=3223 DATABASE_PATH=/workspace/rc023.sqlite \
  REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_DISTILL_BIN=/usr/local/bin/distill \
  REMOTECODE_RUNS_CWD=/workspace REMOTECODE_WEB_ORIGIN=http://localhost:5173 \
  bun apps/api/src/index.ts > /workspace/rc023-api.log 2>&1 &"
for _ in $(seq 1 60); do
  if run curl -fsS "http://127.0.0.1:3223/api/health/ready" >/dev/null 2>&1; then break; fi
  sleep 1
done
say "api ready=$(run curl -fsS http://127.0.0.1:3223/api/health/ready)"
run bash -lc "curl -fsS -c /workspace/rc023-cookies.txt -X POST http://127.0.0.1:3223/api/auth/login \
  -H 'content-type: application/json' -d '{\"password\":\"$PASSWORD\"}' >/dev/null"
WS=$(run bash -lc "curl -fsS -b /workspace/rc023-cookies.txt -X POST http://127.0.0.1:3223/api/workspaces \
  -H 'content-type: application/json' -d '{\"name\":\"rc023\"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"id\"])'")
say "workspace=$WS"
RUN=$(run bash -lc "curl -fsS -b /workspace/rc023-cookies.txt -X POST http://127.0.0.1:3223/api/runs \
  -H 'content-type: application/json' -d '{\"workspaceId\":\"$WS\",\"prompt\":\"List the X11 windows with the linux-use MCP tool list_windows and then stop.\"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"id\"])'")
say "run=$RUN"

SESSION_ID=""
for _ in $(seq 1 90); do
  BODY=$(run bash -lc "curl -fsS -b /workspace/rc023-cookies.txt http://127.0.0.1:3223/api/runs/$RUN")
  SESSION_ID=$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("sessionId") or "")')
  [ -n "$SESSION_ID" ] && break
  sleep 2
done
[ -n "$SESSION_ID" ] || { say "FAIL the run never recorded an ACP session id: $BODY"; exit 1; }
say "run persisted session id ($(printf '%s' "$SESSION_ID" | cut -c1-8)…)"

HANDOFF=$(run bash -lc "curl -fsS -b /workspace/rc023-cookies.txt -X POST http://127.0.0.1:3223/api/runs/$RUN/handoff \
  -H 'content-type: application/json' -d '{\"reason\":\"The portal requested authentication; the login page is open in the session.\"}'")
say "handoff=$HANDOFF"
printf '%s' "$HANDOFF" | python3 -c '
import sys, json
view = json.load(sys.stdin)
assert view["state"] == "needs_user", view
assert view["sessionId"], view
assert view["handoffReason"], view
' || { say "FAIL handoff did not record needs_user with the session id"; exit 1; }

say "-- the login page is still open while the run waits for the user --"
OPEN_AFTER=$(run bash -lc 'DISPLAY=:99 wmctrl -l')
say "$OPEN_AFTER"
printf '%s' "$OPEN_AFTER" | grep -q "RC023" || { say "FAIL login page closed during handoff"; exit 1; }

say "-- the recorded state survives the agent finishing its turn --"
sleep 8
STILL=$(run bash -lc "curl -fsS -b /workspace/rc023-cookies.txt http://127.0.0.1:3223/api/runs/$RUN")
printf '%s' "$STILL" | python3 -c '
import sys, json
view = json.load(sys.stdin)
assert view["state"] == "needs_user", view
assert view["sessionId"], view
' || { say "FAIL the handoff was overwritten: $STILL"; exit 1; }
say "run still needs_user after the agent finished"

say ""
say "PASS rc023: linux-use captured the correct window, clicked and typed with token validation, rejected a stale target, Distill used the local tools, the login page stayed open, and the run recorded the ACP session id in needs_user"
docker rm -f "$NAME" >/dev/null 2>&1 || true