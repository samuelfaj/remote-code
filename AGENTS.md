# RemoteCode agent rules

## Source of truth

Read `README.md`, `plan/index.html`, and the relevant task in `plan/tasks.html` before implementation. The plan describes intended behavior, not a working product. For a planned task, use its **Start**, **Delivery / end**, **Executable proof**, **Failure if**, and **Depends on** fields as the acceptance contract. Do not start a dependent task until its prerequisites have accepted evidence. For work outside the backlog, state the same contract briefly before changing code.

## Build the requested behavior

- Inspect the execution path before editing. Fix the smallest cause that explains the problem; preserve unrelated work and follow the codebase's conventions.
- Keep one modular Elysia backend authoritative for data and actions. Group code by product feature in the backend, web, and mobile apps. Share the Eden client and only logic used by more than one client. Keep device-specific screens in their apps.
- Use the main Distill project as a separate agent process. RemoteCode owns webhooks, schedules, durable run state, Inbox, push, and client events. Do not create a RemoteCode fork or another agent harness to bypass an integration problem.
- Clients display confirmed backend state. A local typecheck does not prove an installed client is compatible with a different server version. A container, process, screen, or Bot session is not by itself a security boundary.
- Do not add abstractions, fallback paths, infrastructure, or unrelated tests without a current requirement. Keep changes and verification proportional to the task.

## Test the changed behavior

For product code, add or update and run **unit, integration, and end-to-end tests whenever each level is feasible**. Unit tests check the relevant rules and state transitions. Integration tests exercise real boundaries such as Elysia routes, persistence, the Eden client, and the Distill process when those boundaries are changed. E2E tests follow the affected user journey through the actual web or mobile interface and inspect the resulting backend state. Use existing test infrastructure and keep cases focused on the acceptance contract and a meaningful failure path; a test that merely mirrors implementation does not count.

Do not skip a feasible level just because another level passed. If a level cannot be added or run, state the specific reason, what was checked instead, and what remains unverified. A local E2E pass and a post-deploy E2E pass are separate evidence. Documentation-only edits need consistency and link checks, not invented product tests.

## Try to falsify your result

Before claiming success, ask: **What observable result would show that my implementation is wrong?** Use the task's **Failure if** field first. Reproduce the requested behavior with real inputs and inspect the authoritative result, such as the backend record, file, process state, or external receipt. Then try the most relevant counterexample or failure transition for this change. Examples include a duplicate request, lost response after commit, restart during a run, revoked control, another user's resource ID, or an expired provider credential. Choose the one that can actually disprove the claim; do not run a broad matrix for a small edit.

For a bug, reproduce the failure before the fix when possible, then repeat the same path after the fix. Use relevant existing tests and add focused coverage at each feasible level that would catch the regression. Do not change production behavior merely to make a test easy.

If the counterexample fails, investigate, correct the cause, and run it again. If the required environment, account, device, provider, or tool is unavailable, mark that proof **unverified**. A mock, green CI, HTTP 200, typecheck, log line, or screenshot of a planned UI cannot substitute for the real behavior it is meant to prove. For documentation-only changes, challenge the claims against the current files and check links and consistency; do not invent runtime proof.

## Evidence and status

Keep distinct evidence for implementation, focused tests, real integration, deployed version, and user-visible behavior. Record the command or action, environment and version or commit, expected result, observed result, and any artifact or receipt needed to reproduce the check. Read back persisted state after writes and verify the relevant feature after deployment. A timeout or lost response means the effect is **unknown** until a receipt or durable state resolves it; never blindly retry an uncertain external effect or label it successful.

Call a task **accepted** only when its delivery, executable proof, and relevant **Failure if** conditions have been checked with evidence. Otherwise report exactly what passed, what failed, and what remains unverified. Do not advance a phase gate, release claim, or public announcement from a plan or partial proof. Never expose secrets, passwords, tokens, or private user data in evidence.

## Boundaries

Get explicit confirmation before an irreversible or destructive operation. Do not discard unrelated changes. When an important RemoteCode milestone is verified, read local `TWITTER.md` if present and follow its X posting instructions; it is intentionally ignored by Git. Its absence must not block engineering work.
