// RC-065 proof: hosted-account failure injection
// Establishes that the control plane correctly detects a container
// failure in a hosted account and does not falsely report "ready".
//
// Port base 34000: documented choice in the 34000-34999 range for
// RC-065 hosted failure proof.  The first account gets port 34000
// (plus the count of existing accounts on the fresh database).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC065_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const run = `rc065-hosted-${randomUUID()}`;
const network = `${run}-net`;
const image = process.env.RC065_IMAGE ?? "remotecode/host:local";
// Port base in 34000-34999 range for RC-065 hosted failure proof.
const portBase = 34_000 + Math.floor(Math.random() * 1000);
const apiPort = 26_000 + Math.floor(Math.random() * 300);
const databasePath = resolve(output, "control.sqlite");
const hostedLabel = "remotecode.hosted";
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");

let controlApi: ReturnType<typeof Bun.spawn> | undefined;
const steps: Record<string, any> = {};
let accountId = "";

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  if (result.exitCode) throw Error(`${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString().trim();
}

function optional(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}

async function stopControl() {
  const task = controlApi;
  controlApi = undefined;
  if (!task) return;
  try { task.kill(); } catch {}
  try { await task.exited; } catch {}
  await delay(300);
}

async function main() {
  const base = `http://127.0.0.1:${apiPort}`;

  // Step 1: Build image if absent, create network, start control plane.
  if (!optional("docker", "image", "inspect", image).out) {
    command("docker", "build", "-t", image, "-f", "prototype/Dockerfile", ".");
  }
  command("docker", "network", "create", "--label", `remotecode.rc065.hosted=${run}`, network);

  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
    } as any);
    return {
      status: response.status,
      body: await response.json().catch(() => null) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };

  const bootControl = async () => {
    controlApi = Bun.spawn(["bun", "apps/api/src/index.ts"], {
      cwd: repo,
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        DATABASE_PATH: databasePath,
        REMOTECODE_AUTH_PASSWORD: password,
        RC060_DOCKER: "docker",
        REMOTECODE_HOSTED_IMAGE: image,
        REMOTECODE_HOSTED_NETWORK: network,
        REMOTECODE_HOSTED_PORT_BASE: String(portBase),
        RC060_READY_TIMEOUT_MS: "90000",
      },
    });
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      try {
        if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).status === 200) return;
      } catch {}
      await delay(300);
    }
    throw Error("control_api_never_became_ready");
  };

  await bootControl();
  steps.step1 = "control_plane_started";

  // Step 2: Provision one hosted account and assert ready with containerId and hostPort.
  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;

  const account = await api("/api/hosted/accounts", "POST", { name: "RC065Test" }, cookie);
  if (account.status !== 201) throw Error(`provision_${account.status}_${JSON.stringify(account.body).slice(0, 200)}`);
  if (account.body.state !== "ready") throw Error(`provision_not_ready_${JSON.stringify(account.body).slice(0, 200)}`);
  if (!account.body.containerId) throw Error("provision_no_containerId");
  if (!account.body.hostPort) throw Error("provision_no_hostPort");
  accountId = account.body.id;
  steps.step2 = { id: accountId, containerId: account.body.containerId, hostPort: account.body.hostPort, state: "ready" };

  // Assert docker inspect shows container running with label remotecode.hosted=<id>.
  const inspected = JSON.parse(command("docker", "inspect", account.body.containerId))[0];
  if (inspected.State?.Running !== true) throw Error(`container_not_running_${account.body.containerId}`);
  const containerLabel = inspected.Config?.Labels?.[hostedLabel];
  if (containerLabel !== account.body.id) throw Error(`label_mismatch_${containerLabel}_expected_${account.body.id}`);
  steps.dockerInspect = { running: true, label: containerLabel };

  // Step 3: Assert the account serves on its own port before the failure.
  const readyBefore = await fetch(`http://127.0.0.1:${account.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(5000) } as any);
  if (readyBefore.status !== 200) throw Error(`account_not_serving_before_failure_${readyBefore.status}`);
  steps.step3 = { status: readyBefore.status };

  // Step 4: Inject the failure — docker kill the container id from the API's own answer.
  command("docker", "kill", account.body.containerId);
  steps.step4 = { method: "docker kill", containerId: account.body.containerId };

  // Step 5: Assert the account's port no longer answers readiness within a bounded wait.
  await delay(2000);
  const deadEnd = Date.now() + 30_000;
  let portDead = false;
  while (Date.now() < deadEnd) {
    try {
      const resp = await fetch(`http://127.0.0.1:${account.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(1000) } as any);
      if (resp.status === 200) { await delay(1000); continue; }
    } catch {}
    portDead = true;
    break;
  }
  if (!portDead) throw Error("port_still_answering_after_kill");
  steps.step5 = { portDead: true };

  // Step 6: Read the control plane's own record and assert it does not claim false success.
  const record = await api(`/api/hosted/accounts/${account.body.id}`, "GET", undefined, cookie);
  if (record.status !== 200) throw Error(`record_read_${record.status}`);
  console.log(JSON.stringify({ controlPlaneRecord: record.body }));
  steps.step6 = { record: record.body };

  if (record.body.state === "ready") {
    console.log(JSON.stringify({
      defect: "control_plane_reports_ready_after_container_death",
      record: record.body,
      codePath: "apps/api/src/features/hosted*.ts",
      grep: "grep apps/api/src/features/hosted*.ts",
    }));
    throw Error(
      "DEFECT: control plane reports account ready while container is gone. " +
      "Record: " + JSON.stringify(record.body) + ". " +
      "Code path: apps/api/src/features/hosted*.ts",
    );
  }
  steps.falseSuccessAsserted = { state: record.body.state, notReady: record.body.state !== "ready" };

  // Step 7: Assert no repeated or duplicated effect; resume the account.
  const containersAfterKill = command(
    "docker", "ps", "-a", "--filter", `label=${hostedLabel}=${account.body.id}`, "--format", "{{.Names}}",
  ).split("\n").filter(Boolean);
  if (containersAfterKill.length !== 1) throw Error(`expected_one_container_after_kill_${containersAfterKill.length}`);
  steps.step7a = { containerCountAfterKill: containersAfterKill.length };

  const resume = await api(`/api/hosted/accounts/${account.body.id}/resume`, "POST", undefined, cookie);
  if (resume.status !== 200 && resume.status !== 201) throw Error(`resume_${resume.status}_${JSON.stringify(resume.body).slice(0, 200)}`);

  const containersAfterResume = command(
    "docker", "ps", "-a", "--filter", `label=${hostedLabel}=${account.body.id}`, "--format", "{{.Names}}",
  ).split("\n").filter(Boolean);
  if (containersAfterResume.length !== 1) throw Error(`expected_one_container_after_resume_${containersAfterResume.length}`);

  const readyAfterResume = await fetch(`http://127.0.0.1:${account.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(5000) } as any);
  if (readyAfterResume.status !== 200) throw Error(`account_not_serving_after_resume_${readyAfterResume.status}`);
  steps.step7b = { containerCountAfterResume: containersAfterResume.length, portServing: true };

  // Step 8: Restart the control plane and re-read the account.
  await stopControl();
  await bootControl();
  const relogin = await api("/api/auth/login", "POST", { password });
  if (relogin.status !== 200) throw Error(`relogin_${relogin.status}`);
  const reread = await api(`/api/hosted/accounts/${account.body.id}`, "GET", undefined, relogin.cookie);
  if (reread.status !== 200) throw Error(`reread_${reread.status}`);

  if (reread.body.containerId !== account.body.containerId) throw Error(`reread_containerId_mismatch_${reread.body.containerId}_expected_${account.body.containerId}`);
  if (reread.body.hostPort !== account.body.hostPort) throw Error(`reread_hostPort_mismatch_${reread.body.hostPort}_expected_${account.body.hostPort}`);

  const readyAfterRestart = await fetch(`http://127.0.0.1:${reread.body.hostPort}/api/health/ready`, { signal: AbortSignal.timeout(5000) } as any);
  if (readyAfterRestart.status !== 200) throw Error(`account_not_serving_after_restart_${readyAfterRestart.status}`);
  steps.step8 = {
    state: reread.body.state,
    containerId: reread.body.containerId,
    hostPort: reread.body.hostPort,
    serving: true,
  };

  // Step 9: Write result.json and print PASS.
  const result = { result: "passed", scope: "RC-065 hosted-account failure injection", steps };
  writeFileSync(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(`PASS rc065-hosted-failure: ${JSON.stringify(steps)}`);
}

try {
  await main();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  const result = { result: "failed", scope: "RC-065 hosted-account failure injection", steps, error: msg };
  writeFileSync(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(`FAIL rc065-hosted-failure: ${msg}`);
  process.exitCode = 1;
} finally {
  await stopControl();
  // Remove containers created by this proof run.
  if (accountId) {
    const containers = optional("docker", "ps", "-a", "--filter", `label=${hostedLabel}=${accountId}`, "--format", "{{.Names}}").out.split("\n").filter(Boolean);
    for (const name of containers) { try { command("docker", "rm", "-f", name); } catch {} }
  }
  // Remove the dedicated network.
  try { command("docker", "network", "rm", network); } catch {}
  // Remove volumes created by this proof run.
  const volumes = optional("docker", "volume", "ls", "--filter", `label=remotecode.rc065.hosted=${run}`, "--format", "{{.Name}}").out.split("\n").filter(Boolean);
  for (const vol of volumes) { try { command("docker", "volume", "rm", vol); } catch {} }
}
