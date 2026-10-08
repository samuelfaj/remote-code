#!/usr/bin/env bash
# RC-007 executable proof: one Linux image starts Elysia, Distill, an X11
# desktop and linux-use in the user's container, with no macOS host role.
# A clean container is started, the GUI is opened, linux-use is checked through
# Distill, and a real Distill agent action runs on the same host.
#
# Requires: docker, curl, a logged-in host Distill home (~/.distill/auth.json).
# Usage: scripts/rc007/run-linux-image-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc007-image}"
AUTH="${RC007_AUTH:-$HOME/.distill/auth.json}"
IMAGE="remotecode/computer:rc007"
NAME="rc007-proof"

mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/rc007-image.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

say "== RC-007 Linux image proof =="
say "image=$IMAGE root=$ROOT"

say "-- build image (native arch) --"
docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$TRANSCRIPT"
ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}')
say "built arch=$ARCH"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e REMOTECODE_BACKGROUND=1 -e DISPLAY=:99 \
  -e DATABASE_PATH=/var/lib/remotecode/remotecode.sqlite "$IMAGE" >/dev/null

# Distill auth for the in-container agent (values are never printed).
docker exec "$NAME" mkdir -p /root/.distill
docker cp "$AUTH" "$NAME:/root/.distill/auth.json"
docker exec "$NAME" chmod 600 /root/.distill/auth.json

say "-- wait for the service ready marker --"
ready=0
for i in $(seq 1 90); do
  if docker exec "$NAME" test -f /var/log/remotecode-services-ready 2>/dev/null; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { say "FAIL services never became ready"; docker logs "$NAME" | tail -30 | tee -a "$TRANSCRIPT"; exit 1; }
say "services ready after ~$((i*2))s"

say "-- Elysia API response body --"
READY_BODY=$(docker exec "$NAME" curl -fsS http://127.0.0.1:3000/api/health/ready)
say "ready=$READY_BODY"
printf '%s' "$READY_BODY" | grep -q '"status":"ready"' || { say "FAIL readiness body"; exit 1; }

say "-- X11 desktop and Chromium window --"
WINDOWS=$(docker exec "$NAME" wmctrl -l)
say "wmctrl: $WINDOWS"
printf '%s' "$WINDOWS" | grep -q "RemoteCode" || { say "FAIL GUI window"; exit 1; }

say "-- linux-use via Distill (mcp doctor) --"
DOCTOR=$(docker exec "$NAME" distill mcp doctor linux-use 2>&1)
say "$DOCTOR" | tail -5
printf '%s' "$DOCTOR" | grep -qi "linux-use" || { say "FAIL mcp doctor"; exit 1; }

say "-- Distill agent action on the same host --"
docker exec "$NAME" bash -lc 'rm -f /workspace/rc007-agent-windows.txt'
AGENT=$(docker exec "$NAME" bash -lc 'cd /workspace && python3 scripts/rc002/acp_client.py \
  --bin /usr/local/bin/distill --cwd /workspace --timeout 240 \
  --transcript /tmp/rc007-agent.jsonl \
  --prompt "Use the linux-use MCP tool list_windows to list the X11 windows on this host, then write the resulting window list to the file /workspace/rc007-agent-windows.txt. Then stop."' 2>&1)
echo "$AGENT" | tail -2 | tee -a "$TRANSCRIPT"
AGENT_STOP=$(printf '%s' "$AGENT" | sed -n 's/.*"stopReason": "\([^"]*\)".*/\1/p' | head -1)
say "agent stopReason=$AGENT_STOP"
[ "$AGENT_STOP" = "end_turn" ] || { say "FAIL agent did not finish"; exit 1; }

AGENT_FILE=$(docker exec "$NAME" cat /workspace/rc007-agent-windows.txt 2>/dev/null || true)
say "agent wrote: $AGENT_FILE"
printf '%s' "$AGENT_FILE" | grep -qi "RemoteCode" || { say "FAIL agent action did not observe the X11 window"; exit 1; }

say ""
say "PASS rc007: image arch=$ARCH api=ready gui=window mcp=linux-use agent=end_turn+window-file"
docker rm -f "$NAME" >/dev/null 2>&1 || true