import { chromium, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

if (!process.argv.includes("--frozen-inputs")) throw new Error("Freeze all API, client and UI writer inputs before running with --frozen-inputs.");
const repo = resolve(import.meta.dirname, "..");
const run = `rc029-${randomUUID()}`;
const output = process.env.RC_FILE_EDITOR_PROOF_DIR;
if (!output || !isAbsolute(output)) throw new Error("Set RC_FILE_EDITOR_PROOF_DIR to a fresh absolute evidence directory.");
const proofDir = resolve(output);
mkdirSync(proofDir, { recursive: false, mode: 0o700 });
const image = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const container = `${run}-api`;
const label = "remotecode.rc029.proof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/remotecode.sqlite";
const sourcePaths = ["package.json", "bun.lock", "apps/api/package.json", "apps/api/src", "apps/web/package.json", "apps/web/index.html", "apps/web/src", "apps/web/vite.config.ts", "packages/client/package.json", "packages/client/src", "scripts/run-file-editor-linux-browser-proof.ts"];
const records: Record<string, any> = { run, image, startedAt: new Date().toISOString(), invocation: ["bun", "scripts/run-file-editor-linux-browser-proof.ts", "--frozen-inputs"], host: `${process.platform}/${process.arch}`, commands: [], checks: {}, scope: "FIRST RC029 web LIST/OPEN/SAVE slice only; no MOVE, CREATE UI, mobile-native or Distill approval acceptance", containerName: container };
const cleanupErrors: string[] = [];
let containerId = "";
let createAttempted = false;
let vite: ViteDevServer | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let base = "";
let cancelled = false;
const deadline = Date.now() + 240_000;

function check(condition: unknown, message: string): asserts condition {
  if (cancelled || Date.now() >= deadline) throw new Error("Proof cancelled or bounded deadline expired.");
  if (!condition) throw new Error(message);
}

function command(bin: string, args: string[]) {
  const result = Bun.spawnSync([bin, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  records.commands.push({ argv: [bin, ...args].map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  const stdout = result.stdout.toString().trim();
  if (result.exitCode !== 0) throw new Error(`${bin} failed (${result.exitCode}): ${(result.stderr.toString().trim() || stdout).replaceAll(password, "[redacted]")}`);
  return stdout;
}

function hashPath(path: string): string {
  const absolute = resolve(repo, path);
  const info = lstatSync(absolute);
  if (info.isFile()) return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  if (!info.isDirectory()) throw new Error(`Unsupported proof input: ${path}`);
  const hash = createHash("sha256");
  for (const entry of readdirSync(absolute).sort()) hash.update(entry).update(hashPath(`${path}/${entry}`));
  return hash.digest("hex");
}

function hashes() { return Object.fromEntries(sourcePaths.map((path) => [path, hashPath(path)])); }
function assertFrozen() {
  check(JSON.stringify(records.sourceSha256Before) === JSON.stringify(hashes()), "Writer inputs changed; stop proof and freeze source before retrying.");
}
function exec(code: string, args: string[] = []) {
  check(containerId, "Owned container is unavailable.");
  return JSON.parse(command("docker", ["exec", containerId, "bun", "-e", code, ...args]));
}
function sql() {
  return exec(`import {Database} from 'bun:sqlite'; import {existsSync,readdirSync} from 'node:fs'; const d=new Database(${JSON.stringify(databasePath)},{readonly:true}); const result={folders:d.query('SELECT workspace_id,state FROM workspace_folder_requests ORDER BY workspace_id').all(),intents:d.query('SELECT request_id,kind,workspace_id,source_path,destination_path,expected_sha256,state FROM file_operation_intents ORDER BY request_id').all(),outcomes:d.query('SELECT request_id,kind,workspace_id,source_path,destination_path,result_path,result_sha256,completed_at FROM file_operation_outcomes ORDER BY request_id').all(),workspaceDirectories:existsSync('/var/lib/remotecode/workspaces')?readdirSync('/var/lib/remotecode/workspaces').sort():[],quickCheck:d.query('PRAGMA quick_check').all()}; d.close(); console.log(JSON.stringify(result));`);
}
function exactFile(workspaceId: string, path: string) {
  return exec(`import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; const b=readFileSync('/var/lib/remotecode/workspaces/'+process.argv[1]+'/'+process.argv[2]);console.log(JSON.stringify({base64:b.toString('base64'),sha256:createHash('sha256').update(b).digest('hex')}));`, [workspaceId, path]);
}
function digest(content: string) { return createHash("sha256").update(content).digest("hex"); }

async function ready(url: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    check(true, "");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).status === 200) return; } catch { /* service is starting */ }
    await delay(200);
  }
  throw new Error(`Service readiness unverified: ${url}`);
}

async function setup() {
  records.baselineGitHead = command("git", ["rev-parse", "HEAD"]);
  records.sourceStatusBefore = command("git", ["status", "--short", "--", ...sourcePaths]);
  records.executedGitCommit = records.sourceStatusBefore ? null : records.baselineGitHead;
  records.sourceSha256Before = hashes();
  check(existsSync(resolve(repo, "apps/web/src/features/files/FilePanel.tsx")) && readFileSync(resolve(repo, "apps/web/src/features/workspaces/WorkspacePanel.tsx"), "utf8").includes("<FilePanel"), "File editor writer inputs not present; runner ready, browser proof not started.");
  await delay(1_000);
  assertFrozen();
  const metadata = JSON.parse(command("docker", ["image", "inspect", image]));
  check(metadata.length === 1 && metadata[0].Id === image && metadata[0].Os === "linux" && metadata[0].Architecture === "arm64", "Approved local ARM64 digest missing or mismatched; never pull a replacement.");
  check(!metadata[0].Config.Volumes || !Object.keys(metadata[0].Config.Volumes).length, "Image declares volumes; refusing untracked storage.");
  records.imageMetadata = { id: metadata[0].Id, platform: "linux/arm64", tags: metadata[0].RepoTags, workingDir: metadata[0].Config.WorkingDir, env: metadata[0].Config.Env };
  check(!command("docker", ["container", "ls", "-aq", "--no-trunc", "--filter", `name=^/${container}$`]), "Container name already exists; refusing reuse.");
  const reserved = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const apiPort = reserved.port;
  reserved.stop(true);
  const webReservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const reservedWebPort = webReservation.port;
  webReservation.stop(true);
  vite = await createServer({ configFile: resolve(repo, "apps/web/vite.config.ts"), server: { host: "127.0.0.1", port: reservedWebPort, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true } } } });
  records.commands.push({ action: "Vite createServer", configFile: "apps/web/vite.config.ts", host: "127.0.0.1", port: reservedWebPort });
  await vite.listen();
  const webPort = (vite.httpServer!.address() as AddressInfo).port;
  base = `http://127.0.0.1:${webPort}`;
  records.ports = { api: apiPort, web: webPort, binding: "127.0.0.1" };
  createAttempted = true;
  containerId = command("docker", ["create", "--name", container, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=700", "--tmpfs", "/var/lib/remotecode:rw,nosuid,nodev,size=64m,mode=700", "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`, "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`, "-e", `REMOTECODE_WEB_ORIGIN=${base}`, "--entrypoint", "bun", image, "apps/api/src/index.ts"]);
  records.containerId = containerId;
  check(command("docker", ["inspect", containerId, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}}`]) === `${containerId} /${container} ${run}`, "Created container ownership mismatch.");
  records.containerMounts = JSON.parse(command("docker", ["inspect", containerId, "--format", "{{json .Mounts}}"]));
  check(records.containerMounts.every((mount: { Type: string; RW: boolean }) => mount.Type !== "volume" && (mount.Type !== "bind" || !mount.RW)), "Unexpected writable bind or volume on proof container.");
  command("docker", ["start", containerId]);
  await ready(`http://127.0.0.1:${apiPort}/api/health/ready`);
  records.linuxRuntime = exec("import {existsSync,readdirSync} from 'node:fs';console.log(JSON.stringify({platform:process.platform,arch:process.arch,bun:Bun.version,cwd:process.cwd(),home:process.env.HOME??null,cache:process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH??null,imageApp:readdirSync('/home/bun/app'),rootElysiaLinkExists:existsSync('/workspace/node_modules/elysia')}));");
  check(records.linuxRuntime.platform === "linux" && records.linuxRuntime.arch === "arm64" && records.linuxRuntime.bun === "1.3.13", "Actual runtime is not approved Linux ARM64 Bun 1.3.13.");
  records.hostVersions = { bun: Bun.version, playwright: JSON.parse(readFileSync(resolve(repo, "node_modules/@playwright/test/package.json"), "utf8")).version };
  records.commands.push({ action: "Chromium launch", headless: true, temporaryRoot: proofDir, homeAndDependencyState: "unchanged" });
  browser = await chromium.launch({ headless: true });
  records.hostVersions.chromium = browser.version();
  assertFrozen();
}

async function loginContext(viewport = { width: 1440, height: 1000 }) {
  const auth = JSON.parse(command("docker", ["exec", "-e", `RC029_PASSWORD=${password}`, containerId, "bun", "-e", 'const r=await fetch("http://127.0.0.1:3000/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:process.env.RC029_PASSWORD})});if(!r.ok)throw Error("login status "+r.status);const cookie=r.headers.get("set-cookie");if(!cookie)throw Error("missing cookie");console.log(JSON.stringify({cookie:cookie.split(";")[0]}));']));
  const context = await browser!.newContext({ viewport });
  context.setDefaultTimeout(12_000);
  await context.addCookies([{ name: "remotecode_session", value: auth.cookie.slice(auth.cookie.indexOf("=") + 1), url: base, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByTestId("workspace-panel").waitFor();
  return { context, page };
}

async function api(page: Page, method: string, path: string, data?: unknown, status = 200) {
  const response = await page.request.fetch(`${base}${path}`, { method, data, timeout: 12_000, maxRedirects: 0, maxRetries: 0 });
  const body = await response.json();
  records.commands.push({ action: "API bootstrap/readback", method, path, expectedStatus: status, observedStatus: response.status() });
  check(response.status() === status, `${method} ${path}: expected ${status}, got ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function select(page: Page, name: string) {
  await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(`Selected: ${name}`);
}

async function screenshot(page: Page, name: string) {
  const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  check(layout.document <= layout.viewport && layout.body <= layout.viewport, `${name}: horizontal overflow ${JSON.stringify(layout)}`);
  await page.screenshot({ path: resolve(proofDir, `${name}.png`), fullPage: true });
  records.checks[name] = { layout, screenshot: `${name}.png` };
}

const requests: Array<{ context: string; method: string; path: string; requestId?: string; expectedVersion?: string; contentSha256?: string }> = [];
function observe(context: BrowserContext, name: string) {
  context.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    const entry: typeof requests[number] = { context: name, method: request.method(), path };
    try {
      if (entry.method === "PUT" && path.endsWith("/files/content")) {
        const data = request.postDataJSON();
        entry.requestId = data?.requestId;
        entry.expectedVersion = data?.expectedVersion;
        if (typeof data?.content === "string") entry.contentSha256 = digest(data.content);
      }
    } catch (error) { records.invalidBrowserRequest = String(error); }
    requests.push(entry);
  });
  context.on("page", (page) => page.on("dialog", async (dialog) => {
    if (dialog.message() === "Discard the unsaved draft and open another file?") await dialog.accept();
    else { records.unexpectedDialog = dialog.message(); await dialog.dismiss(); }
  }));
}
function puts(name: string) { return requests.filter((row) => row.context === name && row.method === "PUT"); }
async function pendingIdentity(page: Page) {
  return page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("remotecode.pending-file:")).map((key) => ({ key, value: JSON.parse(sessionStorage.getItem(key)!) })));
}
async function openFile(page: Page, path: string, content: string) {
  const response = page.waitForResponse((row) => row.request().method() === "GET" && new URL(row.url()).pathname.endsWith("/files/content"));
  await page.getByRole("button", { name: `Open file ${path}`, exact: true }).click();
  const actual = await response;
  check(actual.status() === 200, `OPEN returned ${actual.status()}.`);
  const body = await actual.json();
  check(body.path === path && body.content === content && body.version === digest(content), "UI OPEN response does not match exact Linux text/version.");
  await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(content);
  return body.version as string;
}
function assertDurable(workspaceId: string, path: string, content: string, requestId: string, expectedVersion: string) {
  const file = exactFile(workspaceId, path);
  const state = sql();
  const outcome = state.outcomes.filter((row: any) => row.request_id === requestId);
  const intent = state.intents.filter((row: any) => row.request_id === requestId);
  const expected = { base64: Buffer.from(content).toString("base64"), sha256: digest(content) };
  check(JSON.stringify(file) === JSON.stringify(expected), "Durable Linux bytes differ from SAVE expectation.");
  check(outcome.length === 1 && outcome[0].kind === "save" && outcome[0].workspace_id === workspaceId && outcome[0].source_path === path && outcome[0].destination_path === path && outcome[0].result_path === path && outcome[0].result_sha256 === expected.sha256 && Number.isFinite(Date.parse(outcome[0].completed_at)), "SQL receipt is missing, duplicated or bound to different SAVE.");
  check(intent.length === 1 && intent[0].kind === "save" && intent[0].workspace_id === workspaceId && intent[0].destination_path === path && intent[0].expected_sha256 === expectedVersion && intent[0].state === "completed", "SQL SAVE intent/version not completed exactly once.");
  return { expected, file, outcome: outcome[0], intent: intent[0] };
}

async function journey() {
  const desktop = await loginContext();
  observe(desktop.context, "desktop");
  const page = desktop.page;
  // Only task-owned fixture drafts may be discarded during explicit workspace navigation.
  page.on("dialog", async (dialog) => {
    if (dialog.message() === "Discard the unsaved draft and open another file?") await dialog.accept();
    else { records.unexpectedDialog = dialog.message(); await dialog.dismiss(); }
  });
  const a = await api(page, "POST", "/api/workspaces", { requestId: randomUUID(), name: `${run}-A` }, 201);
  const b = await api(page, "POST", "/api/workspaces", { requestId: randomUUID(), name: `${run}-B` }, 201);
  check([a, b].every((row) => typeof row.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id) && typeof row.name === "string" && row.name.startsWith(run)), "Bootstrap returned invalid fixture workspace identity.");
  records.workspaces = { a, b };
  await page.getByRole("button", { name: "Refresh workspaces", exact: true }).click();
  const beforeInspection = sql();
  await select(page, a.name);
  await expect(page.getByTestId("folder-status")).toHaveText("Folder not provisioned.");
  await expect(page.getByTestId("file-status")).toContainText("no folder was created");
  const version = await api(page, "GET", "/api/version");
  check(version.capabilities.includes("workspace-files-v1"), "Actual Linux host did not negotiate workspace-files-v1.");
  const afterInspection = sql();
  check(JSON.stringify(beforeInspection) === JSON.stringify(afterInspection) && afterInspection.folders.length === 0 && afterInspection.workspaceDirectories.length === 0, "UI capability/folder inspection allocated storage or file intents.");
  check(requests.some((row) => row.path === `/api/workspaces/${a.id}/folder` && row.method === "GET") && !requests.some((row) => row.method !== "GET"), "UI folder inspection did not stay GET-only.");
  records.checks.noAllocation = { version, before: beforeInspection, after: afterInspection };
  await screenshot(page, "desktop-unprovisioned");
  const path = "browser-proof.txt";
  const initial = "Initial Linux text\nUnicode: café 🐎\n";
  const otherText = "Other workspace text; never A's file.\n";
  for (const [workspace, content] of [[a, initial], [b, otherText]] as const) {
    const folder = await api(page, "POST", `/api/workspaces/${workspace.id}/folder`, { requestId: randomUUID() });
    check(folder.workspaceId === workspace.id && folder.state === "provisioned", "Real folder setup not confirmed.");
    if (workspace.id === a.id) {
      await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
      await expect(page.getByText("This directory is empty.", { exact: true })).toBeVisible();
      records.checks.emptyDirectory = { workspaceId: a.id, fileIntents: sql().intents.length };
    }
    const created = await api(page, "POST", `/api/workspaces/${workspace.id}/files`, { requestId: randomUUID(), path, content }, 201);
    check(created.workspaceId === workspace.id && created.kind === "create" && created.path === path && created.version === digest(content), "Real CREATE fixture receipt mismatch.");
  }
  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await expect(page.getByTestId("folder-status")).toHaveText("Folder provisioned on Linux.");
  exec("import {mkdirSync} from 'node:fs';mkdirSync('/var/lib/remotecode/workspaces/'+process.argv[1]+'/nested',{mode:0o700});console.log(JSON.stringify({created:true}));", [a.id]);
  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await page.getByRole("button", { name: "Open directory nested", exact: true }).click();
  await expect(page.getByText("Directory: nested", { exact: true })).toBeVisible();
  await expect(page.getByText("This directory is empty.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open parent directory", exact: true }).click();
  await expect(page.getByText("Directory: Workspace root", { exact: true })).toBeVisible();
  records.checks.directoryNavigation = { path: "nested", parent: "", empty: true };
  const originalVersion = await openFile(page, path, initial);
  await page.getByRole("textbox", { name: "File draft", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Read current file", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toBeFocused();
  records.checks.keyboardFocus = { draftToReadAndBack: true };
  const mobile = await loginContext({ width: 390, height: 844 });
  observe(mobile.context, "mobile");
  await select(mobile.page, a.name);
  const mobileVersion = await openFile(mobile.page, path, initial);
  check(originalVersion === mobileVersion, "Two contexts did not OPEN the same initial version.");
  const winner = "Desktop committed text\nUnicode: café 🐎\n";
  const loser = "Mobile unsaved draft; must not overwrite desktop.\n";
  await page.getByRole("textbox", { name: "File draft", exact: true }).fill(winner);
  await mobile.page.getByRole("textbox", { name: "File draft", exact: true }).fill(loser);
  const firstResponse = page.waitForResponse((row) => row.request().method() === "PUT");
  await page.getByRole("button", { name: "Save file", exact: true }).focus();
  await page.keyboard.press("Enter");
  const accepted = await firstResponse;
  const acceptedReceipt = await accepted.json();
  check(accepted.status() === 201 && acceptedReceipt.version === digest(winner), "First UI SAVE not confirmed by real receipt.");
  await expect(page.getByTestId("file-status")).toContainText("SAVE receipt confirmed");
  const secondResponse = mobile.page.waitForResponse((row) => row.request().method() === "PUT");
  await mobile.page.getByRole("button", { name: "Save file", exact: true }).click();
  const refused = await secondResponse;
  const conflict = await refused.json();
  check(refused.status() === 409 && conflict.error === "version_conflict", "Second UI SAVE did not receive real 409 version_conflict.");
  await expect(mobile.page.getByTestId("file-status")).toContainText("Version conflict");
  await expect(mobile.page.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(loser);
  await expect(mobile.page.getByTestId("pending-file")).toHaveCount(0);
  check(puts("desktop").length === 1 && puts("mobile").length === 1 && puts("desktop")[0].expectedVersion === originalVersion && puts("mobile")[0].expectedVersion === originalVersion, "SAVE contexts did not each send exactly one PUT of the same initial version.");
  const conflictState = sql();
  check(!conflictState.intents.some((row: any) => row.request_id === puts("mobile")[0].requestId), "Rejected conflict created a durable mutation intent.");
  records.checks.conflict = { initialVersion: originalVersion, statuses: [accepted.status(), refused.status()], conflict, durable: assertDurable(a.id, path, winner, acceptedReceipt.requestId, originalVersion), refusedRequestId: puts("mobile")[0].requestId };
  await screenshot(page, "desktop-saved");
  await screenshot(mobile.page, "mobile-conflict");
  assertFrozen();

  await page.getByRole("button", { name: "Read current file", exact: true }).click();
  await expect(page.getByTestId("file-status")).toContainText("Current host text and version read");
  await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(winner);
  await page.getByRole("textbox", { name: "File draft", exact: true }).fill("Storage failure draft; not submitted.\n");
  const beforeStorage = sql();
  const beforeStoragePuts = puts("desktop").length;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__rc029RestoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === sessionStorage && key.startsWith("remotecode.pending-file:")) throw new DOMException("RC029 controlled quota boundary", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  try {
    await page.getByRole("button", { name: "Save file", exact: true }).click();
    await expect(page.getByTestId("file-status")).toContainText("No SAVE request was sent");
    await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeDisabled();
    check(puts("desktop").length === beforeStoragePuts && JSON.stringify(sql()) === JSON.stringify(beforeStorage), "Storage failure reached PUT or changed durable file receipts.");
    check(exactFile(a.id, path).sha256 === digest(winner), "Storage failure changed Linux file.");
    records.checks.storageFailure = { boundary: "sessionStorage pending-file setItem throws QuotaExceededError before PUT", putCount: 0, sqlBefore: beforeStorage, sqlAfter: sql() };
    await screenshot(page, "desktop-storage-failure");
  } finally { await page.evaluate(() => { (window as any).__rc029RestoreStorage(); delete (window as any).__rc029RestoreStorage; }); }
  await page.reload({ waitUntil: "networkidle" });
  await select(page, a.name);
  await openFile(page, path, winner);

  const lostText = "Committed despite lost browser SAVE response.\nUnicode: café 🐎\n";
  const contentURL = `${base}/api/workspaces/${a.id}/files/content`;
  const lost: { forwardedPuts: number; receipt?: any; status?: number; error?: string } = { forwardedPuts: 0 };
  await page.route(contentURL, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    try {
      lost.forwardedPuts++;
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      lost.status = response.status();
      lost.receipt = await response.json();
      // The real Linux API committed; only its browser response is dropped.
      await route.abort("failed");
    } catch (error) { lost.error = String(error); await route.abort("failed").catch(() => {}); }
  });
  await page.getByRole("textbox", { name: "File draft", exact: true }).fill(lostText);
  const beforeLostPuts = puts("desktop").length;
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await expect.poll(() => lost.receipt ?? lost.error, { timeout: 12_000 }).toBeTruthy();
  check(!lost.error && lost.status === 201 && lost.forwardedPuts === 1, "Actual lost-response SAVE was not forwarded once and committed.");
  await expect(page.getByTestId("file-status")).toContainText(/unknown|not confirmed/);
  await expect(page.getByTestId("pending-file")).toContainText(lost.receipt.requestId);
  const pending = await pendingIdentity(page);
  check(pending.length === 1 && pending[0].value.kind === "save" && pending[0].value.requestId === lost.receipt.requestId && pending[0].value.workspaceId === a.id && pending[0].value.path === path && pending[0].value.resultSha256 === digest(lostText), "Lost SAVE identity not exactly persisted before PUT.");
  records.checks.lostResponse = { boundary: "route.fetch real PUT then route.abort actual response after commit", underlying: lost, pending, durable: assertDurable(a.id, path, lostText, lost.receipt.requestId, digest(winner)) };
  await page.unroute(contentURL);
  const manualStart = requests.length;
  await page.reload({ waitUntil: "networkidle" });
  check(JSON.stringify(await pendingIdentity(page)) === JSON.stringify(pending), "Reload did not retain exact pending SAVE identity.");
  await expect(page.getByTestId("pending-file")).toContainText(lost.receipt.requestId);
  await select(page, b.name);
  await expect(page.getByRole("button", { name: "Check file receipt", exact: true })).toBeDisabled();
  await select(page, a.name);
  await expect(page.getByRole("button", { name: "Check file receipt", exact: true })).toBeEnabled();
  const receiptURL = `${base}/api/workspaces/${a.id}/files/receipts/${lost.receipt.requestId}`;
  const beforeBadReceipts = sql();
  const injected: Array<{ fault: string; actualStatus: number; actualReceipt: any; delivered: any }> = [];
  for (const fault of ["invalid", "mismatch"] as const) {
    await page.route(receiptURL, async (route) => {
      try {
        const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
        const body = await actual.json();
        const changed = fault === "invalid" ? { ...body, version: "invalid-sha256" } : { ...body, workspaceId: b.id };
        injected.push({ fault, actualStatus: actual.status(), actualReceipt: body, delivered: changed });
        const headers = { ...actual.headers() };
        delete headers["content-length"];
        await route.fulfill({ response: actual, headers, json: changed });
      } catch (error) { records.receiptBoundaryError = String(error); await route.abort().catch(() => {}); }
    });
    await page.getByRole("button", { name: "Check file receipt", exact: true }).click();
    await expect(page.getByTestId("file-status")).toContainText("Outcome remains unknown");
    check(JSON.stringify(await pendingIdentity(page)) === JSON.stringify(pending), `${fault} receipt cleared or changed pending identity.`);
    check(JSON.stringify(sql()) === JSON.stringify(beforeBadReceipts), `${fault} response injection changed authoritative SQL.`);
    await page.unroute(receiptURL);
  }
  check(injected.length === 2 && injected.every((row) => row.actualStatus === 200 && row.actualReceipt.requestId === lost.receipt.requestId && row.actualReceipt.workspaceId === a.id && row.actualReceipt.version === digest(lostText)), "Receipt fault injection did not corrupt real bound successful receipts.");
  await screenshot(page, "desktop-mismatched-receipt");
  await page.getByRole("button", { name: "Check file receipt", exact: true }).click();
  await expect(page.getByTestId("file-status")).toContainText("Historical file receipt confirmed");
  await expect(page.getByTestId("pending-file")).toHaveCount(0);
  check((await pendingIdentity(page)).length === 0, "Manual GET receipt did not clear matched persisted identity.");
  const manualRequests = requests.slice(manualStart).filter((row) => row.context === "desktop");
  check(manualRequests.every((row) => row.method === "GET") && manualRequests.filter((row) => row.path.endsWith(`/files/receipts/${lost.receipt.requestId}`)).length === 3, "Recovery sent non-GET request or not exactly three manual receipt GETs.");
  check(puts("desktop").length - beforeLostPuts === 1 && lost.forwardedPuts === 1, "Lost SAVE was replayed during reload or manual recovery.");
  records.checks.manualRecovery = { injected, requests: manualRequests, savePutCount: 1, durable: assertDurable(a.id, path, lostText, lost.receipt.requestId, digest(winner)) };
  assertFrozen();

  await openFile(page, path, lostText);
  let releaseRead: () => void = () => {};
  const release = new Promise<void>((resolve) => { releaseRead = resolve; });
  let held = false;
  let oldDelivered = false;
  let oldDeliveryError = "";
  await page.route(`${contentURL}?*`, async (route) => {
    try {
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      held = true;
      await Promise.race([release, delay(12_000)]);
      await route.fulfill({ response: actual });
      oldDelivered = true;
    } catch (error) { oldDeliveryError = String(error); held = true; await route.abort().catch(() => {}); }
  });
  try {
    await page.getByRole("button", { name: "Read current file", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await select(page, b.name);
    await openFile(page, path, otherText);
    releaseRead();
    await expect.poll(() => oldDelivered || Boolean(oldDeliveryError)).toBe(true);
    check(!oldDeliveryError, `Stale workspace response delivery failed: ${oldDeliveryError}`);
    await expect(page.getByTestId("selected-workspace")).toContainText(b.name);
    await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(otherText);
    await delay(250);
    await expect(page.getByTestId("file-status")).toHaveText("Text and version read from the host.");
    await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(otherText);
    records.checks.workspaceFence = { boundary: "hold actual A OPEN response; switch and OPEN B before releasing A", selectedWorkspaceId: b.id, expectedDraft: otherText };
    await screenshot(page, "desktop-workspace-fence");
  } finally { releaseRead(); await page.unroute(`${contentURL}?*`); }

  const beforeArchive = sql();
  await mobile.page.getByRole("button", { name: "Archive workspace", exact: true }).click();
  await expect(mobile.page.getByTestId("workspace-status")).toContainText("Workspace change confirmed.");
  await expect(mobile.page.getByTestId("selected-workspace")).toContainText("Archived workspaces are read-only.");
  await expect(mobile.page.getByRole("button", { name: "Save file", exact: true })).toBeDisabled();
  await expect(mobile.page.getByRole("textbox", { name: "File draft", exact: true })).toHaveAttribute("readonly", "");
  const forbiddenId = randomUUID();
  const archived = await api(page, "PUT", `/api/workspaces/${a.id}/files/content`, { requestId: forbiddenId, path, content: "forbidden archived overwrite", expectedVersion: digest(lostText) }, 409);
  check(archived.error === "workspace_archived" && JSON.stringify(sql()) === JSON.stringify(beforeArchive) && exactFile(a.id, path).sha256 === digest(lostText), "Archived API SAVE mutated file/intent or did not refuse authority.");
  records.checks.archive = { status: 409, error: archived.error, sqlBefore: beforeArchive, sqlAfter: sql(), refusedRequestId: forbiddenId };
  await screenshot(mobile.page, "mobile-archived");
  const auth = await loginContext();
  observe(auth.context, "auth-fence");
  await select(auth.page, a.name);
  await openFile(auth.page, path, lostText);
  const originalAuthCookie = (await auth.context.cookies(base)).find((cookie) => cookie.name === "remotecode_session");
  check(originalAuthCookie, "Authenticated context cookie missing before logout fence.");
  let releaseAuth: () => void = () => {};
  const authRelease = new Promise<void>((resolve) => { releaseAuth = resolve; });
  let authHeld = false;
  let authDelivered = false;
  let authDeliveryError = "";
  await auth.page.route(`${contentURL}?*`, async (route) => {
    try {
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      authHeld = true;
      await Promise.race([authRelease, delay(12_000)]);
      await route.fulfill({ response: actual });
      authDelivered = true;
    } catch (error) { authDeliveryError = String(error); authHeld = true; await route.abort().catch(() => {}); }
  });
  try {
    await auth.page.getByRole("button", { name: "Read current file", exact: true }).click();
    await expect.poll(() => authHeld).toBe(true);
    await auth.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(auth.page.getByRole("heading", { name: "Sign in to your host", exact: true })).toBeVisible();
    releaseAuth();
    await expect.poll(() => authDelivered || Boolean(authDeliveryError)).toBe(true);
    check(!authDeliveryError, `Stale authentication response delivery failed: ${authDeliveryError}`);
    await delay(250);
    await expect(auth.page.getByTestId("file-panel")).toHaveCount(0);
    const unauthorized = await auth.page.request.get(contentURL + `?path=${path}`, { headers: { cookie: `remotecode_session=${originalAuthCookie.value}` } });
    check(unauthorized.status() === 401, "Logout did not revoke real file API authority.");
    records.checks.authFence = { boundary: "hold actual OPEN; real UI logout then deliver stale response", originalSessionStatusAfterLogout: unauthorized.status() };
    await screenshot(auth.page, "desktop-auth-fence");
  } finally { releaseAuth(); await auth.page.unroute(`${contentURL}?*`); await auth.context.close(); }

  records.sqlite = sql();
  check(records.sqlite.folders.length === 2 && records.sqlite.intents.length === 4 && records.sqlite.outcomes.length === 4 && records.sqlite.quickCheck.length === 1 && records.sqlite.quickCheck[0].quick_check === "ok", "Final SQL not exactly two CREATEs and two SAVEs with intact database.");
  check(!records.unexpectedDialog && !records.invalidBrowserRequest && !records.receiptBoundaryError, "Unexpected browser dialog/request or receipt boundary error occurred.");
  records.browserRequests = requests;
  await desktop.context.close();
  await mobile.context.close();
  assertFrozen();
  records.result = "passed";
}

async function cleanup() {
  if (browser) {
    try { await browser.close(); if (browser.isConnected()) throw new Error("Browser connection remained after close."); }
    catch (error) { cleanupErrors.push(`browser: ${String(error)}`); }
    records.browserClosed = !browser.isConnected();
  }
  if (vite) {
    try { await vite.close(); if (vite.httpServer?.listening) throw new Error("Owned Vite listener remains open."); }
    catch (error) { cleanupErrors.push(`vite: ${String(error)}`); }
    records.viteClosed = !vite.httpServer?.listening;
  }
  if (createAttempted) {
    try {
      const found = command("docker", ["container", "ls", "-aq", "--no-trunc", "--filter", `name=^/${container}$`]);
      if (found) {
        const owned = command("docker", ["inspect", found, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}}`]);
        if (owned !== `${found} /${container} ${run}` || (containerId && found !== containerId)) throw new Error("Container ownership changed; refusing removal.");
        command("docker", ["rm", "-f", found]);
      }
      const remaining = command("docker", ["container", "ls", "-aq", "--no-trunc", "--filter", `name=^/${container}$`]);
      records.containerRemoved = remaining === "";
      if (remaining) throw new Error("Owned container remained after cleanup.");
    } catch (error) { cleanupErrors.push(`container: ${String(error)}`); }
  }
  records.cleanup = { errors: cleanupErrors, containerRemoved: records.containerRemoved ?? !createAttempted, browserClosed: records.browserClosed ?? !browser, viteClosed: records.viteClosed ?? !vite, volumesCreated: [] };
}

function writeEvidence() {
  try {
    records.sourceSha256After = hashes();
    records.sourceStatusAfter = command("git", ["status", "--short", "--", ...sourcePaths]);
    records.sourceUnchanged = JSON.stringify(records.sourceSha256Before) === JSON.stringify(records.sourceSha256After);
    if (!records.sourceUnchanged) { records.result = "failed"; records.error = "Proof inputs changed during execution; no accepted evidence."; }
  } catch (error) { records.result = "failed"; records.sourceUnchanged = false; records.hashError = String(error); }
  if (cleanupErrors.length || cancelled) records.result = "failed";
  records.cancelled = cancelled;
  records.finishedAt = new Date().toISOString();
  const evidence = `${JSON.stringify(records, null, 2)}\n`;
  const path = resolve(proofDir, "evidence.json");
  writeFileSync(path, evidence, { mode: 0o600 });
  if (readFileSync(path, "utf8") !== evidence) throw new Error("Persisted evidence readback mismatch.");
}

const cancel = () => {
  cancelled = true;
  void browser?.close().catch((error) => cleanupErrors.push(`cancel browser: ${String(error)}`));
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
try { await setup(); await journey(); }
catch (error) {
  records.result = "failed";
  records.error = (error instanceof Error ? error.message : String(error)).replaceAll(password, "[redacted]");
  records.browserRequests = requests;
}
finally {
  clearTimeout(timer);
  await cleanup();
  writeEvidence();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
console.log(JSON.stringify({ result: records.result, evidence: resolve(proofDir, "evidence.json"), sourceUnchanged: records.sourceUnchanged, cleanup: records.cleanup }));
if (records.result !== "passed") process.exitCode = 1;
