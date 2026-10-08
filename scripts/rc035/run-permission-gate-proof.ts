// RC-035 proof: an approval request is presented before the action, a denial
// prevents it, and an approval lets it happen exactly once.
//
// A controlled ACP agent asks for permission before writing a file and records
// every write it performs.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC035_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc035-permission-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC035_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc035.permissionproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc035.sqlite";
const writeLog = "/var/lib/remotecode/rc035-writes.log";
const agentPath = "/proof/rc035-agent";
let id = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-035 permission gate: deny blocks, allow writes once" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

const agentSource = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
let buffer = "";
let sessionId = "rc035-session";
let promptId = null;
let pending = null;
let target = null;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = (message) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    const match = text.match(/WRITE (\\S+)/);
    if (!match) return send({ id: promptId, result: { stopReason: "end_turn" } });
    target = match[1];
    send({ id: message.id + "-permission", method: "session/request_permission", params: {
      sessionId,
      toolCall: { title: "Write file " + target, kind: "edit" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "deny-once", kind: "reject_once", name: "Deny" },
      ],
    } });
    return;
  }
  if (message.method === "session/cancel" && promptId !== null) return send({ id: promptId, result: { stopReason: "cancelled" } });
  if (message.method === undefined && message.id !== undefined && target !== null) {
    // Answer to our own permission request.
    const outcome = message.result?.outcome ?? {};
    const allowed = outcome.outcome === "selected" && String(outcome.optionId ?? "").includes("allow");
    if (allowed) {
      writeFileSync(target, "written once\\n");
      const log = process.env.RC035_WRITE_LOG;
      if (log) appendFileSync(log, target + "\\n");
    }
    return send({ id: promptId, result: { stopReason: allowed ? "end_turn" : "cancelled" } });
  }
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

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const apiPort = 22_000 + Math.floor(Math.random() * 800);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/rc035-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  writeFileSync(resolve(output, "rc035-agent"), agentSource);
  chmodSync(resolve(output, "rc035-agent"), 0o755);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_DISTILL_BIN=${agentPath}`, "-e", "REMOTECODE_RUNS_CWD=/var/lib/remotecode",
    "-e", `RC035_WRITE_LOG=${writeLog}`,
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);

  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) break; } catch {}
    await delay(200);
  }
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000), tls,
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };

  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc035" }, cookie);
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);
  const workspaceId = workspace.body.id as string;

  const existsInContainer = (path: string) => command("docker", "exec", id, "sh", "-c", `test -e ${path} && echo yes || echo no`) === "yes";
  const waitPermission = async (runId: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const pending = (await api(`/api/runs/${runId}/permissions`, "GET", undefined, cookie)).body.permissions;
      if (pending.length > 0) return pending[0];
      await delay(150);
    }
    throw Error(`no_permission_request_for_${runId}`);
  };
  const settle = async (runId: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const view = (await api(`/api/runs/${runId}`, "GET", undefined, cookie)).body;
      if (view.state !== "starting" && view.state !== "running") return view;
      await delay(150);
    }
    throw Error(`run_never_settled_${runId}`);
  };

  // 1. The request is presented with its action and target, and nothing ran yet.
  const deniedPath = "/var/lib/remotecode/rc035-denied.txt";
  const deniedRun = await api("/api/runs", "POST", { requestId: randomUUID(), workspaceId, prompt: `WRITE ${deniedPath}` }, cookie);
  if (deniedRun.status !== 201) throw Error(`denied_run_${deniedRun.status}`);
  const pendingDeny = await waitPermission(deniedRun.body.id);
  if (!String(pendingDeny.title).includes(deniedPath)) throw Error(`title_${pendingDeny.title}`);
  if (pendingDeny.options.length !== 2) throw Error(`options_${JSON.stringify(pendingDeny.options)}`);
  const beforeDecision = existsInContainer(deniedPath);
  if (beforeDecision) throw Error("file_written_before_any_decision");
  record.pending = { title: pendingDeny.title, kind: pendingDeny.kind, options: pendingDeny.options, fileBeforeDecision: beforeDecision };

  // 2. Deny: the write must not happen.
  const deny = await api(`/api/runs/${deniedRun.body.id}/permissions/${pendingDeny.requestId}`, "POST", { decision: "deny" }, cookie);
  if (deny.status !== 200) throw Error(`deny_${deny.status}`);
  const deniedView = await settle(deniedRun.body.id);
  if (existsInContainer(deniedPath)) throw Error("denied_write_happened");
  const logAfterDeny = command("docker", "exec", id, "sh", "-c", `test -f ${writeLog} && cat ${writeLog} || true`).split("\n").filter(Boolean);
  if (logAfterDeny.length !== 0) throw Error(`denied_write_logged_${JSON.stringify(logAfterDeny)}`);
  record.denied = { state: deniedView.state, stopReason: deniedView.stopReason, fileExists: false, writesLogged: logAfterDeny.length };

  // 3. Allow: exactly one write.
  const allowedPath = "/var/lib/remotecode/rc035-allowed.txt";
  const allowedRun = await api("/api/runs", "POST", { requestId: randomUUID(), workspaceId, prompt: `WRITE ${allowedPath}` }, cookie);
  if (allowedRun.status !== 201) throw Error(`allowed_run_${allowedRun.status}`);
  const pendingAllow = await waitPermission(allowedRun.body.id);
  if (existsInContainer(allowedPath)) throw Error("file_written_before_allow_decision");
  const allow = await api(`/api/runs/${allowedRun.body.id}/permissions/${pendingAllow.requestId}`, "POST", { decision: "allow" }, cookie);
  if (allow.status !== 200) throw Error(`allow_${allow.status}`);
  const allowedView = await settle(allowedRun.body.id);
  if (!existsInContainer(allowedPath)) throw Error("allowed_write_missing");
  const logAfterAllow = command("docker", "exec", id, "sh", "-c", `cat ${writeLog}`).split("\n").filter(Boolean);
  if (logAfterAllow.length !== 1 || logAfterAllow[0] !== allowedPath) throw Error(`allowed_writes_${JSON.stringify(logAfterAllow)}`);
  record.allowed = { state: allowedView.state, stopReason: allowedView.stopReason, fileExists: true, writesLogged: logAfterAllow.length, optionId: allow.body.optionId };

  // 4. A decided request cannot be decided again.
  const again = await api(`/api/runs/${allowedRun.body.id}/permissions/${pendingAllow.requestId}`, "POST", { decision: "allow" }, cookie);
  if (again.status !== 404) throw Error(`second_decision_${again.status}`);
  record.secondDecision = again.status;

  const healthy = await api("/api/health/ready");
  if (healthy.status !== 200) throw Error("api_not_healthy");

  record.result = "permission_gate_denies_before_action_and_allows_once_passed";
  console.log(JSON.stringify({ result: record.result, pending: record.pending, denied: record.denied, allowed: record.allowed, secondDecision: record.secondDecision }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc035-agent"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}