#!/usr/bin/env bash
# RC-015 executable proof: the backend and the Distill agent run with distinct
# system identities in the container; the agent cannot read the gateway token,
# the backend environment or the database, yet an API-authorized task still
# succeeds.
#
# Requires: docker, curl, python3 (host), logged-in host Distill home.
# Usage: scripts/rc015/run-isolation-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/scratch/rc015-isolation}"
IMAGE="${RC015_IMAGE:-remotecode/computer:rc015}"
NAME="rc015-proof"
PASSWORD="rc015-local-password-longenough"
TOKEN="rc015-gateway-secret-value"
AUTH="${RC015_AUTH:-$HOME/.distill/auth.json}"

mkdir -p "$OUTDIR"
TRANSCRIPT="$OUTDIR/rc015-isolation.txt"
: > "$TRANSCRIPT"
say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
run() { docker exec "$NAME" "$@"; }
as_agent() { docker exec -u rcagent "$NAME" "$@"; }

say "== RC-015 backend/agent identity isolation =="
say "-- build image (adds the unprivileged rcagent user and wrapper) --"
docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" | tee -a "$TRANSCRIPT"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null

say "-- provision the backend secret store and the agent workspace --"
run bash -lc "install -d -m 700 /var/lib/remotecode && printf '%s' '$TOKEN' > /var/lib/remotecode/gateway-token && chmod 600 /var/lib/remotecode/gateway-token"
run bash -lc "install -d -o rcagent -g rcagent -m 700 /workspace/rc015-workspace && install -d -o rcagent -g rcagent -m 700 /home/rcagent/.distill"
docker cp "$AUTH" "$NAME:/home/rcagent/.distill/auth.json"
run bash -lc "chown rcagent:rcagent /home/rcagent/.distill/auth.json && chmod 600 /home/rcagent/.distill/auth.json"
say "rcagent uid=$(run id -u rcagent)  backend uid=$(run id -u)"

say "-- start the backend (root) with the gateway token in its environment --"
run bash -lc "cd /workspace && API_PORT=3223 DATABASE_PATH=/var/lib/remotecode/rc015.sqlite \
  REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_GATEWAY_TOKEN='$TOKEN' \
  REMOTECODE_DISTILL_BIN=/usr/local/bin/distill REMOTECODE_AGENT_USER=rcagent REMOTECODE_AGENT_HOME=/home/rcagent REMOTECODE_RUNS_CWD=/workspace/rc015-workspace \
  bun apps/api/src/index.ts > /workspace/rc015-api.log 2>&1 &"
for _ in $(seq 1 60); do run curl -fsS "http://127.0.0.1:3223/api/health/ready" >/dev/null 2>&1 && break; sleep 0.5; done
say "backend ready=$(run curl -fsS http://127.0.0.1:3223/api/health/ready)"
BACKEND_PID=$(run pgrep -f "apps/api/src/index.ts" | head -1)
say "backend pid=$BACKEND_PID"

say "-- the agent user must NOT be able to read backend secrets --"
for target in "/var/lib/remotecode/rc015.sqlite:database" "/var/lib/remotecode/gateway-token:gateway token" "/proc/$BACKEND_PID/environ:backend environment"; do
  path="${target%%:*}"; label="${target##*:}"
  if as_agent cat "$path" >/dev/null 2>&1; then
    say "FAIL agent could read $label ($path)"; exit 1
  fi
  say "denied: agent cannot read $label"
done
say "sanity (root): backend can read the token => $(run cat /var/lib/remotecode/gateway-token)"

say "-- an API-authorized task still succeeds and runs as the agent user --"
run curl -fsS -c /tmp/c015.txt -X POST http://127.0.0.1:3223/api/auth/login -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" >/dev/null
WS=$(run curl -fsS -b /tmp/c015.txt -X POST http://127.0.0.1:3223/api/workspaces -H 'content-type: application/json' -d '{"name":"rc015"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
printf '%s' "{\"workspaceId\":\"$WS\",\"prompt\":\"Run exactly this one shell command and nothing else: id -u > /workspace/rc015-workspace/rc015-identity.txt . After it runs, stop. Do not print the answer; only run that command.\"}" | docker exec -i "$NAME" sh -c 'cat > /tmp/run15.json'
RUN=$(run curl -fsS -b /tmp/c015.txt -X POST http://127.0.0.1:3223/api/runs -H 'content-type: application/json' --data-binary @/tmp/run15.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
say "run=$RUN"
AGENT_PID=""
for _ in $(seq 1 60); do
  AGENT_PID=$(run pgrep -u rcagent -f "distill agent stdio" | head -1 || true)
  [ -n "$AGENT_PID" ] && break
  sleep 0.5
done
AGENT_USER=$(run ps -o user= -p "$AGENT_PID" 2>/dev/null | tr -d '[:space:]')
say "agent process pid=$AGENT_PID runs as user='$AGENT_USER'"
[ "$AGENT_USER" = "rcagent" ] || { say "FAIL agent process ran as '$AGENT_USER', expected rcagent"; exit 1; }
STATE=""
for _ in $(seq 1 240); do
  STATE=$(run curl -fsS -b /tmp/c015.txt "http://127.0.0.1:3223/api/runs/$RUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
  [ "$STATE" = "completed" ] || [ "$STATE" = "failed" ] || [ "$STATE" = "interrupted" ] && break
  sleep 1
done
say "run state=$STATE"
if [ "$STATE" != "completed" ]; then say "FAIL authorized task $STATE"; run tail -20 /workspace/rc015-api.log | tee -a "$TRANSCRIPT"; exit 1; fi

IDENTITY=$(run cat /workspace/rc015-workspace/rc015-identity.txt)
say "agent identity file: $(printf '%s' "$IDENTITY" | tr '\n' '|')"
UID_LINE=$(printf '%s' "$IDENTITY" | tr -d '[:space:]')
[ "$UID_LINE" = "$(run id -u rcagent)" ] || { say "FAIL agent ran as uid $UID_LINE, expected $(run id -u rcagent)"; exit 1; }
case "$IDENTITY" in *"$TOKEN"*) say "FAIL agent output contained the gateway token"; exit 1;; esac
say "agent reported uid=$UID_LINE (the rcagent uid; no gateway token in its output)"

FILE_OWNER=$(run stat -c '%u' /workspace/rc015-workspace/rc015-identity.txt)
say "identity file owner uid=$FILE_OWNER"
[ "$FILE_OWNER" = "$(run id -u rcagent)" ] || { say "FAIL file owner $FILE_OWNER"; exit 1; }

say ""
say "PASS rc015: backend(root) vs agent(rcagent) separated; agent denied db/token/backend-env; authorized API task succeeded as rcagent with no routing token"
docker rm -f "$NAME" >/dev/null 2>&1 || true