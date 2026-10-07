# Where to resume

Latest confirmed state: the RC-026 checkpoint `2404f88` on
`checkpoint/rc002-linux-runtime-evidence`, with the handoff commits on top. Plan status: **51 complete / 1 in progress / 0 blocked / 16 to do**
of the 68 tasks in `plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

Accepted since the previous resume page: RC-025 (the mobile client takes over and
returns the screen on a real simulator). RC-026 is **in progress**: its shared
offline state machine landed and both clients use it, but its three-point
network-cut proof has not been run.

## Ready right now

| Task | Why it is ready |
| --- | --- |
| **RC-044** | RC-025 landed and RC-043 landed, so the shared journey can be finished across both clients. |
Everything else is behind this chain: RC-047 needs RC-026 and RC-046, RC-046 needs RC-044, and
RC-048 onward need RC-045 and RC-046. RC-026 and RC-044 are the two ready tasks.

## In progress and blocked

**RC-026** (reconnect after drops and lost responses). Done: `packages/client/src/offline.ts`
exposes `runMutation({send, deadlineMs, receipt, onLateResult})`, which always resolves to
exactly one of `committed`, `not_committed` or `unknown`, never sends twice, and confirms a
late response through the receipt; the mobile session panel and the web terminal panel both
use it, and its unit tests cover the three outcomes and the single send.

**The exact remaining gap:** the Executable proof cuts the network before sending, during the
request and after the commit, then reconnects and compares the UI, the receipt and the file
with the backend. The harnesses in this repo inject response loss only through the
test-support file API (`apps/api/test-support/native-file-api.ts`) and Playwright route
interception; the session routes have neither, so a loss injection for those routes has to
exist before that proof can run. Nothing else about RC-026 is blocked.

## The pattern that produced every recent defect

Run the task's own proof on real infrastructure before believing the
implementation. Nine real product defects in this stretch were found only that
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
7. the unprivileged agent could read the service database (found by the RC-063 isolation proof);
8. a released screen possession was reported as `expired` instead of `none`;
9. the mobile client never renewed its possession, so it lost the screen (both found by the RC-025 proof).

Also expect a worker to report a failure as "pre-existing" or "unrelated" when
its own change caused it — check the diff before believing that.

## Running the mobile proof

`apps/mobile/ios/` is **gitignored** (it is generated), so it never appears in a
diff and the native proof depends on the machine's generated project:

1. If the Pods were built for an older Xcode, the build fails with
   `The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 13.4`.
   Raise every pod target to the app's own minimum (15.1) in
   `apps/mobile/ios/Podfile`'s `post_install` and re-run `pod install`.
2. Then run, with a fresh absolute directory:
   `RC_NATIVE_TEST_WORK_DIR=<fresh> RC_NATIVE_TEST_FILES=1 RC_NATIVE_TEST_SESSION=1 RC_NATIVE_TEST_REUSE_IOS_PROJECT=1 bash scripts/run-mobile-native-test.sh`
   It boots its own simulator, starts the API in a container over TLS, runs only
   `testInstalledAppTakesOverAndReturnsTheScreenAndRefusesBotInput`, and then
   verifies the Linux database itself. Success ends with
   `Mobile client took and returned the screen; the Linux database shows the released possession`.

## Conventions this repository enforces

- Conventional Commit subjects; one pushed commit per accepted checkpoint.
- Update `plan/tasks.html` status, `CHANGELOG.md`, `plan/checkpoint-evidence.md`
  and (when the route changed) `PIVOT.md` in the same commit as the acceptance.
- `bun test apps/api apps/gateway packages/client`, `bun run typecheck` and
  `python3 scripts/check-doc-links.py` before every push.
- Proof scripts live in `scripts/rc<NNN>/` and need an absolute
  `RC<NNN>_PROOF_DIR` that does not already exist.
