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

if [ "$(uname)" = "Darwin" ]; then
  IMAGE="${REMOTECODE_DEV_HOST_IMAGE:-remotecode/host:dev}"
  DATA_VOLUME="${REMOTECODE_DEV_DATA_VOLUME:-remotecode-dev-data}"
  CONTAINER="${REMOTECODE_DEV_CONTAINER:-remotecode-dev}"
  TERMINAL_IMAGE="${REMOTECODE_DEV_TERMINAL_IMAGE:-remotecode/terminal:local}"

  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "docker is not available; install Docker Desktop or OrbStack and ensure the daemon is running" >&2
    exit 1
  fi

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Building host image $IMAGE ..." >&2
    docker build -t "$IMAGE" -f prototype/Dockerfile .
  fi

  # The workspace shell the terminal spawns: the base image plus git, and no extra
  # environment, so it still matches the API's accepted terminal image contract.
  if ! docker image inspect "$TERMINAL_IMAGE" >/dev/null 2>&1; then
    echo "Building terminal image $TERMINAL_IMAGE ..." >&2
    docker build -t "$TERMINAL_IMAGE" -f prototype/terminal.Dockerfile .
  fi

  TERMINAL_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$TERMINAL_IMAGE" 2>/dev/null) || {
    echo "Pulling terminal image $TERMINAL_IMAGE ..." >&2
    docker pull "$TERMINAL_IMAGE"
    TERMINAL_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$TERMINAL_IMAGE")
  }

  if ! docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
    docker volume create "$DATA_VOLUME"
  fi

  TLS_DIR="$DEV_DIR/tls"
  mkdir -p "$TLS_DIR"
  if [ ! -f "$TLS_DIR/cert.pem" ] || [ ! -f "$TLS_DIR/key.pem" ]; then
    echo "Generating TLS certificate in $TLS_DIR ..." >&2
    openssl req -x509 -newkey rsa:2048 -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" -days 365 -nodes \
      -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  fi

  docker rm -f "$CONTAINER" 2>/dev/null || true

  docker run -d \
    --name "$CONTAINER" \
    -p "127.0.0.1:${API_PORT}:3000" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${DATA_VOLUME}:/var/lib/remotecode" \
    -v "$PWD/apps/api/src:/workspace/apps/api/src:ro" \
    -v "$PWD/packages/client/src:/workspace/packages/client/src:ro" \
    -v "$PWD/prototype/dev-entrypoint.sh:/workspace/prototype/dev-entrypoint.sh:ro" \
    -v "$TLS_DIR:/etc/remotecode/tls:ro" \
    -e DATABASE_PATH=/var/lib/remotecode/remotecode.sqlite \
    -e REMOTECODE_DATA_ROOT=/var/lib/remotecode \
    -e API_PORT=3000 \
    -e REMOTECODE_AUTH_PASSWORD="$REMOTECODE_AUTH_PASSWORD" \
    -e REMOTECODE_WEB_ORIGIN="http://localhost:${WEB_PORT}" \
    -e REMOTECODE_TERMINAL_VOLUME="$DATA_VOLUME" \
    -e REMOTECODE_TERMINAL_IMAGE="$TERMINAL_IMAGE_ID" \
    -e REMOTECODE_BOT_DISPLAY=:99 \
    -e REMOTECODE_BOT_SESSION_ROOT=/var/lib/remotecode/bots \
    -e REMOTECODE_DISPLAY=:99 \
    -e DISPLAY=:99 \
    -e REMOTECODE_DISTILL_BIN=distill \
    -e REMOTECODE_AGENT_USER=rcagent \
    -e REMOTECODE_AGENT_HOME=/home/rcagent \
    -e REMOTECODE_TLS_CERT=/etc/remotecode/tls/cert.pem \
    -e REMOTECODE_TLS_KEY=/etc/remotecode/tls/key.pem \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    --workdir /workspace \
    --entrypoint /bin/sh \
    "$IMAGE" \
    -c "prototype/dev-entrypoint.sh"

  cleanup() {
    docker rm -f "$CONTAINER" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  retries=0
  max_retries=60
  while [ "$retries" -lt "$max_retries" ]; do
    if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
      echo "Container $CONTAINER exited unexpectedly" >&2
      echo "Last 40 lines of container logs:" >&2
      docker logs --tail 40 "$CONTAINER" >&2
      exit 1
    fi
    if curl -kfsS "https://127.0.0.1:$API_PORT/api/health/ready" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
    retries=$((retries + 1))
  done

  if [ "$retries" -ge "$max_retries" ]; then
    echo "API did not become ready within 30 seconds" >&2
    echo "Last 40 lines of container logs:" >&2
    docker logs --tail 40 "$CONTAINER" >&2
    exit 1
  fi

  echo "API: https://127.0.0.1:$API_PORT"
  echo "Web: http://localhost:$WEB_PORT"
  echo "Login password: $REMOTECODE_AUTH_PASSWORD"
  echo "Log: docker logs $CONTAINER"

  REMOTECODE_WEB_PROXY_TARGET="https://127.0.0.1:${API_PORT}" bunx vite --config apps/web/vite.config.ts
else
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
fi
