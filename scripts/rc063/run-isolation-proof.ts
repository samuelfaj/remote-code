// RC-063 proof: try to cross the isolation boundaries from the outside and from
// inside an account. Two real hosted accounts, a real gateway, and an intruder
// session that owns nothing.
//
// Every check below either returns data or does not; a 404/401/403/409 that the
// record shows is the evidence that the path is closed.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC063_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const run = `rc063-${randomUUID().slice(0, 8)}`;
// Built from the tree under test: the account must run the current API, not
// whatever an older tag happens to point at.
const image = process.env.RC063_IMAGE ?? `rc063-host-${randomUUID().slice(0, 8)}:local`;
const accountNetwork = `${run}-net`;
const databasePath = resolve(output, "control.sqlite");
const apiPort = 30_000 + Math.floor(Math.random() * 400);
const gatewayPort = 28_000 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${apiPort}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-063 cross-account, revoked token, direct screen URL, agent secret and volume access" };

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}
function mustDocker(...args: string[]) {
  const result = docker(...args);
  if (result.code !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.err.slice(0, 300)}`);
  return result.out;
}

let controlApi: ReturnType<typeof Bun.spawn> | undefined;
let gateway: ReturnType<typeof Bun.spawn> | undefined;

async function stopAll() {
  for (const task of [controlApi, gateway]) {
    if (!task) continue;
    try { task.kill("SIGKILL"); } catch {}
    try { await task.exited; } catch {}
  }
  controlApi = undefined;
  gateway = undefined;
  await delay(300);
}

let cookie = "";
async function api(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any, setCookie: response.headers.get("set-cookie") ?? "" };
}

try {
  mustDocker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = { reference: image, id: mustDocker("image", "inspect", "-f", "{{.Id}}", image).slice(0, 19) };
  mustDocker("network", "create", "--label", `remotecode.rc063=${run}`, accountNetwork);

  controlApi = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: repo, stdout: "ignore", stderr: "ignore",
    env: {
      ...process.env,
      API_PORT: String(apiPort), DATABASE_PATH: databasePath, REMOTECODE_AUTH_PASSWORD: password,
      RC060_DOCKER: "docker", REMOTECODE_HOSTED_IMAGE: image, REMOTECODE_HOSTED_NETWORK: accountNetwork,
      REMOTECODE_HOSTED_PORT_BASE: String(36_000 + Math.floor(Math.random() * 1_200)),
      REMOTECODE_HOSTED_MAX_ACCOUNTS: "4", RC060_READY_TIMEOUT_MS: "120000",
    },
  });
  const readyEnd = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < readyEnd) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1200) })).status === 200) { ready = true; break; } } catch {}
    await delay(300);
  }
  if (!ready) throw Error("control_api_never_became_ready");

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  cookie = login.headers.get("set-cookie")!.split(";")[0];

  const alpha = await api("/api/hosted/accounts", "POST", { name: "Alpha" });
  const beta = await api("/api/hosted/accounts", "POST", { name: "Beta" });
  if (alpha.status !== 201 || beta.status !== 201) throw Error(`provision_${alpha.status}_${beta.status}`);
  const alphaId = alpha.body.id;
  const betaId = beta.body.id;
  record.accounts = {
    alpha: { id: alphaId, port: alpha.body.hostPort, volume: alpha.body.volumeId },
    beta: { id: betaId, port: beta.body.hostPort, volume: beta.body.volumeId },
  };

  // A second user's session, created against the shipped session table exactly
  // as the repository's own tests do, so the owner boundary can be attacked.
  const intruderToken = randomBytes(32).toString("hex");
  {
    const database = new Database(databasePath);
    database.query("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)")
      .run();
    const { createHash } = await import("node:crypto");
    database.query("INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(intruderToken).digest("hex"), "intruder", Date.now() + 600_000);
    database.close();
  }
  const intruder = { cookie: `remotecode_session=${intruderToken}` };

  // 1. Another account's id, and an id that exists nowhere.
  const crossAccount = await api(`/api/hosted/accounts/${betaId}`, "GET", undefined, { cookie: intruder.cookie });
  const unknownAccount = await api(`/api/hosted/accounts/${randomUUID()}`, "GET");
  const crossSuspend = await api(`/api/hosted/accounts/${betaId}/suspend`, "POST", undefined, { cookie: intruder.cookie });
  const crossUpdate = await api(`/api/hosted/accounts/${betaId}/update`, "POST", { image: "remotecode/does-not-exist:local" }, { cookie: intruder.cookie });
  if (crossAccount.status !== 404) throw Error(`intruder_read_another_account_${crossAccount.status}`);
  if (unknownAccount.status !== 404) throw Error(`unknown_account_${unknownAccount.status}`);
  if (crossSuspend.status !== 404) throw Error(`intruder_suspended_another_account_${crossSuspend.status}`);
  if (crossUpdate.status !== 404) throw Error(`intruder_updated_another_account_${crossUpdate.status}`);
  const stillRunning = await api(`/api/hosted/accounts/${betaId}`);
  if (stillRunning.body?.state !== "ready") throw Error(`intruder_changed_the_account_state_${stillRunning.body?.state}`);

  // 2. A revoked token.
  const logout = await api("/api/auth/logout", "POST");
  if (logout.status !== 200 && logout.status !== 204) throw Error(`logout_${logout.status}`);
  const revoked = await api("/api/hosted/accounts");
  const revokedAnonymous = await fetch(`${base}/api/hosted/accounts`, { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
  if (revoked.status !== 401 || revokedAnonymous.status !== 401) throw Error(`revoked_token_still_worked_${revoked.status}_${revokedAnonymous.status}`);
  // Sign back in for the remaining checks.
  const relogin = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  cookie = relogin.headers.get("set-cookie")!.split(";")[0];

  // 3. The gateway: no token, a forged token, and the real one.
  const routes = { [alpha.body.gatewayToken]: `http://${alphaId}:3000` };
  gateway = Bun.spawn(["bun", "apps/gateway/src/index.ts"], {
    cwd: repo, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, RC011_ROUTES: JSON.stringify(routes), RC011_PORT: String(gatewayPort), RC011_UPSTREAM_TIMEOUT_MS: "5000" },
  });
  let gatewayReady = false;
  const gatewayEnd = Date.now() + 30_000;
  while (Date.now() < gatewayEnd) {
    try { if ((await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, { signal: AbortSignal.timeout(1000) })).status === 200) { gatewayReady = true; break; } } catch {}
    await delay(300);
  }
  if (!gatewayReady) throw Error("gateway_never_became_ready");
  const gatewayNoToken = await fetch(`http://127.0.0.1:${gatewayPort}/api/health/ready`, { signal: AbortSignal.timeout(20_000) });
  const gatewayForged = await fetch(`http://127.0.0.1:${gatewayPort}/api/health/ready`, {
    headers: { "x-rc-gateway-token": "forged-" + randomUUID() }, signal: AbortSignal.timeout(20_000),
  });
  const gatewayBetaWithAlphaToken = await fetch(`http://127.0.0.1:${gatewayPort}/api/health/ready`, {
    headers: { "x-rc-gateway-token": beta.body.gatewayToken }, signal: AbortSignal.timeout(20_000),
  });
  if (gatewayNoToken.status !== 401) throw Error(`gateway_without_token_${gatewayNoToken.status}`);
  if (gatewayForged.status !== 401) throw Error(`gateway_forged_token_${gatewayForged.status}`);
  if (gatewayBetaWithAlphaToken.status !== 401) throw Error(`gateway_route_for_another_account_${gatewayBetaWithAlphaToken.status}`);

  // 4. Direct screen access: the workspace route with no token, and with a token
  //    that was never issued.
  const workspace = await api("/api/workspaces", "POST", { name: "rc063-isolation" });
  const workspaceId = workspace.body?.id ?? workspace.body?.workspace?.id;
  if (!workspaceId) throw Error(`workspace_${workspace.status}`);
  const noTokenFrame = await fetch(`${base}/api/workspaces/${workspaceId}/screen/frame`, { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
  const forgedFrame = await fetch(`${base}/api/workspaces/${workspaceId}/screen/frame`, {
    headers: { cookie, "x-rc-possession": randomBytes(32).toString("hex") }, signal: AbortSignal.timeout(20_000),
  });
  const intruderPreview = await fetch(`${base}/api/workspaces/${workspaceId}/screen/preview`, {
    method: "POST", headers: { cookie: intruder.cookie, "content-type": "application/json" }, body: JSON.stringify({ botId: randomUUID() }),
    signal: AbortSignal.timeout(20_000),
  });
  if (noTokenFrame.status !== 409 || forgedFrame.status !== 409) throw Error(`direct_screen_url_${noTokenFrame.status}_${forgedFrame.status}`);
  if (intruderPreview.status !== 404) throw Error(`intruder_preview_${intruderPreview.status}`);

  // 5. Inside the account: the agent identity must not read the database, and no
  //    service secret may be visible to it.
  const agentUser = "1001";
  const readDatabase = docker("exec", "-u", agentUser, alphaId, "sh", "-c", "cat /var/lib/remotecode/remotecode.sqlite > /dev/null && echo READ || echo DENIED");
  const readSecret = docker("exec", "-u", agentUser, alphaId, "sh", "-c", "env | grep -E 'RC063|REMOTECODE|GW_' || true");
  const readProcEnv = docker("exec", "-u", agentUser, alphaId, "sh", "-c", "cat /proc/1/environ | tr '\\0' '\\n' | grep -E 'REMOTECODE|RC063' || echo DENIED");
  if (readDatabase.out.includes("READ")) throw Error("agent_read_the_service_database");
  // `docker exec` hands the container's own configured environment to the exec
  // process, so the account's own credential shows up by design. What must never
  // appear is the control plane's password or another account's gateway token.
  if (readSecret.out.includes(password)) throw Error("agent_saw_the_control_password");
  if (readSecret.out.includes(alpha.body.gatewayToken) || readSecret.out.includes(beta.body.gatewayToken)) {
    throw Error("agent_saw_a_gateway_token");
  }
  if (readProcEnv.out.includes(password) || readProcEnv.out.includes(alpha.body.gatewayToken)) throw Error("agent_read_pid1_secrets");

  // 6. The other account's volume is not mounted here, and its API does not
  //    answer an unauthenticated caller.
  const alphaMounts = mustDocker("inspect", "-f", "{{range .Mounts}}{{.Name}} {{end}}", alphaId);
  const betaMounts = mustDocker("inspect", "-f", "{{range .Mounts}}{{.Name}} {{end}}", betaId);
  if (alphaMounts.includes(`${betaId}-data`) || betaMounts.includes(`${alphaId}-data`)) throw Error("accounts_share_a_volume");
  const crossNetworkReady = docker("exec", alphaId, "sh", "-c", `curl -s -m 5 -o /dev/null -w '%{http_code}' http://${betaId}:3000/api/health/ready || echo FAILED`);
  // The readiness probe is deliberately unauthenticated, so reachability alone
  // is recorded rather than fatal; what must never answer is a data route.
  const crossNetworkData = docker("exec", alphaId, "sh", "-c",
    `curl -s -m 5 -w '\nHTTP %{http_code}' http://${betaId}:3000/api/bots || echo FAILED`);
  const crossNetworkBilling = docker("exec", alphaId, "sh", "-c",
    `curl -s -m 5 -w '\nHTTP %{http_code}' http://${betaId}:3000/api/hosted/accounts || echo FAILED`);
  const crossVolume = docker("exec", alphaId, "sh", "-c", `test -f /var/lib/remotecode/../../${betaId}-data/remotecode.sqlite && echo READ || echo DENIED`);
  if (/HTTP 2\d\d/.test(crossNetworkData.out) || /HTTP 2\d\d/.test(crossNetworkBilling.out)) {
    throw Error(`another_account_answered_a_data_route_${crossNetworkData.out.slice(-12)}_${crossNetworkBilling.out.slice(-12)}`);
  }
  if (crossVolume.out.includes("READ")) throw Error("another_account_volume_was_readable");

  record.boundaries = {
    crossAccountRead: { status: crossAccount.status },
    unknownAccount: { status: unknownAccount.status },
    crossAccountSuspend: { status: crossSuspend.status },
    crossAccountUpdate: { status: crossUpdate.status },
    accountUntouchedByIntruder: stillRunning.body?.state,
    revokedToken: { api: revoked.status, direct: revokedAnonymous.status },
    gateway: { noToken: gatewayNoToken.status, forged: gatewayForged.status, otherAccountsRoutesOnly: gatewayBetaWithAlphaToken.status },
    directScreen: { noToken: noTokenFrame.status, forgedToken: forgedFrame.status, intruderPreview: intruderPreview.status },
    agentIdentity: {
      databaseRead: readDatabase.out.trim(),
      pidOneSecrets: readProcEnv.out.trim(),
      containerEnvironmentKeys: readSecret.out.split("\n").map((line) => line.split("=")[0]).filter(Boolean),
      crossBoundarySecretInEnvironment: false,
    },
    volumes: { alpha: alphaMounts, beta: betaMounts, crossVolume: crossVolume.out.trim() },
    crossAccountApi: {
      readinessProbe: crossNetworkReady.out.trim(),
      dataRoute: crossNetworkData.out.slice(-120).trim(),
      billingRoute: crossNetworkBilling.out.slice(-120).trim(),
    },
  };

  record.note = "The auth model has one password for one user, so \"another user\" is a real second session for a different user id created in the shipped session table, the way this repository's own tests do.";
  record.result = "no_path_read_or_controlled_another_account_and_the_agent_saw_no_secret_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  await stopAll();
  if (!process.env.RC063_KEEP) {
    for (const id of [record.accounts?.alpha?.id, record.accounts?.beta?.id]) {
      if (id) { docker("rm", "-f", id); docker("volume", "rm", "-f", `${id}-data`); }
    }
    docker("network", "rm", accountNetwork);
    if (!process.env.RC063_IMAGE) docker("image", "rm", "-f", image);
    record.cleanup = { containers: true, network: true, volumes: true, image: !process.env.RC063_IMAGE };
  }
}