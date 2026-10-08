#!/usr/bin/env bash
# RC-054's Windows leg, driven from this machine. This machine has no Windows
# target, so the browser runs on GitHub's windows-latest runner; this script
# brings up the repository's Linux host locally, publishes it on a Cloudflare
# quick tunnel, dispatches `.github/workflows/rc054-windows-client.yml` against
# that origin, and keeps the host up until the run ends.
#
# The passphrase is thrown away after each run and travels as a repository
# secret, so a public workflow run does not carry it in its inputs.
#
# Usage: scripts/rc066/run-windows-restart-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/scratch/rc054-windows-leg}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

IMAGE="${RC054_IMAGE:-remotecode/host:local}"
NAME="rc054-windows-linux-$(date +%s)"
API_PORT="${RC054_API_PORT:-8443}"
# The Windows runner serves the web app on this port and names it as the web
# origin, so the container is told the same value the macOS leg uses.
WEB_ORIGIN="http://127.0.0.1:${RC054_WEB_PORT:-37124}"
PASSWORD="rc054-win-$(openssl rand -hex 16)"
DATA_VOLUME="rc054-win-data-$(date +%s)"
REPO="${RC054_REPO:-samuelfaj/remote-code}"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

TUNNEL_PID=""
cleanup() {
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$OUT/leg.log"; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
say "-- the Linux host's image: $(docker image inspect -f '{{.Id}}' "$IMAGE") --"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-054 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"

docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc054.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" -e REMOTECODE_WEB_ORIGIN="$WEB_ORIGIN" \
  -e REMOTECODE_DISPLAY=:99 "$IMAGE" sleep infinity >/dev/null
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
# `panel` mode is for RC-066's other journeys: they need a host whose agent
# really asks, which is the repository's own ACP stub (scripts/rc051).
EXTRA_ENV=""
if [[ "${RC054_HOST_MODE:-journey}" == "panel" ]]; then
  docker exec "$NAME" bash -lc 'printf "#!/bin/bash\nsleep 3\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs \"\$@\"\n" > /usr/local/bin/rc051-agent && chmod 0755 /usr/local/bin/rc051-agent'
  EXTRA_ENV="REMOTECODE_DISTILL_BIN=/usr/local/bin/rc051-agent"
  say "-- the host runs the repository's runs stub as its agent --"
fi
# The API listens on 3001 and a forwarder holds the published 3000 open, so a
# restart of the API does not close the port the runner's proxy is pooled to.
docker cp "$HERE/cdp-forward.mjs" "$NAME:/tmp/rc066-tcp-forward.mjs"
docker exec -d "$NAME" bash -lc "cd /tmp && FORWARD_TARGET_PORT=3001 FORWARD_LISTEN_PORT=3000 bun rc066-tcp-forward.mjs > /var/log/rc066-forward.log 2>&1"
sleep 1
docker exec -d "$NAME" bash -lc "echo \$\$ > /tmp/rc066-api.pid; exec env DISPLAY=:99 API_PORT=3001 \
  DATABASE_PATH=/var/lib/remotecode/rc054.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' \
  REMOTECODE_WEB_ORIGIN='$WEB_ORIGIN' REMOTECODE_TLS_CERT=/proof-cert.pem \
  REMOTECODE_TLS_KEY=/proof-key.pem $EXTRA_ENV bun apps/api/src/index.ts \
  > /var/log/rc054-api.log 2>&1"

for _ in $(seq 1 60); do
  curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null
say "-- the Linux host is ready on 127.0.0.1:${API_PORT} (TLS) --"

# A quick tunnel needs no account; it is torn down with this script.
say "-- publishing it on a Cloudflare quick tunnel --"
cloudflared tunnel --url "https://127.0.0.1:${API_PORT}" --no-tls-verify \
  --logfile "$OUT/cloudflared.log" --no-autoupdate >/dev/null 2>&1 &
TUNNEL_PID=$!

TUNNEL=""
for _ in $(seq 1 60); do
  TUNNEL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$OUT/cloudflared.log" 2>/dev/null | head -1 || true)
  [[ -n "$TUNNEL" ]] && break
  sleep 1
done
if [[ -z "$TUNNEL" ]]; then
  say "FAIL the tunnel never published an address; see $OUT/cloudflared.log"
  exit 1
fi
# A fresh quick-tunnel hostname is not in any resolver yet; this waits for the
# public name to resolve and answer, and warns rather than aborts, because the
# Windows job's own first step is the assertion that the host is reachable.
dscacheutil -flushcache >/dev/null 2>&1 || true
PUBLIC=""
for _ in $(seq 1 90); do
  if curl -s --fail --max-time 10 "${TUNNEL}/api/health/ready" >/dev/null 2>&1; then PUBLIC=1; break; fi
  sleep 2
done
if [[ "$PUBLIC" == "1" ]]; then
  say "-- the Windows runner will reach the Linux host at ${TUNNEL} --"
else
  say "-- the public name had not answered yet; the run reports it if it stays that way --"
fi

printf '%s' "$PASSWORD" | gh secret set RC054_AUTH_PASSWORD --repo "$REPO"
# `workflow_dispatch` only resolves for a workflow that also exists on the
# default branch, and this one is not merged there; a push to the pull request
# is what arms it. The variable carries the host's origin and is cleared again
# below, so the next ordinary push runs nothing.
say "-- arming the Windows job on branch ${BRANCH} --"
gh variable set RC054_BACKEND_ORIGIN --repo "$REPO" --body "$TUNNEL"
gh variable set RC054_SPEC --repo "$REPO" --body "apps/web/e2e/rc066-windows-restart.spec.ts"
gh variable set RC051_STUB_AGENT --repo "$REPO" --body "$([[ "${RC054_HOST_MODE:-journey}" == "panel" ]] && echo 1 || echo 0)"
# The push that arms the job also fires the other runs on this branch, so the
# run this script waits for is the one created after this moment, not simply
# the newest by name.
ARMED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git -C "$ROOT" commit --allow-empty -q -m "ci: arm the RC-054 Windows leg against ${TUNNEL}"
git -C "$ROOT" push -q origin "HEAD:${BRANCH}"

RUN_ID=""
for _ in $(seq 1 40); do
  sleep 5
  RUN_ID=$(gh run list --repo "$REPO" --branch "$BRANCH" --limit 20 \
    --json databaseId,name,createdAt \
    --jq "[.[] | select(.name == \"rc054-windows-client\" and .createdAt >= \"${ARMED_AT}\")][0].databaseId" 2>/dev/null || true)
  [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] && break
done
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  gh variable delete RC054_BACKEND_ORIGIN --repo "$REPO" >/dev/null 2>&1 || true
gh variable delete RC054_SPEC --repo "$REPO" >/dev/null 2>&1 || true
gh variable delete RC051_STUB_AGENT --repo "$REPO" >/dev/null 2>&1 || true
  say "FAIL the push never produced a windows-client run"
  exit 1
fi
say "run ${RUN_ID}: https://github.com/${REPO}/actions/runs/${RUN_ID}"

# The runner creates its workspace before it saves the file and then waits for
# the host to go away and come back, so the restart is driven from here the
# moment that workspace exists.
MARKER="RC066-WIN-RESTART"
say "-- waiting for the Windows runner's workspace, then restarting the API --"
# The list route needs a session, so this machine signs in to the host it owns.
HOST_COOKIE="$(docker exec "$NAME" bash -lc "curl -sk -X POST https://127.0.0.1:3000/api/auth/login -H 'content-type: application/json' -d '{\"password\":\"'$PASSWORD'\"}' -D - -o /dev/null | grep -i '^set-cookie:' | head -1 | sed 's/^set-cookie: //' | sed 's/;.*//'")"
if [[ -z "$HOST_COOKIE" ]]; then
  say "FAIL: could not sign in to the host it owns"
  exit 1
fi
SEEN=""
for _ in $(seq 1 120); do
  NAMES="$(docker exec "$NAME" bash -lc "curl -sk -H 'cookie: $HOST_COOKIE' https://127.0.0.1:3000/api/workspaces" 2>/dev/null || echo '')"
  if printf '%s' "$NAMES" | grep -q "$MARKER-READY"; then SEEN=1; break; fi
  sleep 5
done
if [[ "$SEEN" != "1" ]]; then
  say "FAIL: the Windows runner never created its workspace; the restart was not driven"
else
  say "-- restarting the API inside the host --"
  # Exactly the API, by the pid it wrote at start-up: `pkill -x bun` would also
  # kill the forwarder that holds the published port open, which turns every
  # later request into a 502 from the tunnel.
  docker exec "$NAME" bash -lc 'kill "$(cat /tmp/rc066-api.pid)" || true' >/dev/null 2>&1 || true
  sleep 3
  # Only the API restarts; the forwarder on 3000 keeps the published port open,
  # which is what the runner's pooled proxy needs.
  docker exec -d "$NAME" bash -lc "echo \$\$ > /tmp/rc066-api.pid; exec env DISPLAY=:99 API_PORT=3001 \
    DATABASE_PATH=/var/lib/remotecode/rc054.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' \
    REMOTECODE_WEB_ORIGIN='$WEB_ORIGIN' REMOTECODE_TLS_CERT=/proof-cert.pem \
    REMOTECODE_TLS_KEY=/proof-key.pem $EXTRA_ENV bun apps/api/src/index.ts \
    > /var/log/rc054-api-restarted.log 2>&1"
  for _ in $(seq 1 60); do
    curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1 && break
    sleep 1
  done
  say "API restarted: $(curl -sk https://127.0.0.1:${API_PORT}/api/health/ready)"
  # The browser cannot see the gap -- the port stays open -- so the restart is
  # announced by a workspace only the new process can have served.
  docker exec "$NAME" bash -lc "curl -sk -X POST https://127.0.0.1:3000/api/workspaces -H 'content-type: application/json' -H 'cookie: $HOST_COOKIE' -d '{\"name\":\"RC066-WIN-RESTART-DONE $(date +%s)\",\"requestId\":\"$(uuidgen)\"}' >/dev/null" || say "the restart marker could not be written"
  # The public path the Windows runner uses, so a tunnel that did not survive the
  # restart is visible in this log rather than only in the run's failure.
  for _ in $(seq 1 60); do
    if curl -s --fail --max-time 10 "${TUNNEL}/api/health/ready" >/dev/null 2>&1; then
      say "the public path answers again through the tunnel"
      break
    fi
    sleep 2
  done
fi

STATUS=0
gh run watch "$RUN_ID" --repo "$REPO" --exit-status >/dev/null 2>&1 || STATUS=1
# Only now: a job decides its own gate when it starts, so clearing the origin
# earlier would skip the run this script just armed.
gh variable delete RC054_BACKEND_ORIGIN --repo "$REPO" >/dev/null 2>&1 || true
gh variable delete RC054_SPEC --repo "$REPO" >/dev/null 2>&1 || true
gh variable delete RC051_STUB_AGENT --repo "$REPO" >/dev/null 2>&1 || true
say "run outcome: $(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq .conclusion)"
gh run view "$RUN_ID" --repo "$REPO" --log > "$OUT/windows-job.log" 2>&1 || true
gh run download "$RUN_ID" --repo "$REPO" -n rc054-windows-evidence -D "$OUT/evidence" 2>/dev/null || true

if [[ -f "$OUT/evidence/proof.log" ]]; then
  say "-- what the Windows runner reported --"
  tail -25 "$OUT/evidence/proof.log" | tee -a "$OUT/leg.log"
fi
if [[ -f "$OUT/evidence/proof.json" ]]; then
  cat "$OUT/evidence/proof.json" | tee -a "$OUT/leg.log"
fi

if [[ "$STATUS" == "0" ]]; then
  say "PASS rc066-windows-restart: the Windows browser survived an API restart and read the same file back once"
else
  say "FAIL rc054-windows: see $OUT/windows-job.log"
fi
exit "$STATUS"
