#!/usr/bin/env bash
# RC-054 browser proof (Windows leg): this script runs on a real Windows
# machine, and it is the only Windows-side piece of the journey. The browser it
# drives is Windows', the web app it loads is served from Windows, but the
# backend it talks to is the Linux host named by RC054_BACKEND_ORIGIN: no shell
# or agent runs here, and nothing about the workspace, the file, the thread or
# the screen lives on this machine.
#
# Usage: RC054_BACKEND_ORIGIN=https://<linux-host>:8443 \
#        RC054_AUTH_PASSWORD=<the Linux host's passphrase> \
#        scripts/rc054/run-windows-client-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/scratch/rc054-windows}"
BACKEND="${RC054_BACKEND_ORIGIN:?set RC054_BACKEND_ORIGIN to the Linux host's HTTPS origin}"
: "${RC054_AUTH_PASSWORD:?set RC054_AUTH_PASSWORD to the Linux host's passphrase}"
ENGINE="${RC054_BROWSER:-chromium}"
WEB_PORT="${RC054_WEB_PORT:-37124}"

mkdir -p "$OUT"
say() { printf '%s\n' "$*" | tee -a "$OUT/proof.log"; }

say "== RC-054: a browser on Windows driving the Linux host at $BACKEND =="
say "-- the machine this runs on --"
say "$(uname -a 2>/dev/null || echo 'uname unavailable')"

say "-- the Linux host answers before anything runs here --"
curl -sk --fail "$BACKEND/api/health/ready" | tee -a "$OUT/proof.log"
printf '\n'

say "-- this Windows machine serves the web app in front of the Linux host --"
REMOTECODE_WEB_PROXY_TARGET="$BACKEND" REMOTECODE_WEB_PROXY_CHANGE_ORIGIN=1 WEB_PORT="$WEB_PORT" \
  bunx vite --config "$ROOT/apps/web/vite.config.ts" --host 127.0.0.1 --port "$WEB_PORT" \
  > "$OUT/vite.log" 2>&1 &
WEB_PID=$!
for _ in $(seq 1 60); do
  curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1 && break
  sleep 1
done
curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null
say "web ready on 127.0.0.1:${WEB_PORT} (it only forwards; the API is the Linux host's)"

say "-- the journey on $ENGINE, on Windows --"
STATUS=0
set +e
RC054_LINUX_HOST=1 RC054_BROWSER="$ENGINE" \
RC003_WEB_URL="http://127.0.0.1:${WEB_PORT}" RC003_API_URL="http://127.0.0.1:${WEB_PORT}" \
RC003_AUTH_PASSWORD="$RC054_AUTH_PASSWORD" \
bun run test:e2e -- "apps/web/e2e/macos-linux-client.spec.ts" 2>&1 | tee -a "$OUT/proof.log" | tail -15
STATUS=${PIPESTATUS[0]}
set -e
say "$ENGINE spec exit status: $STATUS"
kill "$WEB_PID" 2>/dev/null || true

RC054_STATUS="$STATUS" RC054_ENGINE="$ENGINE" RC054_OUT="$OUT" bun -e '
const fs = require("fs");
fs.writeFileSync(process.env.RC054_OUT + "/proof.json", JSON.stringify({
  result: process.env.RC054_STATUS === "0" ? "verified" : "failed",
  scope: "RC-054 Windows browser against a Linux host",
  engine: process.env.RC054_ENGINE,
  os: "windows",
}, null, 2) + "\n");
'

if [[ "$STATUS" == "0" ]]; then
  say "PASS rc054-windows: the Windows browser completed the journey against the Linux host"
else
  say "FAIL rc054-windows: see the engine output above"
fi
exit "$STATUS"
