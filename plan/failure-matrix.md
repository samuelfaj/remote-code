# RC-065 failure matrix — inventory and per-case evidence

RC-065 asks for an **executable matrix of failures** across network, Docker,
Distill, linux-use, the visual channel, the provider, the GUI, disk, the
database, events, leases, routines, push, webhook, restore and version, where
**every case ends in confirmed success, no effect, or a reconcilable unknown**,
and for the proof to inject before/during/after an effect in both a self-managed
and a hosted account, including a swapped window, a delayed frame, input after
revocation, an expired credential, a 429, daylight-saving time and a lost
response, comparing receipts, files, sanitized logs and the UI after a restart.

This file is the inventory the task needs to be closed honestly: for each case
it names the executable surface that already exists in the repository, and the
part that is still missing. **RC-065 stays open** until every row below has a
recorded run with its observed outcome.

## How to read a row

- **Case** — the failure the task names.
- **Executable surface** — the script or test that injects it today.
- **Runnable here?** — whether this machine can run it (Docker + macOS arm64), or
  what it needs.
- **Observed outcome** — what that surface asserts: a confirmed success, a
  *no effect*, or a *reconcilable unknown*.

## Matrix

| Case | Executable surface | Runnable here? | Observed outcome |
| --- | --- | --- | --- |
| Network cut before acceptance | `scripts/rc018/run-connection-cut-proof.ts`, `packages/client/src/index.test.ts` (timeout before headers, cancellation, aborted request) | yes | typed unknown-outcome error; no retry, no invented success |
| Network cut after commit, response lost | `scripts/rc017/run-command-failure-proof.ts` (twice), `apps/api/src/app.test.ts` | yes | one durable effect; same-id repeat returns it; nothing is relaunched |
| Docker: host unavailable / restart | `scripts/rc019/run-supervisor-proof.sh` (host supervisor), `scripts/rc009/run-runs-proof.sh` (run reconciliation after restart) | yes (needs Docker) | run reconciled to `interrupted`/`host_restart`, never replayed |
| Distill: process failure, stall, provider refusal | `scripts/rc017/run-command-failure-proof.ts`, `scripts/rc027/run-stuck-run-proof.sh`, `scripts/rc034/run-provider-failure-proof.ts` | yes | classified refusal (`provider_auth_expired`, `provider_rate_limited` with `retryAfterSeconds`, `provider_unavailable`), watchdog ends a silent run |
| Distill: expired credential (401) and 429 | `scripts/rc034/run-provider-failure-proof.ts` | yes | classified, not retried; the caller reconciles instead |
| linux-use: command failure and session isolation | `scripts/rc017/run-command-failure-proof.ts`, `scripts/rc023/run-first-session-proof.sh`, `scripts/rc063/run-isolation-proof.ts` | yes (needs Docker + Xvfb) | refusal with no effect on another workspace |
| Visual channel: swapped window / delayed frame | `scripts/rc042/run-preview-proof.ts` (per-Bot display binding, crossed cookie 409), `scripts/rc043/run-possession-proof.ts` | yes (needs Docker + X11) | a crossed cookie cannot read another Bot's screen; superseded holder gets 409 |
| Input after revocation | `scripts/rc043/run-possession-proof.ts` (superseded/lost), `scripts/rc057/run-mobile-takeover-proof.sh` (409 `possession_held_by_user` for the agent) | yes | input refused with the host's own error; nothing applied |
| GUI: window absent / restart | `scripts/rc053/run-linux-gui-proof.sh` | yes (needs Docker + X11) | window, API and CDP come back after a container restart |
| Disk: storage failure before/after a durable effect | `apps/mobile/native-tests/RemoteCodeMobileProofUITests.swift` storage-failure modes (`RC_NATIVE_TEST_STORAGE_FAILURE`), `apps/mobile/src/features/files/file-rules.test.ts` | iOS simulator | fails closed; nothing is removed after context revocation |
| Database: locked, busy, corrupted | `apps/api/src/app.test.ts` (locked/unavailable SQLite), `apps/api/src/features/backup.test.ts` | yes | refusal, no partial write |
| Events: gap, malformed frame, reconnect | `scripts/rc014/run-events-recovery-proof.ts`, `apps/web/e2e/actions.spec.ts` (malformed frames, cursor gap) | yes | private state cleared, snapshot re-read, nothing replayed |
| Leases: ownership and supersession | `scripts/rc012/run-ownership-audit-proof.ts`, `scripts/rc043/run-possession-proof.ts` | yes | exactly one holder; the displaced client is told |
| Routines: pause, missed tick, daylight-saving time | `scripts/rc045/run-schedule-proof.ts` (paused schedule plans nothing, occurrence durable, restart → `unknown`/`requires_verification`) | yes | durable occurrence key; no replay |
| Push: provider refused, device gone, duplicate | `scripts/rc047/run-push-proof.ts` (denied device, dedupe per item/device), `scripts/rc055/run-push-routing-proof.ts` | yes (Linux) | durable Inbox item survives a refused push; exactly one alert per device |
| Webhook: unsigned, forged, duplicate, out of order | `scripts/rc061/run-billing-proof.ts` (three runs) | yes | 401/422 write nothing; `duplicate` and `out_of_order` leave the row untouched |
| Restore: backup and restore | `scripts/rc058/run-backup-restore-proof.ts`, `apps/api/src/features/backup.test.ts` | yes | restored state read back from the authority |
| Version: client/server mismatch | `scripts/rc059/run-install-proof.ts`, `scripts/rc062/run-update-proof.ts`, `apps/web/e2e/workspaces.spec.ts` (older capability blocks create before any POST) | yes | refusal before any write |

## Named gaps (what keeps RC-065 open)

1. **No single matrix run.** The rows above are separate proofs with their own
   transcripts; the task asks for one matrix whose every case records
   *confirmed success*, *no effect* or *reconcilable unknown*. Assembling that
   run (and keeping its transcripts in one proof directory) is the next step.
2. **Hosted account leg.** The task asks for the injection in a self-managed
   **and a hosted** account. Self-managed is what the rows above run; the hosted
   leg exists only as the billing/provider proof (`scripts/rc061`) and the
   hosted provisioning proof (`scripts/rc060`), not as an injected-failure run.
3. **Sanitized logs and UI-after-restart comparison.** Several proofs compare
   receipts and files; a matrix that also diffs sanitized logs and the UI after a
   restart is not assembled.
4. **Swapped window** is proven as a *crossed cookie* refusal
   (`scripts/rc042`); a run that swaps the visible window mid-stream and asserts
   the frame identity is not written.
5. **Android storage-failure modes** exist for iOS only.

## Why this file exists

Another agent can take this inventory, run the rows that this machine supports,
and fill in the gaps above without rediscovering which proof covers which case.
