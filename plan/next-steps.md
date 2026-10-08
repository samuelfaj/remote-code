# Where to resume

Latest confirmed state: the RC-054 acceptance checkpoint `32c05bb` on
`checkpoint/rc002-linux-runtime-evidence`, pushed. Plan status:
**65 complete / 0 in progress / 0 blocked / 3 to do** of the 68 tasks in
`plan/tasks.html`.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task),
`PIVOT.md` (why a route changed), `plan/failure-matrix.md` (RC-065's cases and
their executed run) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

## Open tasks, in dependency order

**RC-065 — failure-injection matrix.** The matrix is green
(`bash scripts/rc065/run-failure-matrix.sh <fresh dir>` reports 18 of 18 cases
exited 0), and the two cases that failed are fixed at their cause (see
`plan/failure-matrix.md`). What still keeps it To do is exactly four named
proofs:
1. no injected-failure run in a **hosted account** (self-managed accounts are
   what the matrix runs today; `scripts/rc060/run-hosted-provisioning-proof.ts`
   shows how to provision one and how a provisioning failure is injected),
2. no **sanitized-log and UI-after-restart** comparison,
3. no **swapped-window stream** (only the crossed-cookie refusal in
   `scripts/rc042/run-preview-proof.ts`),
4. no **Android storage-failure modes** (the equivalent modes exist only for iOS
   in `apps/mobile/native-tests/RemoteCodeMobileProofUITests.swift`, selected by
   `RC_NATIVE_TEST_STORAGE_FAILURE`, and there is no Android instrumentation test
   target at all — the Android app is driven by `uiautomator` from
   `scripts/rc057/run-mobile-takeover-proof.sh`).

**RC-066 — multiplatform acceptance.** Needs RC-065. Every client already has
its own proof; the work is to assemble one matrix with a row per client
(macOS/Windows/Linux browsers, container GUI, iOS, Android) and per journey
(file/Git, Distill, scheduled Bot, human login, push, crash/reconnection,
restore, injected failure), each row naming the command, the environment and the
observed result, and saving the receipts. Do not fill a row with a pass it did
not have.

**RC-067 — publish the open version and a managed service.** Needs RC-065 and
RC-066. The image already builds and starts its GUI/API (`prototype/start.sh`),
and `scripts/rc059`–`scripts/rc062` cover install and update. Missing: a public
versioned release with instructions, a hosted service that answers, a paid test
account, and the rollback and support path. Tools available here: `gh` is
authorized on `samuelfaj/remote-code` (public), Railway is logged in, and a
Stripe integration is configured.

## Accepted recently

| Task | Proof | Command |
| --- | --- | --- |
| RC-054 | a browser on macOS and a browser on Windows on the same Linux host | `bash scripts/rc054/run-macos-browsers-proof.sh <fresh dir>` and `bash scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` |
| RC-057 | take over the computer from mobile, on both platforms | `bash scripts/rc057/run-mobile-takeover-proof.sh <fresh dir>` |
| RC-050/051/052/053/055/056 | see `plan/checkpoint-evidence.md` | each task's own command there |

Every proof is reproducible from its command with no client-side process doing
the work.

## How RC-054's Windows leg works (it is unusual)

There is no Windows target on this machine and Cua offers none (AWS, GCP and
Modal all report the `windows` image unsupported). The leg therefore runs on
GitHub's `windows-latest` runner:

- `scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` starts the
  repository's Linux host image here on `127.0.0.1:8443` over TLS, publishes it
  on a Cloudflare quick tunnel (`cloudflared` is installed by Homebrew), sets the
  repository secret `RC054_AUTH_PASSWORD` and the variable
  `RC054_BACKEND_ORIGIN`, then pushes an empty commit to arm
  `.github/workflows/rc054-windows-client.yml` through the open pull request.
- `workflow_dispatch` cannot be used while the workflow is absent from the
  protected default branch, which is why the run is armed by a push; the variable
  is deleted once the run has started, so ordinary pushes run nothing.
- The workflow runs `scripts/rc054/run-windows-client-proof.sh`, which serves
  `apps/web` from the Windows runner with `REMOTECODE_WEB_PROXY_TARGET=<tunnel>`
  and `REMOTECODE_WEB_PROXY_CHANGE_ORIGIN=1` (a tunnel routes by the Host it is
  asked for and refuses the browser's own), then runs the same
  `apps/web/e2e/macos-linux-client.spec.ts` journey and uploads
  `proof-rc054-windows/` as the `rc054-windows-evidence` artifact.

## Environment facts that shape the remaining work

- Docker Desktop (Linux/arm64) runs the repository's own image
  (`prototype/Dockerfile`). A cached image can predate routes: RC-050/RC-051
  runners rebuild with `RC050_REBUILD=1` / `RC051_REBUILD=1`.
- The iOS suite runs on simulator `5A85FF4A-CDFE-4306-823D-C2715DAA74AB`; the
  first build after adding a native module needs `bunx pod-install`.
- The Android emulator is AVD `rc056-android` (Android 15, arm64). The SDK is at
  `/opt/homebrew/share/android-commandlinetools`, the JDK at
  `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`. A release APK
  needs the JS bundle rebuilt after changing `EXPO_PUBLIC_*` (delete
  `apps/mobile/android/app/build/generated/assets`).
- No APNs, no FCM and no Expo push project id are available: device push
  transport cannot be exercised, and both RC-055 and RC-056 record that ceiling.
- The GCP project attached to `gcloud` has no billing account
  (`UREQ_PROJECT_BILLING_NOT_FOUND`), so it cannot host anything; the AWS
  credentials on this machine are for account `467407956890` and were not needed
  in the end.

## Lessons that keep paying off (violate these and you will be refuted)

- A proof must fail when the thing it tests breaks. Every spec here was made to
  fail at least once before it passed; several "passing" drafts were theatre.
- Read the app's own view tree, not a screenshot: XCUITest labels/identifiers,
  `uiautomator dump` on Android, `data-testid` on the web.
- In this app, React Native Web renders disabled controls as `div[aria-disabled]`
  — Playwright's `toBeDisabled()` reports them enabled. Assert the attribute.
- A quoted heredoc leaves `$VAR` literal: the native runner shipped a stub wrapper
  containing `$ROOT_DIR`, and runs stalled until it was expanded.
- `page.request` does not carry the page's session; read the backend inside the
  page with `page.evaluate` + `fetch`.
- Keep one `/api/events` socket: four reconnect tests in `actions.spec.ts` close
  "the" socket, so a second one breaks them.
- A container that runs the Distill agent needs a model the container's own
  catalog offers; this host's default (`claude/claude-opus-5-5`) is not in it, and
  `default_reasoning_effort = "max"` is refused by the models that are
  (`scripts/rc015/run-isolation-proof.sh` now derives both).

## Every push

- Update `plan/tasks.html` (status text **and** the header summary), `CHANGELOG.md`
  (newest first), `plan/checkpoint-evidence.md` and, when the route changed,
  `PIVOT.md` in the same commit as the acceptance.
- `bun run typecheck` and `python3 scripts/check-doc-links.py` before every push;
  run the affected proof twice. Unit and mobile suites: `bun test`, `bun run
  test:mobile`. The full browser suite (`bun run test:e2e`) was 112 passed /
  6 skipped / 0 failed on this host.
- Proof scripts live in `scripts/rc<NNN>/` and take a fresh absolute output dir;
  TS proofs take `RC0NN_PROOF_DIR` and create it themselves.