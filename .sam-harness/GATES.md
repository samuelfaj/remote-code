# Gates

A gate advances only when its stated evidence exists. Fluent output is not evidence.

## Configured commands

The required static gate runs `python3 scripts/check-doc-links.py` to check local README and current plan links and HTML anchors. No product code or product tests exist yet; the test phase has no executable gate.

## CI unification

Prefer generated `sam-harness-*` jobs over host jobs that only repeat the same gates. Suggested stages: check → test → build → deploy → verify → release → monitor. Exception path: failure → repair / rollback → verify.

## Evidence ladder

- [ ] Source: the intended files contain the change.
- [ ] Local checks: required commands passed against the current tree.
- [ ] Commit: the commit SHA contains the reviewed change.
- [ ] Remote: the expected remote branch contains that SHA.
- [ ] Review: findings and approvals belong to the same SHA.
- [ ] Correction findings identify a current added or modified diff line, or line 0 only for deletion-only, deleted, or pure-rename file-level evidence; out-of-scope P2/P3 suggestions are recorded separately, convergence closure references the frozen manifest and same-role IDs, and new P0/P1 regressions follow the same prior-head-to-current-head scope rule.
- [ ] CI: required jobs passed for the reviewed SHA.
- [ ] Artifact: the immutable digest came from that CI run.
- [ ] Deployment: the environment reports that exact digest.
- [ ] Live proof: technical and business signals stayed healthy for the observation window.

Never collapse two boxes into one claim.
