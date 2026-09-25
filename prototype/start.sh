#!/bin/sh
set -eu

export DISPLAY=${DISPLAY:-:99}
export XDG_SESSION_TYPE=x11

CHROME_PID=
OPENBOX_PID=
API_PID=
WEB_PID=
Xvfb "$DISPLAY" -screen 0 1280x900x24 -ac -nolisten tcp >/var/log/rc003-xvfb.log 2>&1 &
XVFB_PID=$!

cleanup() {
  for pid in "$CHROME_PID" "$WEB_PID" "$API_PID" "$OPENBOX_PID" "$XVFB_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

wait_for() {
  url=$1
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS "$url" >/dev/null; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

wait_for_x11() {
  i=0
  while [ "$i" -lt 30 ]; do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  echo "Timed out waiting for X11 at $DISPLAY" >&2
  return 1
}

wait_for_window() {
  i=0
  while [ "$i" -lt 30 ]; do
    if wmctrl -l | grep -F "RemoteCode Linux proof" >/dev/null; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  echo "Timed out waiting for the guest Chromium window" >&2
  return 1
}

wait_for_x11
openbox --sm-disable >/var/log/rc003-openbox.log 2>&1 &
OPENBOX_PID=$!
bun run dev:api >/var/log/rc003-api.log 2>&1 &
API_PID=$!
node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts --host 0.0.0.0 >/var/log/rc003-web.log 2>&1 &
WEB_PID=$!
wait_for http://127.0.0.1:3000/api/health
wait_for http://127.0.0.1:5173/

mkdir -p /var/lib/rc003
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/var/lib/rc003/chromium --app=http://127.0.0.1:5173/ \
  --window-size=1280,900 >/var/log/rc003-chromium.log 2>&1 &
CHROME_PID=$!

wait_for http://127.0.0.1:9222/json/version
wait_for_window
mkdir -p .grok

distill mcp add --scope user linux-use -- python3 /opt/linux-use/server.py
distill mcp doctor linux-use
python3 scripts/linux-use-smoke.py

wait "$CHROME_PID"
