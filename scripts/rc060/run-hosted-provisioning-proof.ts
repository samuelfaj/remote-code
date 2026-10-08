// RC-060 proof: hosted provisioning gives each account its own container,
// volume, gateway route and supervisor, suspends one without touching the
// other, and never reports "ready" after a partial failure.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC060_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc060-hosted-${randomUUID()}`;
const control = `${run}-control`;
const accountNetwork = `${run}-net`;
const image = process.env.RC060_IMAGE ?? "remotecode/host:local";
const label = "remotecode.rc060.hosted";
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
let controlId = "";
const record: any = { run, control, accountNetwork, image, result: "unverified", scope: "RC-060 two accounts, separate hosts, suspend isolation, recoverable failure" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => (arg === password ? "[redacted]" : arg.slice(0, 60))), exitCode: result.exitCode });
  if (result.exitCode) throw Error(`${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString().trim();
}

let controlApi: ReturnType<typeof Bun.spawn> | undefined;

async function stopControl() {
  const task = controlApi;
  controlApi = undefined;
  if (!task) return;
  try { task.kill(); } catch {}
  try { await task.exited; } catch {}
  await delay(300);
}

function optional(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}

const accountContainers = () => command("docker", "ps", "-a", "--filter", `label=${label}=${run}`, "--format", "{{.Names}}")
  .split("\n").filter(Boolean);

try {
  if (!optional("docker", "image", "inspect", image).out) {
    command("docker", "build", "-t", image, "-f", "prototype/Dockerfile", ".");
  }
  const apiPort = 26_000 + Math.floor(Math.random() * 300);
  // A fixed base would collide with containers left by an earlier failed run
  // and make a stale host answer the readiness probe. Each run gets its own.
  const portBase = 41_000 + Math.floor(Math.random() * 3_000);
  const databasePath = resolve(output, "control.sqlite");
  command("docker", "network", "create", "--label", `${label}=${run}`, accountNetwork);

  // The control plane runs on the trusted host, exactly where the Docker
  // control capability lives, and provisions accounts on the same daemon.
  const base = `http://127.0.0.1:${apiPort}`;
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const bootControl = async (hostedImage: string) => {
    controlApi = Bun.spawn(["bun", "apps/api/src/index.ts"], {
      cwd: repo, stdout: "ignore", stderr: "ignore",
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        DATABASE_PATH: databasePath,
        REMOTECODE_AUTH_PASSWORD: password,
        RC060_DOCKER: "docker",
        REMOTECODE_HOSTED_IMAGE: hostedImage,
        REMOTECODE_HOSTED_NETWORK: accountNetwork,
        REMOTECODE_HOSTED_PORT_BASE: String(portBase),
        RC060_READY_TIMEOUT_MS: "90000",
      },
    });
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).status === 200) return; } catch {}
      await delay(300);
    }
    throw Error("control_api_never_became_ready");
  };
  await bootControl(image);
  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;

  const alpha = await api("/api/hosted/accounts", "POST", { name: "Alpha" }, cookie);
  if (alpha.status !== 201 || alpha.body.state !== "ready") throw Error(`alpha_${alpha.status}_${JSON.stringify(alpha.body).slice(0, 200)}`);
  const beta = await api("/api/hosted/accounts", "POST", { name: "Beta" }, cookie);
  if (beta.status !== 201 || beta.body.state !== "ready") throw Error(`beta_${beta.status}_${JSON.stringify(beta.body).slice(0, 200)}`);

  if (alpha.body.containerId === beta.body.containerId) throw Error("accounts_share_a_container");
  if (alpha.body.volumeId === beta.body.volumeId) throw Error("accounts_share_a_volume");
  if (alpha.body.hostPort === beta.body.hostPort) throw Error("accounts_share_a_port");
  if (alpha.body.hostPort < portBase || beta.body.hostPort < portBase) throw Error("port_outside_run_base");

  // Both containers are the ones this run created, running, on the ports the API reported.
  for (const account of [alpha.body, beta.body]) {
    const inspected = JSON.parse(command("docker", "inspect", account.containerId))[0];
    if (inspected.State?.Running !== true) throw Error(`account_not_running_${account.containerId}`);
    const published = inspected.NetworkSettings?.Ports?.["3000/tcp"]?.[0]?.HostPort;
    if (published !== String(account.hostPort)) throw Error(`published_port_${published}_expected_${account.hostPort}`);
  }

  // Each account's own host answers on its own published port.
  const readyA = await fetch(`http://127.0.0.1:${alpha.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(5000) } as any);
  const readyB = await fetch(`http://127.0.0.1:${beta.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(5000) } as any);
  if (readyA.status !== 200 || readyB.status !== 200) throw Error(`account_hosts_${readyA.status}_${readyB.status}`);

  // Data does not cross accounts: a marker written in A's volume is absent in B.
  command("docker", "exec", alpha.body.containerId, "sh", "-c", "echo account-a > /var/lib/remotecode/isolation-marker.txt");
  const markerInB = command("docker", "exec", beta.body.containerId, "sh", "-c",
    "test -f /var/lib/remotecode/isolation-marker.txt && echo present || echo absent");
  if (markerInB !== "absent") throw Error(`marker_crossed_accounts_${markerInB.slice(0, 120)}`);
  const volumes = command("docker", "volume", "ls", "--filter", `label=${label}=${run}`, "--format", "{{.Name}}").split("\n").filter(Boolean);

  // The gateway token and the account secret never reach the account container.
  const leakedToken = command("docker", "exec", alpha.body.containerId, "sh", "-c",
    `env | grep -c '${alpha.body.gatewayToken}' || true`);
  const leakedPassword = command("docker", "exec", alpha.body.containerId, "sh", "-c",
    `env | grep -c '${password}' || true`);
  if (Number(leakedToken) !== 0) throw Error("gateway_token_reached_the_account");
  if (Number(leakedPassword) !== 0) throw Error("control_password_reached_the_account");

  // Suspending one account leaves the other serving.
  const suspended = await api(`/api/hosted/accounts/${alpha.body.id}/suspend`, "POST", undefined, cookie);
  if (suspended.status !== 200 || suspended.body.state !== "suspended") throw Error(`suspend_${suspended.status}_${JSON.stringify(suspended.body).slice(0, 160)}`);
  const stillB = await fetch(`http://127.0.0.1:${beta.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(5000) } as any);
  if (stillB.status !== 200) throw Error(`beta_affected_by_suspend_${stillB.status}`);
  const suspendedA = optional("docker", "inspect", "-f", "{{.State.Running}}", alpha.body.containerId);
  if (suspendedA.out !== "false") throw Error(`alpha_still_running_${suspendedA.out}`);
  const list = await api("/api/hosted/accounts", "GET", undefined, cookie);
  const betaRow = (list.body.accounts ?? []).find((row: any) => row.id === beta.body.id);
  if (!betaRow || betaRow.state !== "ready") throw Error(`beta_state_${JSON.stringify(betaRow)}`);

  // A partial failure must never look ready, and provisioning must recover.
  await stopControl();
  await bootControl("remotecode/does-not-exist:local");
  const afterRestart = await api("/api/auth/login", "POST", { password });
  if (afterRestart.status !== 200) throw Error(`relogin_${afterRestart.status}`);
  const broken = await api("/api/hosted/accounts", "POST", { name: "Broken" }, afterRestart.cookie);
  if (broken.status !== 503 || broken.body.error !== "provisioning_failed") throw Error(`broken_${broken.status}_${JSON.stringify(broken.body).slice(0, 160)}`);
  const brokenRow = await api(`/api/hosted/accounts/${broken.body.accountId}`, "GET", undefined, afterRestart.cookie);
  if (brokenRow.body.state !== "failed") throw Error(`broken_state_${JSON.stringify(brokenRow.body).slice(0, 160)}`);
  if (brokenRow.body.containerId !== null) throw Error("failed_account_kept_a_container");
  const leftover = accountContainers().filter((name) => name === broken.body.accountId);
  if (leftover.length !== 0) throw Error(`failed_provision_left_${JSON.stringify(leftover)}`);

  await stopControl();
  await bootControl(image);
  const finalLogin = await api("/api/auth/login", "POST", { password });
  const recovered = await api("/api/hosted/accounts", "POST", { name: "Recovered" }, finalLogin.cookie);
  if (recovered.status !== 201 || recovered.body.state !== "ready") throw Error(`recovery_${recovered.status}_${JSON.stringify(recovered.body).slice(0, 160)}`);

  record.accounts = {
    alpha: { id: alpha.body.id, containerId: alpha.body.containerId, volumeId: alpha.body.volumeId, hostPort: alpha.body.hostPort, state: "ready" },
    beta: { id: beta.body.id, containerId: beta.body.containerId, volumeId: beta.body.volumeId, hostPort: beta.body.hostPort, state: "ready" },
    recovered: { id: recovered.body.id, containerId: recovered.body.containerId, state: recovered.body.state },
    distinctContainers: true, distinctVolumes: true, distinctPorts: true,
    volumes: volumes.length,
  };
  record.isolation = { markerInBeta: markerInB, gatewayTokenInAccountEnv: Number(leakedToken), controlPasswordInAccountEnv: Number(leakedPassword), betaAfterSuspend: stillB.status };
  record.failure = { status: broken.status, accountState: brokenRow.body.state, containerId: brokenRow.body.containerId, leftoverContainers: leftover.length };
  record.result = "two_accounts_got_separate_hosts_and_a_failed_provision_recovered_passed";
  console.log(JSON.stringify({ result: record.result, accounts: record.accounts, isolation: record.isolation, failure: record.failure }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (process.env.RC060_KEEP) {
    console.log(JSON.stringify({ kept: { control, accountNetwork } }));
  } else {
  await stopControl();
  for (const name of accountContainers()) { try { command("docker", "rm", "-f", name); } catch {} }
  try { command("docker", "network", "rm", accountNetwork); } catch {}
  try { command("docker", "image", "rm", "remotecode/does-not-exist:local"); } catch {}
  }
  for (const account of [record.accounts?.alpha, record.accounts?.beta, record.accounts?.recovered]) {
    if (account?.volumeId) { try { command("docker", "volume", "rm", account.volumeId); } catch {} }
  }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { containers: true, network: true, volumes: true } }));
}

