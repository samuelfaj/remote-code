---
name: sam-harness-release
description: Promote one immutable artifact through approval, observation, and rollback gates.
---

# Sam Harness release

Use the root AGENTS.md, the closest workspace AGENTS.md, .sam-harness/config.yaml, and generated control documents as the authority for this repository.

1. Require a reviewed commit, passing required CI, immutable artifact digest, SBOM, and provenance from one run.
2. Promote the same path and digest to staging and production; never rebuild during promotion.
3. Use provider-side protected production approval and read it back before claiming it.
4. Observe technical and business checks for the configured window; use the explicit rollback command when its boundary is approved.

Do not commit, push, open a change request, release, deploy, alter credentials, or cross another authority boundary unless the active task and canonical configuration grant that exact action.
