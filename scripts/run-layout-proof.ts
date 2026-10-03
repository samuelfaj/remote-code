// RC-033 proof: per-workspace tab layout through the real backend boundary.
// Two workspaces, save tabs on A, switch selection, reopen both, confirm
// A's layout returns and B never moves. Runs on Linux against the pinned image.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC033_LAYOUT_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc033-layout-${randomUUID()}`;
const volume = `${run}-data`;
const image = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc033.layoutproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/layout-proof.sqlite";
const record: any = { run, volume, image, result: "unverified", scope: "RC-033 tab-layout slice: save/open per workspace without cross-workspace moves; not panes, not mobile" };
let id = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Id !== image || metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Approved Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/layout-proof-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  const apiPort = 15_000 + Math.floor(Math.random() * 2000);
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
  const names = [`layout-a-${randomUUID()}`, `layout-b-${randomUUID()}`];
  for (const name of names) {
    const created = await api("/api/workspaces", "POST", { name }, cookie);
    if (created.status !== 201) throw Error(`workspace_${created.status}`);
  }
  const listed = await api("/api/workspaces", "GET", undefined, cookie);
  const workspaceA = listed.body.workspaces.find((row: any) => row.name === names[0]).id;
  const workspaceB = listed.body.workspaces.find((row: any) => row.name === names[1]).id;
  const layoutA = { tabs: [{ id: "tab-1", kind: "file", targetId: "seed.txt" }, { id: "tab-2", kind: "terminal", targetId: "term-1" }], activeTabId: "tab-2" };
  const saved = await api(`/api/workspaces/${workspaceA}/layout`, "PUT", layoutA, cookie);
  if (saved.status !== 200 || JSON.stringify(saved.body.layout) !== JSON.stringify(layoutA)) throw Error("Layout save mismatch");
  // Switch selection to B and back; B stays empty, A returns.
  const onB = await api(`/api/workspaces/${workspaceB}/layout`, "GET", undefined, cookie);
  if (onB.status !== 200 || onB.body.layout !== null) throw Error("Workspace B moved by A's save");
  const reopenA = await api(`/api/workspaces/${workspaceA}/layout`, "GET", undefined, cookie);
  if (reopenA.status !== 200 || JSON.stringify(reopenA.body.layout) !== JSON.stringify(layoutA)) throw Error("Layout did not return after switch");
  const switched = { tabs: layoutA.tabs, activeTabId: "tab-1" };
  const moved = await api(`/api/workspaces/${workspaceA}/layout`, "PUT", switched, cookie);
  if (moved.status !== 200) throw Error("Tab switch not saved");
  const stillB = await api(`/api/workspaces/${workspaceB}/layout`, "GET", undefined, cookie);
  if (stillB.body.layout !== null) throw Error("Tab switch on A moved B");
  record.layout = { workspaceA, workspaceB, saved: layoutA, switched };
  record.result = "workspace_layout_slice_passed";
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
  if (process.exitCode && record.result === "workspace_layout_slice_passed") record.result = "cleanup_unverified";
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ result: record.result, error: record.error, cleanup: record.cleanup }));
}
