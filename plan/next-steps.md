# Where to resume

Latest confirmed state: the RC-067 checkpoint on
`checkpoint/rc002-linux-runtime-evidence`, pushed. Plan status:
**66 complete / 1 in progress / 0 blocked / 1 to do** of the 68 tasks in
`plan/tasks.html`. Open: **RC-066** (to do) and **RC-067** (in progress).

Do these two things next, in this order:

1. **RC-067's last leg.** `bash scripts/rc067/run-hosted-service-dispatch.sh <fresh dir>`
   publishes the control plane on a Cloudflare quick tunnel and runs the check on
   GitHub's `windows-latest` runner. The outside machine already reaches the
   public endpoint (`/api/health/ready` 200, login 200); provisioning answers
   **503**. Run it once and read the line the proof now prints
   (`control plane said: ...`) together with `apps/api/src/features/capacity.ts`
   — the refusal is `account_limit`, `disk_pressure` or `memory_pressure`, and
   `REMOTECODE_HOSTED_MAX_ACCOUNTS`, `REMOTECODE_HOSTED_RESERVED_HEADROOM_BYTES`
   and `REMOTECODE_DATA_ROOT` are the knobs the control plane reads. Then make
   that leg pass twice and mark RC-067 complete. A registry-published image is
   still impossible here: this account's GitHub token has no `write:packages`
   scope and ECR Public has no alias, so the image is built from the published
   tag's own Dockerfile.
2. **RC-066's remaining matrix cells.** `plan/acceptance-matrix.md` states, per
   client and journey, what is proven and what is `not run`. The biggest missing
   runs are the panel journeys from the container's own browser
   (`scripts/rc066/run-container-browser-panel-proof.sh` was started and is
   **unverified** — it needs a standalone driver that uses
   `chromium.connectOverCDP` against the guest Chromium, not the Playwright test
   runner's own browser), the Bot-routine journey from the iOS and Android apps,
   and the cut-and-reconnect journey from the container's browser. Push delivery
   on iOS and Android is a documented ceiling, not a gap: no APNs, FCM or Expo
   push project id exists here.


Read, in this order: `plan/acceptance-matrix.md` (RC-066's artifact and the
exact cells still missing), `plan/tasks.html` (per-task status), `CHANGELOG.md`
(newest-first acceptance log), `plan/checkpoint-evidence.md` (command,
environment, observed result and failure-if check for every accepted task),
`plan/failure-matrix.md` (RC-065's 22 executed cases and how to run them),
`PIVOT.md` (why a route changed), and `plan/capacity.md` /
`plan/failure-state-contract.md`.

## Accepted since the previous resume page

| Task | What it is | Evidence |
| --- | --- | --- |
| RC-054 | Web clients on macOS and Windows | Chromium and WebKit on this Mac; a real Windows Chromium on GitHub's `windows-latest` runner through a Cloudflare tunnel: `1 passed (22.3s)`. `scripts/rc054/run-macos-browsers-proof.sh`, `scripts/rc054/run-windows-host-and-dispatch.sh` |
| RC-065 | Fault injection across every layer | `bash scripts/rc065/run-failure-matrix.sh <fresh dir>` -> `{"result": "passed", "casesRun": 22, "casesPassed": 22, "casesFailed": 0}`. Found and fixed a real defect: a hosted account whose container died kept reading `ready` |

## RC-066 — the acceptance matrix (open)

Artifact: `plan/acceptance-matrix.md`. 23 cells carry a cited result, 17 are
`not run`, 14 are `n/a` because the product's shape makes them meaningless.
Every `not run` cell is drivable here and is what RC-066 still needs. In rough
order of cost:

1. **Windows browser, scheduled Bot.** Run `scripts/rc051/run-linux-web-proof.sh`'s
   spec from the Windows runner that `scripts/rc054/run-windows-host-and-dispatch.sh`
   already wires up. The step that is missing is a dispatch input that selects
   `apps/web/e2e/agent-activity.spec.ts` (it needs `RC051_STUB_AGENT=1` on the
   host) instead of `macos-linux-client.spec.ts`.
2. **Windows browser, injected failure.** The same runner against
   `scripts/rc065/run-restart-log-ui-proof.sh`'s host: the Linux host is started
   here, so point the Windows job at it and run the `after` phase only.
3. **Container guest Chromium**, four cells: scheduled Bot, human login,
   cut-and-reconnect and screen take-over from the container's own browser.
   `scripts/rc042/run-preview-proof.ts` and `scripts/rc053/run-linux-gui-proof.sh`
   already drive that browser over CDP; each cell needs its journey added there.
4. **Container GUI, scheduled Bot.** Same host as RC-053; the journey is the one
   RC-051 already drives.
5. **iOS and Android, scheduled Bot.** `apps/mobile/src/screens/BotsScreen.tsx`
   already shows a Bot's routines, so this needs a native-test mode that opens
   the Bots screen and asserts the routine against `GET /api/schedules`, in the
   shape of `RC_NATIVE_TEST_WORKSPACES`.

Mark a cell only when its run has produced its own recorded result; a skipped
test that reports a pass is the one failure mode this file exists to prevent.

## RC-067 — publish the open version and the managed service (open)

Done so far, all pushed: the annotated tag `v0.1.0` and the GitHub release
`https://github.com/samuelfaj/remote-code/releases/tag/v0.1.0`, and `INSTALL.md`
now pins the instalment to that tag ("3b. Which release you are installing").

Still missing, and in this order:

1. **A public image.** `docker push` to `ghcr.io/samuelfaj/remote-code-host` is
   refused: the `gh` token in use has `repo`, `gist`, `read:org` and
   `admin:public_key` only — no `write:packages`. Either refresh the token with
   that scope (an interactive device flow) or publish the image under a registry
   whose credentials exist; the local image `remotecode/host:local` is the one
   to push (`docker tag` + `docker push`).
2. **The proof.** `scripts/rc067/` does not exist yet. It should clone the
   public repository at `v0.1.0` into a fresh directory, build the image from
   that tag's `prototype/Dockerfile`, start it, then repeat one real journey
   from a browser and one from the Linux GUI, and create a paid test account
   through the billing route the way `scripts/rc061/run-billing-proof.ts` does
   (its provider is an HTTP stand-in for Stripe; a real Stripe test-mode key
   would be needed to call the provider itself).
3. **The managed service.** The hosted control plane creates account containers
   with Docker, so it cannot run on a container platform without a Docker
   socket. A reachable deployment therefore needs a host with Docker; the
   honest options are a machine you own plus the Cloudflare-tunnel pattern that
   `scripts/rc054/run-windows-host-and-dispatch.sh` already uses, or a VPS.
   The GCP project here has no billing account (`UREQ_PROJECT_BILLING_NOT_FOUND`),
   and the AWS account does have working credentials if a VPS is preferred.
4. **Support and rollback.** `INSTALL.md` section 3b and the release notes
   already state that rollback is a rebuild at a tag and that a mismatched
   client is refused by the host (`scripts/rc059/run-install-proof.ts`); the
   release notes should be updated with whatever the hosted service turns out
   to be.

## Environment notes that save time

- Docker is OrbStack on this machine. It went down once under heavy load with
  the Android emulator running; `open -a OrbStack` brings it back in ~25s, and a
  matrix run started while it is down reports per-case failures rather than a
  clear error.
- The RC-054 Windows leg needs `workflow_dispatch` to resolve, which only happens
  for a workflow that is also on the default branch — and `main` here is
  protected. The leg is therefore armed by a repository variable plus a push to
  the open pull request, and the variable is cleared once the run has started.
- Proof conventions: TypeScript proofs take an absolute `RC0NN_PROOF_DIR` that
  must not exist yet; shell proofs take one positional fresh directory; the
  Android proofs need the APK built with
  `EXPO_PUBLIC_API_ORIGIN=http://127.0.0.1:37132` and ports 37131/37132.
