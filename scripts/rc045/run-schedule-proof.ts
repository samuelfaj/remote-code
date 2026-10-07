// RC-045 proof: one workspace agent task and one Bot routine fire on their
// schedule with a durable per-occurrence decision and exactly one execution,
// a paused schedule fires nothing, and a host restart turns an in-flight
// occurrence into an honest "unknown" without running it again.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = "/Users/samuelfajreldines/dev/new-remote-code";
const output = process.env.RC045_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc045-schedules-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC045_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc045.schedules";
const password = randomBytes(24).toString("base64url");
const databasePath = "/var/lib/remotecode/rc045.sqlite";
const launchLog = "/var/lib/remotecode/rc045-launches.log";
let id = "";
let apiPort = 0;
const record: any = { run, volume, image, result: "unverified", scope: "RC-045 schedules: one task, one routine, per-occurrence decision, pause, restart unknown" };

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
const sessionId = "rc045-session";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = (message) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    const log = process.env.RC045_LAUNCH_LOG;
    if (log) appendFileSync(log, text.replace(/\\n/g, " | ") + "\\n");
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
    `REMOTECODE_DISTILL_BIN=/proof/rc045-agent REMOTECODE_RUNS_CWD=/var/lib/remotecode RC045_LAUNCH_LOG=${launchLog} ` +
    `REMOTECODE_TLS_CERT=/proof/proof-ca.pem REMOTECODE_TLS_KEY=/proof/proof-key.pem bun apps/api/src/index.ts > /var/lib/remotecode/rc045-api.log 2>&1`);
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
  apiPort = 32_000 + Math.floor(Math.random() * 500);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "rc045-agent"), agentSource);
  chmodSync(resolve(output, "rc045-agent"), 0o755);
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

  const tls = { ca: readFileSync(cert, "utf8") };
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(`https://127.0.0.1:${apiPort}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), tls,
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const launches = () => command("docker", "exec", id, "sh", "-c", `test -f ${launchLog} && cat ${launchLog} || true`).split("\n").filter(Boolean);

  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc045" }, cookie);
  const workspaceId = workspace.body.id as string;
  const bot = await api("/api/bots", "POST", { name: "Scheduler Bot", instructions: "scheduled routine" }, cookie);
  if (bot.status !== 201) throw Error(`bot_${bot.status}`);

  // A local time one minute ahead of now, in UTC, so the trigger is imminent.
  const soon = new Date(Date.now() + 60_000);
  const localTime = `${String(soon.getUTCHours()).padStart(2, "0")}:${String(soon.getUTCMinutes()).padStart(2, "0")}`;
  const taskSchedule = await api("/api/schedules", "POST", { kind: "task", workspaceId, prompt: "scheduled task", localTime, timezone: "UTC" }, cookie);
  if (taskSchedule.status !== 201) throw Error(`task_schedule_${taskSchedule.status}_${JSON.stringify(taskSchedule.body)}`);
  const routineSchedule = await api("/api/schedules", "POST", { kind: "routine", botId: bot.body.id, workspaceId, prompt: "scheduled routine", localTime, timezone: "UTC" }, cookie);
  if (routineSchedule.status !== 201) throw Error(`routine_schedule_${routineSchedule.status}_${JSON.stringify(routineSchedule.body)}`);
  const paused = await api("/api/schedules", "POST", { kind: "task", workspaceId, prompt: "paused task", localTime, timezone: "UTC" }, cookie);
  const pauseEdit = await api(`/api/schedules/${paused.body.id}`, "PATCH", { enabled: false }, cookie);
  if (pauseEdit.status !== 200 || pauseEdit.body.enabled !== false) throw Error(`pause_${pauseEdit.status}_${JSON.stringify(pauseEdit.body)}`);

  const occurrencesOf = async (scheduleId: string) => (await api(`/api/schedules/${scheduleId}/occurrences`, "GET", undefined, cookie)).body.occurrences as any[];
  const waitFor = async (scheduleId: string, predicate: (rows: any[]) => boolean, label: string, budgetMs = 180_000) => {
    const end = Date.now() + budgetMs;
    let rows: any[] = [];
    while (Date.now() < end) {
      rows = await occurrencesOf(scheduleId);
      if (predicate(rows)) return rows;
      await delay(2_000);
    }
    throw Error(`${label}_timeout_${JSON.stringify(rows)}`);
  };

  const taskRows = await waitFor(taskSchedule.body.id, (rows) => rows.length > 0 && rows[0].state !== "started", "task_occurrence");
  const routineRows = await waitFor(routineSchedule.body.id, (rows) => rows.length > 0 && rows[0].state !== "started", "routine_occurrence");
  if (taskRows.length !== 1 || routineRows.length !== 1) throw Error(`duplicate_occurrences_${taskRows.length}_${routineRows.length}`);
  if (!taskRows[0].decision || !routineRows[0].decision) throw Error(`missing_decision_${JSON.stringify([taskRows[0], routineRows[0]])}`);
  if (!taskRows[0].runId || !routineRows[0].runId) throw Error("occurrence_without_run");
  if (taskRows[0].state !== "succeeded" || routineRows[0].state !== "succeeded") throw Error(`states_${taskRows[0].state}_${routineRows[0].state}`);

  // The paused schedule must not fire while the others did.
  await delay(5_000);
  const pausedRows = await occurrencesOf(paused.body.id);
  if (pausedRows.length !== 0) throw Error(`paused_schedule_fired_${JSON.stringify(pausedRows)}`);
  const afterFirstFires = launches();
  if (afterFirstFires.length !== 2) throw Error(`launches_${JSON.stringify(afterFirstFires)}`);

  // A restart with an occurrence in flight must end as unknown, never rerun.
  const holdTime = `${String(new Date(Date.now() + 60_000).getUTCHours()).padStart(2, "0")}:${String(new Date(Date.now() + 60_000).getUTCMinutes()).padStart(2, "0")}`;
  const holdSchedule = await api("/api/schedules", "POST", { kind: "task", workspaceId, prompt: "HOLD scheduled task", localTime: holdTime, timezone: "UTC" }, cookie);
  if (holdSchedule.status !== 201) throw Error(`hold_schedule_${holdSchedule.status}`);
  const holdRows = await waitFor(holdSchedule.body.id, (rows) => rows.length > 0 && Boolean(rows[0].runId), "hold_occurrence");
  const holdRunId = holdRows[0].runId as string;
  const running = await api(`/api/runs/${holdRunId}`, "GET", undefined, cookie);
  if (running.body.state !== "running") throw Error(`hold_run_${running.body.state}`);

  command("docker", "restart", id);
  await startApi();
  const relogin = await api("/api/auth/login", "POST", { password });
  const cookieAfter = relogin.cookie;
  const holdAfter = (await api(`/api/schedules/${holdSchedule.body.id}/occurrences`, "GET", undefined, cookieAfter)).body.occurrences as any[];
  const runAfter = await api(`/api/runs/${holdRunId}`, "GET", undefined, cookieAfter);
  const launchesAfter = launches();

  if (holdAfter.length !== 1) throw Error(`hold_occurrences_after_restart_${holdAfter.length}`);
  if (holdAfter[0].state !== "unknown" || holdAfter[0].decision !== "requires_verification") throw Error(`hold_recovery_${JSON.stringify(holdAfter[0])}`);
  if (runAfter.body.state !== "interrupted" || runAfter.body.stopReason !== "host_restart") throw Error(`hold_run_after_${JSON.stringify(runAfter.body)}`);
  if (launchesAfter.length !== 3) throw Error(`replay_after_restart_${JSON.stringify(launchesAfter)}`);
  await delay(6_000);
  if (launches().length !== 3) throw Error("a recovered occurrence was run again");
  const taskAfter = await occurrencesOf(taskSchedule.body.id);
  const routineAfter = await occurrencesOf(routineSchedule.body.id);
  if (taskAfter.length !== 1 || routineAfter.length !== 1) throw Error(`fired_again_${taskAfter.length}_${routineAfter.length}`);

  record.schedules = {
    localTime,
    task: { id: taskSchedule.body.id, occurrence: taskRows[0] },
    routine: { id: routineSchedule.body.id, occurrence: routineRows[0] },
    paused: { id: paused.body.id, occurrences: pausedRows.length },
  };
  record.restart = { hold: holdAfter[0], run: { state: runAfter.body.state, stopReason: runAfter.body.stopReason }, launchesBefore: 3, launchesAfter: launchesAfter.length, taskOccurrencesAfter: taskAfter.length, routineOccurrencesAfter: routineAfter.length };
  record.result = "scheduled_task_and_routine_fired_once_with_durable_decisions_and_unknown_after_restart_passed";
  console.log(JSON.stringify({ result: record.result, schedules: record.schedules, restart: record.restart }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc045-agent"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}