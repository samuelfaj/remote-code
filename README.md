# RemoteCode

RemoteCode is being planned as a persistent Linux workspace for each user. The backend, desktop GUI, workspaces, Bots, and their data live in a Docker container. Web and mobile clients connect to that container through HTTP and WebSocket. When a Bot needs a person to log in or complete another visual step, the user can take control of its Linux session and then hand it back.

The project is intended to be open source and self-hostable, with paid hosting for people who prefer a managed workspace. This repository contains the product plan, screen concepts, and local proof implementations. The full application remains incomplete; [checkpoint evidence](plan/checkpoint-evidence.md) separates verified behavior from open requirements.

## Install it yourself

[INSTALL.md](INSTALL.md) is the public, self-managed installation guide: build the host image, create the data volume, start the container, run the external supervisor, and back up or restore. It needs no paid account and no access to any internal service.

## Develop locally

Bun 1.4 or later is required; see https://bun.sh. Run `bash dev.sh` from the repository root to start the API on port 3000 and the web app on http://localhost:5173. The development login password is `remote-code-local-dev`; set `REMOTECODE_AUTH_PASSWORD` to override it. You can also override `API_PORT`, `WEB_PORT`, and `DATABASE_PATH` as environment variables. State and the API log live in the untracked `.dev` directory. Press Ctrl-C to stop both processes. The mobile app is not started by this script.

## Read the plan

- [Product and architecture](plan/index.html): how the Linux host, clients, GUI, Distill, and recovery paths fit together.
- [Build tasks](plan/tasks.html): 68 tasks ordered from initial proof through release, each with an observable completion check.
- [Where to resume](plan/next-steps.md): the pushed checkpoint, what is ready next, and the conventions a new agent must follow.
- [Measured capacity](plan/capacity.md): what one hosted account actually costs under load, and the limits the host enforces from that measurement.
- [Failure-state contract](plan/failure-state-contract.md): per-operation timeouts, cancellation and the rule for a result that was never confirmed.
- [Screen mockups](plan/mockups.html): desktop and mobile concepts, including the Bot computer handoff.
- [Pivot policy](PIVOT.md): how to keep safe, evidence-backed work moving when a task is blocked.

Open `plan/index.html` in a browser to read the plan locally. The three plan pages link to each other and need no build step.

## Proposed implementation

The TypeScript monorepo groups backend, web, and mobile code by product feature. The modular Elysia backend owns data and actions; Eden shares its API types through one client package. Web, desktop, iOS, and Android share connection and service code while keeping device-specific screens. The main Distill project is the sole agent harness, integrated as a separate process. The Linux GUI and Bot computer sessions run in the user's container; clients view and control them remotely when needed. The protected terminal backend is implemented and locally tested with temporary unprivileged process containers mounted only to the authorized workspace leaf; the persistent host remains the sole backend and data authority. This changes the terminal execution method, not the Distill harness. The backend's Docker control is a trusted private-host capability and is never passed to terminal processes. Actual Linux tests cover terminal I/O, dimensions, secret denial and logout/expiry/archive cleanup. A locally tested workspace-bound web panel now supports line input, bounded plain-text output, original-ID inspection and explicit stop through the same Eden client. Unknown input remains blocked after reload and no mutation is automatically resent. The web panel also renders received terminal bytes through a pinned ANSI emulator and offers an explicit Apply size action that stays blocked while a resize outcome is unknown; direct keyboard input is not supported. This bounded slice is locally verified on real Linux. Its version-bound source is published at commit `892cc45d1c5796576667163936470cb4305effaf`, confirmed by `git ls-remote`; that is source publication only, not deployment or an X post. A web disconnect/reconnect candidate proof has new run10 evidence, pending parent final verification; it explicitly restores the saved terminal reference in `sessionStorage`, so it does not claim automatic restore. The full terminal task remains In Progress and unaccepted; native UI, direct keyboard input, flow control, and normal backend graceful shutdown with a live terminal remain open. One real API-process crash/reconciliation journey is locally verified, while broader restart/fault journeys remain open. See [latest reconnect checkpoint](plan/checkpoint-evidence.md#rc-031-web-disconnectreconnect-proof--local-checkpoint--2026-10-03-utc) and [ANSI renderer and resize evidence](plan/checkpoint-evidence.md#rc-031-web-ansi-renderer-and-explicit-resize--locally-verified-bounded-slice--2026-10-03-utc).

The prototype requires `REMOTECODE_AUTH_PASSWORD` to be set to a random passphrase of at least 16 characters before `docker compose up`; do not commit the value. Compose binds its published ports to loopback. Host sessions are stored in the configured SQLite database, expire after 24 hours, and use an HTTP-only, strict same-site cookie; the cookie is marked secure for HTTPS requests. Login rejects non-loopback plain HTTP at both the API and the web proxy ingress, and forwarded-protocol headers are never trusted. Remote access through a TLS-terminating proxy is unsupported until authenticated ingress identity is implemented. Set `REMOTECODE_WEB_ORIGIN` to the exact browser origin; WebSocket events reject missing or different origins. If the host credential is missing or too short, login fails closed.

The older material in [`plan/archive/previous-plan`](plan/archive/previous-plan) records an earlier direction and is kept for reference. Start with the three documents above for the current scope.
