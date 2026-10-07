// RC-044 proof orchestration. A real Linux account container with its own X
// display runs the shipped API; the journey inside types a credential through
// the shipped screen-input route.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
if (process.env.RC044_INSIDE) {
  await (await import("./inside-journey.ts")).runInside();
  process.exit(process.exitCode ?? 0);
}
const output = process.env.RC044_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC044_IMAGE ?? `rc044-host-${randomUUID().slice(0, 8)}:local`;
const run = `rc044-proof-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-044 typed credential never reaches argv or the log" };

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  if (result.exitCode !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString();
}

function inContainer(script: string, timeout = 300_000) {
  const result = Bun.spawnSync(["docker", "exec", run, "bash", "-lc", script], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

try {
  docker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = { reference: image, id: docker("image", "inspect", "-f", "{{.Id}}", image).trim().slice(0, 19) };

  docker("rm", "-f", run);
  docker("run", "-d", "--name", run, image, "sleep", "infinity");
  docker("cp", resolve(repo, "scripts/rc044"), `${run}:/workspace/scripts/rc044`);

  // The shipped API on the container's display, so the input route drives the
  // real X server rather than a seam.
  inContainer(
    `cd /workspace && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc044.sqlite DISPLAY=:99 ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_DISPLAY=:99 ` +
    `bun apps/api/src/index.ts > /var/log/rc044-api.log 2>&1 & echo started`, 20_000);

  let ready = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000).out.trim() === "200") { ready = true; break; }
    await delay(500);
  }
  if (!ready) throw Error(`api_never_became_ready_${inContainer("tail -5 /var/log/rc044-api.log").out.slice(0, 300)}`);

  const journey = inContainer(
    `cd /workspace && RC044_INSIDE=1 DISPLAY=:99 RC044_API=http://127.0.0.1:3000 RC044_DATA_ROOT=/var/lib/remotecode ` +
    `RC044_API_LOG=/var/log/rc044-api.log RC044_AUTH_PASSWORD=${password} bun scripts/rc044/run-login-proof.ts`, 300_000);
  const line = journey.out.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1) ?? "";
  if (!line) throw Error(`journey_produced_no_result_${journey.err.slice(-400)}`);
  const result = JSON.parse(line);
  record.journey = result.journey;
  if (result.result !== "typed_credential_stayed_out_of_argv_and_the_log_and_the_session_profile_is_durable_passed") {
    throw Error(`journey_${result.error ?? "unknown"}`);
  }
  // Host restart: the browser profile that holds the site session lives on the
  // data root, so it must still be there, complete, after the container restarts.
  const beforeRestart = inContainer(
    `du -sb /var/lib/remotecode/bots/rc044/profile 2>/dev/null | cut -f1; ` +
    `ls /var/lib/remotecode/bots/rc044/profile | tr '\n' ','`, 60_000).out.trim();
  docker("restart", run);
  // A restart stops the API too, so the host starts it again before the check.
  inContainer(
    `cd /workspace && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc044.sqlite DISPLAY=:99 ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_DISPLAY=:99 ` +
    `bun apps/api/src/index.ts >> /var/log/rc044-api.log 2>&1 & echo started`, 20_000);
  let back = false;
  const restartDeadline = Date.now() + 120_000;
  while (Date.now() < restartDeadline) {
    if (inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000).out.trim() === "200") { back = true; break; }
    await delay(500);
  }
  if (!back) throw Error("api_did_not_come_back_after_restart");
  const afterRestart = inContainer(
    `du -sb /var/lib/remotecode/bots/rc044/profile 2>/dev/null | cut -f1; ` +
    `ls /var/lib/remotecode/bots/rc044/profile | tr '\n' ','`, 60_000).out.trim();
  const profileSize = (value: string) => Number(value.split("\n")[0] ?? "0");
  if (profileSize(afterRestart) < profileSize(beforeRestart) || profileSize(afterRestart) <= 0) {
    throw Error(`session_profile_did_not_survive_the_restart_${beforeRestart.slice(0, 60)}_${afterRestart.slice(0, 60)}`);
  }
  const workspaceSurvived = inContainer("test -f /var/lib/remotecode/rc044.sqlite && echo PRESENT || echo MISSING").out.trim();
  if (workspaceSurvived !== "PRESENT") throw Error("account_data_did_not_survive_the_restart");
  record.restart = {
    profileBytesBefore: profileSize(beforeRestart),
    profileBytesAfter: profileSize(afterRestart),
    profileEntriesAfter: (afterRestart.split("\n")[1] ?? "").slice(0, 120),
    accountDataAfterRestart: workspaceSurvived,
  };

  record.result = "typed_credential_stayed_out_of_argv_and_the_log_and_the_session_profile_is_durable_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  if (!process.env.RC044_KEEP) {
    const removed = Bun.spawnSync(["docker", "rm", "-f", run], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    if (!process.env.RC044_IMAGE) docker("image", "rm", "-f", image);
    record.cleanup = { container: removed.exitCode === 0, image: !process.env.RC044_IMAGE };
  }
}
