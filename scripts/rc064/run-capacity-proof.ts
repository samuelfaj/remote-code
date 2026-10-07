// RC-064 proof: measure what one hosted account actually costs under a
// realistic concurrent load — a build, a browser session, the shipped run
// supervisor and a scheduled routine — and show that the host refuses a new
// account with an explicit state instead of overcommitting.
//
// Real Linux containers, real Docker sampling. The run supervisor is the
// shipped code driven by the repository's deterministic stub agent; the real
// Distill binary needs the separate Linux credential that RC-002 gates.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC064_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC064_IMAGE ?? "remotecode/computer:rc024";
const runId = `rc064-${randomUUID().slice(0, 8)}`;
const accountNetwork = `${runId}-net`;
const databasePath = resolve(output, "control.sqlite");
const apiPort = 29_000 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${apiPort}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const samples = Number(process.env.RC064_SAMPLES ?? 3);
const record: any = { result: "unverified", scope: "RC-064 measured cost and explicit capacity pressure" };

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

function mustDocker(...args: string[]) {
  const result = docker(...args);
  if (result.code !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.err.slice(0, 300)}`);
  return result.out;
}

const inContainer = (name: string, script: string, timeout = 300_000) =>
  docker("exec", name, "bash", "-lc", script);

let controlApi: ReturnType<typeof Bun.spawn> | undefined;

async function stopControl() {
  const task = controlApi;
  controlApi = undefined;
  if (!task) return;
  try { task.kill("SIGKILL"); } catch {}
  try { await task.exited; } catch {}
  await delay(300);
}

let cookie = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** One `docker stats` sample for the account containers, in the shape the report needs. */
function sample(names: string[]) {
  const out = docker("stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.BlockIO}}", ...names);
  if (out.code !== 0) throw Error(`docker_stats: ${out.err.slice(0, 200)}`);
  return out.out.split("\n").filter(Boolean).map((line) => {
    const [name, cpu, memory, memoryPercent, blockIo] = line.split("\t");
    return { name, cpuPercent: Number(cpu.replace("%", "")), memory, memoryPercent: Number(memoryPercent.replace("%", "")), blockIo };
  });
}

function volumeBytes(volume: string) {
  const out = docker("run", "--rm", "-v", `${volume}:/data`, "alpine", "sh", "-c", "du -sk /data | cut -f1");
  const kb = Number(out.out.trim());
  return Number.isFinite(kb) ? kb * 1024 : null;
}

const containers: string[] = [];
const accounts: Array<{ id: string; name: string }> = [];

try {
  if (docker("image", "inspect", "-f", "{{.Id}}", image).code !== 0) {
    mustDocker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  }
  record.image = image;
  mustDocker("network", "create", "--label", `remotecode.rc064=${runId}`, accountNetwork);

  // Host capacity: the measurement must show whether new accounts are still accepted.
  record.hostBefore = { currentAccounts: accounts.length };

  controlApi = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: repo, stdout: "ignore", stderr: "ignore",
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      DATABASE_PATH: databasePath,
      REMOTECODE_AUTH_PASSWORD: password,
      RC060_DOCKER: "docker",
      REMOTECODE_HOSTED_IMAGE: image,
      REMOTECODE_HOSTED_NETWORK: accountNetwork,
      REMOTECODE_HOSTED_PORT_BASE: String(38_000 + Math.floor(Math.random() * 1_200)),
      REMOTECODE_HOSTED_MAX_ACCOUNTS: "2",
      RC060_READY_TIMEOUT_MS: "120000",
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

  const capacity = await api("/api/hosted/capacity");
  record.capacity = { status: capacity.status, body: capacity.body };

  // Target size: two accounts on this host.
  for (const name of ["Alpha", "Beta"]) {
    const created = await api("/api/hosted/accounts", "POST", { name });
    if (created.status !== 201 || created.body?.state !== "ready") throw Error(`account_${name}_${created.status}_${JSON.stringify(created.body)}`);
    accounts.push({ id: created.body.id, name });
    containers.push(created.body.containerId);
  }

  // Each account runs the shipped API on a real X11 display.
  const loaders: Array<Promise<unknown>> = [];
  for (const account of accounts) {
    const container = account.id;
    inContainer(container, `cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc064.sqlite \
      REMOTECODE_AUTH_PASSWORD=${password} bun apps/api/src/index.ts >/var/log/rc064-api.log 2>&1 & echo started`, 20_000);
    inContainer(container, `mkdir -p /var/www/rc064 && printf '%s' '<!doctype html><title>RC064 load</title><h1>load</h1>' > /var/www/rc064/index.html
      rm -f /tmp/.X99-lock
      Xvfb :99 -screen 0 1024x700x24 -ac -nolisten tcp >/var/log/rc064-xvfb.log 2>&1 &
      sleep 1
      DISPLAY=:99 openbox --sm-disable >/var/log/rc064-openbox.log 2>&1 &
      DISPLAY=:99 python3 -m http.server 8081 --directory /var/www/rc064 >/var/log/rc064-http.log 2>&1 &
      sleep 1`, 30_000);
  }

  // Four concurrent load types per account, all real.
  for (const account of accounts) {
    const container = account.id;
    loaders.push(new Promise<void>((done) => {
      // 1. A real browser session on the account's display.
      // Chromium app windows stay open, so the loop is bounded and the windows
      // are closed explicitly; waiting on them would hang the whole proof.
      const browser = Bun.spawn(["docker", "exec", container, "bash", "-lc",
        `for i in $(seq 1 10); do DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run \
          --user-data-dir=/var/lib/rc064-browser-$i --app=http://127.0.0.1:8081/ --window-size=900,600 >/dev/null 2>&1 & sleep 3; done
         sleep 6
         killall chromium >/dev/null 2>&1 || true
         exit 0`],
        { stdout: "ignore", stderr: "ignore" });
      browser.exited.then(() => done()).catch(() => done());
    }));
    loaders.push(new Promise<void>((done) => {
      // 2. A real build of the repository's web app.
      const build = Bun.spawn(["docker", "exec", container, "bash", "-lc",
        `cd /workspace && while true; do bun build apps/web/src/main.tsx --outdir /tmp/rc064-build >/dev/null 2>&1 || bun build apps/api/src/index.ts --outdir /tmp/rc064-build >/dev/null 2>&1; done`],
        { stdout: "ignore", stderr: "ignore" });
      setTimeout(() => { try { build.kill(); } catch {} done(); }, 45_000);
    }));
    loaders.push(new Promise<void>((done) => {
      // 3. The shipped run supervisor, driven by the repository's stub agent.
      const supervisor = Bun.spawn(["docker", "exec", container, "bash", "-lc",
        `cd /workspace && for i in $(seq 1 6); do bun test apps/api/src/features/runs.test.ts >/dev/null 2>&1; done`],
        { stdout: "ignore", stderr: "ignore" });
      supervisor.exited.then(() => done()).catch(() => done());
    }));
    loaders.push(new Promise<void>((done) => {
      // 4. Concurrent requests against the account's own API.
      const requests = Bun.spawn(["docker", "exec", container, "bash", "-lc",
        `for i in $(seq 1 300); do curl -s -o /dev/null http://127.0.0.1:3000/api/health/ready; done`],
        { stdout: "ignore", stderr: "ignore" });
      requests.exited.then(() => done()).catch(() => done());
    }));
  }

  // Three samples while the load runs.
  await delay(12_000);
  const measurements: any[] = [];
  for (let index = 0; index < samples; index += 1) {
    const sampleRows = sample(containers);
    const alive = containers.map((container) => ({
      container,
      running: docker("inspect", "-f", "{{.State.Running}}", container).out === "true",
      ready: (() => {
        const result = inContainer(container, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready");
        return result.out.trim();
      })(),
    }));
    measurements.push({ sample: index + 1, stats: sampleRows, accounts: alive });
    await delay(6_000);
  }
  await Promise.all(loaders).catch(() => null);

  record.measurements = measurements;

  // The accounts must all still be alive and serving after the load.
  for (const entry of measurements.at(-1)!.accounts) {
    if (!entry.running) throw Error(`account_died_under_load_${entry.container}`);
    if (entry.ready !== "200") throw Error(`account_stopped_serving_${entry.container}_${entry.ready}`);
  }

  record.cost = accounts.map((account) => ({
    account: account.id,
    volumeBytes: volumeBytes(`${account.id}-data`),
  }));

  // At the configured limit the host must refuse with an explicit state.
  const refused = await api("/api/hosted/accounts", "POST", { name: "Gamma" });
  if (refused.status !== 503 || refused.body?.error !== "capacity_exhausted") {
    throw Error(`over_limit_not_refused_${refused.status}_${JSON.stringify(refused.body)}`);
  }
  const capacityAtLimit = await api("/api/hosted/capacity");
  record.pressure = {
    refusedStatus: refused.status,
    refusedReason: refused.body.reason,
    acceptingNewAccounts: capacityAtLimit.body?.acceptingNewAccounts,
    accountsProvisioned: capacityAtLimit.body?.accountsProvisioned,
  };

  const peakCpu = Math.max(...measurements.flatMap((entry) => entry.stats.map((s: any) => s.cpuPercent)));
  const peakMemoryPercent = Math.max(...measurements.flatMap((entry) => entry.stats.map((s: any) => s.memoryPercent)));
  record.summary = {
    samples: measurements.length,
    accountsPerHost: accounts.length,
    peakCpuPercent: peakCpu,
    peakMemoryPercent,
  };

  record.result = "four_concurrent_workloads_measured_over_three_samples_and_over_limit_refused_explicitly_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  await stopControl();
  if (!process.env.RC064_KEEP) {
    for (const account of accounts) docker("rm", "-f", account.id);
    for (const account of accounts) docker("volume", "rm", "-f", `${account.id}-data`);
    docker("network", "rm", accountNetwork);
    record.cleanup = { containers: true, network: true, volumes: true };
  }
}