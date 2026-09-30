import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

const repo = resolve(import.meta.dirname, "..");
const proofDir = process.env.RC_WORKSPACE_PROOF_DIR;
const image = "sha256:398dfc2639647b24469cf639efc73bc55db69cd139233bf574b6427103aeca54";
const password = randomBytes(32).toString("base64url");
if (!proofDir || !proofDir.startsWith("/")) {
  throw new Error("Set RC_WORKSPACE_PROOF_DIR to a fresh absolute directory.");
}
mkdirSync(proofDir, { recursive: true });
if (readdirSync(proofDir).length !== 0) throw new Error("Proof directory must be empty and task-owned.");
const run = `rc028-${randomUUID()}`;
const container = `${run}-api`;
const volume = `${run}-data`;
const label = "remotecode.rc028.proof";
const sourcePaths = ["package.json", "bun.lock", "apps/api/package.json", "apps/api/src", "apps/web/package.json", "apps/web/index.html", "apps/web/src", "apps/web/vite.config.ts", "packages/client/package.json", "packages/client/src", "scripts/run-workspace-linux-browser-proof.ts"];
const apiPort = 39517;
const webPort = 39518;
const base = `http://127.0.0.1:${webPort}`;
const records: Record<string, unknown> = { run, image, apiPort, webPort, host: `${process.platform}/${process.arch}`, containerName: container, volumeName: volume, containerIds: [] as string[] };
let vite: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cookieValue = "";
let containerCreated = false;
let volumeCreated = false;
let cleanupErrors: string[] = [];

function command(bin: string, args: string[], options: { env?: Record<string, string>; capture?: boolean } = {}) {
  const result = Bun.spawnSync([bin, ...args], { cwd: repo, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${bin} ${args.join(" ").replaceAll(password ?? "", "[redacted]")} failed (${result.exitCode}): ${(stderr.trim() || stdout.trim()).replaceAll(password ?? "", "[redacted]")}`);
  return options.capture ? stdout.trim() : "";
}

function hashPath(path: string): string {
  const absolute = resolve(repo, path);
  try {
    return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch {
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const hash = createHash("sha256");
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      hash.update(entry.name).update(hashPath(child));
    }
    return hash.digest("hex");
  }
}

function readSourceHashes() {
  return Object.fromEntries(sourcePaths.map((path) => [path, hashPath(path)]));
}

function readSourceStatus() {
  return command("git", ["status", "--short", "--", ...sourcePaths], { capture: true });
}

function writeEvidence() {
  try {
    const afterHashes = readSourceHashes();
    records.sourceSha256After = afterHashes;
    records.sourceStatusAfter = readSourceStatus();
    records.sourceUnchanged = JSON.stringify(records.sourceSha256Before) === JSON.stringify(afterHashes);
    if (!records.sourceUnchanged) {
      records.result = "failed";
      records.error = "Proof inputs changed while services were running.";
    }
  } catch (error) {
    records.sourceUnchanged = false;
    records.result = "failed";
    records.error = `Could not verify proof-input stability: ${String(error)}`;
  }
  records.cleanup = { container: !containerCreated, volume: !volumeCreated, vitePid: vite?.pid ?? null, errors: cleanupErrors };
  writeFileSync(resolve(proofDir!, "evidence.json"), `${JSON.stringify(records, null, 2)}\n`);
}

async function waitFor(url: string, expected: number) {
  const stop = Date.now() + 30_000;
  while (Date.now() < stop) {
    try { if ((await fetch(url)).status === expected) return; } catch { /* service is starting */ }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url} to return ${expected}`);
}

async function startContainer() {
  if (containerCreated) {
    const owned = command("docker", ["inspect", container, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}}`], { capture: true });
    if (owned !== `${records.containerId as string} /${container} ${run}`) throw new Error("Container ownership changed; refusing recreation");
    command("docker", ["rm", "-f", container]);
    if (command("docker", ["container", "ls", "-aq", "--filter", `name=^/${container}$`], { capture: true })) throw new Error("Owned container remained after removal; refusing recreation.");
    containerCreated = false;
  }
  records.containerId = command("docker", ["create", "--name", container, "--label", `${label}=${run}`, "--platform", "linux/amd64", "--pull", "never", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`, "--mount", `type=bind,src=${resolve(repo, "apps/api")},dst=/workspace/apps/api,readonly`, "-p", `127.0.0.1:${apiPort}:39517`, "-e", "API_PORT=39517", "-e", "DATABASE_PATH=/var/lib/remotecode/remotecode.sqlite", "-e", `REMOTECODE_AUTH_PASSWORD=${password}`, "-e", `REMOTECODE_WEB_ORIGIN=${base}`, "--entrypoint", "bun", image, "apps/api/src/index.ts"], { capture: true });
  containerCreated = true;
  (records.containerIds as string[]).push(records.containerId as string);
  const createdIdentity = command("docker", ["inspect", container, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}}`], { capture: true });
  if (createdIdentity !== `${records.containerId as string} /${container} ${run}`) throw new Error("Created container identity did not match the proof owner.");
  command("docker", ["start", container]);
  await waitFor(`http://127.0.0.1:${apiPort}/api/health/ready`, 200);
}

function testStartFailureCleanup() {
  const name = `${run}-start-failure`;
  const value = `${run}-start-failure`;
  if (command("docker", ["container", "ls", "-aq", "--filter", `name=^/${name}$`], { capture: true })) throw new Error("Start-failure test container name already exists; refusing reuse.");
  const id = command("docker", ["create", "--name", name, "--label", `${label}=${value}`, "--platform", "linux/amd64", "--pull", "never", "--read-only", "-p", `127.0.0.1:${apiPort}:39517`, "--entrypoint", "/bin/true", image], { capture: true });
  let startError = "";
  try { command("docker", ["start", name]); }
  catch (error) { startError = error instanceof Error ? error.message : String(error); }
  const expectedIdentity = `${id} /${name} ${value}`;
  let state = "unverified";
  let removed = false;
  let cleanupError = "";
  try {
    const inspected = command("docker", ["inspect", name, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}} {{.State.Status}}`], { capture: true });
    const [actualId, actualName, actualLabel, actualState] = inspected.split(" ");
    state = actualState ?? "unverified";
    if (actualId !== id || actualName !== `/${name}` || actualLabel !== value) throw new Error(`Created test-container identity mismatch: ${inspected}`);
    command("docker", ["rm", "-f", name]);
    removed = !command("docker", ["container", "ls", "-aq", "--filter", `name=^/${name}$`], { capture: true });
  } catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
  const expectedError = /39517|port is already allocated|address already in use/i.test(startError);
  const result = { name, id, expectedIdentity, state, startFailed: Boolean(startError), expectedPortFailure: expectedError, removed, cleanupError, startError };
  records.setupFailure = result;
  writeFileSync(resolve(proofDir!, "setup-failure.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (!startError || state === "running" || !expectedError || !removed) throw new Error(`Controlled Docker start failure cleanup failed: ${JSON.stringify(result)}`);
}

async function pageWithLogin(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 } });
  const auth = command("docker", ["exec", "-e", `RC028_PASSWORD=${password}`, container, "bun", "-e", 'const r=await fetch("http://127.0.0.1:39517/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:process.env.RC028_PASSWORD})});if(!r.ok)throw Error("login status "+r.status);const c=r.headers.get("set-cookie");if(!c)throw Error("cookie missing");console.log(JSON.stringify({cookie:c.split(";")[0]}));'], { capture: true });
  cookieValue = JSON.parse(auth).cookie.split("=")[1];
  await context.addCookies([{ name: "remotecode_session", value: cookieValue, url: base, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByTestId("workspace-panel").waitFor();
  return { context, page };
}

async function createWorkspace(page: Page, name: string) {
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByTestId("workspace-status").filter({ hasText: "Workspace change confirmed." }).waitFor();
  const response = await page.request.get(`${base}/api/workspaces`);
  if (!response.ok()) throw new Error(`Workspace list returned ${response.status()}`);
  const payload = await response.json() as { workspaces?: Array<{ id: string; name: string; archived?: boolean }> };
  const rows = payload.workspaces;
  if (!Array.isArray(rows)) throw new Error("Workspace list response has an unexpected shape.");
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`Created workspace ${name} missing from API`);
  return found;
}

async function open(page: Page, name: string) {
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await page.getByTestId("selected-workspace").getByText(`Selected: ${name}`).waitFor();
}

async function readSqliteCounts() {
  const value = command("docker", ["exec", container, "bun", "-e", 'import {Database} from "bun:sqlite";const d=new Database("/var/lib/remotecode/remotecode.sqlite",{readonly:true});const n=(q)=>d.query(q).get().n;const r={workspaces:n("select count(*) n from workspaces"),snapshots:n("select count(*) n from workspace_receipts"),creates:n("select count(*) n from workspace_requests"),changes:n("select count(*) n from workspace_change_requests"),sessions:n("select count(*) n from sessions"),quickCheck:d.query("pragma quick_check").all()};console.log(JSON.stringify(r));d.close();'], { capture: true });
  return JSON.parse(value) as { workspaces: number; snapshots: number; creates: number; changes: number; sessions: number; quickCheck: Array<{ quick_check: string }> };
}

async function main() {
  records.baselineGitHead = command("git", ["rev-parse", "HEAD"], { capture: true });
  const sourceStatus = readSourceStatus();
  records.sourceStatusBefore = sourceStatus;
  records.proofInputsDirty = sourceStatus.length > 0;
  records.executedGitCommit = sourceStatus.length === 0 ? records.baselineGitHead : null;
  records.sourceSha256Before = readSourceHashes();
  records.imagePlatform = command("docker", ["image", "inspect", image, "--format", "{{.Os}}/{{.Architecture}}"], { capture: true });
  if (records.imagePlatform !== "linux/amd64") throw new Error(`Wrong image platform: ${records.imagePlatform}`);
  if (command("docker", ["container", "ls", "-aq", "--filter", `name=^/${container}$`], { capture: true })) throw new Error("Proof container name already exists; refusing to reuse it.");
  if (command("docker", ["volume", "ls", "-q", "--filter", `name=^${volume}$`], { capture: true })) throw new Error("Proof volume name already exists; refusing to reuse it.");
  const apiListener = Bun.listen({ hostname: "127.0.0.1", port: apiPort, socket: { data() {} } });
  apiListener.stop(true);
  const webListener = Bun.listen({ hostname: "127.0.0.1", port: webPort, socket: { data() {} } });
  webListener.stop(true);
  command("docker", ["volume", "create", "--label", `${label}=${run}`, volume]);
  volumeCreated = true;
  await startContainer();
  testStartFailureCleanup();
  const webEnv = { API_PORT: String(apiPort), WEB_PORT: String(webPort) };
  vite = spawn(resolve(repo, "node_modules/.bin/vite"), ["--config", "apps/web/vite.config.ts"], { cwd: repo, env: { ...process.env, ...webEnv }, stdio: "ignore" });
  records.vitePid = vite.pid;
  await waitFor(base, 200);
  const viteIndex = await (await fetch(base)).text();
  if (!viteIndex.includes("/@vite/client")) throw new Error("Port 39518 is not serving the Vite app started by this proof.");
  browser = await chromium.launch({ headless: true });
  const { context, page } = await pageWithLogin();
  const suffix = randomUUID().slice(0, 8);
  const nameA = `RC028-A-${suffix}`;
  const nameB = `RC028-B-${suffix}`;
  records.workspaceBOriginalName = nameB;
  const a = await createWorkspace(page, nameA);
  const b = await createWorkspace(page, nameB);
  await page.getByRole("button", { name: `Open workspace ${nameA}` }).click();
  await page.getByLabel("New workspace name").fill(`${nameA}-renamed`);
  await page.getByRole("button", { name: "Rename workspace" }).click();
  await page.getByTestId("workspace-status").filter({ hasText: "Workspace change confirmed." }).waitFor();
  await page.getByRole("button", { name: `Open workspace ${nameB}` }).click();
  await page.getByRole("button", { name: "Archive workspace" }).click();
  await page.getByTestId("workspace-status").filter({ hasText: "Workspace change confirmed." }).waitFor();
  const renamed = `${nameA}-renamed`;
  await open(page, renamed);
  await open(page, nameB);
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base, { waitUntil: "networkidle" });
  await mobile.getByTestId("workspace-panel").waitFor();
  await page.screenshot({ path: resolve(proofDir!, "desktop.png"), fullPage: true });
  await mobile.screenshot({ path: resolve(proofDir!, "mobile.png"), fullPage: true });
  records.workspaceA = { id: a.id, originalName: nameA, name: renamed };
  records.workspaceB = { id: b.id, originalName: nameB, name: nameB, archived: true };

  const previousId = records.containerId;
  await startContainer();
  if (records.containerId === previousId) throw new Error("Container did not get recreated with a new ID");
  await waitFor(base, 200);
  const restoredPage = await context.newPage();
  await restoredPage.goto(base, { waitUntil: "networkidle" });
  await restoredPage.getByTestId("workspace-panel").waitFor();
  const apiPayload = await (await restoredPage.request.get(`${base}/api/workspaces`)).json() as { workspaces?: Array<{ id: string; name: string; archived?: boolean }> };
  const apiRows = apiPayload.workspaces;
  if (!Array.isArray(apiRows)) throw new Error("Workspace list response has an unexpected shape after restart.");
  for (const expected of [records.workspaceA, records.workspaceB] as Array<{ id: string; name: string; archived?: boolean }>) {
    const actual = apiRows.find((row) => row.id === expected.id);
    if (!actual || actual.name !== expected.name || Boolean(actual.archived) !== Boolean(expected.archived)) throw new Error(`Workspace metadata mismatch after restart for ${expected.id}`);
  }
  await open(restoredPage, renamed);
  await open(restoredPage, nameB);
  const selectedArchived = restoredPage.getByTestId("selected-workspace");
  await selectedArchived.getByText("Archived workspaces are read-only.").waitFor();
  const renameControlCount = await selectedArchived.getByRole("button", { name: "Rename workspace" }).count();
  const archiveControlCount = await selectedArchived.getByRole("button", { name: "Archive workspace" }).count();
  if (renameControlCount !== 0 || archiveControlCount !== 0) throw new Error("Archived workspace still exposes mutation controls in the UI.");
  const sqliteBeforeForbiddenRename = await readSqliteCounts();
  const forbiddenResponse = await restoredPage.request.patch(`${base}/api/workspaces/${b.id}`, {
    data: { requestId: randomUUID(), name: `${nameB}-forbidden-rename` },
  });
  const forbiddenBody = await forbiddenResponse.json() as { error?: string };
  if (forbiddenResponse.status() !== 409 || forbiddenBody.error !== "workspace_archived") throw new Error(`Archived rename returned ${forbiddenResponse.status()} ${JSON.stringify(forbiddenBody)} instead of 409 workspace_archived.`);
  const afterForbiddenPayload = await (await restoredPage.request.get(`${base}/api/workspaces`)).json() as { workspaces?: Array<{ id: string; name: string; archived?: boolean }> };
  const afterForbiddenRows = afterForbiddenPayload.workspaces;
  if (!Array.isArray(afterForbiddenRows) || afterForbiddenRows.length !== 2) throw new Error("Workspace list changed after forbidden archived rename.");
  for (const expected of [records.workspaceA, records.workspaceB] as Array<{ id: string; name: string; archived?: boolean }>) {
    const actual = afterForbiddenRows.find((row) => row.id === expected.id);
    if (!actual || actual.name !== expected.name || Boolean(actual.archived) !== Boolean(expected.archived)) throw new Error(`Workspace metadata changed after forbidden rename for ${expected.id}`);
  }
  const sqliteAfterForbiddenRename = await readSqliteCounts();
  if (JSON.stringify(sqliteAfterForbiddenRename) !== JSON.stringify(sqliteBeforeForbiddenRename)) throw new Error("SQLite counts changed after rejected archived rename.");
  records.forbiddenArchivedRename = { status: forbiddenResponse.status(), error: forbiddenBody.error, renameControlCount, archiveControlCount, sqliteBefore: sqliteBeforeForbiddenRename, sqliteAfter: sqliteAfterForbiddenRename };
  for (const expected of [records.workspaceA, records.workspaceB] as Array<{ id: string; name: string; archived?: boolean }>) {
    const response = await restoredPage.request.get(`${base}/api/workspaces/${expected.id}`);
    if (!response.ok()) throw new Error(`Workspace open returned ${response.status()} for ${expected.id}`);
    const actual = await response.json() as { id: string; name: string; archived: boolean };
    if (actual.id !== expected.id || actual.name !== expected.name || Boolean(actual.archived) !== Boolean(expected.archived)) throw new Error(`Workspace ID or metadata changed after restart for ${expected.id}`);
  }
  const otherContext = await browser!.newContext();
  await otherContext.addCookies([{ name: "remotecode_session", value: cookieValue, url: base, httpOnly: true, sameSite: "Strict" }]);
  const otherPage = await otherContext.newPage();
  await otherPage.setViewportSize({ width: 390, height: 844 });
  await otherPage.goto(base, { waitUntil: "networkidle" });
  await otherPage.getByRole("button", { name: `Open workspace ${renamed}` }).click();
  await otherPage.getByTestId("selected-workspace").getByText(`Selected: ${renamed}`).waitFor();
  if (!(await restoredPage.getByTestId("selected-workspace").getByText(`Selected: ${nameB}`).count())) throw new Error("Separate browser context selection crossed over");
  await otherPage.screenshot({ path: resolve(proofDir!, "mobile-after-restart.png"), fullPage: true });
  await restoredPage.getByRole("button", { name: "Sign out" }).click();
  await restoredPage.getByRole("heading", { name: "Sign in to your host" }).waitFor();
  await restoredPage.getByTestId("auth-recovery-status").filter({ hasText: "Confirmed logout." }).waitFor();
  await restoredPage.screenshot({ path: resolve(proofDir!, "logged-out.png"), fullPage: true });
  const sqlite = await readSqliteCounts();
  records.sqlite = sqlite;
  if (sqlite.workspaces !== 2 || sqlite.snapshots !== 4 || sqlite.creates !== 2 || sqlite.changes !== 2 || sqlite.sessions !== 0 || sqlite.quickCheck.length !== 1 || sqlite.quickCheck[0].quick_check !== "ok") throw new Error(`SQLite acceptance failed: ${JSON.stringify(sqlite)}`);
  records.logoutStatus = "confirmed by signed-out UI";
  await otherContext.close();
  await context.close();
  await browser.close(); browser = undefined;
  records.result = "passed";
}

try { await main(); }
catch (error) { records.result = "failed"; records.error = error instanceof Error ? error.message : String(error); }
finally {
  await browser?.close().catch((error) => cleanupErrors.push(`browser: ${String(error)}`));
  if (vite?.pid) {
    if (vite.exitCode === null && vite.signalCode === null) vite.kill("SIGTERM");
    await Promise.race([once(vite, "exit"), delay(1_000)]);
    if (vite.exitCode === null && vite.signalCode === null) vite.kill("SIGKILL");
    if (vite.exitCode === null && vite.signalCode === null) await Promise.race([once(vite, "exit"), delay(3_000)]);
    records.viteStopped = vite.exitCode !== null || vite.signalCode !== null;
    if (!records.viteStopped) cleanupErrors.push("Vite process exit was not confirmed");
  }
  if (containerCreated) {
    try {
      const owned = command("docker", ["inspect", container, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}}`], { capture: true });
      if (owned !== `${records.containerId as string} /${container} ${run}`) throw new Error("Container ownership changed; refusing removal");
      command("docker", ["rm", "-f", container]);
      if (command("docker", ["container", "ls", "-aq", "--filter", `name=^/${container}$`], { capture: true })) throw new Error("Owned container remains after cleanup");
      containerCreated = false;
    } catch (error) { cleanupErrors.push(`container: ${String(error)}`); }
  }
  if (volumeCreated) {
    try {
      const owner = command("docker", ["volume", "inspect", volume, "--format", `{{index .Labels "${label}"}}`], { capture: true });
      if (owner !== run) throw new Error("Volume ownership changed; refusing removal");
      command("docker", ["volume", "rm", volume]);
      volumeCreated = false;
    } catch (error) { cleanupErrors.push(`volume: ${String(error)}`); }
  }
  writeEvidence();
}
if (records.result !== "passed" || cleanupErrors.length) process.exitCode = 1;
else console.log(JSON.stringify({ result: records.result, evidence: resolve(proofDir, "evidence.json"), workspaceA: records.workspaceA, workspaceB: records.workspaceB, sqlite: records.sqlite, cleanup: records.cleanup }));
