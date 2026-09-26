# State and ownership contract

## Scope and evidence boundary

This document defines RemoteCode's planned ownership and failure-state rules from the product plan. It does not claim that Distill's Linux run lifecycle has been exercised. The timed-out ACP prompt remains an unknown external effect; this contract models that condition as `unknown` and does not use it as proof.

## Authority map

| Resource or action | Authority | Rule |
| --- | --- | --- |
| User identity | Elysia backend | Derive the user from the authenticated server-side session, never from a client-supplied owner ID. |
| Workspace | Elysia backend | A workspace belongs to one authenticated user. Every read and mutation checks that ownership. |
| Bot | Elysia backend | A Bot belongs to the user's workspace and cannot authorize access by itself. |
| Thread | Elysia backend | A thread belongs to its workspace and records its Bot association when applicable. |
| Run | Elysia backend | A run belongs to one thread, workspace, Bot when applicable, and stable operation ID. The backend persists its state and receipt. |
| Agent work | Distill process | Distill performs the requested computation. Its output changes RemoteCode state only after the backend receives and records it. |
| Events | Elysia backend | Publish an event only after its state change is durable. Events carry a cursor; a client gap is repaired from an authoritative snapshot. |
| Human computer control | Elysia backend | A time-bounded possession record names the controlling user and session. Bot computer actions are rejected while human possession is active. Expiration, disconnect, or restart revokes the old possession and requires reconciliation before Bot resumption. |
| Client display | Client | A client renders the latest confirmed backend state. Local optimism cannot mark a run successful. |

## Run states

| State | Meaning | Allowed next step |
| --- | --- | --- |
| `accepted` | The backend durably accepted the operation and created its stable receipt. | Start the associated Distill process or report a confirmed pre-execution failure. |
| `running` | The backend has evidence that the associated process is active. | Persist progress, finish with a confirmed result, enter `needs_human`, or record interruption. |
| `needs_human` | The backend paused the run for a human action. | Resume only after the user returns possession and the backend records a fresh observation. |
| `succeeded` | The backend received and durably recorded a successful result. | Terminal for this operation ID. |
| `failed_no_effect` | Authoritative evidence confirms failure before the requested effect occurred. | Terminal for this operation ID; a new attempt needs a new authorized operation. |
| `interrupted` | The process stopped, but the effect may not be known. | Reconcile from authoritative state; never infer success or automatically rerun. |
| `unknown` | The available evidence cannot determine whether an external effect occurred. | Await a correlated authoritative receipt or an explicit recovery decision. No automatic retry. |

A timeout, client disconnect, or host restart is not itself proof of failure. The backend may move `running` to `interrupted` only when process termination is observed; if the external effect remains unresolved, the result is `unknown`. A client never converts `accepted`, `running`, `interrupted`, or `unknown` into `succeeded` without a durable backend receipt.

## Required transition cases

| Scenario and injected point | Authoritative observation | Single allowed final outcome | Duplicate/recovery rule |
| --- | --- | --- | --- |
| Duplicate submission after the first request has a durable acceptance receipt but before Distill starts, using the same operation ID | Backend finds the existing receipt in `accepted`. | One operation remains `accepted` with one run ID. | Return the existing receipt. Never start a second run for that operation ID. |
| Client disconnects after the backend durably records success but before the response or event arrives | Backend retains the terminal success receipt and event cursor. | `succeeded`, loaded from the backend snapshot after reconnect. | Reconnect reads the receipt and cursor. It does not submit the operation again. |
| Host restarts after accepting a run but before recording a completion result | Recovery finds the accepted receipt but cannot prove completion or absence of effect. | `unknown` pending reconciliation; never `succeeded` or a fresh run. | Consult correlated durable/provider state. Do not replay while the result is unknown. |

These cases intentionally distinguish the *product contract* from the missing RC-002 runtime evidence. RC-002 remains required before any task that executes or supervises a real Distill run.

## Acceptance checks for RC-004

- Every resource and action in the authority map has one authoritative owner.
- The three transition cases above specify an injected point, an authoritative observation, exactly one allowed final outcome, and a retry/recovery rule.
- No client state or absent response is treated as backend-confirmed success.
- Unresolved effects remain `unknown`; neither this design document nor RC-004 acceptance marks the timed-out RC-002 prompt reconciled.

## Deferred runtime proof

The table is a design contract, not executable Linux Distill proof. RC-002's file creation, interruption, process restart, and state/file reconciliation remain unverified. RC-007, RC-009, RC-022, and other tasks that require real Distill execution keep their existing RC-002 dependency.
