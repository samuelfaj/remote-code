---
name: sam-harness-implement
description: Implement only the frozen scope and validate it with configured repository controls.
---

# Sam Harness implement

Use the root AGENTS.md, the closest workspace AGENTS.md, .sam-harness/config.yaml, and generated control documents as the authority for this repository.

1. Work only inside the approved paths and preserve unrelated changes.
2. Keep user commands as argv arrays from `.sam-harness/config.yaml`; never invent setup or deployment commands.
3. Make the smallest change that satisfies the frozen acceptance criteria.
4. Run the configured static and test phases and retain current-tree receipts.

Do not commit, push, open a change request, release, deploy, alter credentials, or cross another authority boundary unless the active task and canonical configuration grant that exact action.
