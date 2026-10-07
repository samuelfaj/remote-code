// RC-047 proof orchestration. A real Linux account container runs the shipped
// API, the shipped Inbox, the shipped push dispatcher and a push provider
// stand-in; the journey inside counts what the provider actually received.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
if (process.env.RC047_PHASE) {
  // The journey runs its phase as a side effect of being imported.
  await import("./inside-journey.ts");
  process.exit(process.exitCode ?? 0);
}
const output = process.env.RC047_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC047_IMAGE ?? `rc047-host-${randomUUID().slice(0, 8)}:local`;
const run = `rc047-proof-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-047 push from Inbox items with dedup and a denied device" };

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  if (result.exitCode !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString();
}

function inContainer(script: string, timeout = 300_000) {
  const result = Bun.spawnSync(["docker", "exec", run, "bash", "-lc", script], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function startServices() {
  // The push provider stand-in, then the API pointed at it.
  inContainer(
    `cd /workspace && RC047_PUSH_PORT=8099 RC047_PUSH_LOG=/var/log/rc047-push.log RC047_PUSH_DEAD=/var/log/rc047-dead-token ` +
    `bun scripts/rc047/push-endpoint.ts >> /var/log/rc047-push-stdout.log 2>&1 & echo started`, 20_000);
  inContainer(
    `cd /workspace && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc047.sqlite DISPLAY=:99 ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_DISTILL_BIN=/usr/local/bin/rc047-agent ` +
    `REMOTECODE_PUSH_ENDPOINT=http://127.0.0.1:8099/push ` +
    `bun apps/api/src/index.ts >> /var/log/rc047-api.log 2>&1 & echo started`, 20_000);
}

async function waitReady(label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000).out.trim() === "200") return;
    await delay(500);
  }
  throw Error(`api_never_became_ready_${label}_${inContainer("tail -5 /var/log/rc047-api.log").out.slice(0, 300)}`);
}

try {
  docker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = { reference: image, id: docker("image", "inspect", "-f", "{{.Id}}", image).trim().slice(0, 19) };

  docker("rm", "-f", run);
  docker("run", "-d", "--name", run, image, "sleep", "infinity");
  docker("cp", resolve(repo, "scripts/rc047"), `${run}:/workspace/scripts/rc047`);

  // The repository's own ACP stub, held open briefly so a run can be handed to
  // the human, which is what raises the item the push stands for.
  inContainer(
    `printf '#!/bin/bash\\nsleep 3\\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs "$@"\\n' > /usr/local/bin/rc047-agent && ` +
    `chmod 0755 /usr/local/bin/rc047-agent && echo ready`, 20_000);

  startServices();
  await waitReady("first");

  const first = inContainer(
    `cd /workspace && RC047_PHASE=create DISPLAY=:99 RC047_API=http://127.0.0.1:3000 ` +
    `RC047_AUTH_PASSWORD=${password} RC047_PUSH_LOG=/var/log/rc047-push.log RC047_PUSH_DEAD=/var/log/rc047-dead-token ` +
    `bun scripts/rc047/inside-journey.ts`, 600_000);
  const firstLine = first.out.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1) ?? "";
  if (!firstLine) throw Error(`phase_one_produced_no_result_${first.err.slice(-500)}`);
  const phaseOne = JSON.parse(firstLine);
  if (phaseOne.result !== "phase_one_done") throw Error(`phase_one_${phaseOne.error ?? "unknown"}`);
  record.beforeRestart = phaseOne.beforeRestart;

  // Host restart: the Inbox, the devices and the deliveries are durable state.
  docker("restart", run);
  startServices();
  await waitReady("second");

  const second = inContainer(
    `cd /workspace && RC047_PHASE=verify DISPLAY=:99 RC047_API=http://127.0.0.1:3000 ` +
    `RC047_AUTH_PASSWORD=${password} RC047_PUSH_LOG=/var/log/rc047-push.log RC047_PUSH_DEAD=/var/log/rc047-dead-token ` +
    `RC047_ITEM_1=${phaseOne.fixture.firstItem} RC047_ITEM_2=${phaseOne.fixture.secondItem} ` +
    `RC047_ITEM_3=${phaseOne.fixture.thirdItem} RC047_TOKEN_A=${phaseOne.fixture.tokenA} ` +
    `RC047_TOKEN_B=${phaseOne.fixture.tokenB} RC047_WORKSPACE=${phaseOne.fixture.workspaceId} RC047_BOT=${phaseOne.fixture.botId} ` +
    `bun scripts/rc047/inside-journey.ts`, 600_000);
  const secondLine = second.out.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1) ?? "";
  if (!secondLine) throw Error(`phase_two_produced_no_result_${second.err.slice(-500)}`);
  const phaseTwo = JSON.parse(secondLine);
  if (phaseTwo.result !== "two_devices_got_at_most_one_alert_each_and_a_denied_push_kept_the_inbox_item_passed") {
    throw Error(`phase_two_${phaseTwo.error ?? "unknown"}`);
  }
  record.afterRestart = phaseTwo.afterRestart;
  record.fixture = phaseOne.fixture;
  record.result = "two_devices_got_at_most_one_alert_each_and_a_denied_push_kept_the_inbox_item_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  if (!process.env.RC047_KEEP) {
    const removed = Bun.spawnSync(["docker", "rm", "-f", run], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    if (!process.env.RC047_IMAGE) docker("image", "rm", "-f", image);
    record.cleanup = { container: removed.exitCode === 0, image: !process.env.RC047_IMAGE };
  }
}
