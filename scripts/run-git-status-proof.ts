// RC-030 proof: git status slice through the real backend boundary on Linux.
// Provisions a workspace, inits a git repo in the folder via the API's own
// folder path, then checks branch/clean/dirty through the shipped route.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC030_GIT_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc030-git-${randomUUID()}`;
const volume = `${run}-data`;
const baseImage = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const image = process.env.RC030_GIT_IMAGE ?? baseImage;
const label = "remotecode.rc030.gitproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/git-proof.sqlite";
const record: any = { run, volume, image, result: "unverified", scope: "RC-030 git-status slice: branch/clean/dirty/404/401/foreign; not stage/commit/branch/fetch/push" };
let id = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
const stateCode = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)},{readonly:true,create:false});console.log(JSON.stringify({quickCheck:d.query('pragma quick_check').all()}));d.close();`;
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  record.proofImage = image;
  record.baseImage = baseImage;
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/git-proof-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
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
  record.gitVersion = command("docker", "exec", id, "git", "--version");
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
  const ws = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "git-proof" }, cookie);
  if (ws.status !== 201 && ws.status !== 200) throw Error(`workspace_${ws.status}`);
  const workspaceId = ws.body.id as string;
  const folder = await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: randomUUID() }, cookie);
  if (folder.status !== 200) throw Error(`folder_${folder.status}`);
  const setupCode = `import{execSync}from'node:child_process';import{writeFileSync}from'node:fs';const folder='/var/lib/remotecode/workspaces/${workspaceId}';` +
    `execSync('git init -b main && git config user.email t@e.com && git config user.name t',{cwd:folder});` +
    `writeFileSync(folder+'/tracked.txt','one');execSync('git add tracked.txt && git commit -m init',{cwd:folder});` +
    `console.log('setup-ok');`;
  const setup = command("docker", "exec", id, "bun", "-e", setupCode).trim();
  if (setup !== "setup-ok") throw Error("repo_setup_failed");
  const clean = await api(`/api/workspaces/${workspaceId}/git/status`, "GET", undefined, cookie);
  if (clean.status !== 200 || clean.body.branch !== "main" || clean.body.clean !== true) throw Error(`clean_${clean.status}_${JSON.stringify(clean.body)}`);
  record.clean = clean.body;
  const dirtyCode = `import{writeFileSync}from'node:fs';writeFileSync('/var/lib/remotecode/workspaces/${workspaceId}/tracked.txt','two');` +
    `writeFileSync('/var/lib/remotecode/workspaces/${workspaceId}/new.txt','new');console.log('dirty-ok');`;
  command("docker", "exec", id, "bun", "-e", dirtyCode);
  const dirty = await api(`/api/workspaces/${workspaceId}/git/status`, "GET", undefined, cookie);
  if (dirty.status !== 200 || dirty.body.clean !== false || !dirty.body.changed.includes("tracked.txt") || !dirty.body.untracked.includes("new.txt")) {
    throw Error(`dirty_${dirty.status}_${JSON.stringify(dirty.body)}`);
  }
  record.dirty = dirty.body;
  const earlyDiff = await api(`/api/workspaces/${workspaceId}/git/diff?path=${encodeURIComponent("tracked.txt")}`, "GET", undefined, cookie);
  if (earlyDiff.status !== 200 || typeof earlyDiff.body.diff !== "string" || !earlyDiff.body.diff.includes("two")) {
    throw Error(`earlydiff_${earlyDiff.status}_${JSON.stringify(earlyDiff.body).slice(0, 200)}`);
  }
  record.diff = { path: earlyDiff.body.path, bytes: earlyDiff.body.diff.length, truncated: earlyDiff.body.truncated };
  const badDiff = await api(`/api/workspaces/${workspaceId}/git/diff?path=${encodeURIComponent("../evil")}`, "GET", undefined, cookie);
  if (badDiff.status !== 400) throw Error(`baddiff_${badDiff.status}`);
  const ws2 = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "empty" }, cookie);
  const folder2 = await api(`/api/workspaces/${ws2.body.id}/folder`, "POST", { requestId: randomUUID() }, cookie);
  if (folder2.status !== 200) throw Error("folder2_failed");
  const notrepo = await api(`/api/workspaces/${ws2.body.id}/git/status`, "GET", undefined, cookie);
  if (notrepo.status !== 404 || notrepo.body.error !== "not_a_repository") throw Error(`notrepo_${notrepo.status}_${JSON.stringify(notrepo.body)}`);
  record.notRepo = notrepo.body;
  const anon = await api(`/api/workspaces/${workspaceId}/git/status`);
  if (anon.status !== 401) throw Error(`anon_${anon.status}`);
  const commitId = randomUUID();
  const commit = await api(`/api/workspaces/${workspaceId}/git/commit`, "POST", { requestId: commitId, message: "proof commit" }, cookie);
  if (commit.status !== 200 || !/^[0-9a-f]{40}$/.test(commit.body.commit)) throw Error(`commit_${commit.status}_${JSON.stringify(commit.body)}`);
  record.commit = commit.body;
  const replay = await api(`/api/workspaces/${workspaceId}/git/commit`, "POST", { requestId: commitId, message: "proof commit" }, cookie);
  if (replay.status !== 200 || replay.body.commit !== commit.body.commit) throw Error(`replay_${replay.status}_${JSON.stringify(replay.body)}`);
  const afterCommit = await api(`/api/workspaces/${workspaceId}/git/status`, "GET", undefined, cookie);
  if (afterCommit.status !== 200 || afterCommit.body.clean !== true) throw Error(`after_${afterCommit.status}_${JSON.stringify(afterCommit.body)}`);
  const branches = await api(`/api/workspaces/${workspaceId}/git/branches`, "GET", undefined, cookie);
  if (branches.status !== 200 || branches.body.current !== "main" || !branches.body.branches.includes("main")) {
    throw Error(`branches_${branches.status}_${JSON.stringify(branches.body)}`);
  }
  record.branches = branches.body;
  const createBranch = await api(`/api/workspaces/${workspaceId}/git/branch`, "POST", { name: "feature", create: true }, cookie);
  if (createBranch.status !== 200 || createBranch.body.branch !== "feature") throw Error(`mkbranch_${createBranch.status}_${JSON.stringify(createBranch.body)}`);
  const switchBack = await api(`/api/workspaces/${workspaceId}/git/branch`, "POST", { name: "main" }, cookie);
  if (switchBack.status !== 200 || switchBack.body.branch !== "main") throw Error(`switchback_${switchBack.status}_${JSON.stringify(switchBack.body)}`);
  const badBranch = await api(`/api/workspaces/${workspaceId}/git/branch`, "POST", { name: "../evil" }, cookie);
  if (badBranch.status !== 400) throw Error(`badbranch_${badBranch.status}`);
  record.branchSwitch = { created: createBranch.body, back: switchBack.body };
  record.scope = "RC-030 git status+commit+branch+diff slice: branch/clean/dirty/404/401/commit/replay/branches/switch/diff; not fetch/pull/push";
  const state = JSON.parse(command("docker", "exec", id, "bun", "-e", stateCode));
  record.state = state;
  record.result = "git_status_slice_passed";
  console.log(JSON.stringify({ result: record.result, clean: record.clean, dirty: record.dirty }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ result: "unverified", error: record.error }));
} finally {
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  const cleanup = { api: true, volume: true };
  console.log(JSON.stringify({ cleanup }));
}
