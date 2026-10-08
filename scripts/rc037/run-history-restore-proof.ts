// RC-037 proof: two threads and their messages survive a container restart,
// and the interrupted one keeps its own state.
//
// The shipped API runs in a Docker container on a task-owned volume. Two runs
// are created (one completed, one interrupted) with history entries, the
// container is restarted, and the same ids, messages and states are read back.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC037_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc037-history-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC037_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc037.historyproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc037.sqlite";
const agentPath = "/proof/rc037-agent";
let id = "";
let apiPort = 0;
const record: any = { run, volume, image, result: "unverified", scope: "RC-037 two threads and their messages survive a restart" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

const agentSource = `#!/usr/bin/env bun
let buffer = "";
let promptId = null;
const sessionId = "rc037-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = (message) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk" } } });
    if (text.includes("SLOW")) return;
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
  command("docker", "exec", id, "sh", "-c",
    `cd /workspace && API_PORT=3000 DATABASE_PATH=${databasePath} REMOTECODE_AUTH_PASSWORD='${password}' REMOTECODE_DISTILL_BIN=${agentPath} ` +
    `REMOTECODE_RUNS_CWD=/var/lib/remotecode RC034_UNUSED=1 REMOTECODE_TLS_CERT=/proof/proof-ca.pem REMOTECODE_TLS_KEY=/proof/proof-key.pem ` +
    `bun apps/api/src/index.ts > /var/lib/remotecode/rc037-api.log 2>&1 &`);
  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(resolve(output, "proof-ca.pem")) };
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) return; } catch {}
    await delay(200);
  }
  throw Error("api_never_became_ready");
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  apiPort = 21_000 + Math.floor(Math.random() * 800);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "rc037-agent"), agentSource);
  chmodSync(resolve(output, "rc037-agent"), 0o755);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_DISTILL_BIN=${agentPath}`, "-e", "REMOTECODE_RUNS_CWD=/var/lib/remotecode",
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "sleep", image, "infinity");
  command("docker", "start", id);
  await startApi();

  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
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
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc037" }, cookie);
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);
  const workspaceId = workspace.body.id as string;

  // Thread A completes; thread B is interrupted.
  const threadA = await api("/api/runs", "POST", { requestId: randomUUID(), workspaceId, prompt: "quick thread A" }, cookie);
  const threadB = await api("/api/runs", "POST", { requestId: randomUUID(), workspaceId, prompt: "SLOW thread B" }, cookie);
  if (threadA.status !== 201 || threadB.status !== 201) throw Error(`runs_${threadA.status}_${threadB.status}`);
  const settle = async (runId: string, states: string[]) => {
    let view: any = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      view = (await api(`/api/runs/${runId}`, "GET", undefined, cookie)).body;
      if (view && states.includes(view.state)) return view;
      await delay(150);
    }
    throw Error(`run_never_reached_${states.join("_")}_${JSON.stringify(view)}`);
  };
  const completedA = await settle(threadA.body.id, ["completed", "failed"]);
  if (completedA.state !== "completed") throw Error(`threadA_${JSON.stringify(completedA)}`);
  await settle(threadB.body.id, ["running"]);
  const stopped = await api(`/api/runs/${threadB.body.id}/stop`, "POST", undefined, cookie);
  if (stopped.status !== 200) throw Error(`stop_${stopped.status}`);
  const interruptedB = await settle(threadB.body.id, ["interrupted", "failed"]);
  if (interruptedB.state !== "interrupted" || interruptedB.stopReason !== "cancelled") throw Error(`threadB_${JSON.stringify(interruptedB)}`);

  // Messages for both threads.
  const messageA = await api(`/api/workspaces/${workspaceId}/history`, "POST", { requestId: randomUUID(), type: "thread", content: "message for thread A" }, cookie);
  const messageB = await api(`/api/workspaces/${workspaceId}/history`, "POST", { requestId: randomUUID(), type: "thread", content: "message for thread B" }, cookie);
  if (messageA.status !== 201 || messageB.status !== 201) throw Error(`history_${messageA.status}_${messageB.status}`);

  const before = {
    runs: [
      (await api(`/api/runs/${threadA.body.id}`, "GET", undefined, cookie)).body,
      (await api(`/api/runs/${threadB.body.id}`, "GET", undefined, cookie)).body,
    ],
    history: (await api(`/api/workspaces/${workspaceId}/history`, "GET", undefined, cookie)).body.history,
  };
  if (before.history.length !== 2) throw Error(`history_count_before_${before.history.length}`);

  // Restart the container: the API and its process state go away, the volume stays.
  command("docker", "restart", id);
  await startApi();
  const relogin = await api("/api/auth/login", "POST", { password });
  if (relogin.status !== 200) throw Error(`relogin_${relogin.status}`);
  const cookieAfter = relogin.cookie;

  const after = {
    runs: [
      (await api(`/api/runs/${threadA.body.id}`, "GET", undefined, cookieAfter)).body,
      (await api(`/api/runs/${threadB.body.id}`, "GET", undefined, cookieAfter)).body,
    ],
    history: (await api(`/api/workspaces/${workspaceId}/history`, "GET", undefined, cookieAfter)).body.history,
  };

  if (after.history.length !== 2) throw Error(`history_count_after_${after.history.length}`);
  const stable = (view: any) => `${view.id}|${view.prompt}|${view.state}|${view.stopReason}|${view.workspaceId}`;
  if (stable(before.runs[0]) !== stable(after.runs[0])) throw Error(`thread_a_changed_${stable(before.runs[0])}_${stable(after.runs[0])}`);
  if (stable(before.runs[1]) !== stable(after.runs[1])) throw Error(`thread_b_changed_${stable(before.runs[1])}_${stable(after.runs[1])}`);
  if (after.runs[1].state !== "interrupted" || after.runs[1].stopReason !== "cancelled") throw Error(`interrupted_became_${JSON.stringify(after.runs[1])}`);
  const historyKey = (entry: any) => `${entry.id}|${entry.type}|${entry.content}`;
  const beforeKeys = before.history.map(historyKey).sort();
  const afterKeys = after.history.map(historyKey).sort();
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) throw Error(`history_changed_${JSON.stringify(beforeKeys)}_${JSON.stringify(afterKeys)}`);
  if (new Set(afterKeys).size !== afterKeys.length) throw Error("history_duplicated");

  record.before = { runs: before.runs.map((r: any) => ({ id: r.id, prompt: r.prompt, state: r.state, stopReason: r.stopReason })), history: beforeKeys };
  record.after = { runs: after.runs.map((r: any) => ({ id: r.id, prompt: r.prompt, state: r.state, stopReason: r.stopReason })), history: afterKeys };
  record.result = "two_threads_and_messages_survived_restart_with_interrupted_state_passed";
  console.log(JSON.stringify({ result: record.result, before: record.before, after: record.after }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc037-agent"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}