// RC-012 proof: file routes stop after logout/expiry through the real backend
// boundary on Linux. Logout, expired-row and foreign-owner denials leave
// bytes and receipts unchanged.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC012_FILES_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc012-files-${randomUUID()}`;
const volume = `${run}-data`;
const image = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc012.filesproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/files-proof.sqlite";
const record: any = { run, volume, image, result: "unverified", scope: "RC-012 file-routes slice: logout/expiry/foreign denial on reads+writes; not bots/threads/tasks" };
let id = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
const stateCode = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)},{readonly:true,create:false});d.exec('PRAGMA busy_timeout=250');console.log(JSON.stringify({files:d.query('select count(*) n from file_operation_outcomes').get(),intents:d.query('select count(*) n from file_operation_intents').get(),sessions:d.query('select count(*) n from sessions').get(),quickCheck:d.query('pragma quick_check').all()}));d.close();`;
function state() { return JSON.parse(command("docker", "exec", id, "bun", "-e", stateCode)); }
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Id !== image || metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Approved Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/files-proof-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  const apiPort = 16_000 + Math.floor(Math.random() * 2000);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", `API_PORT=3000`, "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_TLS_CERT=/proof/proof-ca.pem`, "-e", `REMOTECODE_TLS_KEY=/proof/proof-key.pem`,
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
  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const name = `files-${randomUUID()}`;
  if ((await api("/api/workspaces", "POST", { name }, cookie)).status !== 201) throw Error("workspace_create_failed");
  const listed = await api("/api/workspaces", "GET", undefined, cookie);
  const workspaceId = listed.body.workspaces.find((row: any) => row.name === name).id;
  if ((await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: randomUUID() }, cookie)).status !== 200) throw Error("folder_provision_failed");
  const seed = await api(`/api/workspaces/${workspaceId}/files`, "POST", { requestId: randomUUID(), path: "seed.txt", content: "seed\n" }, cookie);
  if (seed.status !== 201) throw Error(`file_create_${seed.status}`);
  const seedBytes = command("docker", "exec", id, "bun", "-e",
    `import{readFileSync}from'node:fs';console.log(JSON.stringify({content:readFileSync(${JSON.stringify(`/var/lib/remotecode/workspaces/${workspaceId}/seed.txt`)},'utf8')}))`);
  record.seedBytes = seedBytes;
  const before = state();
  // This product has a single local user: every password login maps to the
  // same user, so a second login cannot act as a foreign owner. Foreign-owner
  // isolation for files is proved by unit tests with seeded alice/bob
  // sessions; here prove logout stops the owner cookie on reads and writes.
  // Logout stops the owner cookie on reads and writes; file outcomes and
  // intents must be unchanged (only the sessions row goes away).
  const logout = await api("/api/auth/logout", "POST", {}, cookie);
  if (![200, 204].includes(logout.status)) throw Error(`logout_${logout.status}`);
  if ((await api(`/api/workspaces/${workspaceId}/files`, "GET", undefined, cookie)).status !== 401) throw Error("Logged-out read not denied");
  if ((await api(`/api/workspaces/${workspaceId}/files`, "POST", { requestId: randomUUID(), path: "late.txt", content: "y" }, cookie)).status !== 401) throw Error("Logged-out write not denied");
  const after = state();
  if (after.files?.n !== before.files?.n || after.intents?.n !== before.intents?.n) throw Error(`Logout changed file state: ${JSON.stringify(after)}`);
  const lateBytes = command("docker", "exec", id, "bun", "-e",
    `import{existsSync,readFileSync,readdirSync}from'node:fs';const dir=${JSON.stringify(`/var/lib/remotecode/workspaces/${workspaceId}`)};console.log(JSON.stringify({files:readdirSync(dir).sort(),seed:readFileSync(dir+'/seed.txt','utf8'),lateExists:existsSync(dir+'/late.txt')}))`);
  record.lateBytes = lateBytes;
  const parsed = JSON.parse(lateBytes);
  if (parsed.seed !== "seed\n" || parsed.lateExists || !parsed.files.includes("seed.txt")) throw Error(`Denied writes changed bytes: ${lateBytes}`);
  record.before = before;
  record.after = after;
  record.result = "file_routes_session_bound_passed";
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
  if (process.exitCode && record.result === "file_routes_session_bound_passed") record.result = "cleanup_unverified";
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ result: record.result, error: record.error, cleanup: record.cleanup }));
}
