# Where to resume

Latest confirmed state: the RC-050 partial checkpoint `00beb87` on
`checkpoint/rc002-linux-runtime-evidence`, with the handoff commits on top. Plan status: **57 complete / 1 in progress / 0 blocked / 10 to do**
of the 68 tasks in `plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

Accepted since the previous resume page: RC-048 (one shared client core covering
every named domain, with the shared contract proven by breaking it) and RC-049 (the web
sidebar and responsive keyboard navigation, proven in a real browser).

## Ready right now

| Task | Why it is ready |
| --- | --- |
| **RC-051** | Every dependency landed, including RC-049. |
| **RC-055** | The iOS app: RC-025, RC-047 and RC-048 all landed. |
| **RC-056** | The Android app, with the same dependencies. |

RC-052 needs RC-050 and RC-051, and RC-057 needs RC-055 and RC-056.

## In progress and blocked

Nothing. Every task is either Complete or still To do with an unmet dependency. The 10 tasks
left are behind RC-051, RC-055 and RC-056, and behind finishing RC-050.

### Finish RC-050 on a Linux host

Its proof needs a Linux host, because the workspace folder, the file editor and the
terminal answer 501 elsewhere. `apps/web/e2e/workspace-work.spec.ts` skips with that
reason on any other platform. Run it against a Linux-hosted API and web origin, which
`playwright.config.ts` already supports through `RC003_WEB_URL` and `RC003_API_URL`:

```bash
RC003_API_URL=https://127.0.0.1:37117 RC003_AUTH_PASSWORD=<password> \
  RC003_WEB_URL=http://127.0.0.1:37118 bun run test:e2e -- apps/web/e2e/workspace-work.spec.ts
```

The API has to answer over TLS for the browser, which is how the repository's other
container proofs run it (`scripts/run-file-editor-linux-browser-proof.ts`).

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
