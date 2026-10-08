#!/usr/bin/env bash
# RC-067's Windows leg, driven from this machine. This machine is a
# real Windows runner, so the API calls and port checks run here; the
# control plane is the Linux host reachable at RC067_CONTROL_ORIGIN.
#
# Usage: RC067_CONTROL_ORIGIN=https://<tunnel-host>:8443 \
#        RC067_PASSPHRASE=<the control plane's passphrase> \
#        scripts/rc067/run-windows-hosted-service-proof.sh [OUTDIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/scratch/rc067-windows}"
# Git Bash on a Windows runner hands over a drive path such as D:\a\... , so
# both the POSIX and the Windows form count as absolute here.
case "$OUT" in /*|[A-Za-z]:*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

CONTROL_ORIGIN="${RC067_CONTROL_ORIGIN:?set RC067_CONTROL_ORIGIN to the control plane's HTTPS origin}"
PASSPHRASE="${RC067_PASSPHRASE:?set RC067_PASSPHRASE to the control plane's passphrase}"

say() { printf '%s\n' "$*" | tee -a "$OUT/proof.log"; }

declare -A STEP_RESULT

say "== RC-067: hosted service reachable from Windows runner at $CONTROL_ORIGIN =="

# 1. Health check
say "-- step: health check --"
if curl -sk --fail "$CONTROL_ORIGIN/api/health/ready" >/dev/null 2>&1; then
  say "PASS: control plane answers /api/health/ready"
  STEP_RESULT[health]="ok"
else
  say "FAIL: control plane does not answer /api/health/ready at $CONTROL_ORIGIN"
  STEP_RESULT[health]="fail"
fi

# 2. Sign in
say "-- step: sign in --"
# The session cookie is read from a jar: -w only reports the status, and the
# headers are not in the output at all.
COOKIE_JAR="$OUT/cookies.txt"
LOGIN_STATUS=$(curl -sk -o "$OUT/login.json" -w "%{http_code}" -X POST "$CONTROL_ORIGIN/api/auth/login" \
  -H "content-type: application/json" \
  -d "{\"password\":\"$PASSPHRASE\"}" -c "$COOKIE_JAR" 2>/dev/null || echo "000")
LOGIN_COOKIE=$(awk '/remotecode/ {print $6"="$7}' "$COOKIE_JAR" 2>/dev/null | head -1)

if [[ "$LOGIN_STATUS" == "200" ]]; then
  say "PASS: login returned 200"
  STEP_RESULT[login]="ok"
else
  say "FAIL: login returned $LOGIN_STATUS"
  STEP_RESULT[login]="fail"
fi

# 3. Provision a hosted account
say "-- step: provision hosted account --"
ACCOUNT_RESPONSE=$(curl -sk -w "\n%{http_code}" -X POST "$CONTROL_ORIGIN/api/hosted/accounts" \
  -H "content-type: application/json" \
  -H "Cookie: $LOGIN_COOKIE" \
  -d '{"name":"RC067-Windows-Proof"}' 2>/dev/null || true)
ACCOUNT_STATUS=$(echo "$ACCOUNT_RESPONSE" | tail -1)
ACCOUNT_BODY=$(echo "$ACCOUNT_RESPONSE" | sed '$d')
ACCOUNT_ID=$(echo "$ACCOUNT_BODY" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
ACCOUNT_PORT=$(echo "$ACCOUNT_BODY" | grep -o '"hostPort"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')

if [[ "$ACCOUNT_STATUS" == "201" && -n "$ACCOUNT_ID" && -n "$ACCOUNT_PORT" ]]; then
  say "PASS: provision returned 201, id=$ACCOUNT_ID, hostPort=$ACCOUNT_PORT"
  STEP_RESULT[provision]="ok"
else
  say "FAIL: provision returned $ACCOUNT_STATUS, id=${ACCOUNT_ID:-none}, port=${ACCOUNT_PORT:-none}"
  STEP_RESULT[provision]="fail"
fi

# 4. Poll until the account reports ready
say "-- step: poll until ready --"
READY=0
for _ in $(seq 1 60); do
  POLL_RESPONSE=$(curl -sk -w "\n%{http_code}" "$CONTROL_ORIGIN/api/hosted/accounts/$ACCOUNT_ID" \
    -H "Cookie: $LOGIN_COOKIE" 2>/dev/null || true)
  POLL_STATUS=$(echo "$POLL_RESPONSE" | tail -1)
  POLL_BODY=$(echo "$POLL_RESPONSE" | sed '$d')
  POLL_STATE=$(echo "$POLL_BODY" | grep -o '"state"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
  if [[ "$POLL_STATUS" == "200" && "$POLL_STATE" == "ready" ]]; then
    READY=1
    break
  fi
  sleep 2
done

if [[ "$READY" == "1" ]]; then
  say "PASS: account $ACCOUNT_ID is ready"
  STEP_RESULT[poll_ready]="ok"
else
  say "FAIL: account $ACCOUNT_ID did not become ready (last state: ${POLL_STATE:-unknown})"
  STEP_RESULT[poll_ready]="fail"
fi

# 5. Assert the account's own port answers /api/health/ready from this runner
say "-- step: account port reachable from Windows runner --"
if [[ -n "$ACCOUNT_PORT" ]]; then
  if curl -sk --fail "http://127.0.0.1:${ACCOUNT_PORT}/api/health/ready" >/dev/null 2>&1; then
    say "PASS: account port $ACCOUNT_PORT answers /api/health/ready from this runner"
    STEP_RESULT[account_port]="ok"
  else
    say "FAIL: account port $ACCOUNT_PORT does not answer /api/health/ready from this runner"
    STEP_RESULT[account_port]="fail"
  fi
else
  say "FAIL: cannot check account port because hostPort is empty"
  STEP_RESULT[account_port]="fail"
fi

# 6. Suspend the account
say "-- step: suspend account --"
SUSPEND_RESPONSE=$(curl -sk -w "\n%{http_code}" -X POST "$CONTROL_ORIGIN/api/hosted/accounts/$ACCOUNT_ID/suspend" \
  -H "Cookie: $LOGIN_COOKIE" 2>/dev/null || true)
SUSPEND_STATUS=$(echo "$SUSPEND_RESPONSE" | tail -1)
SUSPEND_BODY=$(echo "$SUSPEND_RESPONSE" | sed '$d')
SUSPEND_STATE=$(echo "$SUSPEND_BODY" | grep -o '"state"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')

if [[ "$SUSPEND_STATUS" == "200" && "$SUSPEND_STATE" == "suspended" ]]; then
  say "PASS: suspend returned 200 and state is suspended"
  STEP_RESULT[suspend]="ok"
else
  say "FAIL: suspend returned $SUSPEND_STATUS, state=${SUSPEND_STATE:-unknown}"
  STEP_RESULT[suspend]="fail"
fi

# 7. Verify the record says suspended
say "-- step: verify suspended record --"
VERIFY_RESPONSE=$(curl -sk -w "\n%{http_code}" "$CONTROL_ORIGIN/api/hosted/accounts/$ACCOUNT_ID" \
  -H "Cookie: $LOGIN_COOKIE" 2>/dev/null || true)
VERIFY_STATUS=$(echo "$VERIFY_RESPONSE" | tail -1)
VERIFY_BODY=$(echo "$VERIFY_RESPONSE" | sed '$d')
VERIFY_STATE=$(echo "$VERIFY_BODY" | grep -o '"state"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')

if [[ "$VERIFY_STATUS" == "200" && "$VERIFY_STATE" == "suspended" ]]; then
  say "PASS: account record reports suspended"
  STEP_RESULT[verify_suspended]="ok"
else
  say "FAIL: account record does not report suspended (status: $VERIFY_STATUS, state: ${VERIFY_STATE:-unknown})"
  STEP_RESULT[verify_suspended]="fail"
fi

# Write proof.json
ALL_OK=1
for s in health login provision poll_ready account_port suspend verify_suspended; do
  if [[ "${STEP_RESULT[$s]:-fail}" != "ok" ]]; then
    ALL_OK=0
  fi
done

RESULT="verified"
if [[ "$ALL_OK" != "1" ]]; then
  RESULT="failed"
fi

STEPS_JSON=""
for s in health login provision poll_ready account_port suspend verify_suspended; do
  [[ -n "$STEPS_JSON" ]] && STEPS_JSON+=","
  STEPS_JSON+="\"$s\":\"${STEP_RESULT[$s]:-fail}\""
done

cat > "$OUT/proof.json" <<PROOF_EOF
{
  "result": "$RESULT",
  "scope": "RC-067 managed service reachable from outside",
  "steps": {$STEPS_JSON}
}
PROOF_EOF

if [[ "$ALL_OK" == "1" ]]; then
  say "PASS rc067-windows-hosted: the Windows runner proved the managed service is reachable from outside"
else
  say "FAIL rc067-windows-hosted: see $OUT/proof.log for details"
fi
exit "$([[ "$ALL_OK" == "1" ]] && echo 0 || echo 1)"
