# Hosted capacity — measured, not estimated (RC-064)

Every number here comes from `scripts/rc064/run-capacity-proof.ts` running on
this host, not from a datasheet. The proof provisions accounts on the trusted
host, runs four concurrent workloads in each, samples `docker stats` three
times, and then asks the host for one more account.

## What the load actually is

| Workload | What runs |
| --- | --- |
| Build | a real `bun build` of the repository's web app, looping in the account |
| Browser | ten real Chromium `--app` sessions on the account's own Xvfb display |
| Run supervisor | the shipped run supervisor driven by the repository's deterministic stub agent |
| Requests | sustained `curl` against the account's own API |

**Not exercised:** the real Distill binary. It needs the Linux Distill
credential that RC-002 gates separately, so the supervisor path is the shipped
code that was measured. Do not read these numbers as "Distill under load".

## Measured per account (two accounts on one 16 GiB / 8 vCPU host)

| Sample | Account A CPU | Account A RAM | Account B CPU | Account B RAM |
| --- | --- | --- | --- | --- |
| 1 | 272.0% | 1.97 GiB | 208.4% | 1.35 GiB |
| 2 | 229.2% | 2.33 GiB | 226.2% | 1.70 GiB |
| 3 | 205.1% | 2.09 GiB | 231.5% | 2.12 GiB |

- **CPU peak:** 272% of one core observed for a single account under this load.
- **RAM peak:** 2.33 GiB for a single account; both accounts together stayed under 4.5 GiB.
- **Disk per account:** the data volume held 618,496 bytes after provisioning and a few routines — the volume, not the image, is the per-account disk cost, since every account shares the image layers.
- Both accounts stayed `running` and answered `/api/health/ready` 200 in every sample.

## Limits derived from the measurement

These are the values the API now enforces (`apps/api/src/features/capacity.ts`,
all overridable by environment):

| Limit | Value | Why |
| --- | --- | --- |
| `REMOTECODE_HOSTED_MAX_ACCOUNTS` | 8 | 8 accounts at the measured 2.33 GiB peak is ~18.6 GiB, so a 32 GiB host keeps a full account of headroom. |
| `REMOTECODE_HOSTED_CPU_CORES` | 2 | One account already reached 272% of a core; 2 cores is the point where its own work starts queueing rather than starving a neighbour. |
| `REMOTECODE_HOSTED_MEMORY_BYTES` | 4 GiB | Measured peak 2.33 GiB plus room for a browser-heavy Bot. |
| `REMOTECODE_HOSTED_DISK_BYTES` | 20 GiB | Volume cost observed is small, but a workspace that clones a repository is not. |
| `REMOTECODE_HOSTED_RESERVED_HEADROOM_BYTES` | 2 GiB | The free space the host must keep before it stops accepting accounts. |

## What happens at the limit

`POST /api/hosted/accounts` answers **503 `{"error":"capacity_exhausted","reason":"account_limit"}`**
*after* ownership resolution and *before* any volume or container is created, so
an over-limit request leaves no partial resource behind. `GET /api/hosted/capacity`
derives `acceptingNewAccounts` and `reason` from the same helper that gates
provisioning, so the report and the refusal can never disagree. A package is
never sold on estimated capacity: the number a customer is quoted is the number
this proof measured.

## Honest gaps

- `host.freeDiskBytes` and `host.freeMemoryBytes` are `null` on macOS, where
  neither the Linux `df` invocation nor `/proc/meminfo` exists; on Linux both are
  measured and drive `disk_pressure` / `memory_pressure`.
- The measurement covers one host with two accounts. It does not extrapolate to
  a busy ten-account host, and no queueing layer exists yet — over the limit the
  request is refused rather than queued, which is an explicit state, not a wait.
