#!/bin/sh
set -eu

export DISPLAY=${DISPLAY:-:99}
export XDG_SESSION_TYPE=x11

rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}" 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 1280x900x24 -ac -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
X11VNC_PID=""
XTERM_PID=""

cleanup() {
  kill "$X11VNC_PID" "$XTERM_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

openbox --sm-disable >/dev/null 2>&1 &

# Xvfb creates the display socket asynchronously; a client started before it
# exists fails against a missing display.
i=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; do
  i=$((i + 1))
  if [ "$i" -ge 100 ]; then
    echo "X display $DISPLAY did not appear" >&2
    exit 1
  fi
  sleep 0.05
done

# The API connects to VNC over loopback; it authenticates the session, so the
# RFB stream itself carries no password.
x11vnc -display "$DISPLAY" -rfbport "${REMOTECODE_MACHINE_VNC_PORT:-5900}" \
  -localhost -forever -shared -nopw -quiet -noxdamage >/dev/null 2>&1 &
X11VNC_PID=$!
xterm -display "$DISPLAY" >/dev/null 2>&1 &
XTERM_PID=$!

# The agent runs as its own user with its own home, so the provider model it must
# use is configured here. The credential itself is never written: `env_key` names
# the environment variable the agent already receives. Without this the agent
# starts unauthenticated and every run ends as a failure.
if [ -n "${REMOTECODE_AGENT_MODEL:-}" ] && [ -n "${REMOTECODE_AGENT_HOME:-}" ]; then
  mkdir -p "$REMOTECODE_AGENT_HOME/.distill"
  cat > "$REMOTECODE_AGENT_HOME/.distill/config.toml" <<EOF
[models]
default = "remotecode-agent"

[model.remotecode-agent]
name = "${REMOTECODE_AGENT_MODEL_NAME:-RemoteCode agent}"
model = "${REMOTECODE_AGENT_MODEL}"
base_url = "${REMOTECODE_AGENT_MODEL_BASE_URL:-https://openrouter.ai/api/v1}"
env_key = "${REMOTECODE_AGENT_MODEL_ENV_KEY:-OPENROUTER_API_KEY}"
api_backend = "chat_completions"
context_window = ${REMOTECODE_AGENT_MODEL_CONTEXT:-128000}
EOF
  chmod 600 "$REMOTECODE_AGENT_HOME/.distill/config.toml"
  if [ -n "${REMOTECODE_AGENT_USER:-}" ]; then
    chown -R "$REMOTECODE_AGENT_USER" "$REMOTECODE_AGENT_HOME/.distill" 2>/dev/null || true
  fi
fi

exec bun apps/api/src/index.ts
