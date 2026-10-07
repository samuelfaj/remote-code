// RC-036 proof orchestration: a real Linux host with a git-backed workspace and
// the shipped API, then the journey inside the account container (auth refuses
// plain HTTP from a non-loopback peer), an API restart, and the restart check.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
if (process.env.RC036_INSIDE === "verify") {
  await (await import("./verify.ts")).runInside();
  process.exit(process.exitCode ?? 0);
}
if (process.env.RC036_INSIDE === "journey") {
  await (await import("./journey.ts")).runInside();
  process.exit(process.exitCode ?? 0);
}
const output = process.env.RC036_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC036_IMAGE ?? `rc036-host-${randomUUID().slice(0, 8)}:local`;
const run = `rc036-proof-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-036 attachment stays in its thread, run diff matches the workspace, survives a restart" };

function mustDocker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  if (result.exitCode !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 400)}`);
  return result.stdout.toString();
}

function inContainer(script: string, timeout = 300_000) {
  const result = Bun.spawnSync(["docker", "exec", run, "bash", "-lc", script], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function startApi() {
  inContainer(
    `cd /workspace && mkdir -p /var/lib/remotecode && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc036.sqlite ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_DISTILL_BIN=/usr/local/bin/rc036-agent ` +
    `nohup bun apps/api/src/index.ts >/var/log/rc036-api.log 2>&1 & echo $! > /var/run/rc036.pid; sleep 1; cat /var/run/rc036.pid`,
    30_000);
}

function waitReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probe = inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000);
    if (probe.out.trim() === "200") return true;
    Bun.sleepSync(400);
  }
  return false;
}

function stopApi() {
  inContainer("kill $(cat /var/run/rc036.pid) 2>/dev/null; sleep 2; echo stopped", 30_000);
}

function lastJson(text: string) {
  return text.trim().split("\n").filter((line) => line.startsWith("{")).at(-1) ?? "";
}

try {
  mustDocker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = { reference: image, id: mustDocker("image", "inspect", "-f", "{{.Id}}", image).slice(0, 19) };

  Bun.spawnSync(["docker", "rm", "-f", run], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  mustDocker("run", "-d", "--name", run, image, "sleep", "infinity");
  mustDocker("cp", resolve(repo, "scripts/rc036"), `${run}:/workspace/scripts/rc036`);
  // The agent binary is the repository's own ACP stub, not Distill: the real
  // binary needs the Linux credential RC-002 gates, so the shipped supervisor is
  // what this proof drives.
  inContainer(
    `printf '#!/bin/bash\\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs "$@"\\n' > /usr/local/bin/rc036-agent && chmod 0755 /usr/local/bin/rc036-agent && echo staged`,
    30_000);
  startApi();
  if (!waitReady()) throw Error(`api_never_became_ready_${inContainer("tail -5 /var/log/rc036-api.log").out.slice(0, 400)}`);

  const journey = inContainer(
    `cd /workspace && RC036_INSIDE=journey RC036_API=http://127.0.0.1:3000 RC036_AUTH_PASSWORD=${password} ` +
    `bun scripts/rc036/run-attachment-proof.ts`,
    600_000);
  const journeyLine = lastJson(journey.out);
  if (!journeyLine) throw Error(`journey_produced_no_result_${journey.err.slice(-500)}`);
  const first = JSON.parse(journeyLine);
  if (first.result !== "attachment_stayed_in_its_thread_and_the_served_diff_matched_the_workspace_passed") {
    throw Error(`journey_${first.error ?? "unknown"}`);
  }
  record.journey = first;

  // Restart the API and check that nothing the message carried was lost.
  stopApi();
  startApi();
  if (!waitReady()) throw Error(`api_not_ready_after_restart_${inContainer("tail -5 /var/log/rc036-api.log").out.slice(0, 400)}`);
  const verify = inContainer(
    `cd /workspace && RC036_INSIDE=verify RC036_API=http://127.0.0.1:3000 RC036_AUTH_PASSWORD=${password} ` +
    `RC036_THREAD_A=${first.fixture.threadA} RC036_THREAD_B=${first.fixture.threadB} RC036_RUN_ID=${first.fixture.runId} ` +
    `RC036_FOLDER=${first.fixture.folderPath} RC036_ATTACH_SHA=${first.attachment.sha256} ` +
    `RC036_ATTACH_SIZE=${first.attachment.size} bun scripts/rc036/run-attachment-proof.ts`,
    300_000);
  const verifyLine = lastJson(verify.out);
  if (!verifyLine) throw Error(`restart_check_produced_no_result_${verify.err.slice(-500)}`);
  const second = JSON.parse(verifyLine);
  if (second.result !== "attachment_and_run_changes_survived_the_api_restart_passed") {
    throw Error(`restart_check_${second.error ?? "unknown"}`);
  }
  record.afterRestart = second.afterRestart;
  record.result = "attachment_stayed_in_its_thread_the_diff_matched_the_workspace_and_both_survived_a_restart_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  if (!process.env.RC036_KEEP) {
    Bun.spawnSync(["docker", "rm", "-f", run], { cwd: repo, stdout: "ignore", stderr: "ignore" });
    if (!process.env.RC036_IMAGE) Bun.spawnSync(["docker", "image", "rm", "-f", image], { cwd: repo, stdout: "ignore", stderr: "ignore" });
    record.cleanup = { container: true, image: !process.env.RC036_IMAGE };
  }
}