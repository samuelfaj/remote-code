# Where to resume

Pushed checkpoint: `b7dd9b6` on `checkpoint/rc002-linux-runtime-evidence`
(matches `origin`). Plan status: **49 complete / 0 in progress / 0 blocked / 19 to do**
of the 68 tasks in `plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

Accepted since the previous resume page: RC-024 (web takeover), RC-062 (image
update), RC-064 (measured capacity), RC-042 (per-Bot preview), RC-043 (two-client
possession), RC-029 (workspace file editing) and RC-063 (proved isolation).

## Ready right now

| Task | Why it is ready |
| --- | --- |
| **RC-036** | RC-029 landed, so a message can carry an attachment and a run result can show changed files with a diff. No thread/message surface exists yet (`grep` finds none), so this task also has to introduce the smallest one. |
| **RC-025** | RC-024 landed, so the mobile client can take over and return the session over the existing Eden core. The failure-if forbids a parallel API implementation, so it must reuse `packages/client`. |

Everything else is gated behind one of those two: RC-026 and RC-044 need RC-025,
and RC-046 onward need that chain.

## In progress and blocked

Nothing. Every task is either Complete or still To do with an unmet dependency.

## The pattern that produced every recent defect

Run the task's own proof on real infrastructure before believing the
implementation. Seven real product defects in this stretch were found only that
way, and every one of them had passed the worker's unit tests first:

1. the update data copy was killed before it finished (`docker start` returns
   before the container exits);
2. preserved `docker create` flags were appended after the image, so Docker read
   them as the container's command;
3. the update rollback could not reuse the account name, leaving the account on
   the version that could not serve;
4. a crashed swap left the account advertised as `ready`;
5. `docker stop` raced its own spawn timeout in hosted suspend;
6. the preview/observation tokens were not scoped to the workspace;
7. the unprivileged agent could read the service database (found by the RC-063 isolation proof).

Also expect a worker to report a failure as "pre-existing" or "unrelated" when
its own change caused it — check the diff before believing that.

## Conventions this repository enforces

- Conventional Commit subjects; one pushed commit per accepted checkpoint.
- Update `plan/tasks.html` status, `CHANGELOG.md`, `plan/checkpoint-evidence.md`
  and (when the route changed) `PIVOT.md` in the same commit as the acceptance.
- `bun test apps/api apps/gateway packages/client`, `bun run typecheck` and
  `python3 scripts/check-doc-links.py` before every push.
- Proof scripts live in `scripts/rc<NNN>/` and need an absolute
  `RC<NNN>_PROOF_DIR` that does not already exist.
