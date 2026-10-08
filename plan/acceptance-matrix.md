# RC-066 acceptance matrix

Critical journeys with results and evidence by client. Every filled cell names a
command whose script exists and a result recorded in `plan/checkpoint-evidence.md`
or in the proof's own PASS line. `n/a` marks a cell the product's shape makes
meaningless; `not run` marks a run that is possible here and has not been made.

## Matrix

| Client | File / Git | Distill | Scheduled Bot | Human login | Push | Crash / reconnection | Restore | Injected failure (RC-065) | Screen take-over |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Browser on macOS | `bash scripts/rc054/run-macos-browsers-proof.sh <fresh dir>` — exit 0; Chromium `1 passed (5.6s)`, WebKit `1 passed (6.0s)`: created a workspace, prepared its folder, created and saved a file through the panel and read the host's copy back | n/a — the agent runs on the Linux host; the client shows its runs (`scripts/rc051/run-linux-web-proof.sh` drives a run to `completed` from the panel) | `bash scripts/rc051/run-linux-web-proof.sh <fresh dir>` — `1 passed` twice; a scheduled task created in the panel is re-read from `GET /api/schedules` and its disable toggle takes effect there | included in RC-054 and RC-051: sign-in through the app's own field against the Linux host | n/a from this client — routing is decided on the host (`bun scripts/rc055/run-push-routing-proof.ts`, verified) | `bash scripts/rc054/run-macos-browsers-proof.sh <fresh dir>` — the journey closes the live channel and reconnects, then asserts the session's state | n/a — restore is a host operation (`bun scripts/rc058/run-backup-restore-proof.ts`) | `bash scripts/rc065/run-restart-log-ui-proof.sh <fresh dir>` — a file created before the API is killed and restarted still reads back through the browser | `bash scripts/rc054/run-macos-browsers-proof.sh <fresh dir>` — took and returned the screen with the host as the authority |
| Browser on Windows | `bash scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` — exit 0; GitHub Actions run 37745604065 on `windows-latest`, `1 passed (22.3s)`, `proof.json` `{"result":"verified","engine":"chromium","os":"windows"}` | n/a — same as macOS | `RC054_HOST_MODE=panel RC054_SPEC=apps/web/e2e/agent-activity.spec.ts bash scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` — GitHub Actions run 37764130646 on `windows-latest`, `1 passed (22.2s)`: the host runs the repository's stub agent, and a Windows browser drives a run, a permission request, a scheduled task and a Bot routine against the host's own answers | included in the RC-054 Windows journey | n/a — same as macOS | `bash scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` — the same cut-and-reconnect leg runs in the Windows browser | n/a — same as macOS | `not run` — the restart-and-re-read journey has not been repeated from a Windows browser | `bash scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` — same take-and-return leg |
| Browser on Linux (container guest Chromium) | `bun scripts/run-file-editor-linux-browser-proof.ts --frozen-inputs` — passed; `sourceUnchanged: true`, `cleanup.errors: []` (RC-029). Its client is a browser on this Mac against a Linux-hosted API (`chromium.launch({ headless: true })`), so it is not evidence for this row; it is listed here so the earlier citation is not mistaken for one | n/a — same as macOS | `bash scripts/rc066/run-container-browser-panel-proof.sh <fresh dir>` — exit 0 twice. The container's own Chromium (CDP `Chrome/154.0.8037.92`, user agent `X11; Linux x86_64`) drives a workspace, a scheduled task whose disable toggle lands on the host, and a Bot whose routine row shows the host's `localTime=10:30` / `America/New_York` | `bash scripts/rc066/run-container-browser-panel-proof.sh <fresh dir>` — signed in from the guest browser (`status=200`), then `connection-status` read `Live updates connected` | n/a — same as macOS | `bash scripts/rc066/run-container-browser-panel-proof.sh <fresh dir>` — the guest browser's live channel was dropped (`crash_reconnect_start: cutting live channel`) and the session reconnected with the workspace data preserved | n/a — same as macOS | `bash scripts/rc065/run-failure-matrix.sh <fresh dir>` — every failure case runs in the Linux container itself (see the row below) | `bash scripts/rc066/run-container-browser-panel-proof.sh <fresh dir>` — take-over and return driven from the guest browser: the host reported `holder`, then `none` |
| Container GUI | `bash scripts/rc053/run-linux-gui-proof.sh <fresh dir>` — passed; file operations driven through the container's own X11 window and its CDP browser | `bash scripts/rc053/run-linux-gui-proof.sh <fresh dir>` — includes `distill mcp doctor linux-use` inside the container | `bash scripts/rc066/run-container-browser-panel-proof.sh <fresh dir>` — the same guest Chromium is the container GUI's browser, and it created the scheduled task whose disable toggle the host then reported disabled | included in RC-053's journey | n/a — same as macOS | `bash scripts/rc053/run-linux-gui-proof.sh <fresh dir>` — the window returns after a restart and the API answers again | n/a — same as macOS | `bash scripts/rc065/run-failure-matrix.sh <fresh dir>` — the cases run on this host | `bash scripts/rc053/run-linux-gui-proof.sh <fresh dir>` — possession taken and returned through the container's own display |
| iOS | `RC_NATIVE_TEST_FILES=1 bash scripts/run-mobile-native-test.sh` — exit 0 twice; lists, opens and saves a Linux workspace file and refuses a stale client (RC-025) | n/a — same as macOS | `not run` — the app's `apps/mobile/src/screens/BotsScreen.tsx` shows a Bot's routines, so this is drivable; a native-test mode that opens the Bots screen and asserts a routine against `GET /api/schedules` is what is missing | `RC_NATIVE_TEST_LOGIN_DEADLINE=1 bash scripts/run-mobile-native-test.sh` — exit 0; sign-in through the app's own fields, credential absent from transcripts and command lines (RC-044) | ceiling — no APNs project and no Expo push project id exist here, and RC-047's provider is an HTTP stand-in, so device push cannot be exercised on this machine; RC-047 and RC-055 prove the routing and the provider boundary without a device token | `RC_NATIVE_TEST_RECOVERY=1 RC_NATIVE_TEST_FILES=1 bash scripts/run-mobile-native-test.sh` — exit 0; a committed-but-lost release is resolved by receipt and applied exactly once (RC-026) | n/a — the app exposes no restore surface; restore is a host operation (`bun scripts/rc058/run-backup-restore-proof.ts`) | `RC_NATIVE_TEST_STORAGE_FAILURE=1` scenarios in `bash scripts/run-mobile-native-test.sh` — the app fails closed and removes nothing after context revocation | `RC_NATIVE_TEST_TAKEOVER=1 bash scripts/run-mobile-native-test.sh` — exit 0; `testTakeoverScreenOnHostWithHumanInput` passed in 64.4 s and 66.0 s (RC-057) |
| Android | `bash scripts/rc056/run-android-proof.sh` — verified; sign-in, workspace, Bot, thread, run, Inbox, action submission, Inbox across force-stop and relaunch | n/a — same as macOS | `not run` — the app's `apps/mobile/src/screens/BotsScreen.tsx` shows a Bot's routines, so this is drivable; a native-test mode that opens the Bots screen and asserts a routine against `GET /api/schedules` is what is missing | included in RC-056's journey | ceiling — no FCM credentials and no Expo push project id exist here, so device push cannot be exercised on this machine; RC-047 and RC-055 prove the routing and the provider boundary without a device token | `bash scripts/rc056/run-android-proof.sh` — force-stop and relaunch; the Inbox item survives | n/a — the app exposes no restore surface; restore is a host operation (`bun scripts/rc058/run-backup-restore-proof.ts`) | `bash scripts/rc065/run-android-storage-failure-proof.sh <fresh dir>` — exit 0 twice, `{"result": "verified"}`; the app's own store is made unwritable before an attempt and after a confirmed receipt, and neither claims success | `bash scripts/rc057/run-mobile-takeover-proof.sh <fresh dir>` — exit 0; `PASS rc057 (android)` |

## The injected-failure row, in full

RC-065's matrix is the evidence for the last column:
`bash scripts/rc065/run-failure-matrix.sh <fresh dir>` runs every case in turn,
one transcript per case (`meta/<case>/transcript.log`, `exit`, `command`) plus
`matrix.json`, and reported **22 of 22 cases exited 0** on the run recorded in
`plan/failure-matrix.md`: the original eighteen plus the hosted account whose
container is killed, the sanitized-log and UI-after-restart comparison, the
window swapped mid-stream, and the Android storage-failure modes.

## Known ceilings

Each is a limit of what this machine can reach, not a claim about the product.

1. **APNs and FCM transport** — no APNs credentials, no FCM credentials and no
   Expo push project id exist here, so a device cannot obtain a real token;
   RC-047's provider is an HTTP stand-in for both.
2. **Windows on this machine** — there is no Windows host, VM or browser here.
   The Windows leg runs on GitHub's `windows-latest` runner, which is a real
   Windows machine.
3. **Physical devices** — only the iOS simulator and the Android emulator are
   available; no physical iPhone or Android device is exercised.
4. **The real Distill credential** — RC-002 gates it. The agent binary in these
   proofs is the repository's own ACP stub where a real model turn would be
   needed; RC-015 shows the real binary running inside the container.

## Verification

Every cited script was checked for existence on 2026-10-08 with:

```
for f in scripts/rc051/run-linux-web-proof.sh scripts/rc053/run-linux-gui-proof.sh \
  scripts/rc054/run-macos-browsers-proof.sh scripts/rc054/run-windows-host-and-dispatch.sh \
  scripts/rc055/run-push-routing-proof.ts scripts/rc056/run-android-proof.sh \
  scripts/rc057/run-mobile-takeover-proof.sh scripts/rc058/run-backup-restore-proof.ts \
  scripts/rc065/run-failure-matrix.sh scripts/rc065/run-restart-log-ui-proof.sh \
  scripts/rc065/run-android-storage-failure-proof.sh scripts/run-mobile-native-test.sh \
  scripts/run-file-editor-linux-browser-proof.ts; do
  [ -f "$f" ] && echo "EXISTS: $f" || echo "MISSING: $f"; done
```

## Statistics

- Cells with a cited result: 28
- Cells marked `not run`: 12
- Cells marked `n/a` by the product's shape: 14