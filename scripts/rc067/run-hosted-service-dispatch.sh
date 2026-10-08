#!/usr/bin/env bash
# RC-067's dispatch leg, runs here. Starts the control plane locally,
# publishes it on a Cloudflare quick tunnel, arms the GitHub workflow
# through repository variables plus a push, waits for the run, downloads
# the rc067-windows-evidence artifact, prints what the Windows runner
# reported, clears the variables, and tears the control plane down on
# exit. Exits non-zero if the Windows run did not pass.
#
# The passphrase is thrown away after each run and travels as a
# repository secret, so a public workflow run does not carry it in its
# inputs.
#
# Usage: scripts/rc067/run-hosted-service-dispatch.sh <OUTDIR>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: scripts/rc067/run-hosted-service-dispatch.sh <OUTDIR>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

IMAGE="${RC067_IMAGE:-remotecode/host:local}"
NAME="rc067-hosted-$(date +%s)"
API_PORT="${RC067_API_PORT:-26000}"
# Port base in 35000-35999 for the hosted accounts' host ports.
PORT_BASE=$((35000 + RANDOM % 1000))
PASSWORD="rc067-$(openssl rand -hex 16)"
DATA_VOLUME="rc067-data-$(date +%s)"
NETWORK="rc067-net-$(date +%s)"
LABEL="remotecode.rc067.hosted"
REPO="${RC067_REPO:-samuelfaj/remote-code}"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

TUNNEL_PID=""
CONTROL_PID=""
cleanup() {
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "$CONTROL_PID" ]] && kill "$CONTROL_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  gh variable delete RC067_CONTROL_ORIGIN --repo "$REPO" >/dev/null 2>&1 || true
  gh variable delete RC067_MODE --repo "$REPO" >/dev/null 2>&1 || true
  gh secret delete RC067_PASSPHRASE --repo "$REPO" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$OUT/dispatch.log"; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
say "-- the control plane image: $(docker image inspect -f '{{.Id}}' "$IMAGE") --"

# Create a Docker network for the hosted accounts, labelled so this
# run's containers can be identified and cleaned up.
docker network create --label "${LABEL}=${NAME}" "$NETWORK" >/dev/null

# Create a data volume for the control plane's database.
docker volume create "$DATA_VOLUME" >/dev/null

# Start the control plane container (it holds the database and the
# Docker daemon access; the API process runs on the host).
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc067.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${API_PORT}" \
  -e REMOTECODE_DISPLAY=:99 \
  -e REMOTECODE_HOSTED_IMAGE="$IMAGE" \
  -e REMOTECODE_HOSTED_NETWORK="$NETWORK" \
  -e REMOTECODE_HOSTED_PORT_BASE="$PORT_BASE" \
  "$IMAGE" sleep infinity >/dev/null

# Generate TLS certs so the tunnel exposes an HTTPS origin.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-067 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'

# Start the control plane API process inside the container.
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 \
  DATABASE_PATH=/var/lib/remotecode/rc067.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' \
  REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${API_PORT}' \
  REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem \
  REMOTECODE_HOSTED_IMAGE='$IMAGE' REMOTECODE_HOSTED_NETWORK='$NETWORK' \
  REMOTECODE_HOSTED_PORT_BASE='$PORT_BASE' \
  bun apps/api/src/index.ts \
  > /var/log/rc067-api.log 2>&1"

# Wait for the control plane to become ready.
for _ in $(seq 1 60); do
  curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null
say "-- the control plane is ready on 127.0.0.1:${API_PORT} (TLS) --"

# Publish the control plane on a Cloudflare quick tunnel.
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

# A fresh quick-tunnel hostname is not in any resolver yet; this
# waits for the public name to resolve and answer, and warns rather
# than aborts, because the Windows job's own first step is the
# assertion that the host is reachable.
dscacheutil -flushcache >/dev/null 2>&1 || true
PUBLIC=""
for _ in $(seq 1 90); do
  if curl -s --fail --max-time 10 "${TUNNEL}/api/health/ready" >/dev/null 2>&1; then
    PUBLIC=1
    break
  fi
  sleep 2
done
if [[ "$PUBLIC" == "1" ]]; then
  say "-- the Windows runner will reach the control plane at ${TUNNEL} --"
else
  say "-- the public name had not answered yet; the run reports it if it stays that way --"
fi

# Set the repository variables and secret that the workflow needs.
printf '%s' "$PASSWORD" | gh secret set RC067_PASSPHRASE --repo "$REPO"
gh variable set RC067_CONTROL_ORIGIN --repo "$REPO" --body "$TUNNEL"
gh variable set RC067_MODE --repo "$REPO" --body "hosted"

# The push that arms the job also fires the other runs on this
# branch, so the run this script waits for is the one created after
# this moment, not simply the newest by name.
ARMED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git -C "$ROOT" commit --allow-empty -q -m "ci: arm the RC-067 hosted-service proof against ${TUNNEL}"
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
  gh variable delete RC067_CONTROL_ORIGIN --repo "$REPO" >/dev/null 2>&1 || true
  gh variable delete RC067_MODE --repo "$REPO" >/dev/null 2>&1 || true
  gh secret delete RC067_PASSPHRASE --repo "$REPO" >/dev/null 2>&1 || true
  say "FAIL the push never produced a windows-client run"
  exit 1
fi
say "run ${RUN_ID}: https://github.com/${REPO}/actions/runs/${RUN_ID}"

STATUS=0
gh run watch "$RUN_ID" --repo "$REPO" --exit-status >/dev/null 2>&1 || STATUS=1

# Only now: a job decides its own gate when it starts, so clearing the
# origin earlier would skip the run this script just armed.
gh variable delete RC067_CONTROL_ORIGIN --repo "$REPO" >/dev/null 2>&1 || true
gh variable delete RC067_MODE --repo "$REPO" >/dev/null 2>&1 || true
gh secret delete RC067_PASSPHRASE --repo "$REPO" >/dev/null 2>&1 || true

say "run outcome: $(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq .conclusion)"
gh run view "$RUN_ID" --repo "$REPO" --log > "$OUT/windows-job.log" 2>&1 || true
gh run download "$RUN_ID" --repo "$REPO" -n rc067-windows-evidence -D "$OUT/evidence" 2>/dev/null || true

if [[ -f "$OUT/evidence/proof.log" ]]; then
  say "-- what the Windows runner reported --"
  tail -25 "$OUT/evidence/proof.log" | tee -a "$OUT/dispatch.log"
fi

if [[ -f "$OUT/evidence/proof.json" ]]; then
  say "-- proof.json from the Windows runner --"
  cat "$OUT/evidence/proof.json" | tee -a "$OUT/dispatch.log"
fi

if [[ "$STATUS" == "0" ]]; then
  say "PASS rc067-windows-hosted: the Windows runner proved the managed service is reachable from outside"
else
  say "FAIL rc067-windows-hosted: see $OUT/windows-job.log"
fi
exit "$STATUS"
