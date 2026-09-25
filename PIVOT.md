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

## Pivot record — RC-002, 2026-09-25

- **Blocked task:** RC-002, “Prove main Distill on Linux.”
- **Missing prerequisite:** The timed-out ACP `session/prompt` has no retained Distill session identifier or authoritative session/usage record that can be correlated to it. The recovered request ID `4` is local to the ACP client.
- **Effect:** Unknown. The provider may or may not have processed the prompt; do not infer its outcome or billing from the timeout.
- **Routes checked:** Read-only local Distill history and usage capability, saved harness/terminal output, and the already-authorized browser profile. Local history identifies only the current Grok harness session; the Console route leads to team onboarding rather than a usage record. No credentials were read, no login/team creation occurred, and the prompt was not repeated. Detailed observations are in [`plan/checkpoint-evidence.md`](plan/checkpoint-evidence.md#rc-002--main-distill-on-linux).
- **Decision:** Stop repeating those searches. Keep RC-002 unaccepted and RC-004 gated. Do not run another lifecycle test while the old provider effect remains unknown. A Mac can be used for non-executing preparation but cannot satisfy RC-002's Linux proof.
- **Resume condition:** Obtain an authoritative, sanitized record from an already-authorized source with identifiers and timing sufficient to correlate the prior attempt. Then compare it with every RC-002 acceptance and failure condition before resuming. If no such record exists, keep the task explicitly unverified; do not claim acceptance or retry the operation.
