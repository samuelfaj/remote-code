#!/bin/sh
set -eu

export DISPLAY=${DISPLAY:-:99}
export XDG_SESSION_TYPE=x11

rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}" 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 1280x900x24 -ac -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!

cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

openbox --sm-disable >/dev/null 2>&1 &

exec bun apps/api/src/index.ts
