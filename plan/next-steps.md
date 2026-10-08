# Where to resume

Latest confirmed state: the RC-066 acceptance checkpoint on
`checkpoint/rc002-linux-runtime-evidence`, pushed. **All 68 tasks in
`plan/tasks.html` are complete** and every cell of `plan/acceptance-matrix.md`
names a command and a result.

Read, in this order: `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (the command, the
observed result and the failure-if check for every accepted task),
`plan/acceptance-matrix.md` (the client-by-journey matrix, including the two
recorded ceilings), `PIVOT.md` (why a route changed), `plan/failure-matrix.md`
(RC-065's 22 cases) and `plan/capacity.md` / `plan/failure-state-contract.md`
(measured limits and the per-operation failure table).

## What is proven and how to re-run it

The heavy proofs each take one command and a fresh absolute output directory:

- `bash scripts/rc065/run-failure-matrix.sh <fresh dir>` — 22 failure cases, one transcript each.
- `bash scripts/rc054/run-macos-browsers-proof.sh <fresh dir>` and `bash scripts/rc054/run-windows-host-and-dispatch.sh <fresh dir>` — the macOS and Windows browser legs.
- `bash scripts/rc066/run-container-browser-panel-proof.sh <fresh dir>` — the container's own Chromium driving the panel.
- `bash scripts/rc066/run-windows-restart-proof.sh <fresh dir>` — the Windows browser across an API restart.
- `bash scripts/rc066/run-android-bot-routine-proof.sh <fresh dir>` and `RC_NATIVE_TEST_ROUTINES=1 RC_NATIVE_TEST_WORK_DIR=<fresh dir> bash scripts/run-mobile-native-test.sh` — the two mobile routine journeys.
- `bash scripts/rc067/run-publish-proof.sh <fresh dir>` and `bash scripts/rc067/run-hosted-service-dispatch.sh <fresh dir>` — the published artifact and the managed service.

## Recorded ceilings (not gaps)

- Device push on iOS and Android: no APNs project, no FCM credentials and no
  Expo push project id exist on this machine. RC-047 and RC-055 prove the
  routing and the provider boundary without a device token.
- A registry-published image: this account's GitHub token has no
  `write:packages` scope and ECR Public has no alias, so the image is built from
  the published `v0.1.0` tag's own Dockerfile. The tag pins the source, so
  nothing can diverge from it.
- The managed control plane is published here on a Cloudflare quick tunnel
  rather than deployed to a cloud host: the GCP project has no billing account
  and Railway cannot run nested Docker.

## Housekeeping this repository expects

- `python3 scripts/check-doc-links.py` must stay clean.
- `bun run typecheck`, `bun test apps/api/src apps/gateway/src packages/client/src` and `bun run test:e2e` are the local gates.
- Commit subjects follow Conventional Commits, and each checkpoint is pushed.
