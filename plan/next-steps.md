# Where to resume

Pushed checkpoint: `54de031` on `checkpoint/rc002-linux-runtime-evidence`
(matches `origin`). Plan status: **46 complete / 1 in progress / 0 blocked / 21 to do**
of the 68 tasks in `plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

## Ready right now

| Task | Why it is ready |
| --- | --- |
| **RC-043** | Exclusive possession already exists (RC-024) and the preview landed (RC-042). Extend possession to two clients, disconnection and resumption, then prove a Bot click is refused while the human holds the screen. |
| **RC-025** | Web takeover landed (RC-024). Build the minimal mobile client on the existing Eden core; the failure-if forbids a parallel API implementation. |

Everything else is gated behind one of those two: RC-026 needs RC-025, RC-044
and RC-046 need RC-043's chain, and RC-036 needs RC-029.

## In progress

**RC-029** (edit workspace files) — the file APIs and the container-restart proof
for the last clauses have not been completed. Its remaining work is not blocked;
the clauses that depend on the mobile tasks (RC-055/RC-056) are the ones to defer.

## The pattern that produced every recent defect

Run the task's own proof on real infrastructure before believing the
implementation. Six real product defects in this stretch were found only that
way, and every one of them had passed the worker's unit tests first:

1. the update data copy was killed before it finished (`docker start` returns
   before the container exits);
2. preserved `docker create` flags were appended after the image, so Docker read
   them as the container's command;
3. the update rollback could not reuse the account name, leaving the account on
   the version that could not serve;
4. a crashed swap left the account advertised as `ready`;
5. `docker stop` raced its own spawn timeout in hosted suspend;
6. the preview/observation tokens were not scoped to the workspace.

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
