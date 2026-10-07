#!/usr/bin/env bash
# RC-002 executable proof: the main Distill project through its existing stdio
# interface inside Linux. Proves submission+output (file creation), interruption
# (cancelled, never completed) and restart reconciliation (files, session state
# and usage receipt survive), with no RemoteCode fork and no macOS runtime
# dependency for the Distill process.
#
# Requires: docker, curl, python3 (host), a logged-in host Distill home
# (~/.distill/auth.json). The Distill process itself runs inside a Linux
# container using the official Linux binary.
#
# Usage: scripts/rc002/run-distill-linux-stdio-proof.sh [OUTDIR]
set -euo pipefail

VERSION="2.0.33"
SHA_AARCH64="f270e93957452d63526a5b42c0e2ae7c2f0307ae71df03b7a45a2679663a6473"
SHA_X86_64="b132c32acbecf887c9ea2a1f93e6eb62c27b5f090e9a3c6eb708224a8c25bfcc"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="${1:-$HERE/../../scratch/rc002-stdio}"
WORK="${RC002_WORK:-$OUTDIR/work}"
AUTH="${RC002_AUTH:-$HOME/.distill/auth.json}"
CONTAINER="rc002-proof"
VOLUME="rc002-proof-home"

mkdir -p "$OUTDIR" "$WORK/scripts/rc002" "$WORK/out"
cp "$HERE/acp_client.py" "$WORK/scripts/rc002/acp_client.py"
TRANSCRIPT="$OUTDIR/rc002-stdio.txt"
: > "$TRANSCRIPT"

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

say "== RC-002 Distill Linux stdio proof =="
say "version=$VERSION outdir=$OUTDIR"
docker version --format 'docker={{.Server.Version}}' | tee -a "$TRANSCRIPT"

# --- 1. official Linux binary, checksum-verified ---------------------------
if [ ! -x "$WORK/distill-linux-aarch64" ]; then
  say "downloading official $VERSION linux binaries + SHA256SUMS"
  curl -sSL -o "$WORK/SHA256SUMS" "https://github.com/samuelfaj/distill/releases/download/v$VERSION/SHA256SUMS"
  curl -sSL -o "$WORK/distill-linux-aarch64" "https://github.com/samuelfaj/distill/releases/download/v$VERSION/distill-linux-aarch64"
  curl -sSL -o "$WORK/distill-linux-x86_64" "https://github.com/samuelfaj/distill/releases/download/v$VERSION/distill-linux-x86_64"
fi
chmod +x "$WORK/distill-linux-aarch64" "$WORK/distill-linux-x86_64"
got_a=$(shasum -a 256 "$WORK/distill-linux-aarch64" | awk '{print $1}')
got_x=$(shasum -a 256 "$WORK/distill-linux-x86_64" | awk '{print $1}')
[ "$got_a" = "$SHA_AARCH64" ] || { say "FAIL aarch64 checksum $got_a"; exit 1; }
[ "$got_x" = "$SHA_X86_64" ] || { say "FAIL x86_64 checksum $got_x"; exit 1; }
say "checksum aarch64=$got_a (matches SHA256SUMS)"

# --- 2. clean container: persistent distill home volume, workspace bind ----
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$CONTAINER" --platform linux/arm64 \
  -v "$WORK:/work" -v "$VOLUME:/root/.distill" debian:bookworm-slim sleep infinity >/dev/null
docker exec "$CONTAINER" bash -lc 'apt-get update -qq && apt-get install -y -qq python3 procps' >/dev/null 2>&1
docker cp "$AUTH" "$CONTAINER:/root/.distill/auth.json"
docker exec "$CONTAINER" chmod 600 /root/.distill/auth.json

say "guest=$(docker exec "$CONTAINER" uname -m) bin=$(docker exec "$CONTAINER" /work/distill-linux-aarch64 --version)"
say "login=$(docker exec "$CONTAINER" /work/distill-linux-aarch64 models | head -1)"

# --- 3. submission + output: create a real file ----------------------------
docker exec "$CONTAINER" bash -lc 'rm -rf /work/ws && mkdir -p /work/ws'
CREATE_OUT=$(docker exec "$CONTAINER" bash -lc 'cd /work && python3 /work/scripts/rc002/acp_client.py \
  --bin /work/distill-linux-aarch64 --cwd /work/ws --timeout 180 \
  --transcript /work/out/create.jsonl \
  --prompt "Create a file named rc002-created.txt in the current directory containing exactly the single line: hello-rc002. Then stop."')
CREATE_SID=$(printf '%s' "$CREATE_OUT" | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
CREATE_STOP=$(printf '%s' "$CREATE_OUT" | sed -n 's/.*"stopReason": "\([^"]*\)".*/\1/p' | head -1)
CONTENT=$(docker exec "$CONTAINER" cat /work/ws/rc002-created.txt)
say "create: session=$CREATE_SID stopReason=$CREATE_STOP content='$CONTENT'"
[ "$CREATE_STOP" = "end_turn" ] || { say "FAIL create did not end_turn"; exit 1; }
[ "$CONTENT" = "hello-rc002" ] || { say "FAIL create content"; exit 1; }

# --- 4. interruption: cancelled, never completed ---------------------------
docker exec "$CONTAINER" bash -lc 'rm -rf /work/ws2 && mkdir -p /work/ws2'
INTR_OUT=$(docker exec "$CONTAINER" bash -lc 'cd /work && python3 /work/scripts/rc002/acp_client.py \
  --bin /work/distill-linux-aarch64 --cwd /work/ws2 --timeout 150 --interrupt-after 20 \
  --transcript /work/out/interrupt.jsonl \
  --prompt "Create files one at a time in the current directory: for i in 01 02 03 04 05, create rc002-step-\$i.txt containing the line step-\$i, and after creating each file run the shell command sleep 4 before moving on. Then stop."')
INTR_SID=$(printf '%s' "$INTR_OUT" | sed -n 's/.*"sessionId": "\([^"]*\)".*/\1/p' | head -1)
INTR_STOP=$(printf '%s' "$INTR_OUT" | sed -n 's/.*"stopReason": "\([^"]*\)".*/\1/p' | head -1)
FILES=$(docker exec "$CONTAINER" bash -lc 'ls /work/ws2 | tr "\n" " "')
say "interrupt: session=$INTR_SID stopReason=$INTR_STOP partialFiles='$FILES'"
[ "$INTR_STOP" = "cancelled" ] || { say "FAIL interrupt not cancelled"; exit 1; }

# --- 5. restart the host and Distill process; reconcile --------------------
docker rm -f "$CONTAINER" >/dev/null
docker run -d --name "$CONTAINER" --platform linux/arm64 \
  -v "$WORK:/work" -v "$VOLUME:/root/.distill" debian:bookworm-slim sleep infinity >/dev/null
sleep 2
RECON_CONTENT=$(docker exec "$CONTAINER" cat /work/ws/rc002-created.txt)
RECON_TURN=$(docker exec "$CONTAINER" bash -lc "grep -o '\"outcome\":\"cancelled\"' \
  '/root/.distill/sessions/%2Fwork%2Fws2/$INTR_SID/events.jsonl' | head -1")
USAGE=$(docker exec "$CONTAINER" /work/distill-linux-aarch64 usage "$CREATE_SID")
say "restart: file='$RECON_CONTENT' interruptedTurn='$RECON_TURN'"
say "restart usage receipt: $(printf '%s' "$USAGE" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["session"]["totalTokens"],d["session"]["primaryModelId"])')"
[ "$RECON_CONTENT" = "hello-rc002" ] || { say "FAIL file lost after restart"; exit 1; }
[ -n "$RECON_TURN" ] || { say "FAIL interrupted run not persisted as cancelled"; exit 1; }

say ""
say "PASS rc002: create=file+end_turn interrupt=cancelled restart=file+receipt intact"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true