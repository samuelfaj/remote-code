---
name: sam-harness-classify
description: Classify a repository task from evidence before choosing an implementation path.
---

# Sam Harness classify

Use the root AGENTS.md, the closest workspace AGENTS.md, .sam-harness/config.yaml, and generated control documents as the authority for this repository.

1. Read the task, root rules, invariants, and configuration.
2. Name the expected existing behavior and concrete breakage before classifying a bug; otherwise classify a feature or maintenance task.
3. Record ambiguity and risk without editing source.
4. Hand the classification and evidence to planning.

Do not commit, push, open a change request, release, deploy, alter credentials, or cross another authority boundary unless the active task and canonical configuration grant that exact action.
