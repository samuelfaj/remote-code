# Executable workflow

`.sam-harness/config.yaml` is the canonical source for every executable command. Commands remain argv arrays; this document is a human-readable inventory and does not grant authority.

## Delivery graph

Happy path: check → test → build → deploy → verify → release → monitor.

Exception path: failure → repair / rollback → verify. After repair or rollback, re-enter verify; do not skip it.

Generated GitLab stages use those names. GitHub job names stay `static`, `test`, `e2e`, `artifact`, `staging`, `production`, and `observe`; map them onto the same graph. Do not collapse the graph into one stage.

## Unify redundant CI

Prefer generated `sam-harness-*` jobs as the canonical gates. After apply or upgrade, delete or disable host jobs that only repeat a Harness phase (the same lint, typecheck, unit, contract, build, or browser command). Keep unique host work such as the live deploy path, infrastructure, seed, and a host review that Harness does not own.

If a host job is the only coverage for a command (`ci.external_coverage`), move that command into a Harness gate before deleting the host job, then retarget or drop the coverage entry so it names a job that still exists. Align parent `stages:` with the graph above, including `repair`. Independent jobs use `needs: []`.

The full workflow is not enabled. Only configured static and test gates may run. A production or regulated installation is incomplete until every required lifecycle command is explicit.
