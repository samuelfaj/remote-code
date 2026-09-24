---
name: sam-harness-plan
description: Freeze an executable plan with acceptance criteria, invariants, authority, and proof gates.
---

# Sam Harness plan

Use the root AGENTS.md, the closest workspace AGENTS.md, .sam-harness/config.yaml, and generated control documents as the authority for this repository.

1. Freeze the goal, acceptance criteria, invariants, owned paths, and no-go surfaces.
2. Map every static and test guard to one executable command or one auditable waiver.
3. Separate source, local checks, review, CI, artifact, deployment, and live proof.
4. Stop before action when a required command, owner, environment, rollback, or authority decision is missing.

Do not commit, push, open a change request, release, deploy, alter credentials, or cross another authority boundary unless the active task and canonical configuration grant that exact action.
