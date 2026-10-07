// RC-055 proof orchestration. A real Linux account container runs the shipped
// API, the shipped Inbox, the shipped push dispatcher and a push provider
// stand-in; the journey inside feeds the payload the provider actually received
// into the shipped mobile router and resolves the thread the app would open.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC055_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("RC055_PROOF_DIR must be a fresh absolute directory");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC055_IMAGE ?? `rc055-host-${randomUUID().slice(0, 8)}:local`;
const run = `rc055-proof-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const artifact = resolve(output, "proof.json");

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  if (result.exitCode !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 400)}`);
  return result.stdout.toString();
}

function inContainer(script: string, timeout = 300_000) {
  const result = Bun.spawnSync(["docker", "exec", run, "bash", "-lc", script], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function cleanup() {
  try { docker("rm", "-f", run); } catch { /* the container may already be gone */ }
}

try {
  // A fresh image, because the proof runs the working tree's own client and
  // router inside the container.
  docker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  writeFileSync(resolve(output, "image.txt"), docker("image", "inspect", "-f", "{{.Id}}", image));

  docker("rm", "-f", run);
  docker("run", "-d", "--name", run, image, "sleep", "infinity");
  docker("cp", resolve(repo, "scripts/rc055"), `${run}:/workspace/scripts/rc055`);
  docker("cp", resolve(repo, "scripts/rc047"), `${run}:/workspace/scripts/rc047`);

  // The repository's own ACP stub as the agent, so a run really runs and then
  // records the Inbox item this push stands for.
  inContainer(
    `printf '#!/bin/bash\\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs "$@"\\n' > /usr/local/bin/rc055-agent && ` +
    `chmod 0755 /usr/local/bin/rc055-agent && echo ready`, 20_000);

  inContainer(
    `cd /workspace && RC047_PUSH_PORT=8099 RC047_PUSH_LOG=/var/log/rc055-push.log RC047_PUSH_DEAD=/var/log/rc055-dead-token ` +
    `bun scripts/rc047/push-endpoint.ts >> /var/log/rc055-push-stdout.log 2>&1 & echo started`, 20_000);
  inContainer(
    `cd /workspace && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc055.sqlite ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_DISTILL_BIN=/usr/local/bin/rc055-agent ` +
    `REMOTECODE_PUSH_ENDPOINT=http://127.0.0.1:8099/push ` +
    `bun apps/api/src/index.ts >> /var/log/rc055-api.log 2>&1 & echo started`, 20_000);

  let ready = false;
  for (let attempt = 0; attempt < 180 && !ready; attempt += 1) {
    ready = inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000).out.trim() === "200";
    if (!ready) await delay(500);
  }
  if (!ready) throw Error(`api_never_became_ready: ${inContainer("tail -5 /var/log/rc055-api.log").out.slice(0, 400)}`);

  const journey = inContainer(
    `cd /workspace && RC055_API=http://127.0.0.1:3000 RC055_AUTH_PASSWORD=${password} ` +
    `RC055_PUSH_LOG=/var/log/rc055-push.log RC055_RECORD=/var/log/rc055-record.json ` +
    `bun scripts/rc055/inside-journey.ts`, 300_000);
  process.stdout.write(journey.out);
  if (journey.err.trim()) process.stdout.write(journey.err);

  const record = inContainer("cat /var/log/rc055-record.json 2>/dev/null || echo '{}'").out.trim();
  writeFileSync(artifact, record);
  writeFileSync(resolve(output, "push-provider.log"), inContainer("cat /var/log/rc055-push.log 2>/dev/null || true").out);
  writeFileSync(resolve(output, "api.log"), inContainer("tail -60 /var/log/rc055-api.log 2>/dev/null || true").out);

  const parsed = JSON.parse(record || "{}") as { result?: string };
  console.log(`record: ${artifact}`);
  console.log(`result: ${parsed.result ?? "missing"}`);
  cleanup();
  process.exit(journey.code === 0 && parsed.result === "verified" ? 0 : 1);
} catch (error) {
  writeFileSync(resolve(output, "failure.txt"), error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
  cleanup();
  throw error;
}