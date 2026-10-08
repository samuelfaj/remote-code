# Where to resume

Latest confirmed state: the RC-057 acceptance checkpoint `6b3d24d` on
`checkpoint/rc002-linux-runtime-evidence`, pushed. Plan status:
**64 complete / 1 in progress / 0 blocked / 3 to do** of the 68 tasks in
`plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task), `PIVOT.md`
(why a route changed) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

## Accepted since the previous resume page

| Task | Proof | Command |
| --- | --- | --- |
| RC-050 | workspace work view on a Linux host | `bash scripts/rc050/run-linux-web-proof.sh <fresh dir>` |
| RC-051 | runs, permissions, schedules, routines, Inbox | `bash scripts/rc051/run-linux-web-proof.sh <fresh dir>` |
| RC-052 | computer panel takes, releases and recovers | `bun run test:e2e -- apps/web/e2e/computer-panel.spec.ts` |
| RC-055 | the app's own screens plus push routing | `RC_NATIVE_TEST_WORK_DIR=<fresh dir> RC_NATIVE_TEST_NAVIGATION=1 bash scripts/run-mobile-native-test.sh` and `bun scripts/rc055/run-push-routing-proof.ts` |
| RC-056 | the Android app on a real emulator | `bash scripts/rc056/run-android-proof.sh <fresh dir>` |
| RC-053 | the container's own GUI drives the work UI | `bash scripts/rc053/run-linux-gui-proof.sh <fresh dir>` |

All of these passed twice except where the note says otherwise; every proof is
reproducible from the commands above with no Mac-side process doing the work.

## In progress

**RC-054 — macOS leg proven, Windows leg has no target.** `bash
scripts/rc054/run-macos-browsers-proof.sh <fresh dir>` runs the browser journey
on Chromium and WebKit against the repository's Linux host over TLS behind a
local Vite: both engines passed. Windows is **unverified**: this machine has no
Windows host, VM or browser. To close RC-054 someone needs a Windows machine (or
a Windows CI runner with a browser) and the same journey pointed at a Linux host;
`apps/web/e2e/macos-linux-client.spec.ts` is already engine-agnostic and gated on
`RC054_LINUX_HOST=1`.

## To do, in dependency order

**RC-057 — take over the computer from mobile.** Every dependency (RC-025,
RC-044, RC-052, RC-055, RC-056) is accepted, so this is ready. What is missing
today:
1. No shipped client helper posts `POST /api/workspaces/:id/screen/input`
   (`apps/api/src/features/screen.ts` line 339, events `{ kind: "click", x, y }`
   and the key/text kinds it also accepts). Add one to `packages/client` beside
   the possession helpers.
2. `apps/mobile/src/features/session/SessionPanel.tsx` takes over and returns the
   screen but has **no human-input control**, which the contract requires. Add
   one, gated on holding the screen, showing the host's answer only.
3. The device must reach a host whose screen really exists (X11). On this machine
   `adb reverse tcp:<port> tcp:<port>` maps the emulator's loopback to the Mac's,
   and the container publishes its API there over TLS; the device then needs the
   container's CA trusted (emulator with `adb root` into
   `/system/etc/security/cacerts`, or `xcrun simctl keychain <device>
   add-root-cert <pem>` for a simulator) and the app built with
   `EXPO_PUBLIC_API_ORIGIN=https://127.0.0.1:<port>`.
4. Proof shape: take over on iOS and on Android, send a real click/keystroke
   through the app, return control, drop the link mid-way and recover — with the
   Bot refused while the human holds the screen (RC-043/044 semantics, already
   proven on Linux by `scripts/rc044/run-login-proof.ts`).

**RC-065 — failure-injection matrix.** The per-operation failure contract is
already recorded in `plan/failure-state-contract.md`, and most failure cases have
proofs: `scripts/rc026` (lost responses), `scripts/rc027`, `scripts/rc047`,
`scripts/rc058`–`scripts/rc064` and the unit suites. The work left is to assemble
one executable matrix that names, for each of the listed failures (network,
Docker, Distill, linux-use, visual channel, provider, GUI, disk, database,
events, leases, routines, push, webhook, restore, version), the command that
injects it and the observed outcome, and to run the ones that need real Linux in
the container. Do not re-run proofs whose subject has not changed; cite them.

**RC-066 — multiplatform acceptance.** Blocked by RC-054's Windows leg and by
RC-057: the matrix needs Windows, iOS, Android, container GUI, macOS and Linux
results. Build the matrix file now with the results that exist (each row naming
the command, the environment and the observed result) and mark the missing
targets explicitly — do not fill a row with a pass it did not have.

**RC-067 — publish the open version and a managed service.** Needs RC-065 and
RC-066. The self-managed image already builds and starts its GUI/API
(`prototype/start.sh`), and `scripts/rc059`–`scripts/rc062` cover install/update
paths; what is missing is publishing the versioned artifacts with public
instructions and a real paid test account, plus the rollback and support path.

## Environment facts that shape the remaining work

- Docker Desktop (Linux/arm64) runs the repository's own image
  (`prototype/Dockerfile`, rebuilt to `sha256:404c39c1…` during RC-053). A cached
  image can predate routes: RC-050/RC-051 runners rebuild with `RC050_REBUILD=1` /
  `RC051_REBUILD=1`, and the RC-051 runner refuses to start on an image whose
  `GET /api/inbox` is not 401.
- The iOS suite runs on simulator `5A85FF4A-CDFE-4306-823D-C2715DAA74AB`; the
  first build after adding a native module needs `bunx pod-install`.
- The Android emulator is AVD `rc056-android` (Android 15, arm64). The SDK is at
  `/opt/homebrew/share/android-commandlinetools`, the JDK at
  `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`. A release APK
  needs the JS bundle rebuilt after changing `EXPO_PUBLIC_*` (delete
  `apps/mobile/android/app/build/generated/assets`).
- No APNs, no FCM and no Expo push project id are available: device push
  transport cannot be exercised, and both RC-055 and RC-056 record that ceiling.

## Lessons that keep paying off (violate these and you will be refuted)

- A proof must fail when the thing it tests breaks. Every spec here was made to
  fail at least once before it passed; several "passing" drafts were theatre.
- Read the app's own view tree, not a screenshot: XCUITest labels/identifiers,
  `uiautomator dump` on Android, `data-testid` on the web.
- In this app, React Native Web renders disabled controls as `div[aria-disabled]`
  — Playwright's `toBeDisabled()` reports them enabled. Assert the attribute.
- A quoted heredoc leaves `$VAR` literal: the native runner shipped a stub wrapper
  containing `$ROOT_DIR`, and runs stalled until it was expanded.
- The sidebar, not the workspace panel, tells the web shell which workspace the
  panels show; the mobile Threads screen reaches workspaces through its own picker.
- `page.request` does not carry the page's session; read the backend inside the
  page with `page.evaluate` + `fetch`.
- Keep one `/api/events` socket: four reconnect tests in `actions.spec.ts` close
  "the" socket, so a second one breaks them.

## Every push

- Update `plan/tasks.html` (status text **and** the header summary), `CHANGELOG.md`
  (newest first), `plan/checkpoint-evidence.md` and, when the route changed,
  `PIVOT.md` in the same commit as the acceptance.
- `bun test apps/api apps/gateway packages/client`, `bun run typecheck` and
  `python3 scripts/check-doc-links.py` before every push. The full browser suite
  (`bun run test:e2e`) is 112 passed / 5 skipped / 0 failed on this host.
- Proof scripts live in `scripts/rc<NNN>/` and take a fresh absolute output dir
  that does not already exist.

## RC-057 current state (2026-10-08, latest)

Items 1–3 of the RC-057 list above are done. The harness
`scripts/rc057/run-mobile-takeover-proof.sh` stands up the Linux host with its own
Xvfb display and TLS, runs a plain-HTTP front on this Mac
(`scripts/rc057/http-front.ts`; the emulator reaches it through `adb reverse`, it
speaks TLS to the host and drops the `Secure` attribute only on that loopback
hop), installs the app and proves: sign-in to the Linux host, the workspace list,
opening the workspace, the take-over (`Possession: holder`) and a text input the
host applied (`The host applied the text.`).

It stops there because every control in the session panel is disabled afterwards:
the app's own view tree shows all four controls (`Take over screen`,
`Return screen`, `Send screen text`, `Click screen centre`) enabled right after the
text send and all four disabled at the next observation, with no error message on
screen. The session panel's own busy gate is released per operation now, so the
flag comes from its parent
`apps/mobile/src/features/workspaces/WorkspacePanel.tsx`, which passes
`blocked={busy || Boolean(pending) || !storageReady || Boolean(readError)}`.
One instrumented run printing those four values (or a `testID` per value) names
the one that sticks; the likely candidate is `storageReady`, which is set false on
a device-storage failure and set true again only through the pending-recovery
path.

After that, the click, the return and the force-stop-and-recover legs follow the
text leg's shape, and the same journey should run on an iOS simulator (there the
container CA path is `xcrun simctl keychain <device> add-root-cert <pem>`).
