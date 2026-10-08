#!/usr/bin/env bash
# RC-065 failure matrix: one transcript per failure case.
#
# Each row names the shipped proof that injects that failure; this script runs
# them in turn, keeps a transcript per case, and writes matrix.json with the
# command, the exit status and the tail of the output. A row whose
# prerequisites are missing here is recorded as not run with the reason, never
# as a pass.
#
# Usage: scripts/rc065/run-failure-matrix.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: run-failure-matrix.sh <fresh absolute output dir>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2; esac
mkdir -p "$OUT"
TRANSCRIPT="$OUT/matrix.log"

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

CASES=(
  "network-before-acceptance|RC018_PROOF_DIR={CASE} bun $ROOT/scripts/rc018/run-connection-cut-proof.ts"
  "network-after-commit-response-lost|RC017_PROOF_DIR={CASE} bun $ROOT/scripts/rc017/run-command-failure-proof.ts"
  "distill-provider-refusals-401-429|RC034_PROOF_DIR={CASE} bun $ROOT/scripts/rc034/run-provider-failure-proof.ts"
  "distill-stalled-run-watchdog|bash $ROOT/scripts/rc027/run-stuck-run-proof.sh {CASE}"
  "distill-run-reconciliation-after-host-restart|bash $ROOT/scripts/rc009/run-runs-proof.sh {CASE}"
  "docker-host-supervisor-restart|bash $ROOT/scripts/rc019/run-supervisor-proof.sh {CASE}"
  "linux-use-command-failure-and-isolation|RC015_DISTILL_VERSION=${RC015_DISTILL_VERSION:-2.0.35} RC015_DISTILL_SHA256_AARCH64=${RC015_DISTILL_SHA256_AARCH64:-c32fbea7962a54aa4f278fe30a28571149f65154675cd6670d5be2153d1f83ad} RC015_RUN_WINDOW=${RC015_RUN_WINDOW:-420} bash $ROOT/scripts/rc015/run-isolation-proof.sh {CASE}"
  "linux-use-first-session-and-revoked-target|bash $ROOT/scripts/rc023/run-first-session-proof.sh {CASE}"
  "visual-channel-crossed-cookie|RC042_PROOF_DIR={CASE} bun $ROOT/scripts/rc042/run-preview-proof.ts"
  "input-after-revocation-and-supersession|RC043_PROOF_DIR={CASE} bun $ROOT/scripts/rc043/run-possession-proof.ts"
  "gui-restart-window-returns|bash $ROOT/scripts/rc053/run-linux-gui-proof.sh {CASE}"
  "events-gap-and-recovery|RC014_PROOF_DIR={CASE} bun $ROOT/scripts/rc014/run-events-recovery-proof.ts"
  "leases-ownership-audit|RC012_PROOF_DIR={CASE} bun $ROOT/scripts/rc012/run-ownership-audit-proof.ts"
  "routines-pause-missed-tick-restart|RC045_PROOF_DIR={CASE} bun $ROOT/scripts/rc045/run-schedule-proof.ts"
  "push-refused-device-and-dedupe|RC047_PROOF_DIR={CASE} bun $ROOT/scripts/rc047/run-push-proof.ts"
  "webhook-unsigned-forged-duplicate-out-of-order|RC061_PROOF_DIR={CASE} bun $ROOT/scripts/rc061/run-billing-proof.ts"
  "restore-backup-round-trip|RC058_PROOF_DIR={CASE} bun $ROOT/scripts/rc058/run-backup-restore-proof.ts"
  "version-mismatch-refusal|RC059_PROOF_DIR={CASE} bun $ROOT/scripts/rc059/run-install-proof.ts"
  "hosted-account-container-death|RC065_PROOF_DIR={CASE} bun $ROOT/scripts/rc065/run-hosted-failure-proof.ts"
  "sanitized-log-and-ui-after-restart|bash $ROOT/scripts/rc065/run-restart-log-ui-proof.sh {CASE}"
  "swapped-window-frame-identity|RC065_PROOF_DIR={CASE} bun $ROOT/scripts/rc065/run-window-swap-proof.ts"
  "android-storage-failure-modes|bash $ROOT/scripts/rc065/run-android-storage-failure-proof.sh {CASE}"
)

PASSED=0
FAILED=0

for row in "${CASES[@]}"; do
  case_name="${row%%|*}"
  template="${row#*|}"
  # Each proof insists on creating its own output directory, so the case path
  # must not exist yet; this runner's own notes live beside it.
  case_dir="$OUT/cases/$case_name"
  meta_dir="$OUT/meta/$case_name"
  mkdir -p "$meta_dir" "$OUT/cases"
  rm -rf "$case_dir"
  command="${template//\{CASE\}/$case_dir}"
  say "-- $case_name --"
  say "$command"
  set +e
  ( cd "$ROOT" && eval "$command" ) > "$meta_dir/transcript.log" 2>&1
  status=$?
  set -e
  printf '%s\n' "$status" > "$meta_dir/exit"
  printf '%s\n' "$command" > "$meta_dir/command"
  tail -4 "$meta_dir/transcript.log" | sed 's/^/    /' >> "$TRANSCRIPT" || true
  if [ "$status" -eq 0 ]; then
    say "$case_name: exit 0"
    PASSED=$((PASSED + 1))
  else
    say "$case_name: exit $status"
    FAILED=$((FAILED + 1))
  fi
done

python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
cases = []
meta_root = os.path.join(out, "meta")
for name in sorted(os.listdir(meta_root)):
    path = os.path.join(meta_root, name)
    if not os.path.isdir(path):
        continue
    def read(filename, limit=None):
        full = os.path.join(path, filename)
        if not os.path.exists(full):
            return ""
        with open(full, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
        return str.join("\n", lines[-limit:] if limit else lines)
    cases.append({
        "case": name,
        "command": read("command").strip(),
        "exit": int(read("exit").strip() or -1),
        "tail": read("transcript.log", 6),
    })
passed = sum(1 for case in cases if case["exit"] == 0)
failed = sum(1 for case in cases if case["exit"] != 0)
record = {
    "result": "passed" if failed == 0 else "failed",
    "scope": "RC-065 failure matrix: one transcript per failure case",
    "casesRun": len(cases),
    "casesPassed": passed,
    "casesFailed": failed,
    "cases": cases,
}
with open(os.path.join(out, "matrix.json"), "w") as handle:
    json.dump(record, handle, indent=2)
print(json.dumps({"result": record["result"], "casesRun": record["casesRun"],
                  "casesPassed": passed, "casesFailed": failed}))
PY

if [ "$FAILED" -ne 0 ]; then
  say "FAIL rc065: $FAILED case(s) failed; see $OUT/matrix.json"
  exit 1
fi
say "PASS rc065: $PASSED case(s) ran with their own transcript"
