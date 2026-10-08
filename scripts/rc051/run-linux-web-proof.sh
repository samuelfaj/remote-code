#!/usr/bin/env bash
# RC-051 Linux-hosted browser proof.
#
# RC-051's panel shows live runs, the permission it denies, scheduled tasks, Bot
# routines and Inbox work that all come from the host. This stands up the
# repository's own Linux runtime with the repository's own runs stub as the
# agent (so a run really asks for permission) and points the browser at it
# through a local Vite, which keeps the browser on loopback — the login guard
# requires that — while the API answers over TLS inside the container.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: run-linux-web-proof.sh <fresh absolute output dir>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

IMAGE="${RC051_IMAGE:-remotecode/host:local}"
NAME="rc051-linux-$(date +%s)"
API_PORT="${RC051_API_PORT:-37119}"
WEB_PORT="${RC051_WEB_PORT:-37120}"
PASSWORD="rc051-linux-$(openssl rand -hex 12)"
DATA_VOLUME="rc051-data-$(date +%s)"

cleanup() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$OUT/proof.log"; }

say "-- image --"
# A cached image is only usable if it carries the routes this proof drives; a
# stale layer would answer a missing route with 404 and make the proof pass or
# fail against an API that is not the working tree.
if [[ "${RC050_REBUILD:-0}" == "1" || "${RC051_REBUILD:-0}" == "1" ]]; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
docker image inspect -f '{{.Id}}' "$IMAGE" | tee -a "$OUT/proof.log"

say "-- a self-signed certificate for the container's API --"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-051 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"

say "-- the repository's Linux host, with the runs stub as the agent --"
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 \
  -e DATABASE_PATH=/var/lib/remotecode/rc051.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}" \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
# The repository's own ACP stub, delayed briefly so the run is still asking
# when the panel is opened — a run that has already finished never raises a
# permission request.
docker exec "$NAME" bash -lc 'printf "#!/bin/bash\nsleep 3\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs \"\$@\"\n" > /usr/local/bin/rc051-agent && chmod 0755 /usr/local/bin/rc051-agent'
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc051.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem REMOTECODE_DISTILL_BIN=/usr/local/bin/rc051-agent bun apps/api/src/index.ts > /var/log/rc051-api.log 2>&1"

for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$NAME" tail -20 /var/log/rc051-api.log | tee -a "$OUT/proof.log" >&2
  echo "the Linux API never became ready" >&2
  exit 1
fi
say "api ready over TLS on 127.0.0.1:${API_PORT}"

say "-- the image serves the routes this proof drives --"
INBOX_CODE="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:${API_PORT}/api/inbox")"
say "GET /api/inbox -> $INBOX_CODE"
if [[ "$INBOX_CODE" != "401" ]]; then
  echo "the API image does not serve the shipped Inbox route; rebuild it with RC051_REBUILD=1" >&2
  exit 1
fi

say "-- a local Vite in front of it, so the browser stays on loopback --"
REMOTECODE_WEB_PROXY_TARGET="https://127.0.0.1:${API_PORT}" WEB_PORT="$WEB_PORT" \
  bunx vite --config "$ROOT/apps/web/vite.config.ts" --host 127.0.0.1 \
  > "$OUT/vite.log" 2>&1 &
WEB_PID=$!
for _ in $(seq 1 60); do
  if curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then break; fi
  sleep 1
done
if ! curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
  tail -20 "$OUT/vite.log" | tee -a "$OUT/proof.log" >&2
  echo "the web origin never became ready" >&2
  exit 1
fi
say "web ready on 127.0.0.1:${WEB_PORT}"

say "-- the RC-051 spec against that Linux host --"
set +e
RC051_STUB_AGENT=1 \
RC003_WEB_URL="http://127.0.0.1:${WEB_PORT}" \
RC003_API_URL="http://127.0.0.1:${WEB_PORT}" \
RC003_AUTH_PASSWORD="$PASSWORD" \
  bun run test:e2e -- "$ROOT/apps/web/e2e/agent-activity.spec.ts" 2>&1 | tee -a "$OUT/proof.log"
STATUS=${PIPESTATUS[0]}
set -e

say "-- the API's own log, for anything the run hid --"
docker exec "$NAME" tail -40 /var/log/rc051-api.log 2>&1 | tee -a "$OUT/proof.log" || true

say "spec exit status: $STATUS"
exit "$STATUS"