#!/usr/bin/env bash
# RC-019 host supervisor: bounded probes for the Docker daemon, the container,
# the API, Distill and the X11 GUI, with a limited staged restart. It never
# blocks on one call, never restarts forever, reports a lock instead of
# claiming the host is healthy, and never deletes the data volume.
#
# Env: RC019_DOCKER (docker command), RC019_CONTAINER, RC019_API_URL,
#      RC019_GUI_MATCH, RC019_PROBE_TIMEOUT, RC019_MAX_RESTARTS,
#      RC019_STATE_FILE, RC019_DISTILL_PATH.
set -uo pipefail

DOCKER="${RC019_DOCKER:-docker}"
CONTAINER="${RC019_CONTAINER:-remotecode}"
API_URL="${RC019_API_URL:-http://127.0.0.1:3000/api/health/ready}"
GUI_MATCH="${RC019_GUI_MATCH:-RemoteCode}"
PROBE_TIMEOUT="${RC019_PROBE_TIMEOUT:-6}"
MAX_RESTARTS="${RC019_MAX_RESTARTS:-2}"
STATE_FILE="${RC019_STATE_FILE:-/tmp/rc019-state.json}"
DISTILL_PATH="${RC019_DISTILL_PATH:-/usr/local/bin/distill}"

PROBE_OUT="${TMPDIR:-/tmp}/rc019-probe.$$.out"

# Run a command with a hard deadline. Returns 137 when the deadline killed it.
bounded() {
  local secs="$1"; shift
  "$@" >"$PROBE_OUT" 2>/dev/null &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return $rc
}

probe() {
  case "$1" in
    daemon)    bounded "$PROBE_TIMEOUT" "$DOCKER" info ;;
    container) bounded "$PROBE_TIMEOUT" "$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER" && grep -qx true "$PROBE_OUT" ;;
    api)       bounded "$PROBE_TIMEOUT" "$DOCKER" exec "$CONTAINER" curl -fsS --max-time "$PROBE_TIMEOUT" "$API_URL" ;;
    gui)       bounded "$PROBE_TIMEOUT" "$DOCKER" exec "$CONTAINER" wmctrl -l && grep -qi "$GUI_MATCH" "$PROBE_OUT" ;;
    distill)   bounded "$PROBE_TIMEOUT" "$DOCKER" exec "$CONTAINER" test -x "$DISTILL_PATH" ;;
  esac
}

evaluate() {
  local all=1 d c a g s
  if probe daemon; then d=true; else d=false; all=0; fi
  if probe container; then c=true; else c=false; all=0; fi
  if probe api; then a=true; else a=false; all=0; fi
  if probe gui; then g=true; else g=false; all=0; fi
  if probe distill; then s=true; else s=false; all=0; fi
  printf '{"ts":"%s","healthy":%s,"probes":{"daemon":%s,"container":%s,"api":%s,"gui":%s,"distill":%s}}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$([ "$all" = 1 ] && echo true || echo false)" \
    "$d" "$c" "$a" "$g" "$s"
  return $((1 - all))
}

restarts=0
while true; do
  status=$(evaluate)
  if printf '%s' "$status" | grep -q '"healthy":true'; then
    printf '%s\n' "${status%\}},\"state\":\"healthy\",\"action\":\"none\",\"restarts\":$restarts}" > "$STATE_FILE"
    echo "healthy restarts=$restarts"
    exit 0
  fi
  echo "unhealthy: $status"
  if [ "$restarts" -ge "$MAX_RESTARTS" ]; then
    printf '%s\n' "${status%\}},\"state\":\"locked\",\"action\":\"reported_lock\",\"restarts\":$restarts,\"volume\":\"preserved\"}" > "$STATE_FILE"
    echo "locked: reported lock after $restarts restarts; data volume preserved"
    exit 2
  fi
  restarts=$((restarts + 1))
  echo "recovery: restarting container (attempt $restarts/$MAX_RESTARTS)"
  bounded "${RC019_RESTART_TIMEOUT:-60}" "$DOCKER" restart "$CONTAINER" >/dev/null 2>&1
  # Let the services come back, but never longer than the settle budget.
  deadline=$(( $(date +%s) + ${RC019_RESTART_SETTLE:-15} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if probe api && probe gui; then break; fi
    sleep 2
  done
done