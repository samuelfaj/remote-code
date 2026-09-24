---
name: sam-harness-repair
description: Repair a failed receipt within explicit attempt, file, line, and authority budgets.
---

# Sam Harness repair

Use the root AGENTS.md, the closest workspace AGENTS.md, .sam-harness/config.yaml, and generated control documents as the authority for this repository.

1. Require the exact failed receipt, enabled correction configuration, `filesystem_sandboxed: true`, and, for provider-secret CI, `trusted_external_command: true`. A failed review must carry an intact, conflict-free repair manifest. `trusted_config_arguments` may name only safe helper paths resolved from the trusted config directory. Sam-harness does not OS-sandbox arbitrary argv.
2. Independently verify and apply every manifest action in one coherent correction inside the sandboxed local workspace; do not stop after the first item or defer known work. Keep provider credentials and remote authority read-only.
3. Enforce maximum attempts and cumulative changed-file and changed-line budgets against the frozen baseline; rerun static and test after every attempt. Automatic review repair is limited to one pass; the repair branch is re-reviewed but cannot spawn another automatic repair branch.
4. Emit the runtime-created correction-only patch and receipt artifacts. Only a separate trusted publisher may apply that patch, disable hooks, push an isolated prefixed branch, or open a change request when explicitly authorized. Independent re-review remains required.

Do not commit, push, open a change request, release, deploy, alter credentials, or cross another authority boundary unless the active task and canonical configuration grant that exact action.
