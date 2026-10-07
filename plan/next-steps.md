# Where to resume

Latest confirmed state: commits `66c91f4` (RC-051 accepted) and `e3cd81f`
(mobile navigation and push routing, RC-055 in progress) on
`checkpoint/rc002-linux-runtime-evidence`, pushed. Plan status:
**59 complete / 1 in progress / 0 blocked / 8 to do** of the 68 tasks in
`plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

Accepted since the previous resume page: **RC-051**, whose proof
(`bash scripts/rc051/run-linux-web-proof.sh <fresh dir>`, twice, `1 passed`) runs
the agent/Bots/schedules/Inbox panel against a containerised Linux API with the
repository's own runs stub as the agent: a task is sent, the permission the stub
really raises is denied through the panel, the host is asked again and no longer
lists it, the run settles with no Stop offered, the scheduled task and Bot
routine match `GET /api/schedules`, every open Inbox item matches `GET /api/inbox`,
and a second workspace shows none of the first one's work.

Last accepted before that: **RC-050** (workspace work view on Linux, including the
file editor, Git/diff, terminal and layout restore).

## Ready right now

| Task | Why it is ready |
| --- | --- |
| **RC-052** | RC-050 and RC-051 both accepted; the computer panel is the remaining piece. |
| **RC-055** | In progress: navigation, screens and push routing landed; the on-device proof and APNs are open. |
| **RC-056** | The Android app; RC-025, RC-047 and RC-048 landed. |
| **RC-053**, **RC-054** | Linux GUI window and the macOS/Windows browser clients. |
| **RC-065**, **RC-066**, **RC-067** | Failure injection, multiplatform acceptance, publishing. |

RC-057 (mobile takeover) depends on RC-055 and RC-056.

## Things that will cost time if forgotten

- **The Linux host image must carry the routes a proof drives.** The cached
  `remotecode/host:local` image predated the Inbox/push/messages/screen routes,
  so `GET /api/inbox` answered 404 inside the container while it answered 401 on
  this Mac. `scripts/rc051/run-linux-web-proof.sh` now probes that route and
  refuses to run otherwise; rebuild with `RC051_REBUILD=1` (or
  `RC050_REBUILD=1`). Rebuild the image whenever `apps/api` changes.
- **Do not open a second `/api/events` socket from a panel.** Four reconnect
  tests in `apps/web/e2e/actions.spec.ts` close "the" socket; a second one made
  the app look connected after a disconnect. Panels refresh on the cursor the
  app already holds (`eventCursor`).
- **The host's schedule kind for a workspace task is `task`**, not `workspace`;
  `POST /api/schedules` answers 400 `invalid_kind` otherwise. Bot routines are
  kind `routine` and need a `botId`.
- **The host's permission view carries no `runId`.** Store a run's requests
  under that run; do not try to infer the run from the payload.
- **The terminal contract only accepts a terminal image given as an image id**
  (`sha256:…`) whose `Config.Env` is exactly the canned set, which is why
  `prototype/terminal.Dockerfile` exists — the host image is refused with
  `terminal_image_not_public`.
- **A worker will call its own breakage "pre-existing".** Measure against HEAD
  before believing it: the RC-051 panel took `bun run test:e2e` from 111 passing
  to 107, and the failures were caused by the new code.

## House rules kept by every checkpoint

- One pushed commit per accepted task, with `plan/tasks.html`, `CHANGELOG.md`,
  `plan/checkpoint-evidence.md` and (when the route changed) `PIVOT.md` in the
  same commit as the acceptance.
- `bun run test:e2e`, `bun test apps/api apps/gateway packages/client`,
  `bun test apps/mobile`, `bun run typecheck` and
  `python3 scripts/check-doc-links.py` before every push.
- Proof scripts live in `scripts/rc<NNN>/` and need an absolute output directory
  that does not already exist.