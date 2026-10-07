# Where to resume

Latest confirmed state: the RC-050 checkpoint `756a025` on
`checkpoint/rc002-linux-runtime-evidence`, pushed. Plan status:
**58 complete / 0 in progress / 0 blocked / 10 to do** of the 68 tasks in
`plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

Accepted since the previous resume page: RC-050, whose proof
(`bash scripts/rc050/run-linux-web-proof.sh <fresh dir>`) runs the workspace work
view against a containerised Linux API: repository, Git status and diff, a saved
file-editor edit checked against the host content, and the workspace's layout
restored after a reload.

## Ready right now

| Task | Why it is ready |
| --- | --- |
| **RC-051** | Every dependency landed, including RC-049 and now RC-050. |
| **RC-055** | The iOS app: RC-025, RC-047 and RC-048 all landed. |
| **RC-056** | The Android app, with the same dependencies. |

RC-052 needs RC-050 and RC-051; RC-053 and RC-054 need RC-050, RC-051 and
RC-052; RC-057 needs RC-055 and RC-056; RC-065, RC-066 and RC-067 are the
release and acceptance tasks behind everything else.

## What RC-051 (display agent, Bots and scheduled tasks) still needs

The API and the shared client already cover every named surface. What has **no
UI at all** yet:

1. **Run/agent streaming** — the client exposes `readRun`, `readWorkspaceRuns`
   and `readRunChanges`, and no component renders them.
2. **Permission requests** — `GET /api/runs/:id/permissions` and
   `POST /api/runs/:id/permissions/:requestId` exist with no UI.
3. **Participant/roster list** — no UI and no API route.
4. **Workspace scheduled tasks** — client has `listSchedules`/`createSchedule`/
   `setScheduleEnabled`; nothing renders them.
5. **Bot routines** — same schedules API, no UI.
6. **"Needs you"** — the Inbox routes exist (`/api/inbox`, `/api/inbox/:id`,
   `/api/inbox/:id/read`, `/api/inbox/:id/resolve`) with **no client helpers and
   no UI**; that gap needs a client function too.

Threads and Bots already render in the sidebar (`NavigationShell.tsx`). The
proof must compare every displayed state with the API, so drive it through a
Linux-hosted or local API and read the backend back inside the page.

## What RC-055 and RC-056 still need (mobile)

- No navigation library at all: the app is one screen. Workspaces, the file
  editor and screen possession exist; Bots, threads, Inbox and a main-actions
  destination do not.
- No push infrastructure: no `expo-notifications`, no token registration, no
  tap-to-thread routing, no APNs entitlement, no FCM files, no `eas.json`.
- Android has **nothing**: no `apps/mobile/android/`, no Gradle files, no
  emulator script. The one Android artefact is the package id in `app.json`.
- The only native harness is the XCUITest suite
  (`apps/mobile/native-tests/RemoteCodeMobileProofUITests.swift`, driven by
  `scripts/run-mobile-native-test.sh`), which covers the single-screen app.

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

RC-050 added two more found the same way: the Git view never reloaded after work
happened, and the terminal image the proof pinned had no `git` while the host
image is refused by the terminal contract's environment allowlist.

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