// RC-040 proof: two Bots run Distill sessions at the same time and stay separate.
//
// A controlled ACP agent records every prompt it receives and writes a file
// named after the task marker in it, so the proof can compare the transcripts,
// the files and the run states of two Bots started together.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC040_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc040-bots-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC040_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc040.botproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc040.sqlite";
const promptLog = "/var/lib/remotecode/rc040-prompts.log";
const workspaceDir = "/var/lib/remotecode/rc040-workspace";
const agentPath = "/proof/rc040-agent";
let id = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-040 two Bots run Distill threads simultaneously" };

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
let promptId = null;
const sessionId = "rc040-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = (message) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    const log = process.env.RC040_PROMPT_LOG;
    if (log) appendFileSync(log, JSON.stringify({ argv: process.argv.slice(1).join(" "), text }) + "\\n");
    const marker = text.includes("TASK_ALPHA") ? "alpha" : text.includes("TASK_BETA") ? "beta" : null;
    if (marker) writeFileSync(process.env.RC040_WORKDIR + "/" + marker + ".txt", marker + ": " + text);
    if (text.includes("SLOW")) return;
    return send({ id: message.id, result: { stopReason: "end_turn" } });
  }
  // session/cancel arrives as a notification (no id): answer the open prompt.
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

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const apiPort = 20_000 + Math.floor(Math.random() * 900);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/rc040-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  writeFileSync(resolve(output, "rc040-agent"), agentSource);
  chmodSync(resolve(output, "rc040-agent"), 0o755);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_DISTILL_BIN=${agentPath}`, "-e", `REMOTECODE_RUNS_CWD=${workspaceDir}`,
    "-e", `RC040_PROMPT_LOG=${promptLog}`, "-e", `RC040_WORKDIR=${workspaceDir}`,
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);
  command("docker", "exec", id, "mkdir", "-p", workspaceDir);

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
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc040" }, cookie);
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);

  const alpha = await api("/api/bots", "POST", { name: "Alpha", instructions: "ALPHA-INSTRUCTIONS: answer only about alpha." }, cookie);
  const beta = await api("/api/bots", "POST", { name: "Beta", instructions: "BETA-INSTRUCTIONS: answer only about beta." }, cookie);
  if (alpha.status !== 201 || beta.status !== 201) throw Error(`bots_${alpha.status}_${beta.status}`);

  // Simultaneous tasks for the two Bots, in the same workspace.
  const [runAlpha, runBeta] = await Promise.all([
    api(`/api/bots/${alpha.body.id}/run`, "POST", { requestId: randomUUID(), workspaceId: workspace.body.id, prompt: "TASK_ALPHA please" }, cookie),
    api(`/api/bots/${beta.body.id}/run`, "POST", { requestId: randomUUID(), workspaceId: workspace.body.id, prompt: "TASK_BETA please" }, cookie),
  ]);
  if (runAlpha.status !== 201 || runBeta.status !== 201) throw Error(`runs_${runAlpha.status}_${runBeta.status}`);

  const settle = async (runId: string) => {
    let view: any = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      view = (await api(`/api/runs/${runId}`, "GET", undefined, cookie)).body;
      if (view && view.state !== "starting" && view.state !== "running") return view;
      await delay(200);
    }
    throw Error(`run_never_settled_${runId}_${JSON.stringify(view)}`);
  };
  const alphaView = await settle(runAlpha.body.id);
  const betaView = await settle(runBeta.body.id);
  if (alphaView.state !== "completed" || betaView.state !== "completed") throw Error(`states_${alphaView.state}_${betaView.state}`);
  if (alphaView.stopReason !== "end_turn" || betaView.stopReason !== "end_turn") throw Error(`stop_${alphaView.stopReason}_${betaView.stopReason}`);

  // Each Bot's thread holds only its own run.
  const alphaRuns = (await api(`/api/bots/${alpha.body.id}/runs`, "GET", undefined, cookie)).body.runs;
  const betaRuns = (await api(`/api/bots/${beta.body.id}/runs`, "GET", undefined, cookie)).body.runs;
  if (alphaRuns.length !== 1 || alphaRuns[0].id !== runAlpha.body.id) throw Error(`alpha_thread_${JSON.stringify(alphaRuns.map((r: any) => r.id))}`);
  if (betaRuns.length !== 1 || betaRuns[0].id !== runBeta.body.id) throw Error(`beta_thread_${JSON.stringify(betaRuns.map((r: any) => r.id))}`);

  // Transcript: each stored prompt carries its own Bot's instructions only.
  if (!alphaView.prompt.includes("ALPHA-INSTRUCTIONS") || !alphaView.prompt.includes("TASK_ALPHA")) throw Error(`alpha_prompt_${alphaView.prompt}`);
  if (alphaView.prompt.includes("BETA-INSTRUCTIONS") || betaView.prompt.includes("ALPHA-INSTRUCTIONS")) throw Error("instructions_crossed_between_bots");
  if (!betaView.prompt.includes("BETA-INSTRUCTIONS") || !betaView.prompt.includes("TASK_BETA")) throw Error(`beta_prompt_${betaView.prompt}`);

  // The agent recorded two separate prompts, each with its own instructions.
  const prompts = command("docker", "exec", id, "sh", "-c", `cat ${promptLog}`).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (prompts.length !== 2) throw Error(`prompt_count_${prompts.length}`);
  if (new Set(prompts.map((p: any) => p.argv)).size !== 1) throw Error(`harness_changed_${JSON.stringify(prompts.map((p: any) => p.argv))}`);
  const alphaPrompt = prompts.find((p: any) => p.text.includes("TASK_ALPHA"));
  const betaPrompt = prompts.find((p: any) => p.text.includes("TASK_BETA"));
  if (!alphaPrompt || alphaPrompt.text.includes("BETA-INSTRUCTIONS")) throw Error("alpha_transcript_wrong");
  if (!betaPrompt || betaPrompt.text.includes("ALPHA-INSTRUCTIONS")) throw Error("beta_transcript_wrong");

  // Files: each run wrote only its own file, in the workspace.
  const alphaFile = command("docker", "exec", id, "cat", `${workspaceDir}/alpha.txt`);
  const betaFile = command("docker", "exec", id, "cat", `${workspaceDir}/beta.txt`);
  if (!alphaFile.startsWith("alpha: ALPHA-INSTRUCTIONS") || alphaFile.includes("BETA-INSTRUCTIONS")) throw Error(`alpha_file_${alphaFile}`);
  if (!betaFile.startsWith("beta: BETA-INSTRUCTIONS") || betaFile.includes("ALPHA-INSTRUCTIONS")) throw Error(`beta_file_${betaFile}`);

  // A Bot run can be interrupted.
  const slow = await api(`/api/bots/${alpha.body.id}/run`, "POST", { requestId: randomUUID(), workspaceId: workspace.body.id, prompt: "SLOW hold" }, cookie);
  if (slow.status !== 201) throw Error(`slow_${slow.status}`);
  let running: any = null;
  const runningDeadline = Date.now() + 20_000;
  while (Date.now() < runningDeadline) {
    running = (await api(`/api/runs/${slow.body.id}`, "GET", undefined, cookie)).body;
    if (running?.state === "running") break;
    await delay(150);
  }
  if (running?.state !== "running") throw Error(`slow_not_running_${JSON.stringify(running)}`);
  const stopped = await api(`/api/runs/${slow.body.id}/stop`, "POST", undefined, cookie);
  if (stopped.status !== 200) throw Error(`stop_${stopped.status}`);
  const interrupted = await settle(slow.body.id);
  if (interrupted.state !== "interrupted" || interrupted.stopReason !== "cancelled") throw Error(`interrupt_${JSON.stringify(interrupted)}`);

  record.threads = {
    alpha: { runId: runAlpha.body.id, botId: alphaView.botId, state: alphaView.state, stopReason: alphaView.stopReason, prompt: alphaView.prompt, file: alphaFile.slice(0, 120) },
    beta: { runId: runBeta.body.id, botId: betaView.botId, state: betaView.state, stopReason: betaView.stopReason, prompt: betaView.prompt, file: betaFile.slice(0, 120) },
    alphaThreadRunIds: alphaRuns.map((r: any) => r.id),
    betaThreadRunIds: betaRuns.map((r: any) => r.id),
    promptAttempts: prompts.length,
    uniqueHarness: new Set(prompts.map((p: any) => p.argv)).size,
  };
  record.interrupt = { runId: slow.body.id, state: interrupted.state, stopReason: interrupted.stopReason };
  if (alphaView.botId !== alpha.body.id || betaView.botId !== beta.body.id) throw Error("run_not_bound_to_its_bot");

  record.result = "two_bots_ran_their_own_threads_and_one_bot_was_interrupted_passed";
  console.log(JSON.stringify({ result: record.result, threads: record.threads, interrupt: record.interrupt }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc040-agent"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}