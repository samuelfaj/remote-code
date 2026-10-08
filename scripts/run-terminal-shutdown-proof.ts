// RC-031 graceful live-actor shutdown proof: start one PTY via HTTP, keep it
// producing, SIGTERM the API, and read back exited/removed + Docker absence.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC_TERMINAL_SHUTDOWN_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc031-shutdown-${randomUUID()}`;
const volume = `${run}-data`;
const image = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc031.shutdown";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/terminal-shutdown.sqlite";
const record: any = { run, volume, image, result: "unverified", scope: "RC-031 graceful live-actor shutdown via normal SIGTERM; not full task acceptance" };
let id = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
const stateCode = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)},{readonly:true,create:false});d.exec('PRAGMA busy_timeout=250');console.log(JSON.stringify({terminals:d.query('select terminal_id,state,cleanup,container_id,exit_code from terminal_sessions').all(),quickCheck:d.query('pragma quick_check').all()}));d.close();`;
function state() { return JSON.parse(command("docker", "exec", id, "bun", "-e", stateCode)); }
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Id !== image || metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Approved Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/shutdown-proof-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  const apiPort = 13_000 + Math.floor(Math.random() * 4000);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly",
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", `API_PORT=3000`, "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_TLS_CERT=/proof/proof-ca.pem`, "-e", `REMOTECODE_TLS_KEY=/proof/proof-key.pem`,
    "-e", `REMOTECODE_TERMINAL_VOLUME=${volume}`, "-e", `REMOTECODE_TERMINAL_IMAGE=${image}`,
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);
  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) break; } catch {}
    await delay(200);
  }
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000), tls } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const login = await api("/api/auth/login", "POST", { password, requestId: randomUUID() });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const created = await api("/api/workspaces", "POST", { name: run, requestId: randomUUID() }, cookie);
  if (created.status !== 201) throw Error(`workspace_${created.status}`);
  const listed = await api("/api/workspaces", "GET", undefined, cookie);
  const workspaceId = listed.body.workspaces.find((row: any) => row.name === run).id;
  const folder = await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: randomUUID() }, cookie);
  if (folder.status !== 200) throw Error(`folder_${folder.status}`);
  const startBody = { requestId: randomUUID(), cols: 80, rows: 24 };
  const started = await api(`/api/workspaces/${workspaceId}/terminals`, "POST", startBody, cookie);
  if (started.status !== 201) throw Error(`terminal_start_${started.status}_${started.body?.error}`);
  const terminalId = started.body.terminalId;
  // Keep one live actor producing while shutdown arrives.
  const fed = await api(`/api/terminals/${terminalId}/input`, "POST", { sequence: 1, text: "while true; do printf 'live-%s\\n' \"$(date +%s%N)\"; sleep 0.1; done\n" }, cookie);
  if (fed.status !== 200) throw Error(`terminal_input_${fed.status}`);
  await delay(1500);
  const live = await api(`/api/terminals/${terminalId}?offset=0`, "GET", undefined, cookie);
  if (live.status !== 200 || live.body.state !== "running") throw Error("Actor not running before shutdown");
  // Let deferred Elysia route registration finish so the shipped SIGTERM ->
  // onStop -> stopAll path settles this row (same wait the browser proof's
  // journeys give the server before its owned shutdown).
  await delay(8000);
  record.beforeShutdown = { terminalId, state: live.body.state, endOffset: live.body.endOffset };
  // Normal graceful shutdown: SIGTERM the API with the actor live.
  command("docker", "exec", id, "bun", "-e", "process.kill(1,'SIGTERM')");
  const stopEnd = Date.now() + 60_000;
  let exited = false;
  while (!exited && Date.now() < stopEnd) {
    exited = JSON.parse(command("docker", "inspect", id))[0].State.Status === "exited";
    if (!exited) await delay(200);
  }
  if (!exited) throw Error("API did not exit after SIGTERM with live actor");
  record.apiExited = true;
  const name = `${run}-readback`;
  const reader = command("docker", "create", "--name", name, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--network", "none", "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode,readonly`,
    "--entrypoint", "bun", image, "-e", stateCode);
  try {
    const after = JSON.parse(command("docker", "start", "--attach", reader));
    record.after = after;
    const row = after.terminals.find((t: any) => t.terminal_id === terminalId);
    if (!row || row.state !== "exited" || row.cleanup !== "removed") throw Error(`Live actor not gracefully settled: ${JSON.stringify(row)}`);
    const ids = command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n");
    if (row.container_id && ids.includes(row.container_id)) throw Error("Actor container still present after graceful shutdown");
    record.actorContainerAbsent = true;
    if (after.terminals.some((t: any) => t.cleanup !== "removed")) throw Error("Unsettled terminals remain");
    record.result = "terminal_graceful_live_actor_shutdown_passed";
  } finally {
    command("docker", "rm", "-f", reader);
  }
} catch (error) {
  record.error = String(error).replaceAll(password, "[redacted]");
  process.exitCode = 1;
} finally {
  record.cleanup = {};
  try {
    if (id) {
      try { command("docker", "rm", "-f", id); } catch {}
      const names = command("docker", "ps", "-a", "--format", "{{.Names}}").split("\n");
      record.cleanup.api = !names.includes(run) && !names.includes(`/${run}`);
    }
    try { command("docker", "volume", "rm", volume); record.cleanup.volume = true; }
    catch { record.cleanup.volume = false; process.exitCode = 1; }
  } catch (error) { record.cleanup.error = String(error); process.exitCode = 1; }
  if (process.exitCode && record.result === "terminal_graceful_live_actor_shutdown_passed") record.result = "cleanup_unverified";
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ result: record.result, error: record.error, cleanup: record.cleanup }));
}
