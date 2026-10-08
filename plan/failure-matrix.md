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

1. **~~No single matrix run.~~ Closed 2026-10-08.** `scripts/rc065/run-failure-matrix.sh`
   now runs every row below in turn and keeps one transcript per case in one
   proof directory; the executed run is recorded at the end of this file.
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

## Executed matrix — 2026-10-08 (UTC)

`bash scripts/rc065/run-failure-matrix.sh <fresh dir>` runs each case below in turn and keeps one transcript per case (`meta/<case>/transcript.log`, `exit`, `command`) plus `matrix.json`.

Observed on this machine: **18 of 18 cases exited 0**, each with its own transcript and each creating its own output directory — network before acceptance and after a lost response, Distill provider 401/429, the stalled-run watchdog, run reconciliation after a host restart, the Docker host supervisor, linux-use command failure and isolation, the linux-use first session and revoked target, the visual channel crossed cookie, input after revocation and supersession, the GUI restart, the event gap, the ownership audit, routines, push, webhooks, restore and the version refusal. `matrix.json` records `{"result": "passed", "casesRun": 18, "casesPassed": 18, "casesFailed": 0}`.

Two cases failed on earlier runs and are now fixed at their cause, neither in product code: `scripts/rc015/run-isolation-proof.sh` handed the agent a model the container cannot resolve, and `scripts/rc061/run-billing-proof.ts` aborted its "lost response" request before it left the process, so the event was sometimes never delivered instead of merely unanswered.

Still outside this matrix, and why RC-065 is not accepted: no injected-failure run in a hosted account, no sanitized-log and UI-after-restart comparison, no swapped-window stream (only the crossed-cookie refusal), and no Android storage-failure modes.

### linux-use-command-failure-and-isolation — resolved 2026-10-08 (UTC)

`linux-use-command-failure-and-isolation` splits in two, and only the second half ever failed:

- **Isolation holds**: the agent process runs as `rcagent` and the proof shows it cannot read the database, the gateway token or the backend environment, while the backend can.
- **The authorized task did not finish.** Three findings, each measured:
  1. The image the proof builds carries Distill **2.0.33** while this host's credential is for **2.0.35**; the proof now takes `RC015_DISTILL_VERSION`/`RC015_DISTILL_SHA256_AARCH64` so the two can match (2.0.35 Linux aarch64 sha256 `c32fbea7962a54aa4f278fe30a28571149f65154675cd6670d5be2153d1f83ad`).
  2. The proof copied only `auth.json`; without the host's `config.toml` the agent never finished its turn at all (`run state=running` past the window). It now copies the config too, which the failure branch prints before exiting.
  3. With both in place the run ended in a definite, reported state: `state=failed`, `stopReason=provider_failed`, `error="Internal error"`. The cause was the model name itself: this host's `config.toml` selects `claude/claude-opus-5-5`, which is **not in the catalog this credential exposes inside the container** (`grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`), so `distill -m claude/claude-opus-5-5` answers `unknown model id`; and `default_reasoning_effort = "max"` is refused by those models (`invalid-argument: Invalid reasoning effort`).
- **Fix:** the proof asks the container's own catalog endpoint for a model id and rewrites only the copied config's `[models]` `default`, `worker` and `default_reasoning_effort` lines. `RC015_MODEL` and `RC015_REASONING_EFFORT` override both.
- **Result:** run twice, `run state=completed`; the identity file the container's agent wrote reads `1001` (the `rcagent` uid) and is owned by `1001`; the gateway token never appears in the agent's output. The proof still prints the run's own record on failure and `RC015_RUN_WINDOW` keeps its wait explicit.

### webhook-unsigned-forged-duplicate-out-of-order — resolved 2026-10-08 (UTC)

`scripts/rc061/run-billing-proof.ts` injects a lost response by aborting the webhook request immediately after starting it. Aborting that early could cancel the send itself, so the event was sometimes never delivered and the receipt check failed (`receipt_missing_...`, `found:false`) — a different failure from losing the answer to it. It now sends the request normally, reads nothing back, and polls the receipt for up to 10 s, which is what a caller with no response actually does. Three consecutive runs pass, and the case passes inside the 18-case matrix.
