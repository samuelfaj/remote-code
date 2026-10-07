// RC-017 command row: the three failure points of a command, measured on the
// shipped run supervisor. A controlled agent records every launch, so "never
// launch a second command" is observable rather than assumed.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = "/Users/samuelfajreldines/dev/new-remote-code";
const output = process.env.RC017_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc017-command-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC017_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc017.commandproof";
const password = randomBytes(24).toString("base64url");
const databasePath = "/var/lib/remotecode/rc017.sqlite";
const launchLog = "/var/lib/remotecode/rc017-launches.log";
let id = "";
let apiPort = 0;
let injectorPort = 0;
const record: any = { run, volume, image, result: "unverified", scope: "RC-017 command row: before acceptance, commit without response, unknown result" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args, exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

const agentSource = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
let buffer = "";
let promptId = null;
const sessionId = "rc017-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = (message) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    const log = process.env.RC017_LAUNCH_LOG;
    if (log) appendFileSync(log, text + "\\n");
    if (text.includes("HOLD")) return;
    return send({ id: promptId, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/cancel" && promptId !== null) return send({ id: promptId, result: { stopReason: "cancelled" } });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) { try { handle(JSON.parse(line)); } catch {} }
    index = buffer.indexOf("\\n");
  }
});
`;

async function startApi() {
  command("docker", "exec", "-d", id, "bash", "-lc",
    `cd /workspace && API_PORT=3000 DATABASE_PATH=${databasePath} REMOTECODE_AUTH_PASSWORD='${password}' ` +
    `REMOTECODE_DISTILL_BIN=/proof/rc017-agent REMOTECODE_RUNS_CWD=/var/lib/remotecode RC017_LAUNCH_LOG=${launchLog} ` +
    `REMOTECODE_TLS_CERT=/proof/proof-ca.pem REMOTECODE_TLS_KEY=/proof/proof-key.pem bun apps/api/src/index.ts > /var/lib/remotecode/rc017-api.log 2>&1`);
  const tls = { ca: readFileSync(resolve(output, "proof-ca.pem")) };
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try { if ((await fetch(`https://127.0.0.1:${apiPort}/api/health/ready`, { signal: AbortSignal.timeout(1200), tls } as any)).status === 200) return; } catch {}
    await delay(250);
  }
  throw Error("api_never_became_ready");
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  apiPort = 31_000 + Math.floor(Math.random() * 500);
  injectorPort = apiPort + 1000;
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "rc017-agent"), agentSource);
  chmodSync(resolve(output, "rc017-agent"), 0o755);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "sleep", image, "infinity");
  command("docker", "start", id);
  await startApi();

  const ca = readFileSync(cert, "utf8");
  const upstream = `https://127.0.0.1:${apiPort}`;
  const tls = { ca };
  const healthy = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(upstream + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), tls,
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const launches = () => command("docker", "exec", id, "sh", "-c", `test -f ${launchLog} && cat ${launchLog} || true`).split("\n").filter(Boolean);

  let mode = "healthy";
  const cut = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("rc017 cut")); } }), { status: 200, headers: { "content-type": "application/json" } });
  const injector = Bun.serve({
    port: injectorPort,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__mode") { mode = url.searchParams.get("value") ?? "healthy"; return Response.json({ mode }); }
      const isRunStart = url.pathname === "/api/workspaces" || url.pathname === "/api/runs";
      const forwarded = await fetch(upstream + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        tls,
      } as any);
      if (mode === "cut-after" && isRunStart && request.method === "POST") { await forwarded.arrayBuffer(); return cut(); }
      return new Response(forwarded.body, { status: forwarded.status, headers: forwarded.headers });
    },
  });

  const login = await healthy("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const workspace = await healthy("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc017" }, cookie);
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);
  const workspaceId = workspace.body.id as string;
  const setMode = async (value: string) => { await fetch(`http://127.0.0.1:${injectorPort}/__mode?value=${value}`); };
  const startThrough = async (requestId: string, prompt: string) => {
    try {
      const response = await fetch(`http://127.0.0.1:${injectorPort}/api/runs`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ requestId, workspaceId, prompt }),
        signal: AbortSignal.timeout(20_000),
      } as any);
      await response.text().catch(() => "");
      return { threw: false, status: response.status };
    } catch (error) { return { threw: true, error: String(error).slice(0, 100) }; }
  };

  // Point 1: refused before acceptance - no run, no launch.
  const badBody = await healthy("/api/runs", "POST", { workspaceId, prompt: "" }, cookie);
  if (badBody.status !== 400 && badBody.status !== 422) throw Error(`invalid_command_${badBody.status}`);
  if (launches().length !== 0) throw Error(`launch_before_acceptance_${JSON.stringify(launches())}`);

  // Point 2: accepted and launched, response lost - the run is the authority and
  // the same id must not launch a second command.
  const cutId = randomUUID();
  await setMode("cut-after");
  const cutAttempt = await startThrough(cutId, "quick command");
  if (!cutAttempt.threw) throw Error(`cut_was_not_applied_${JSON.stringify(cutAttempt)}`);
  await setMode("healthy");
  const cutRun = await healthy(`/api/runs/${cutId}`, "GET", undefined, cookie);
  if (cutRun.status !== 200) throw Error(`run_row_missing_after_cut_${cutRun.status}`);
  const repeat = await healthy("/api/runs", "POST", { requestId: cutId, workspaceId, prompt: "quick command" }, cookie);
  if (repeat.status !== 201 && repeat.status !== 200) throw Error(`repeat_${repeat.status}`);
  if (repeat.body.id !== cutId) throw Error(`repeat_created_another_run_${repeat.body.id}`);
  await delay(500);
  const afterRepeat = launches();
  if (afterRepeat.length !== 1) throw Error(`second_command_launched_${JSON.stringify(afterRepeat)}`);

  // Point 3: the outcome stays unknown across a restart - interrupted, never
  // completed, and never replayed.
  const holdId = randomUUID();
  const hold = await healthy("/api/runs", "POST", { requestId: holdId, workspaceId, prompt: "HOLD command" }, cookie);
  if (hold.status !== 201) throw Error(`hold_${hold.status}`);
  let running: any = null;
  const runningDeadline = Date.now() + 20_000;
  while (Date.now() < runningDeadline) {
    running = (await healthy(`/api/runs/${holdId}`, "GET", undefined, cookie)).body;
    if (running?.state === "running") break;
    await delay(150);
  }
  if (running?.state !== "running") throw Error(`hold_not_running_${JSON.stringify(running)}`);
  command("docker", "restart", id);
  await startApi();
  const relogin = await healthy("/api/auth/login", "POST", { password });
  const reconciled = await healthy(`/api/runs/${holdId}`, "GET", undefined, relogin.cookie);
  if (reconciled.body.state !== "interrupted" || reconciled.body.stopReason !== "host_restart") throw Error(`reconcile_${JSON.stringify(reconciled.body)}`);
  const beforeReplay = launches().length;
  await delay(500);
  if (launches().length !== beforeReplay) throw Error("restart_relaunched_a_command");
  const heldCommands = launches().filter((line) => line.includes("HOLD")).length;
  if (heldCommands !== 1) throw Error(`held_command_launched_${heldCommands}_times`);

  record.commandRow = {
    beforeAcceptance: { status: badBody.status, launches: 0 },
    commitWithoutResponse: { attempt: cutAttempt, runState: cutRun.body.state, repeat: { status: repeat.status, sameId: repeat.body.id === cutId }, launches: afterRepeat.length },
    unknownResult: { state: reconciled.body.state, stopReason: reconciled.body.stopReason, launchesForThatCommand: heldCommands, launchesAfterRestart: launches().length - beforeReplay },
  };
  record.result = "command_row_before_acceptance_commit_without_response_and_unknown_result_passed";
  console.log(JSON.stringify({ result: record.result, commandRow: record.commandRow }));
  injector.stop(true);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc017-agent"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}