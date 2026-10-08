// RC-062 proof: an image update migrates a data copy, swaps the account onto
// the new image without losing workspaces, Bots or routines, rolls back when
// the new version cannot serve, and never resumes an update interrupted by a
// host crash. Real Docker on this host; nothing is faked.
import { randomBytes, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC062_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const baseImage = process.env.RC062_BASE_IMAGE ?? "remotecode/host:local";
const newImage = `rc062-new-${randomUUID().slice(0, 8)}:local`;
const brokenImage = `rc062-broken-${randomUUID().slice(0, 8)}:local`;
const run = `rc062-${randomUUID().slice(0, 8)}`;
const accountNetwork = `${run}-net`;
const databasePath = resolve(output, "control.sqlite");
const apiPort = 28_000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${apiPort}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-062 update on a data copy, rollback, crash recovery" };

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

function bootControl() {
  controlApi = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: repo, stdout: "ignore", stderr: "ignore",
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      DATABASE_PATH: databasePath,
      REMOTECODE_AUTH_PASSWORD: password,
      RC060_DOCKER: "docker",
      REMOTECODE_HOSTED_IMAGE: baseImage,
      REMOTECODE_HOSTED_NETWORK: accountNetwork,
      REMOTECODE_HOSTED_PORT_BASE: String(36_000 + Math.floor(Math.random() * 1_500)),
      RC060_READY_TIMEOUT_MS: "120000",
    },
  });
}

async function stopControl() {
  const task = controlApi;
  controlApi = undefined;
  if (!task) return;
  try { task.kill("SIGKILL"); } catch {}
  try { await task.exited; } catch {}
  await delay(400);
}

async function waitApiReady() {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1200) })).status === 200) return; } catch {}
    await delay(300);
  }
  throw Error("control_api_never_became_ready");
}

function updateRows() {
  const database = new Database(databasePath);
  try {
    return database.query("SELECT id, state, step, error, from_image, to_image FROM hosted_updates ORDER BY started_at").all() as any[];
  } finally { database.close(); }
}

/** Waits until an update row reaches one of the given states, then returns it. */
async function waitForState(states: string[], timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const row of updateRows()) {
      if (states.includes(row.state)) return row;
    }
    await delay(120);
  }
  return null;
}

function volumeNames(label: string) {
  const out = docker("volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}");
  return out.out.split("\n").filter(Boolean);
}

let cookie = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

try {
  if (docker("image", "inspect", "-f", "{{.Id}}", baseImage).code !== 0) {
    mustDocker("build", "-q", "-t", baseImage, "-f", "prototype/Dockerfile", ".");
  }
  // A genuinely different image: same application plus a version marker.
  docker("rm", "-f", `${run}-seed`);
  // `docker commit` keeps the container's own command, so the seed container's
  // command is overridden and the image's original entrypoint is restored
  // explicitly; otherwise the new image would just sleep and never serve.
  const baseCmd = mustDocker("inspect", "-f", "{{json .Config.Cmd}}", baseImage);
  const baseEntrypoint = mustDocker("inspect", "-f", "{{json .Config.Entrypoint}}", baseImage);
  const commitChanges = [
    ...(baseCmd !== "null" ? ["--change", `CMD ${baseCmd}`] : []),
    ...(baseEntrypoint !== "null" ? ["--change", `ENTRYPOINT ${baseEntrypoint}`] : []),
  ];
  mustDocker("run", "-d", "--name", `${run}-seed`, baseImage, "sleep", "infinity");
  mustDocker("exec", `${run}-seed`, "sh", "-c", "echo v2 > /etc/remotecode-version");
  mustDocker("commit", ...commitChanges, `${run}-seed`, newImage);
  mustDocker("exec", `${run}-seed`, "sh", "-c", "rm -f /workspace/apps/api/src/index.ts");
  mustDocker("commit", ...commitChanges, `${run}-seed`, brokenImage);
  docker("rm", "-f", `${run}-seed`);
  record.images = { base: baseImage, new: newImage, broken: brokenImage };

  mustDocker("network", "create", "--label", `remotecode.rc062=${run}`, accountNetwork);
  bootControl();
  await waitApiReady();

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  cookie = login.headers.get("set-cookie")!.split(";")[0];

  // Work the update must not lose.
  const workspace = await api("/api/workspaces", "POST", { name: "rc062-workspace" });
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);
  const workspaceId = workspace.body?.id ?? workspace.body?.workspace?.id;
  const bot = await api("/api/bots", "POST", { name: "RC062Bot" });
  if (bot.status !== 201) throw Error(`bot_${bot.status}`);
  const routine = await api("/api/schedules", "POST", { kind: "routine", botId: bot.body.id, workspaceId, prompt: "rc062 routine", localTime: "07:30", timezone: "UTC" });
  if (routine.status !== 201 && routine.status !== 200) throw Error(`routine_${routine.status}_${JSON.stringify(routine.body)}`);

  const account = await api("/api/hosted/accounts", "POST", { name: "UpdateAlpha" });
  if (account.status !== 201 || account.body.state !== "ready") throw Error(`account_${account.status}_${JSON.stringify(account.body)}`);
  const accountId = account.body.id;
  const accountPort = account.body.hostPort;
  const accountEnv = mustDocker("inspect", "-f", "{{json .Config.Env}}", accountId);
  const accountNetworkMode = mustDocker("inspect", "-f", "{{json .HostConfig.NetworkMode}}", accountId).replace(/"/g, "");
  record.before = { account: accountId, hostPort: accountPort, network: accountNetworkMode, keepsSecret: accountEnv.includes("REMOTECODE_AUTH_PASSWORD") };

  const accountReady = async () => (await fetch(`http://127.0.0.1:${accountPort}/api/health/ready`, { signal: AbortSignal.timeout(5_000) })).status;
  const accountImage = () => mustDocker("inspect", "-f", "{{.Config.Image}}", accountId);
  const dataSurvives = async () => {
    const bots = (await api("/api/bots")).body?.bots ?? [];
    const routines = (await api(`/api/schedules`)).body?.schedules ?? (await api("/api/schedules")).body ?? [];
    const workspaces = (await api("/api/workspaces")).body?.workspaces ?? [];
    return {
      bot: bots.some((entry: any) => entry.name === "RC062Bot"),
      routine: JSON.stringify(routines).includes("RC062Bot") || JSON.stringify(routines).includes(workspaceId),
      workspace: JSON.stringify(workspaces).includes("rc062-workspace"),
    };
  };
  const before = await dataSurvives();
  if (!before.bot || !before.workspace) throw Error(`seed_data_missing_${JSON.stringify(before)}`);

  // --- A. Apply the new version. ---
  const applied = await api(`/api/hosted/accounts/${accountId}/update`, "POST", { image: newImage });
  if (applied.status !== 200 || applied.body?.state !== "ready") throw Error(`apply_${applied.status}_${JSON.stringify(applied.body)}_row_${JSON.stringify(updateRows().at(-1))}`);
  if (accountImage() !== newImage) throw Error(`account_still_on_${accountImage()}`);
  if (mustDocker("exec", accountId, "cat", "/etc/remotecode-version") !== "v2") throw Error("new_image_not_running");
  if ((await accountReady()) !== 200) throw Error("account_lost_its_published_port_after_update");
  const afterApply = await dataSurvives();
  if (!afterApply.bot || !afterApply.workspace || !afterApply.routine) throw Error(`data_lost_after_update_${JSON.stringify(afterApply)}`);
  const leftovers = volumeNames("remotecode.update");
  if (leftovers.length) throw Error(`copy_volumes_left_behind_${leftovers.join(",")}`);
  record.applied = { status: applied.status, state: applied.body.state, image: accountImage(), version: "v2", portStillAnswers: 200, data: afterApply, copyVolumesLeft: 0 };

  // --- B. The new version cannot serve: roll back to the old one. ---
  const rolledBack = await api(`/api/hosted/accounts/${accountId}/update`, "POST", { image: brokenImage });
  if (rolledBack.status !== 503 || rolledBack.body?.step !== "swap") throw Error(`rollback_${rolledBack.status}_${JSON.stringify(rolledBack.body)}`);
  if (accountImage() !== newImage) throw Error(`rollback_left_image_${accountImage()}`);
  if ((await accountReady()) !== 200) throw Error("rolled_back_account_is_unreachable");
  const afterRollback = await dataSurvives();
  if (!afterRollback.bot || !afterRollback.workspace || !afterRollback.routine) throw Error(`data_lost_after_rollback_${JSON.stringify(afterRollback)}`);
  const rollbackRow = updateRows().at(-1)!;
  if (rollbackRow.state !== "rolled_back") throw Error(`rollback_row_${rollbackRow.state}`);
  record.rollback = { status: rolledBack.status, step: rolledBack.body.step, state: rollbackRow.state, imageAfter: accountImage(), portStillAnswers: 200, data: afterRollback };

  // --- C. Crash during the image swap: never resumed. ---

  // --- C. Crash during the image swap: never resumed. ---
  // Swapping onto the image that cannot serve keeps the account in `swapping`
  // for the whole readiness window, so the crash lands inside the swap.
  // Handled from the start: the request is expected to die with the process.
  const swapAttempt = api(`/api/hosted/accounts/${accountId}/update`, "POST", { image: brokenImage }).catch(() => null);
  const swapping = await waitForState(["swapping"], 90_000);
  if (!swapping) throw Error("never_reached_swapping");
  await stopControl();
  await swapAttempt;
  const containerAfterCrash = docker("inspect", "-f", "{{.State.Running}}", accountId);
  bootControl();
  await waitApiReady();
  const afterRestartRow = updateRows().find((row) => row.id === swapping.id)!;
  if (afterRestartRow.state !== "failed" || afterRestartRow.error !== "host_restart") {
    throw Error(`crash_not_recovered_${JSON.stringify(afterRestartRow)}`);
  }
  await delay(3_000);
  const stillFailed = updateRows().find((row) => row.id === swapping.id)!;
  if (stillFailed.state !== "failed") throw Error(`crash_was_resumed_${stillFailed.state}`);
  const afterCrash = await dataSurvives();
  if (!afterCrash.bot || !afterCrash.workspace || !afterCrash.routine) throw Error(`data_lost_after_crash_${JSON.stringify(afterCrash)}`);
  record.crashDuringSwap = {
    caughtState: swapping.state,
    containerRunningWhenKilled: containerAfterCrash.out,
    recoveredState: afterRestartRow.state,
    recoveredError: afterRestartRow.error,
    resumedAfterRestart: false,
    data: afterCrash,
  };

  // A crash mid-swap must not leave the account advertised as a working host:
  // it is on an image that was never confirmed to serve.
  const recoveredAccount = await api(`/api/hosted/accounts/${accountId}`);
  if (recoveredAccount.status !== 200) throw Error(`account_read_${recoveredAccount.status}`);
  if (recoveredAccount.body?.state === "ready") {
    throw Error(`crash_left_account_marked_ready_${JSON.stringify(recoveredAccount.body)}`);
  }
  record.afterCrash = { accountState: recoveredAccount.body?.state, image: accountImage() };

  record.result = "update_migrated_preserved_data_rolled_back_on_failure_and_never_resumed_a_crashed_swap_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  await stopControl();
  if (!process.env.RC062_KEEP) {
    for (const container of mustDockerOrEmpty("ps", "-a", "--format", "{{.Names}}")) {
      if (container.startsWith(run)) docker("rm", "-f", container);
    }
    for (const volume of volumeNames(`remotecode.update`)) docker("volume", "rm", "-f", volume);
    for (const volume of volumeNames(`remotecode.hosted`)) docker("volume", "rm", "-f", volume);
    docker("network", "rm", accountNetwork);
    docker("image", "rm", "-f", newImage);
    docker("image", "rm", "-f", brokenImage);
    record.cleanup = { containers: true, network: true, images: true };
  }
}

function mustDockerOrEmpty(...args: string[]) {
  const result = docker(...args);
  return result.code === 0 ? result.out.split("\n").filter(Boolean) : [];
}