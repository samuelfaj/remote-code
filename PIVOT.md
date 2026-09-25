# Pivot policy

## Purpose

Keep safe, evidence-backed work moving when a task encounters a blocker. A pivot changes the route or sequence of work; it does not turn missing evidence into success or silently change a task's acceptance criteria.

## Response to a blocker

1. **Bound the blocked action.** Record the affected task, the exact missing prerequisite, what effect is uncertain, and which acceptance criteria are still unmet.
2. **Check authorized alternatives once.** Look for another already-authorized source, environment, or proof route that can answer the same question. Do not repeat a search that has already returned no usable evidence. While an external effect is unknown, do not authenticate, create accounts, provision paid resources, or retry the action. For other operations, cross those authority boundaries only when explicitly authorized.
3. **Choose the safest useful pivot.** Prefer, in order:
   - an equivalent proof route that preserves the task's full acceptance criteria;
   - an independent backlog task whose `Start` and dependencies are already satisfied;
   - bounded preparation that does not execute the blocked action, change production behavior, weaken acceptance criteria, or claim task completion.
4. **If no safe work is available, state the exact wait condition.** Do not invent parallel work, bypass dependencies, or repeatedly search the same source. Keep unrelated completed work intact and make the next action explicit.
5. **Keep the handoff current.** Record the decision in this file and update the task evidence and `CHANGELOG.md` when the blocker or chosen route changes. Review and publish only scoped, verified changes.

## Invariants

- A timeout or lost response leaves the effect unknown until authoritative state resolves it.
- Do not repeat an uncertain mutation merely to obtain a receipt.
- A Mac-only test cannot satisfy an acceptance criterion that requires real Linux execution.
- A new host, mock, local model, or alternative provider is not equivalent unless it exercises the same required product path and is allowed by the task contract.
- A pivot may defer or mark work unverified; only evidence can mark a task accepted. Scope reductions must be explicit and must not be represented as acceptance of the original contract.
- Do not cross account, credential, paid-resource, destructive, or deployment boundaries without the required authorization.

## Initial pivot record — RC-002 reconciliation (superseded for RC-004 sequencing) — 2026-09-25

- **Blocked task:** RC-002, “Prove main Distill on Linux.”
- **Missing prerequisite:** The timed-out ACP `session/prompt` has no retained Distill session identifier or authoritative session/usage record that can be correlated to it. The recovered request ID `4` is local to the ACP client.
- **Effect:** Unknown. The provider may or may not have processed the prompt; do not infer its outcome or billing from the timeout.
- **Routes checked:** Read-only local Distill history and usage capability, saved harness/terminal output, and the already-authorized browser profile. Local history identifies only the current Grok harness session; the Console route leads to team onboarding rather than a usage record. No credentials were read, no login/team creation occurred, and the prompt was not repeated. Detailed observations are in [`plan/checkpoint-evidence.md`](plan/checkpoint-evidence.md#rc-002--main-distill-on-linux).
- **Decision at the initial assessment:** Stop repeating those searches and keep RC-002 unaccepted. Under the original graph, RC-004 was also gated. The later record below revises RC-004 for non-executing contract work only. Do not run another lifecycle test while the old provider effect remains unknown. A Mac cannot satisfy RC-002's Linux proof.
- **Resume condition for RC-002:** Obtain an authoritative, sanitized record from an already-authorized source with identifiers and timing sufficient to correlate the prior attempt. Then compare it with every RC-002 acceptance and failure condition before resuming. If no such record exists, keep RC-002 explicitly unverified; do not claim acceptance or retry the operation.

## Pivot record — separate contracts from live Distill proof — 2026-09-25

- **Blocked path:** RC-002's timed-out ACP prompt still has no correlated provider record. It remains unaccepted, and the prompt will not be repeated while its external effect is unknown.
- **Safe resequencing:** RC-004 is a design-only ownership/state contract. Its start now requires the accepted RC-001 inventory and documented product flows, while explicitly modeling every unproven Distill result as `unknown`. This lets contract and backend-foundation work proceed without claiming the old prompt was reconciled or executing another provider action.
- **Unchanged gates:** RC-002 remains required before building or supervising real Distill runs, and remains unaccepted until the file-creation, interruption, restart, and reconciliation proof is obtained. Tasks that execute Distill retain that dependency. RC-015 now names RC-002 directly because its isolation proof requires the real Distill process.
- **Progress:** RC-004 is accepted as design only, RC-005 is complete for the monorepo/typecheck contract, and RC-006 is accepted for the API lifecycle and SQLite readiness contract. RC-002's receipt requirement remains unchanged; no task that runs or supervises real Distill can start until RC-002 is accepted, and the old prompt must not be restarted.
- **Next action:** Proceed to RC-008, “Persist data outside the image,” which depends on RC-006 and can move forward without Distill. RC-007 and other tasks that execute or supervise real Distill remain gated on RC-002.

## Pivot record — RC-006 health check and RC-008 continuation — 2026-09-25

- **Reason for sequencing:** RC-006 needs to establish API process health and the current essential storage dependency, not execute or supervise Distill. The currently available dependency is SQLite; Distill is not part of API readiness at this foundation stage.
- **Verified scope:** Linux container execution proved start, stop, restart, SQLite exclusive-lock failure, bounded 503 readiness, independent 200 liveness, and recovery after unlocking. RC-006 is marked complete against those criteria.
- **Explicit limitation:** The database file currently defaults to `/tmp/remotecode.sqlite`; this gives the API a real dependency to check but is not durable storage. Data-volume persistence and restoration remain RC-008 and are not inferred from the health check.
- **Unchanged gate:** RC-002 remains unknown and unaccepted. RC-007 still depends on RC-002, and this pivot does not authorize another external prompt, authentication, or substitute Distill proof.

## Pivot record — RC-008 storage foundation — 2026-09-25

- **Eligible scope:** RC-008 depends on accepted RC-006 and does not require Distill. Current API state consists only of action receipts; workspaces, run history, and persistent profiles do not exist yet.
- **Safe implementation slice:** Persist the existing action receipts in the same configurable SQLite database used for readiness. Insert into SQLite before returning HTTP 201 or broadcasting the event. Configure the Linux image to use `/var/lib/remotecode/remotecode.sqlite` and expose that directory as a volume; Compose supplies the named volume.
- **Acceptance boundary:** This is progress, not RC-008 acceptance. The full task still requires workspace/history/profile storage and container destroy/recreate proof with the same volume. The task remains in progress until all of its delivery, failure, and executable proof criteria pass.
- **Unchanged gate:** RC-002 remains unverified and no uncertain Distill request is repeated. RC-007 and live Distill work stay gated on RC-002.
- **Observed proof:** Built `remotecode-rc008:local` as Linux amd64 emulation and ran it with named volume `rc008-proof-data-20260925`. A receipt survived container removal and recreation with the same volume; the rebuilt image also restored the same ID/content. Under a SQLite exclusive lock, readiness returned 503 in 0.423 seconds while liveness returned 200, and readiness recovered after unlock. A locked action write returned 500 and was absent from action history. See `plan/checkpoint-evidence.md` for IDs and commands/results.
- **Next work:** Implement and verify workspace, run-history, and persistent-profile storage on the named volume. RC-008 remains in progress until its full data scope and failure criteria pass.
