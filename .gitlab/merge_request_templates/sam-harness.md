<!-- sam-harness:start -->
## Description

In two to four sentences, explain the problem, the outcome, and why it matters.
Lead with behavior and value, not files or implementation details.

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Other: <specific type>

## What Changed

- User-visible change: concise outcome or `None`.
- Internal change: concise implementation summary or `None`.

## Behavior

- Before: previous observable behavior.
- After: new observable behavior.
- Unchanged: important behavior intentionally preserved.

## Business Rules

- Added: new rule or `None`.
- Changed: changed rule or `None`.
- Preserved: rule that must continue to hold.
- Write rules as conditions and outcomes: “When X, the system must Y.”

## Scope and Impact

- In scope: changed components and paths, including every changed file.
- Out of scope: nearby behavior intentionally not changed.
- User impact: who is affected and how, or `None`.
- Technical impact: API, data, configuration, operations, or compatibility, or `None`.

## Risks and Mitigations

- Risk: concrete failure mode and affected users or systems.
- Mitigation: prevention, detection, containment, or `None`.
- Remaining risk: what is still uncertain, or `None known`.
- Use `Not verified` when evidence is unavailable.

## Rollout and Recovery

- Rollout: deployment, migration, feature flag, or `Not applicable`.
- Monitoring: signal that confirms healthy behavior, or `Not applicable`.
- Recovery: rollback or corrective action if the change fails, or `Not applicable`.

## Validation

- `<command>` — `PASS`, `FAIL`, or `NOT RUN`: concise result or reason.

## Tests

- Scenarios: business and technical behavior covered, or `None`.
- Added or updated: exact test paths, or `None`.
- Executed: exact commands and status, or `Not run`.

## Author Checklist

- [ ] Description explains the problem, outcome, and reason.
- [ ] Before/after behavior and business rules are explicit.
- [ ] Every changed file is represented in scope.
- [ ] Risks, mitigations, and recovery are documented.
- [ ] Tests and validation reflect commands actually run.
- [ ] No unrelated changes are included.

## Notes for Reviewer

- Review first: highest-risk rule, behavior, or file.
- Open questions: unresolved decision or `None`.

Use `Not applicable` or `Not verified` instead of filling evidence gaps. Mark a checkbox only when its claim has evidence.

## Sam Harness Merge request evidence

Do not mark an item complete without a receipt tied to this exact change.

### Evidence ladder

- [ ] Source: intended paths and diff are identified.
- [ ] Local checks: required static and test commands passed; every waiver is linked and justified.
- [ ] Commit: the reviewed commit SHA contains the change.
- [ ] Remote: the expected remote branch contains that SHA.
- [ ] Review: independent findings and approvals belong to the same SHA.
- [ ] CI: required status checks passed for that SHA; branch protection and merge queue or merge-request approval rules were read back from the provider.
- [ ] Artifact: immutable digest, SBOM, and provenance came from the same CI run.
- [ ] Deployment: staging and production report that exact digest after required environment approval.
- [ ] Live proof: technical and business signals stayed healthy for the full observation window.

### Human-facing and UX checks

- [ ] Not applicable, with the affected surface and reason recorded; or all applicable checks below are complete.
- [ ] Loading, empty, error, success, unavailable, and destructive states were exercised.
- [ ] Keyboard access, focus, contrast, responsive layout, and reduced motion were checked.
- [ ] Visible labels use human names rather than internal IDs; dates, money, permissions, and status match user context.
- [ ] Localization and accessible names were verified for every affected locale.
- [ ] Browser or device evidence shows the changed states at relevant widths.

Provider YAML declares jobs and environment boundaries. It does not prove remote protection, approval, or required-status settings.
<!-- sam-harness:end -->
