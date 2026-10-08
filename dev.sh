#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

DEV_DIR="$PWD/.dev"
mkdir -p "$DEV_DIR"

if [ -z "${API_PORT+x}" ]; then API_PORT=3000; fi
if [ -z "${WEB_PORT+x}" ]; then WEB_PORT=5173; fi
if [ -z "${DATABASE_PATH+x}" ]; then DATABASE_PATH="$DEV_DIR/remotecode.sqlite"; fi
if [ -z "${REMOTECODE_DATA_ROOT+x}" ]; then REMOTECODE_DATA_ROOT="$DEV_DIR/data"; fi
if [ -z "${REMOTECODE_WEB_ORIGIN+x}" ]; then REMOTECODE_WEB_ORIGIN="http://localhost:$WEB_PORT"; fi
if [ -z "${REMOTECODE_AUTH_PASSWORD+x}" ]; then REMOTECODE_AUTH_PASSWORD="remote-code-local-dev"; fi

export API_PORT WEB_PORT DATABASE_PATH REMOTECODE_DATA_ROOT REMOTECODE_WEB_ORIGIN REMOTECODE_AUTH_PASSWORD

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed. See https://bun.sh" >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  bun install
fi

bun apps/api/src/index.ts >"$DEV_DIR/api.log" 2>&1 &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

retries=0
max_retries=60
while [ "$retries" -lt "$max_retries" ]; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API process exited unexpectedly" >&2
    echo "Last 20 lines of $DEV_DIR/api.log:" >&2
    tail -20 "$DEV_DIR/api.log" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$API_PORT/api/health/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  retries=$((retries + 1))
done

if [ "$retries" -ge "$max_retries" ]; then
  echo "API did not become ready within 30 seconds" >&2
  echo "Last 20 lines of $DEV_DIR/api.log:" >&2
  tail -20 "$DEV_DIR/api.log" >&2
  exit 1
fi

echo "API: http://127.0.0.1:$API_PORT"
echo "Web: http://localhost:$WEB_PORT"
echo "Login password: $REMOTECODE_AUTH_PASSWORD"
echo "Log: $DEV_DIR/api.log"

bunx vite --config apps/web/vite.config.ts
