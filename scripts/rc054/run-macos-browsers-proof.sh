#!/usr/bin/env bash
# RC-054 browser proof (macOS leg): a browser on this machine drives a Linux
# host, with no shell or agent running here, and the journey is repeated on two
# engines. Windows is not available on this machine and is reported as such.
#
# Usage: scripts/rc054/run-macos-browsers-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: run-macos-browsers-proof.sh <fresh absolute output dir>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

IMAGE="${RC054_IMAGE:-remotecode/host:local}"
NAME="rc054-linux-$(date +%s)"
API_PORT="${RC054_API_PORT:-37123}"
WEB_PORT="${RC054_WEB_PORT:-37124}"
PASSWORD="rc054-linux-$(openssl rand -hex 12)"
DATA_VOLUME="rc054-data-$(date +%s)"

cleanup() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$OUT/proof.log"; }

if [[ "${RC054_REBUILD:-0}" == "1" ]]; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
say "-- image --"
docker image inspect -f '{{.Id}}' "$IMAGE" | tee -a "$OUT/proof.log"

say "-- a self-signed certificate for the container's API --"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-054 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"

say "-- the repository's Linux host, with the API on its own display --"
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:${API_PORT}:3000" -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 \
  -e DATABASE_PATH=/var/lib/remotecode/rc054.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}" \
  -e REMOTECODE_DISPLAY=:99 \
  "$IMAGE" sleep infinity >/dev/null
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc054.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem bun apps/api/src/index.ts > /var/log/rc054-api.log 2>&1"

for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$NAME" tail -20 /var/log/rc054-api.log | tee -a "$OUT/proof.log" >&2
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

STATUS=0
for ENGINE in chromium webkit; do
  say "-- the journey on $ENGINE --"
  set +e
  RC054_LINUX_HOST=1 RC054_BROWSER="$ENGINE" \
  RC003_WEB_URL="http://127.0.0.1:${WEB_PORT}" RC003_API_URL="http://127.0.0.1:${WEB_PORT}" \
  RC003_AUTH_PASSWORD="$PASSWORD" \
  bun run test:e2e -- "apps/web/e2e/macos-linux-client.spec.ts" 2>&1 | tee -a "$OUT/proof.log" | tail -12
  ENGINE_STATUS=${PIPESTATUS[0]}
  set -e
  say "$ENGINE spec exit status: $ENGINE_STATUS"
  [[ "$ENGINE_STATUS" == "0" ]] || STATUS=1
done

say "-- Windows --"
say "not run here: this machine has no Windows target, so that leg runs on GitHub's windows-latest runner via scripts/rc054/run-windows-host-and-dispatch.sh, which publishes a host like this one over a tunnel and runs the same journey from a Windows Chromium"

say "-- the API's own log, for anything the run hid --"
docker exec "$NAME" tail -20 /var/log/rc054-api.log 2>&1 | tee -a "$OUT/proof.log" || true

python3 - "$OUT" "$STATUS" <<'PY'
import json, sys
out, status = sys.argv[1], int(sys.argv[2])
json.dump({
  "result": "verified" if status == 0 else "failed",
  "scope": "RC-054 macOS browsers against a Linux host",
  "engines": ["chromium", "webkit"],
  "windows": "run separately by scripts/rc054/run-windows-host-and-dispatch.sh on GitHub's windows-latest runner",
}, open(out + "/proof.json", "w"), indent=2)
print("proof.json written")
PY

if [[ "$STATUS" == "0" ]]; then
  say "PASS rc054: both macOS engines completed the journey against the Linux host"
else
  say "FAIL rc054: see the engine output above"
fi
exit "$STATUS"
