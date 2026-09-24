---
name: sam-harness-review
description: Review an immutable change independently without mutating the repository.
---

# Sam Harness review

Use the root AGENTS.md, the closest workspace AGENTS.md, .sam-harness/config.yaml, and generated control documents as the authority for this repository.

1. Freeze the repository fingerprint and review bundle.
2. Require `filesystem_read_only: true` and, for provider-secret CI, `trusted_external_command: true`. `trusted_config_arguments` names only zero-based argv positions whose safe relative helper paths must resolve from the trusted config directory. The attested command runner is the trust boundary; sam-harness detects mutation but does not OS-sandbox arbitrary argv.
3. Run every reviewer against the explicit trusted base and untrusted head patch. Require `review_complete: true` plus every actionable finding with its exact `required_change` and observable `acceptance`; treat malformed output, repository mutation, P0, and P1 findings as blocking.
4. Consolidate in-scope findings into one lineage-bound, hashed repair manifest. Record out-of-scope P2 and P3 separately in the HTML receipt and never confuse consensus with independent proof.
5. Every initial finding must identify a current added or modified line in base..head, or line 0 only for deletion-only, deleted, or pure-rename file-level evidence. Out-of-scope P0/P1 findings block; out-of-scope P2/P3 suggestions are excluded from correction and recorded in the HTML receipt. For convergence, pass --prior-review-receipt, preserve frozen IDs only for the same reviewer role, and apply the same scope rule to new P0/P1 findings in prior-head..current-head. Missing proof fails closed.

Do not commit, push, open a change request, release, deploy, alter credentials, or cross another authority boundary unless the active task and canonical configuration grant that exact action.
