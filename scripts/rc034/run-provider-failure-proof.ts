// RC-034 proof: the supervisor ends a run with a distinct, honest state when
// the provider refuses or fails, without retrying or switching model/account.
//
// A controlled ACP agent answers each prompt with one provider error (expired
// credential, 429 with Retry-After, 503 unavailable) and records every prompt
// attempt, so exactly one attempt per run is observable.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC034_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc034-provider-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC034_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc034.providerproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc034.sqlite";
const promptLog = "/var/lib/remotecode/rc034-prompts.log";
const agentPath = "/proof/rc034-agent";
let id = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-034 provider failure: distinct states, one attempt, no model switch" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

const agentSource = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
let buffer = "";
const sessionId = "rc034-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = (message) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    const log = process.env.RC034_PROMPT_LOG;
    if (log) appendFileSync(log, process.argv.join(" ") + "\\n");
    const text = message.params?.prompt?.[0]?.text ?? "";
    if (text.includes("AUTH_EXPIRED")) return send({ id: message.id, error: { code: -32001, message: "401 Unauthorized: the provider credential has expired" } });
    if (text.includes("RATE_LIMITED")) return send({ id: message.id, error: { code: -32002, message: "429 Too Many Requests. Retry-After: 30" } });
    if (text.includes("UNAVAILABLE")) return send({ id: message.id, error: { code: -32003, message: "503 Service Unavailable: provider temporarily unavailable" } });
    return send({ id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/cancel" && message.id !== undefined) return send({ id: message.id, result: { stopReason: "cancelled" } });
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
  const apiPort = 19_800 + Math.floor(Math.random() * 1000);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/rc034-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  writeFileSync(resolve(output, "rc034-agent"), agentSource);
  chmodSync(resolve(output, "rc034-agent"), 0o755);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_DISTILL_BIN=${agentPath}`, "-e", "REMOTECODE_RUNS_CWD=/var/lib/remotecode",
    "-e", `RC034_PROMPT_LOG=${promptLog}`,
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
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc034" }, cookie);
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);

  const cases = [
    { prompt: "AUTH_EXPIRED task", reason: "provider_auth_expired", retryAfter: null },
    { prompt: "RATE_LIMITED task", reason: "provider_rate_limited", retryAfter: 30 },
    { prompt: "UNAVAILABLE task", reason: "provider_unavailable", retryAfter: null },
  ];
  const observed: any[] = [];
  for (const scenario of cases) {
    const created = await api("/api/runs", "POST", { workspaceId: workspace.body.id, prompt: scenario.prompt }, cookie);
    if (created.status !== 201) throw Error(`run_${scenario.prompt}_${created.status}`);
    const runId = created.body.id as string;
    let view: any = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      view = (await api(`/api/runs/${runId}`, "GET", undefined, cookie)).body;
      if (view && view.state !== "starting" && view.state !== "running") break;
      await delay(250);
    }
    if (!view || view.state !== "failed") throw Error(`state_${scenario.prompt}_${JSON.stringify(view)}`);
    if (view.stopReason !== scenario.reason) throw Error(`reason_${scenario.prompt}_${view.stopReason}`);
    if ((view.retryAfterSeconds ?? null) !== scenario.retryAfter) throw Error(`retry_${scenario.prompt}_${view.retryAfterSeconds}`);
    // Re-read: the terminal state must be stable, not a transient.
    const after = (await api(`/api/runs/${runId}`, "GET", undefined, cookie)).body;
    if (after.state !== "failed" || after.stopReason !== scenario.reason) throw Error(`unstable_${scenario.prompt}_${JSON.stringify(after)}`);
    observed.push({ prompt: scenario.prompt, state: view.state, stopReason: view.stopReason, retryAfterSeconds: view.retryAfterSeconds ?? null, error: view.error });
  }
  record.runs = observed;

  const healthy = await api("/api/health/ready");
  if (healthy.status !== 200) throw Error("api_not_healthy_after_failures");

  // Exactly one attempt per run, always the same command line: no retry and no
  // model or account switch.
  const lines = command("docker", "exec", id, "sh", "-c", `cat ${promptLog}`).split("\n").filter(Boolean);
  if (lines.length !== cases.length) throw Error(`attempts_${lines.length}_expected_${cases.length}`);
  if (new Set(lines).size !== 1) throw Error(`command_line_changed_${JSON.stringify([...new Set(lines)])}`);
  if (/\s--model\s|\smodel=|--account|account=/.test(lines[0])) throw Error(`model_or_account_switch_${lines[0]}`);
  record.attempts = { count: lines.length, uniqueCommandLines: new Set(lines).size, commandLine: lines[0].replace(agentPath, "<agent>") };

  record.result = "provider_failures_get_distinct_states_without_retry_passed";
  console.log(JSON.stringify({ result: record.result, runs: record.runs, attempts: record.attempts }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc034-agent"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}