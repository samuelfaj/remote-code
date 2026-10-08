// RC-046 proof orchestration: a real Linux account container with a durable data
// root runs the shipped API and the shipped run supervisor, an Inbox is filled
// through real runs, the container is restarted, and the Inbox is read again.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
if (process.env.RC046_PHASE) {
  // The journey runs its phase as a side effect of being imported.
  await import("./inside-journey.ts");
  process.exit(process.exitCode ?? 0);
}
const output = process.env.RC046_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC046_IMAGE ?? `rc046-host-${randomUUID().slice(0, 8)}:local`;
const run = `rc046-proof-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-046 durable Inbox across a restart" };

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  if (result.exitCode !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString();
}

function inContainer(script: string, timeout = 300_000) {
  const result = Bun.spawnSync(["docker", "exec", run, "bash", "-lc", script], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function startApi() {
  return inContainer(
    `cd /workspace && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc046.sqlite DISPLAY=:99 ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_DISTILL_BIN=/usr/local/bin/rc046-agent ` +
    `bun apps/api/src/index.ts >> /var/log/rc046-api.log 2>&1 & echo started`, 20_000);
}

async function waitReady(label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000).out.trim() === "200") return;
    await delay(500);
  }
  throw Error(`${label}_api_never_became_ready_${inContainer("tail -5 /var/log/rc046-api.log").out.slice(0, 300)}`);
}

/** The run supervisor is shipped; the agent binary is the repository's own stub. */
function installStubAgent() {
  return inContainer(
    // The stub finishes quickly; a short delay keeps a run alive long enough for the
    // proof to hand it to the human, which is the state this task is about.
    `printf '#!/bin/bash\\nsleep 3\\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs "$@"\\n' > /usr/local/bin/rc046-agent && ` +
    `chmod 0755 /usr/local/bin/rc046-agent && echo installed`, 20_000);
}

try {
  docker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = { reference: image, id: docker("image", "inspect", "-f", "{{.Id}}", image).trim().slice(0, 19) };

  docker("rm", "-f", run);
  docker("run", "-d", "--name", run, image, "sleep", "infinity");
  docker("cp", resolve(repo, "scripts/rc046"), `${run}:/workspace/scripts/rc046`);
  installStubAgent();
  startApi();
  await waitReady("first");

  const first = inContainer(
    `cd /workspace && RC046_PHASE=create DISPLAY=:99 RC046_API=http://127.0.0.1:3000 ` +
    `RC046_AUTH_PASSWORD=${password} bun scripts/rc046/run-inbox-proof.ts`, 600_000);
  const firstLine = first.out.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1) ?? "";
  if (!firstLine) throw Error(`phase_one_produced_no_result_${first.err.slice(-400)}`);
  const phaseOne = JSON.parse(firstLine);
  if (phaseOne.result !== "phase_one_done") throw Error(`phase_one_${phaseOne.error ?? "unknown"}`);
  record.beforeRestart = phaseOne.beforeRestart;

  // Host restart: the Inbox is durable state on the data root, so it must survive.
  docker("restart", run);
  startApi();
  await waitReady("second");

  const second = inContainer(
    `cd /workspace && RC046_PHASE=verify DISPLAY=:99 RC046_API=http://127.0.0.1:3000 ` +
    `RC046_AUTH_PASSWORD=${password} RC046_ITEM_A=${phaseOne.fixture.itemA} RC046_ITEM_B=${phaseOne.fixture.itemB} ` +
    `RC046_BOT_A=${phaseOne.fixture.botA} RC046_BOT_B=${phaseOne.fixture.botB} RC046_RUN_B=${phaseOne.fixture.runB} ` +
    `bun scripts/rc046/run-inbox-proof.ts`, 600_000);
  const secondLine = second.out.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1) ?? "";
  if (!secondLine) throw Error(`phase_two_produced_no_result_${second.err.slice(-400)}`);
  const phaseTwo = JSON.parse(secondLine);
  if (phaseTwo.result !== "inbox_item_type_bot_run_read_state_and_destination_survived_a_host_restart_and_a_waiting_item_refused_resolution_passed") {
    throw Error(`phase_two_${phaseTwo.error ?? "unknown"}`);
  }
  record.afterRestart = phaseTwo.afterRestart;
  record.fixture = phaseOne.fixture;
  record.result = phaseTwo.result;
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  if (!process.env.RC046_KEEP) {
    const removed = Bun.spawnSync(["docker", "rm", "-f", run], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    if (!process.env.RC046_IMAGE) docker("image", "rm", "-f", image);
    record.cleanup = { container: removed.exitCode === 0, image: !process.env.RC046_IMAGE };
  }
}
