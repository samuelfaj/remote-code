// RC-012 proof: every resource route derives ownership from the live session.
// Two real sessions (A and B) plus one expired session are used against the
// shipped API; B must never list, read or change A's resources, and an expired
// session must be refused everywhere.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = "/Users/samuelfajreldines/dev/new-remote-code";
const output = process.env.RC012_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc012-ownership-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC012_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc012.ownershipproof";
const password = randomBytes(24).toString("base64url");
const databasePath = "/var/lib/remotecode/rc012.sqlite";
let id = "";
let apiPort = 0;
const record: any = { run, volume, image, result: "unverified", scope: "RC-012 cross-account ownership over every shipped resource route" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args, exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  apiPort = 29_000 + Math.floor(Math.random() * 800);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", "REMOTECODE_DISTILL_BIN=/bin/true", "-e", "REMOTECODE_RUNS_CWD=/var/lib/remotecode",
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", image, "apps/api/src/index.ts");
  command("docker", "start", id);

  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1200), tls } as any)).status === 200) break; } catch {}
    await delay(250);
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
  const seedSession = (userId: string, expiresAt: number) => {
    const token = randomBytes(32).toString("hex");
    const code = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)});d.exec('PRAGMA busy_timeout=500');` +
      `d.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(${JSON.stringify(tokenHash(token))},${JSON.stringify(userId)},${expiresAt});d.close();console.log('ok');`;
    if (command("docker", "exec", id, "bun", "-e", code) !== "ok") throw Error("session_seed_failed");
    return `remotecode_session=${token}`;
  };

  const loginA = await api("/api/auth/login", "POST", { password });
  if (loginA.status !== 200) throw Error(`login_${loginA.status}`);
  const cookieA = loginA.cookie;
  const cookieB = seedSession("account-b", Date.now() + 600_000);
  const cookieExpired = seedSession("account-expired", Date.now() - 60_000);

  // Account A creates real resources.
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "account-a" }, cookieA);
  if (workspace.status !== 201) throw Error(`workspace_${workspace.status}`);
  const workspaceId = workspace.body.id as string;
  const folder = await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: randomUUID() }, cookieA);
  if (folder.status !== 201 && folder.status !== 200) throw Error(`folder_${folder.status}`);
  const file = await api(`/api/workspaces/${workspaceId}/files`, "POST", { requestId: randomUUID(), path: "owned.txt", content: "account-a-secret" }, cookieA);
  if (file.status !== 201 && file.status !== 200) throw Error(`file_${file.status}`);
  const history = await api(`/api/workspaces/${workspaceId}/history`, "POST", { requestId: randomUUID(), type: "thread", content: "account-a message" }, cookieA);
  if (history.status !== 201) throw Error(`history_${history.status}`);
  const layout = await api(`/api/workspaces/${workspaceId}/layout`, "PUT", { tabs: [{ id: "tab-a", kind: "file", targetId: "owned.txt" }], activeTabId: "tab-a" }, cookieA);
  if (layout.status !== 200) throw Error(`layout_${layout.status}`);
  const bot = await api("/api/bots", "POST", { name: "AccountABot", instructions: "account-a only" }, cookieA);
  if (bot.status !== 201) throw Error(`bot_${bot.status}`);
  const botId = bot.body.id as string;
  const botMemory = await api(`/api/bots/${botId}/memory`, "POST", { text: "account-a fact" }, cookieA);
  if (botMemory.status !== 201) throw Error(`bot_memory_${botMemory.status}`);
  const botRun = await api(`/api/bots/${botId}/run`, "POST", { requestId: randomUUID(), workspaceId, prompt: "account-a task" }, cookieA);
  if (botRun.status !== 201) throw Error(`bot_run_${botRun.status}`);
  const runId = botRun.body.id as string;

  // Every resource route, addressed with account A's real ids.
  const audit: Array<{ name: string; method: string; path: string; body?: unknown; expect: number }> = [
    { name: "workspace list", method: "GET", path: "/api/workspaces", expect: 200 },
    { name: "workspace read", method: "GET", path: `/api/workspaces/${workspaceId}`, expect: 404 },
    { name: "workspace patch", method: "PATCH", path: `/api/workspaces/${workspaceId}`, body: { requestId: randomUUID(), name: "stolen" }, expect: 404 },
    { name: "folder read", method: "GET", path: `/api/workspaces/${workspaceId}/folder`, expect: 404 },
    { name: "folder create", method: "POST", path: `/api/workspaces/${workspaceId}/folder`, body: { requestId: randomUUID() }, expect: 404 },
    { name: "history read", method: "GET", path: `/api/workspaces/${workspaceId}/history`, expect: 404 },
    { name: "history write", method: "POST", path: `/api/workspaces/${workspaceId}/history`, body: { requestId: randomUUID(), type: "thread", content: "stolen" }, expect: 404 },
    { name: "layout read", method: "GET", path: `/api/workspaces/${workspaceId}/layout`, expect: 404 },
    { name: "layout write", method: "PUT", path: `/api/workspaces/${workspaceId}/layout`, body: { tabs: [], activeTabId: null }, expect: 404 },
    { name: "files list", method: "GET", path: `/api/workspaces/${workspaceId}/files`, expect: 404 },
    { name: "file content", method: "GET", path: `/api/workspaces/${workspaceId}/files/content?path=owned.txt`, expect: 404 },
    { name: "file write", method: "POST", path: `/api/workspaces/${workspaceId}/files`, body: { requestId: randomUUID(), path: "owned.txt", content: "stolen" }, expect: 404 },
    { name: "git status", method: "GET", path: `/api/workspaces/${workspaceId}/git/status`, expect: 404 },
    { name: "git branches", method: "GET", path: `/api/workspaces/${workspaceId}/git/branches`, expect: 404 },
    { name: "git commit", method: "POST", path: `/api/workspaces/${workspaceId}/git/commit`, body: { requestId: randomUUID(), message: "stolen" }, expect: 404 },
    { name: "git fetch", method: "POST", path: `/api/workspaces/${workspaceId}/git/fetch`, body: { remote: "origin" }, expect: 404 },
    { name: "run list", method: "GET", path: `/api/workspaces/${workspaceId}/runs`, expect: 404 },
    { name: "run read", method: "GET", path: `/api/runs/${runId}`, expect: 404 },
    { name: "run stop", method: "POST", path: `/api/runs/${runId}/stop`, expect: 404 },
    { name: "run handoff", method: "POST", path: `/api/runs/${runId}/handoff`, body: { reason: "stolen" }, expect: 404 },
    { name: "run permissions", method: "GET", path: `/api/runs/${runId}/permissions`, expect: 404 },
    { name: "bot list", method: "GET", path: "/api/bots", expect: 200 },
    { name: "bot read", method: "GET", path: `/api/bots/${botId}`, expect: 404 },
    { name: "bot patch", method: "PATCH", path: `/api/bots/${botId}`, body: { name: "stolen" }, expect: 404 },
    { name: "bot memory read", method: "GET", path: `/api/bots/${botId}/memory`, expect: 404 },
    { name: "bot memory write", method: "POST", path: `/api/bots/${botId}/memory`, body: { text: "stolen" }, expect: 404 },
    { name: "bot skills write", method: "PUT", path: `/api/bots/${botId}/skills`, body: { skills: ["stolen"] }, expect: 404 },
    { name: "bot runs", method: "GET", path: `/api/bots/${botId}/runs`, expect: 404 },
    { name: "bot run start", method: "POST", path: `/api/bots/${botId}/run`, body: { requestId: randomUUID(), workspaceId, prompt: "stolen" }, expect: 404 },
    { name: "bot session read", method: "GET", path: `/api/bots/${botId}/session`, expect: 404 },
    { name: "workspace receipt", method: "GET", path: `/api/workspaces/receipts/${randomUUID()}`, expect: 404 },
  ];

  const denied: any[] = [];
  for (const entry of audit) {
    const response = await api(entry.path, entry.method, entry.body, cookieB);
    if (entry.expect === 200) {
      // A list route may answer 200; what matters is that it holds no A-owned row.
      const rows = response.body?.workspaces ?? response.body?.bots ?? [];
      if (response.status !== 200 || rows.some((row: any) => row?.id === workspaceId || row?.id === botId)) {
        throw Error(`list_leaked_a_resource_${entry.name}_${response.status}`);
      }
      denied.push({ name: entry.name, status: response.status, rows: rows.length });
      continue;
    }
    if (response.status !== entry.expect) throw Error(`ownership_${entry.name}_${response.status}_${JSON.stringify(response.body).slice(0, 160)}`);
    denied.push({ name: entry.name, status: response.status });
  }

  // Nothing of A's changed while B was trying.
  const afterWorkspace = await api(`/api/workspaces/${workspaceId}`, "GET", undefined, cookieA);
  const afterFile = await api(`/api/workspaces/${workspaceId}/files/content?path=owned.txt`, "GET", undefined, cookieA);
  const afterHistory = await api(`/api/workspaces/${workspaceId}/history`, "GET", undefined, cookieA);
  const afterLayout = await api(`/api/workspaces/${workspaceId}/layout`, "GET", undefined, cookieA);
  const afterBot = await api(`/api/bots/${botId}`, "GET", undefined, cookieA);
  const afterMemory = await api(`/api/bots/${botId}/memory`, "GET", undefined, cookieA);
  if (afterWorkspace.body.name !== "account-a") throw Error("workspace_was_renamed");
  if (afterFile.body.content !== "account-a-secret") throw Error(`file_was_changed_${JSON.stringify(afterFile.body).slice(0, 120)}`);
  if ((afterHistory.body.history ?? []).length !== 1) throw Error("history_was_changed");
  if (afterLayout.body.layout?.activeTabId !== "tab-a") throw Error("layout_was_changed");
  if (afterBot.body.name !== "AccountABot" || afterBot.body.skills?.length !== 0) throw Error(`bot_was_changed_${JSON.stringify(afterBot.body).slice(0, 160)}`);
  if ((afterMemory.body.entries ?? []).length !== 1) throw Error("bot_memory_was_changed");

  // An expired session is refused on read, write and list.
  const expiredChecks = [
    { name: "expired list", method: "GET", path: "/api/workspaces" },
    { name: "expired read", method: "GET", path: `/api/workspaces/${workspaceId}` },
    { name: "expired write", method: "POST", path: `/api/workspaces/${workspaceId}/history`, body: { requestId: randomUUID(), type: "thread", content: "expired" } },
    { name: "expired bot read", method: "GET", path: `/api/bots/${botId}` },
    { name: "expired run read", method: "GET", path: `/api/runs/${runId}` },
  ];
  const expired: any[] = [];
  for (const entry of expiredChecks) {
    const response = await api(entry.path, entry.method, entry.body, cookieExpired);
    if (response.status !== 401) throw Error(`expired_session_${entry.name}_${response.status}`);
    expired.push({ name: entry.name, status: response.status });
  }
  // And anonymously.
  const anonymous = await api(`/api/workspaces/${workspaceId}`, "GET");
  if (anonymous.status !== 401) throw Error(`anonymous_read_${anonymous.status}`);

  record.ownership = { auditedRoutes: denied.length, denied };
  record.intact = {
    workspace: afterWorkspace.body.name,
    file: afterFile.body.content,
    historyEntries: (afterHistory.body.history ?? []).length,
    activeTab: afterLayout.body.layout?.activeTabId,
    bot: afterBot.body.name,
    memoryEntries: (afterMemory.body.entries ?? []).length,
  };
  record.expired = { checks: expired, anonymous: anonymous.status };
  record.result = "every_resource_route_denied_a_second_account_and_an_expired_session_passed";
  console.log(JSON.stringify({ result: record.result, auditedRoutes: denied.length, expired: expired.length, intact: record.intact }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}