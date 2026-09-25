# Checkpoint evidence

This file records local observations for the current backlog checkpoint. It distinguishes source inventory and environment probes from accepted product behavior. The raw command output was also captured in the session scratch directory during this run; this repository note preserves the observations needed for another agent to resume.

## RC-001 — current-app parity inventory

- **Result:** Accepted as inventory only, not as implementation proof.
- **Source checkout:** `../remote-code/macos-app`, branch `production`, revision `5515958f7e6cbb46bf33c16c3ff91df7e4dab021`; `git -C ../remote-code/macos-app status --porcelain` returned empty at inspection. Representative file existence and task-ID mappings were checked by script.
- **Artifact:** [`parity-inventory.md`](parity-inventory.md), linked from RC-001 in `tasks.html`.
- **Scope boundary:** The app checkout is adjacent to this planning repository, not copied into it. Reconfirm the pinned source revision before changing the mapping. No feature execution or product parity is claimed.
- **Verification:** `python3 scripts/check-doc-links.py` passed. A semantic check confirmed every referenced task ID exists, source paths exist, schedule execution/UI proofs cover both workspace tasks and Bot routines, and the explicit exclusions are present. `git diff --check` passed.

## RC-002 — main Distill on Linux

- **Result:** Blocked. No Linux Distill runtime was present in the available cached Linux image. Configurable-model access is **unverified**; credentials were not inspected and no provider request was made.
- **Environment:** macOS host; `distill --version` → `distill 2.0.14 (8e7101188723)`; Docker client/server `29.4.0/29.4.0`; cached `remotecode/computer:local` reports `linux/arm64`.
- **Action:** Ran the cached image with `--network none` and checked `command -v distill` inside it.
- **Observed at the original probe:** `Distill=unavailable`. Local Distill executables were all `macOS-aarch64` Mach-O binaries (versions 2.0.9, 2.0.13, and 2.0.14); `docker images` contained no Distill image. At that time `.sam-harness/config.yaml` set `network: false`, so no runtime or dependency was downloaded and no model was called.
- **Linux binary follow-up:** After the user explicitly authorized network use, downloaded the official Distill v2.0.14 `distill-linux-aarch64` release asset; published SHA-256 `abf7e29c56c164476ea81ef6cc6a1b056620b154839c03de3db3ae9a66bb6864` matched. `file` identified an ELF 64-bit ARM aarch64 Linux executable. Mounted it read-only into `remotecode/computer:local` and ran it with networking disabled. The container reported `aarch64`, glibc 2.36, and all dynamic libraries resolved, but `distill --version` terminated with `Illegal instruction` (exit 132). Therefore this asset is not currently a usable runtime in the available Linux guest. A follow-up attempt to run the checksum-verified x86_64 binary with `--platform linux/amd64` failed because the cached image has no amd64 variant (`Unable to find image ... locally`, then pull denied); running it against the ARM64 guest reported the missing `/lib64/ld-linux-x86-64.so.2`. No emulation-compatible x86_64 guest is available in the current Docker context. No model credentials were inspected or model request made; configurable-model access remains unverified.
- **Remaining proof:** Make a Linux Distill runtime usable on the target Linux guest, then run the real stdio-backed file-creation, interruption, backend/process restart, and state/file reconciliation checks with authorized configurable-model access.

## RC-003 — Linux GUI and remote clients

- **Result:** Blocked after a partial Linux/X11 MCP probe; this is not acceptance of the full React Native Web/Elysia/Distill journey.
- **Environment at probe time:** Cached `remotecode/computer:local` image, Debian 12, Linux arm64; `linux-use` source at `fe6b2048f71685672ceeec34a8e765540bc8ba55`, mounted read-only; `.sam-harness/config.yaml` then had `network: false`; Xvfb started on `:99` with `XDG_SESSION_TYPE=x11`. The network authority was explicitly enabled later, but this does not change the observed missing `wmctrl` or unavailable application source.
- **Action:** Sent real JSON-RPC stdio requests (`initialize`, `tools/call` for `doctor`, and `tools/call` for `list_windows`) to the mounted `linux-use/server.py` process in that Linux container.
- **Observed:** Server identified itself as `linux-use` 1.0.0. `doctor` returned `platform=linux`, `display=true`, `session_type=x11`, `xdotool=/usr/bin/xdotool`, `wmctrl=null`, and no supported native tools. `list_windows` returned `isError=true` with `Unsupported/unavailable: required system utility 'wmctrl' is not installed.` No window actions or input were attempted.
- **Known limitations:** `linux-use` documents capture, input, semantic actions, and Chrome automation as unsupported. This planning repository has no `apps/api`, `apps/web`, or container build source; the cached image has no Distill or `wmctrl`. The shared backend/client/browser journey remains unverified.
- **Verification:** `python3 scripts/check-doc-links.py`, RC-003 blocker consistency check, and `git diff --check` passed.

## Next backlog gate — no dependency-ready implementation task

- **Result:** No further planned implementation task can start without violating the backlog's `Depends on` and accepted-evidence rules.
- **Method:** Parsed each `<details class="ticket">` entry in `plan/tasks.html` and extracted its `Depends on`/`Status` text across all 67 tasks.
- **Observed:** RC-001 is the only completed item and is explicitly inventory-only. RC-002 and RC-003 are blocked. RC-004 requires accepted RC-002 evidence; every remaining task depends directly or transitively on one or more of RC-002/003 or on unaccepted work. No `To do` task has all dependencies accepted.
- **Next action:** Resume RC-002 only when a Linux Distill runtime and authorized configurable-model test access are available. Resume RC-003 when its Linux GUI prerequisites (`wmctrl`, required `linux-use` capabilities) and actual API/web implementation source are available. Do not start RC-004 before RC-002 is accepted; do not treat the partial RC-003 probe as acceptance.
- **Authority:** After explicit user confirmation, `.sam-harness/config.yaml` and `.sam-harness/DELEGATION.md` allow network, commit, and push. Git remains `main...origin/main` with local changes. A Linux binary was downloaded for testing but failed at startup as recorded above. No commit or push has been made; this checkpoint's checks and review must complete before publication.

## Authority and publication

- The user explicitly authorized network, commit, and push in response to separate authority questions. `.sam-harness/config.yaml` and `.sam-harness/DELEGATION.md` now set all three to `true`. The official Linux binary was downloaded and checksum-verified but failed to run in the available guest; no commit or push has yet been made. No model credentials were inspected and no model request was made.
- No product behavior milestone was verified, so no X post was made. `TWITTER.md` requires posts to describe only verified product milestones.
- Planning-page browser check: served the repository on localhost and opened `plan/tasks.html` in an owned Chrome background tab. Confirmed the rendered summary shows `1 completed (inventory only); 2 blocked`; selecting phase 00 displays four tasks, and the link to `plan/parity-inventory.md` returned HTTP 200. Searching for `RC-002` initially displayed `0 tasks` because search omitted the ticket `id`; added `ticket.id` to the search corpus. Repeated the same browser interaction and confirmed it displays exactly `1 task`, `RC-002`, “Prove main Distill on Linux.” The page's complete `file://` route could not be tested because the browser tool accepts only HTTP(S).
- Raw outputs from probes were saved under the goal's private scratch directory while this goal is active; the summaries above are the durable handoff.
