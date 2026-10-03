# RC-011 container-routing prerequisite — frozen design packet

## Charter

- Goal: continue the active RemoteCode plan with evidence-backed implementation and scoped publication; do not restart the goal.
- Decision: determine a safe, testable design to supply the container-routing prerequisite for RC-011.
- Profile/topology: full, single-host; all blind seats use distinct native reasoning workers. Host-default model/effort; no second provider requested or claimed.
- Packet head: `9f011c1b74e253c5f20f033b91f4e52cd28bfb70`; current tree has only pre-existing untracked `scripts/__pycache__/`.
- Authority: repository writes, network, commit, push are true in `.sam-harness/config.yaml` and `.sam-harness/DELEGATION.md`; release/deploy are false. User authorized checkpoint pushes and autonomous task decisions.
- No-go: no deployment, credential changes, external account provisioning, X post absent a verified product milestone, Distill prompt, Distill history search, authentication for reconciliation, or action that assumes the old RC-002 prompt failed/succeeded. RC-002 remains unknown and gated.

## T-001 thesis

### Objective and problem frame

Provide the missing container-routing prerequisite so RC-011 can be re-evaluated against its unchanged acceptance criteria. The current backend authenticates only a local identity; `prototype/compose.yaml` exposes one API/web container on loopback; no gateway or per-account routing exists. A client-supplied account/container identifier cannot be an authorization source. The route must bind a successfully authenticated server-side gateway session to one preconfigured tenant host, keep gateway-only credentials out of tenant containers/agent process environments, isolate tenant networks, proxy API and WebSocket traffic, and fail within a fixed deadline when a host is unavailable.

### Scope

1. Add a standalone gateway service for preconfigured test/managed account records, authenticating account ID plus password and issuing a gateway-owned HttpOnly session.
2. Bind each opaque gateway session server-side to exactly one account and configured tenant service; ignore/strip client-supplied routing identity/target headers.
3. Forward HTTP and WebSocket API traffic with a gateway-signed short-lived identity assertion; tenant API verifies signature and audience using a public key. Keep the signing private key and account credential hashes only in the gateway environment. Never put a routing credential in tenant service configuration or agent/terminal environment.
4. Provide a Docker Compose proof fixture with two API-only tenant containers on distinct private networks and the gateway on both networks; do not add Docker socket access. Tenant containers publish no API ports to the host.
5. Add focused unit, real API integration, and browser E2E proof: account A/B route to their own distinct persistent action IDs; A cannot select or read B by changing input/header; clients cannot directly reach tenant API ports; WebSocket events traverse gateway; logout revokes gateway session/socket; unavailable target returns a bounded error.
6. Update handoff records and re-evaluate all task Starts/dependencies; do not change RC-011 task criteria or claim acceptance unless its full original proof and failure conditions pass.

### Constraints and invariants

- Preserve the existing standalone local development flow unless explicit managed-gateway mode is configured.
- Do not trust client-provided user ID, host ID, target URL, or forwarding identity.
- In gateway mode, malformed, expired, wrong-audience, wrong-signature, or missing assertions fail closed; never fall back to a local cookie identity.
- Strip inbound auth/identity/forwarding headers before adding the gateway assertion. Never log passwords, cookies, assertions, private keys, or account hashes.
- Tenant A and tenant B networks are disjoint; only the trusted gateway joins both. No host port is published for tenant API services.
- Network timeout is bounded; no request waits indefinitely for Docker or a tenant service. No unbounded retries.
- Do not weaken any plan acceptance criterion. Keep RC-012/014 partial as applicable and RC-002 unknown.
- Documentation and product code tests must use the existing actual gateway/API paths. Browser verification is required if UI changes.

### Alternatives

1. Trust a client-selected account header or URL target: rejected because it permits tenant reassignment/SSRF and does not bind a session to an account.
2. Share one tenant Docker network or mount the Docker socket into a tenant/gateway exposed to agent processes: rejected because it expands lateral reach or management privilege.
3. Add only a mocked route resolver: rejected as insufficient proof for container isolation and real HTTP/WebSocket forwarding.
4. Use configured account-to-service mapping and isolated Compose networks, with an Ed25519 gateway assertion verified by each API: selected as the smallest local implementation that can be exercised with the available Docker runtime and does not give tenant processes a signing secret or Docker socket.
5. Defer all work until dynamic provisioning exists: rejected as not required to verify configured account routing, but dynamic account/container provisioning remains out of scope and will be recorded as a limit unless the original task requires it.

### Steps and proof gates

1. Implement strict account/session binding and signature verification; unit test tampered, missing, expired, and wrong-audience assertions plus spoofed route headers.
2. Exercise a real Elysia API behind the gateway for two different account identities; verify routes, data isolation, logout, and WebSocket update flow.
3. Build and run the proof fixture using the installed Docker daemon (client/server 29.4.0, Linux arm64 engine); confirm private tenant APIs have no published host ports and peer tenant networks cannot reach one another. Do not claim native Linux host proof beyond this actual Linux container engine; report host details.
4. Exercise gateway in Chromium/Playwright with account A and B and backend readback; falsify with altered account headers and target unavailability.
5. Run current tree typecheck, unit/integration tests, E2E, Vite build as needed, docs-link check, `git diff --check`, and configured Sam Harness static/test gates.
6. Obtain exact-patch independent reasoning review; repair findings and repeat relevant checks. Publish a scoped checkpoint and verify remote SHA/CI.

### Success criteria

- The same login/account session always maps to the server-configured tenant, independent of request path/query/header manipulation.
- A and B each create/read only their own distinct backend action IDs through the gateway; the wrong host never serves the request.
- Tenant API ports are not host-published and A cannot connect to B's API over the proof networks.
- WebSocket snapshot/event and logout/revocation behavior function through the gateway.
- Missing tenant/deadline failures return a documented non-success response within the configured upper bound.
- Gateway private signing material and account credential hashes are not present in tenant container env/mounts/process args; identity assertions are not passed to agent/terminal as environment values.
- Original RC-011 acceptance and failure criteria are checked separately; unresolved managed-account provisioning, security isolation, or proof keeps RC-011 unaccepted.

### Rollout, rollback, observability

- Local proof Compose file only; no live deployment or change to the default single-container Compose workflow.
- Rollback by removing the optional gateway/proof fixture and retaining standalone API behavior; no database migration is planned.
- Do not log request bodies, cookies, authorization, assertions, credential hashes, or private keys. Log only redacted outcome, target account identifier only if treated as non-secret, status class, and elapsed duration.

### Residual risks and recheck triggers

- Static trusted account-to-service configuration may not equal production dynamic provisioning; check against any explicit RC-011 requirement before acceptance.
- A gateway compromise can access all tenant routes; the gateway is a trusted multi-tenant boundary and must not share a process/container with Distill.
- Tenant API process isolation from other same-container processes remains RC-015; this work only avoids injecting gateway secrets/tokens into the tenant process environment.
- WebSocket forwarding, request aborts, and logout socket closure can race; test the real path.
- Recheck if deployment target, trust boundaries, account/session contract, expected container provisioning lifecycle, API routes, or Docker availability changes.

### Assumptions ledger

- A-001 (EXPERIMENT_PLANNED): RC-011 permits preconfigured account-to-service entries as the initial gateway registry; verify by matching the full task/plan language and real two-account proof. Owner: implementation agent. Pass: no signup/dynamic provisioning criterion exists and two independent configured accounts meet its executable proof.
- A-002 (EXPERIMENT_PLANNED): isolated Docker networks without Docker socket access are sufficient to demonstrate gateway-to-host routing while blocking tenant-to-tenant direct access. Verify by live cross-network connect attempts and request-level proof. Owner: implementation agent. Pass: only gateway can reach both API services; tenant A cannot reach B; neither API has a host-published port.
- A-003 (EXPERIMENT_PLANNED): an Ed25519 assertion with per-host audience is an acceptable internal identity mechanism that does not expose signing authority to tenant hosts. Verify by signature/audience/expiry tamper tests and env/mount/argv inspection. Owner: implementation agent. Pass: invalid token rejected by real API, valid token accepted only at intended host, signing private key absent from tenant service.
- A-004 (UNKNOWN): the required native/runtime guarantee for isolating a tenant API from an agent process sharing the same OS/container identity. This is not claimed solved; RC-015 remains separately gated by RC-002 and may keep RC-011 incomplete if the failure criterion requires stronger isolation.

### Evidence index

- E-001 VERIFIED: RC-011 Start, delivery, executable proof, failure criteria; `plan/tasks.html`, task `#rc-011` (full task content available in repository).
- E-002 VERIFIED: RC-011 directly depends on RC-010; task metadata in `plan/tasks.html`.
- E-003 VERIFIED: current auth emits only user ID `local` and validates host password/session; `apps/api/src/features/auth.ts:1-180`.
- E-004 VERIFIED: API app uses the database-backed auth feature and action/storage routes; `apps/api/src/app.ts:1-34`.
- E-005 VERIFIED: current Compose has one API/web service, loopback-published ports, one volume; `prototype/compose.yaml:1-15`.
- E-006 VERIFIED: current image starts API, web, and Distill in one container process environment; `prototype/Dockerfile` and `prototype/start.sh`.
- E-007 VERIFIED: the product architecture requires gateway account identity and routing to one user container; `plan/index.html` sections “Account and gateway” and “Isolate backend from agent actions”.
- E-008 VERIFIED: Docker Engine is available as Linux arm64, client/server 29.4.0; command `docker version --format 'client={{.Client.Version}} server={{.Server.Version}} os={{.Server.Os}} arch={{.Server.Arch}}'`.
- E-009 VERIFIED: branch and remote at `9f011c1b74e253c5f20f033b91f4e52cd28bfb70`; latest PR #2 static/test checks passed; `git status` preserves unrelated `scripts/__pycache__/`.
- E-010 VERIFIED: `distill subagent begin --node council-rc011-logic` failed immediately with exit 2, “unrecognized subcommand 'begin'”. Council child telemetry unavailable; one proof gap, per skill, and skip all other telemetry brackets. This is not a model prompt and did not inspect/retry the unresolved RC-002 action.

### Conditional specialist selection

- SELECTED security-privacy: account/session binding, tenancy, signing material, and direct-port isolation are load-bearing.
- SELECTED reliability-performance: bounded proxy/tenant unavailability is explicit in the task's failure clause.
- SELECTED api-compatibility: HTTP, signed identity, and WebSocket proxy contracts are being introduced.
- SELECTED testability-release: acceptance depends on executable two-container/network proof and safe local fixture lifecycle.
- SELECTED operations-observability: tenant/Docker dependency failure must terminate and report without false success or secret logging.
- SELECTED product-ux: gateway login/logout, authorization, and error behavior affect user-visible session flow.
- NOT_APPLICABLE data-migration: no persisted schema change is planned for gateway sessions in this thesis.
- NOT_APPLICABLE cost-dependency: no paid provider or new external runtime dependency is planned.
- NOT_APPLICABLE compliance-governance: this local prototype adds no production data jurisdiction or legal policy; access control review is covered by security-privacy.

## Verbatim blind-seat mission

> Try to falsify this system-development thesis within your assigned lens only. Find at most three concrete, load-bearing failure mechanisms, most severe and best supported first; prefer one causal mechanism over stylistic remarks. Use the supplied evidence; separate fact, inference, assumption, and missing evidence; name the proof that would settle each uncertainty and the smallest sufficient correction. Never approve by deference or vote. Return `NO_MATERIAL_OBJECTION` when that is honest. Stay under 1,000 words and stop at the cap. Return the response only as your final result; write no files. Response fields: `reviewer_id`, `provider`, `thesis_id`, `search_summary`, `verdict` (`OBJECTIONS|NO_MATERIAL_OBJECTION|BLOCKED`), `objections` (0-3, each `claim` (falsifiable), `failure_mode`, `severity` (`BLOCKER|HIGH|MEDIUM|LOW|UNSUPPORTED`), `confidence` (0-100), `premise_ids`, `evidence_ids`, `required_proof`, `smallest_correction`), `disconfirming_evidence`, `residual_uncertainty`. Reject a response with more than 3 objections, a missing search, failure mechanism, or disconfirming evidence, or a blindness violation.
