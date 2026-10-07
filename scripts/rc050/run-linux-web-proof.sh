#!/usr/bin/env bash
# RC-050 Linux-hosted browser proof.
#
# The folder, the file editor and the terminal are served only by a Linux host,
# so this stands up the repository's own Linux runtime — the same image the
# container proofs use — and points the browser at it through a local Vite,
# which keeps the browser on loopback (the login guard requires that) while the
# API answers over TLS inside the container.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: run-linux-web-proof.sh <fresh absolute output dir>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

IMAGE="${RC050_IMAGE:-remotecode/host:local}"
NAME="rc050-linux-$(date +%s)"
API_PORT="${RC050_API_PORT:-37117}"
WEB_PORT="${RC050_WEB_PORT:-37118}"
PASSWORD="rc050-linux-$(openssl rand -hex 12)"
DATA_VOLUME="rc050-data-$(date +%s)"

cleanup() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$OUT/proof.log"; }

say "-- image --"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
docker image inspect -f '{{.Id}}' "$IMAGE" | tee -a "$OUT/proof.log"

say "-- a self-signed certificate for the container's API --"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-050 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"

say "-- the repository's Linux host, with the API on its own display --"
docker volume create "$DATA_VOLUME" >/dev/null
# The terminal feature spawns a container of its own, so the API needs the host's
# Docker socket and a terminal image, exactly as the repository's terminal proof
# arranges it (scripts/run-terminal-linux-browser-proof.ts).
# The terminal has to be able to run git, so it uses the same host image the
# API runs in rather than a bare runtime image.
TERMINAL_IMAGE="${RC050_TERMINAL_IMAGE:-$IMAGE}"
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  -e REMOTECODE_TERMINAL_VOLUME="$DATA_VOLUME" \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  -e REMOTECODE_TERMINAL_IMAGE="$TERMINAL_IMAGE" \
  -e API_PORT=3000 \
  -e DATABASE_PATH=/var/lib/remotecode/rc050.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}" \
  -e REMOTECODE_DISPLAY=:99 \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc050.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc050-api.log 2>&1"

for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$NAME" tail -20 /var/log/rc050-api.log | tee -a "$OUT/proof.log" >&2
  echo "the Linux API never became ready" >&2
  exit 1
fi
say "api ready over TLS on 127.0.0.1:${API_PORT}"

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

say "-- the RC-050 spec against that Linux host --"
set +e
RC050_LINUX_API=1 \
RC003_WEB_URL="http://127.0.0.1:${WEB_PORT}" \
RC003_API_URL="http://127.0.0.1:${WEB_PORT}" \
RC003_AUTH_PASSWORD="$PASSWORD" \
  bun run test:e2e -- "$ROOT/apps/web/e2e/workspace-work.spec.ts" 2>&1 | tee -a "$OUT/proof.log"
STATUS=${PIPESTATUS[0]}
set -e

say "-- the API's own log, for anything the run hid --"
docker exec "$NAME" tail -30 /var/log/rc050-api.log 2>&1 | tee -a "$OUT/proof.log" || true

say "spec exit status: $STATUS"
exit "$STATUS"