# RemoteCode

RemoteCode is being planned as a persistent Linux workspace for each user. The backend, desktop GUI, workspaces, Bots, and their data live in a Docker container. Web and mobile clients connect to that container through HTTP and WebSocket. When a Bot needs a person to log in or complete another visual step, the user can take control of its Linux session and then hand it back.

The project is intended to be open source and self-hostable, with paid hosting for people who prefer a managed workspace. This repository currently contains the product plan and screen concepts, not a working application.

## Read the plan

- [Product and architecture](plan/index.html): how the Linux host, clients, GUI, Distill, and recovery paths fit together.
- [Build tasks](plan/tasks.html): 67 tasks ordered from initial proof through release, each with an observable completion check.
- [Screen mockups](plan/mockups.html): desktop and mobile concepts, including the Bot computer handoff.
- [Pivot policy](PIVOT.md): how to keep safe, evidence-backed work moving when a task is blocked.

Open `plan/index.html` in a browser to read the plan locally. The three plan pages link to each other and need no build step.

## Proposed implementation

The TypeScript monorepo groups backend, web, and mobile code by product feature. The modular Elysia backend owns data and actions; Eden shares its API types through one client package. Web, desktop, iOS, and Android share connection and service code while keeping device-specific screens. The main Distill project is the sole agent harness, integrated as a separate process. The Linux GUI and Bot computer sessions run in the user's container; clients view and control them remotely when needed.

The older material in [`plan/archive/previous-plan`](plan/archive/previous-plan) records an earlier direction and is kept for reference. Start with the three documents above for the current scope.
