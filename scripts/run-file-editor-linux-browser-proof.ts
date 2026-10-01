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
const records: Record<string, any> = { run, image, startedAt: new Date().toISOString(), invocation: ["bun", "scripts/run-file-editor-linux-browser-proof.ts", "--frozen-inputs"], host: `${process.platform}/${process.arch}`, commands: [], checks: {}, scope: "RC029 web LIST/OPEN/CREATE/SAVE/MOVE slices; no native editor or Distill approval acceptance", containerName: container };
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
  return exec(`import {Database} from 'bun:sqlite'; import {existsSync,readdirSync} from 'node:fs'; const d=new Database(${JSON.stringify(databasePath)},{readonly:true}); const result={folders:d.query('SELECT workspace_id,state FROM workspace_folder_requests ORDER BY workspace_id').all(),intents:d.query('SELECT request_id,kind,workspace_id,source_path,destination_path,expected_sha256,source_device,source_inode,state FROM file_operation_intents ORDER BY request_id').all(),outcomes:d.query('SELECT request_id,kind,workspace_id,source_path,destination_path,result_path,result_sha256,completed_at FROM file_operation_outcomes ORDER BY request_id').all(),workspaceDirectories:existsSync('/var/lib/remotecode/workspaces')?readdirSync('/var/lib/remotecode/workspaces').sort():[],quickCheck:d.query('PRAGMA quick_check').all()}; d.close(); console.log(JSON.stringify(result));`);
}
function exactFile(workspaceId: string, path: string) {
  return exec(`import {readFileSync,lstatSync} from 'node:fs'; import {createHash} from 'node:crypto'; const path='/var/lib/remotecode/workspaces/'+process.argv[1]+'/'+process.argv[2];let info;try{info=lstatSync(path,{bigint:true});}catch(e){if(e.code!=='ENOENT')throw e;}if(!info)console.log(JSON.stringify({exists:false}));else{if(!info.isFile())throw Error('Expected regular fixture file');const b=readFileSync(path);console.log(JSON.stringify({exists:true,base64:b.toString('base64'),sha256:createHash('sha256').update(b).digest('hex'),device:String(info.dev),inode:String(info.ino),mode:Number(info.mode&0o777n)}));}`, [workspaceId, path]);
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
  records.commands.push({ action: "Chromium launch", headless: true, temporaryRoot: "default", homeAndDependencyState: "unchanged" });
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
  await page.route(/\/api\/workspaces\/[0-9a-f-]+\/files(?:\/(?:content|move))?$/, async (route) => {
    if (route.request().method() !== "POST" && route.request().method() !== "PUT") return route.continue();
    try { await assertPendingBeforeForward(page, route.request()); await route.continue(); }
    catch (error) { records.storageBoundaryError = String(error); await route.abort().catch(() => {}); }
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByTestId("workspace-panel").waitFor();
  return { context, page };
}

async function api(page: Page, method: string, path: string, data?: unknown, status = 200) {
  const response = await page.request.fetch(new URL(path, base).href, { method, data, timeout: 12_000, maxRedirects: 0, maxRetries: 0 });
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

const expectedEffects = new Map<string, any>();
const boundaryChecks: unknown[] = [];
const requests: Array<{ context: string; method: string; path: string; kind?: "create" | "save" | "move"; requestId?: string; expectedVersion?: string; contentSha256?: string }> = [];
async function assertPendingBeforeForward(page: Page, request: Request) {
  const match = new URL(request.url()).pathname.match(/\/api\/workspaces\/([^/]+)\/files(?:\/(content|move))?$/);
  check(match, "Unexpected file mutation URL at storage boundary.");
  const data = request.postDataJSON();
  check(data && typeof data.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.requestId), "Mutation request ID is not canonical.");
  const kind = match[2] === "move" ? "move" : request.method() === "PUT" ? "save" : "create";
  const inputKeys = kind === "move" ? "destinationPath,expectedVersion,requestId,sourcePath" : kind === "save" ? "content,expectedVersion,path,requestId" : "content,path,requestId";
  check(Object.keys(data).sort().join(",") === inputKeys && (kind === "create" || typeof data.expectedVersion === "string" && /^[0-9a-f]{64}$/.test(data.expectedVersion)), "Mutation input contains an implicit write or invalid expected version.");
  const expected = kind === "move" ? { kind, requestId: data.requestId, workspaceId: match[1], sourcePath: data.sourcePath, destinationPath: data.destinationPath, expectedVersion: data.expectedVersion }
    : { kind, requestId: data.requestId, workspaceId: match[1], path: data.path, resultSha256: digest(data.content) };
  const stored = await pendingIdentity(page);
  check(stored.length === 1 && Object.keys(stored[0].value).sort().join(",") === Object.keys(expected).sort().join(",") && Object.entries(expected).every(([key, value]) => value !== undefined && stored[0].value[key] === value), "Content-free pending identity was not persisted exactly before forwarding actual file mutation.");
  boundaryChecks.push({ method: request.method(), path: new URL(request.url()).pathname, identity: expected, stored: stored[0] });
}
function observe(context: BrowserContext, name: string) {
  context.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    const entry: typeof requests[number] = { context: name, method: request.method(), path };
    try {
      if (entry.method === "PUT" && path.endsWith("/files/content") || entry.method === "POST" && /\/files(?:\/move)?$/.test(path)) {
        entry.kind = path.endsWith("/move") ? "move" : entry.method === "PUT" ? "save" : "create";
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
function puts(name: string) { return requests.filter((row) => row.context === name && row.kind === "save"); }
function posts(name: string, kind: "create" | "move") { return requests.filter((row) => row.context === name && row.kind === kind); }
async function pendingIdentity(page: Page) {
  return page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("remotecode.pending-file:")).map((key) => ({ key, value: JSON.parse(sessionStorage.getItem(key)!) })));
}
async function openFile(page: Page, path: string, content: string) {
  const response = page.waitForResponse((row) => row.request().method() === "GET" && new URL(row.url()).pathname.endsWith("/files/content"));
  await page.getByRole("button", { name: `Open file ${path.split("/").at(-1)}`, exact: true }).click();
  const actual = await response;
  check(actual.status() === 200, `OPEN returned ${actual.status()}.`);
  const body = await actual.json();
  check(body.path === path && body.content === content && body.version === digest(content), "UI OPEN response does not match exact Linux text/version.");
  await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(content);
  return body.version as string;
}
function assertDurable(workspaceId: string, path: string, content: string, requestId: string, expectedVersion: string | null, kind: "create" | "save" | "move" = "save", sourcePath = path) {
  const file = exactFile(workspaceId, path);
  const state = sql();
  const outcome = state.outcomes.filter((row: any) => row.request_id === requestId);
  const intent = state.intents.filter((row: any) => row.request_id === requestId);
  const expected = { base64: Buffer.from(content).toString("base64"), sha256: digest(content) };
  check(file.exists && file.base64 === expected.base64 && file.sha256 === expected.sha256 && (kind !== "create" || file.mode === 0o600), "Durable Linux bytes/mode differ from expected write.");
  const source = kind === "create" ? "" : sourcePath;
  check(outcome.length === 1 && outcome[0].kind === kind && outcome[0].workspace_id === workspaceId && outcome[0].source_path === source && outcome[0].destination_path === path && outcome[0].result_path === path && outcome[0].result_sha256 === expected.sha256 && Number.isFinite(Date.parse(outcome[0].completed_at)), "SQL receipt is missing, duplicated or bound to a different operation.");
  check(intent.length === 1 && intent[0].kind === kind && intent[0].workspace_id === workspaceId && intent[0].source_path === source && intent[0].destination_path === path && intent[0].expected_sha256 === expectedVersion && intent[0].state === "completed", "SQL operation intent/version not completed exactly once.");
  const actual = { expected, file, outcome: outcome[0], intent: intent[0] };
  const prior = expectedEffects.get(requestId);
  check(!prior || JSON.stringify(prior.outcome) === JSON.stringify(actual.outcome) && JSON.stringify(prior.intent) === JSON.stringify(actual.intent), "Historical SQL receipt changed.");
  expectedEffects.set(requestId, actual);
  return actual;
}

async function postFromUI(page: Page, button: "Create file" | "Move file", url: string, status: number) {
  const response = page.waitForResponse((row) => row.request().method() === "POST" && row.url() === url);
  await page.getByRole("button", { name: button, exact: true }).click();
  const actual = await response;
  const body = await actual.json();
  records.commands.push({ action: button, method: "POST", path: new URL(url).pathname, expectedStatus: status, observedStatus: actual.status() });
  check(actual.status() === status, `${button} expected ${status}, got ${actual.status()} ${JSON.stringify(body)}`);
  return body;
}

async function recoverPost(page: Page, workspace: any, otherWorkspace: any, kind: "create" | "move", receipt: any, pending: any[], files: Array<{ path: string; state: any }>) {
  const initialPosts = posts("desktop", kind).length;
  const start = requests.length;
  const before = sql();
  await page.reload({ waitUntil: "networkidle" });
  check(JSON.stringify(await pendingIdentity(page)) === JSON.stringify(pending), `${kind} identity changed after same-tab reload.`);
  await expect(page.getByTestId("pending-file")).toContainText(receipt.requestId);
  await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveCount(0);
  await select(page, otherWorkspace.name);
  await expect(page.getByRole("button", { name: "Check file receipt", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create file", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "New file path", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "New file text", exact: true })).toHaveValue("");
  await select(page, workspace.name);
  await expect(page.getByRole("textbox", { name: "New file text", exact: true })).toHaveValue("");
  const url = `${base}/api/workspaces/${workspace.id}/files/receipts/${receipt.requestId}`;
  const injected: any[] = [];
  for (const fault of ["substituted", "wrong-kind"] as const) {
    await page.route(url, async (route) => {
      try {
        const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
        const body = await actual.json();
        const changed = fault === "substituted" ? { ...body, path: "nested/substituted-receipt.txt" }
          : { requestId: body.requestId, workspaceId: body.workspaceId, kind: "save", path: body.path, version: body.version, createdAt: body.createdAt };
        injected.push({ fault, actualStatus: actual.status(), actualReceipt: body, delivered: changed });
        const headers = { ...actual.headers() };
        delete headers["content-length"];
        await route.fulfill({ response: actual, headers, json: changed });
      } catch (error) { records.receiptBoundaryError = String(error); await route.abort().catch(() => {}); }
    });
    try {
      await page.getByRole("button", { name: "Check file receipt", exact: true }).click();
      await expect(page.getByTestId("file-status")).toContainText("Outcome remains unknown");
      check(JSON.stringify(await pendingIdentity(page)) === JSON.stringify(pending), `${kind} ${fault} receipt cleared pending identity.`);
      check(JSON.stringify(sql()) === JSON.stringify(before) && files.every((file) => JSON.stringify(exactFile(workspace.id, file.path)) === JSON.stringify(file.state)), "Receipt response fault changed authoritative SQL/files.");
    } finally { await page.unroute(url); }
  }
  check(injected.length === 2 && injected.every((row) => row.actualStatus === 200 && Object.keys(row.actualReceipt).sort().join(",") === Object.keys(receipt).sort().join(",") && Object.entries(receipt).every(([key, value]) => row.actualReceipt[key] === value)), "Receipt faults did not alter actual successful bound historical receipts.");
  await screenshot(page, `desktop-${kind}-unknown-receipt`);
  await page.getByRole("button", { name: "Check file receipt", exact: true }).click();
  await expect(page.getByTestId("file-status")).toContainText("Historical file receipt confirmed");
  await expect(page.getByTestId("pending-file")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "File draft", exact: true })).toHaveCount(0);
  check((await pendingIdentity(page)).length === 0 && posts("desktop", kind).length === initialPosts, `${kind} recovery replayed POST or did not clear matched identity.`);
  const recovery = requests.slice(start).filter((row) => row.context === "desktop");
  check(recovery.every((row) => row.method === "GET") && recovery.filter((row) => row.path.endsWith(`/files/receipts/${receipt.requestId}`)).length === 3, `${kind} recovery was not exactly three manual GETs with no writes.`);
  check(JSON.stringify(sql()) === JSON.stringify(before) && files.every((file) => JSON.stringify(exactFile(workspace.id, file.path)) === JSON.stringify(file.state)), "Receipt-only recovery changed completed SQL bindings or renamed/wrote files again.");
  records.checks[`${kind}Recovery`] = { receipt, pending, injected, requests: recovery, sqlBefore: before, sqlAfter: sql(), files, secondPostCount: 0, historicalReceiptCreatedNoWritableBaseline: true };
}

async function createMoveJourney(page: Page, mobile: Page, a: any, b: any) {
  const createURL = `${base}/api/workspaces/${a.id}/files`;
  const moveURL = `${createURL}/move`;
  const sourcePath = "nested/ui-source.txt";
  const uncertainPath = "nested/ui-uncertain.txt";
  const movedPath = "nested/ui-moved.txt";
  const finalPath = "nested/ui-final.txt";
  const initial = "\uFEFFCREATE from actual UI\nUTF-8: café 🐎\n";
  const uncertainText = "\uFEFFCommitted CREATE with lost response\nUTF-8: café 🐎\n";
  await select(page, a.name);
  await expect(page.getByTestId("folder-status")).toHaveText("Folder provisioned on Linux.");

  const snapshotPath = "nested/proposal-at-click.txt";
  const nextPath = "nested/proposal-after-click.txt";
  const snapshotText = "CREATE input pair at explicit click\n";
  const nextText = "Next input pair typed while preflight waits\n";
  await page.getByRole("textbox", { name: "New file path", exact: true }).fill(snapshotPath);
  await page.getByRole("textbox", { name: "New file text", exact: true }).fill(snapshotText);
  let releaseInputs: () => void = () => {};
  const inputRelease = new Promise<void>((resolve) => { releaseInputs = resolve; });
  let inputsHeld = false;
  let inputDeliveryError = "";
  await page.route(`${base}/api/auth/session`, async (route) => {
    if (inputsHeld || await page.getByTestId("file-status").textContent() !== "Checking CREATE authority…") return route.continue();
    inputsHeld = true;
    try {
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      check(actual.status() === 200, "CREATE input-change boundary did not use an actual valid session.");
      await Promise.race([inputRelease, delay(12_000)]);
      await route.fulfill({ response: actual });
    } catch (error) { inputDeliveryError = String(error); await route.abort().catch(() => {}); }
  });
  const proposalResponse = page.waitForResponse((row) => row.request().method() === "POST" && row.url() === createURL);
  try {
    await page.getByRole("button", { name: "Create file", exact: true }).click();
    await expect.poll(() => inputsHeld).toBe(true);
    await page.getByRole("textbox", { name: "New file path", exact: true }).fill(nextPath);
    await page.getByRole("textbox", { name: "New file text", exact: true }).fill(nextText);
    releaseInputs();
    const response = await proposalResponse;
    const body = await response.json();
    const sent = response.request().postDataJSON();
    check(!inputDeliveryError && response.status() === 201 && sent.path === snapshotPath && sent.content === snapshotText && body.path === snapshotPath && body.version === digest(snapshotText), "CREATE mixed changed inputs instead of preserving the immutable click proposal.");
    await expect(page.getByTestId("file-status")).toContainText(`CREATE receipt confirmed for ${snapshotPath}`);
    await expect(page.getByRole("textbox", { name: "New file path", exact: true })).toHaveValue(nextPath);
    await expect(page.getByRole("textbox", { name: "New file text", exact: true })).toHaveValue(nextText);
    check(!exactFile(a.id, nextPath).exists, "Edited-next CREATE path was written without its own explicit action.");
    records.checks.creationProposalSnapshot = { boundary: "hold actual preflight GET; edit both inputs before release", sent, retainedNext: { path: nextPath, content: nextText }, durable: assertDurable(a.id, snapshotPath, snapshotText, body.requestId, null, "create") };
  } finally { releaseInputs(); await page.unroute(`${base}/api/auth/session`); }

  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await page.getByRole("button", { name: "Open directory nested", exact: true }).click();
  await openFile(page, snapshotPath, snapshotText);
  const moveProposalPath = "nested/move-proposal-at-click.txt";
  const nextMovePath = "nested/move-proposal-after-click.txt";
  const proposalSourceBefore = exactFile(a.id, snapshotPath);
  await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill(moveProposalPath);
  let releaseMoveInputs: () => void = () => {};
  const moveInputRelease = new Promise<void>((resolve) => { releaseMoveInputs = resolve; });
  let moveInputsHeld = false;
  let moveInputError = "";
  await page.route(`${base}/api/auth/session`, async (route) => {
    if (moveInputsHeld || await page.getByTestId("file-status").textContent() !== "Checking MOVE authority…") return route.continue();
    moveInputsHeld = true;
    try {
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      check(actual.status() === 200, "MOVE input-change boundary did not use an actual valid session.");
      await Promise.race([moveInputRelease, delay(12_000)]);
      await route.fulfill({ response: actual });
    } catch (error) { moveInputError = String(error); await route.abort().catch(() => {}); }
  });
  const moveProposalResponse = page.waitForResponse((row) => row.request().method() === "POST" && row.url() === moveURL);
  try {
    await page.getByRole("button", { name: "Move file", exact: true }).click();
    await expect.poll(() => moveInputsHeld).toBe(true);
    await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill(nextMovePath);
    releaseMoveInputs();
    const response = await moveProposalResponse;
    const body = await response.json();
    const sent = response.request().postDataJSON();
    const destinationFile = exactFile(a.id, moveProposalPath);
    check(!moveInputError && response.status() === 201 && sent.sourcePath === snapshotPath && sent.destinationPath === moveProposalPath && sent.expectedVersion === digest(snapshotText) && body.path === moveProposalPath, "MOVE did not preserve its explicit click proposal.");
    check(!exactFile(a.id, snapshotPath).exists && !exactFile(a.id, nextMovePath).exists && JSON.stringify(destinationFile) === JSON.stringify(proposalSourceBefore), "MOVE input edit caused extra rename or changed inode/bytes/mode.");
    await expect(page.getByTestId("file-status")).toContainText(`MOVE receipt confirmed for ${moveProposalPath}`);
    await expect(page.getByRole("textbox", { name: "Move destination path", exact: true })).toHaveValue(nextMovePath);
    records.checks.moveProposalSnapshot = { sent, retainedNextDestination: nextMovePath, sourceBefore: proposalSourceBefore, destinationAfter: destinationFile, durable: assertDurable(a.id, moveProposalPath, snapshotText, body.requestId, digest(snapshotText), "move", snapshotPath) };
  } finally { releaseMoveInputs(); await page.unroute(`${base}/api/auth/session`); }
  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await openFile(page, moveProposalPath, snapshotText);
  const missingMovePath = "missing-parent/not-moved.txt";
  await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill(missingMovePath);
  const beforeMissingMove = sql();
  const missingMoveSource = exactFile(a.id, moveProposalPath);
  const missingMove = await postFromUI(page, "Move file", moveURL, 404);
  check(missingMove.error === "destination_parent_not_found" && JSON.stringify(sql()) === JSON.stringify(beforeMissingMove) && JSON.stringify(exactFile(a.id, moveProposalPath)) === JSON.stringify(missingMoveSource) && !exactFile(a.id, missingMovePath).exists, "Missing-parent MOVE did not return exact no-effect refusal.");
  records.checks.missingMoveParent = { response: missingMove, before: beforeMissingMove, after: sql(), sourceBefore: missingMoveSource, identityAfterResponse: await pendingIdentity(page) };
  await expect(page.getByTestId("pending-file")).toHaveCount(0);
  await screenshot(page, "desktop-move-missing-parent-refused");

  const missingPath = "missing-parent/not-created.txt";
  await page.getByRole("textbox", { name: "New file path", exact: true }).fill(missingPath);
  await page.getByRole("textbox", { name: "New file text", exact: true }).fill("Refused before any file intent\n");
  const beforeMissing = sql();
  const missing = await postFromUI(page, "Create file", createURL, 404);
  const missingRequest = posts("desktop", "create").at(-1)!;
  check(missing.error === "parent_directory_not_found" && JSON.stringify(sql()) === JSON.stringify(beforeMissing) && !exactFile(a.id, missingPath).exists, "Missing-parent CREATE did not return the exact no-effect refusal.");
  records.checks.missingCreateParent = { response: missing, requestId: missingRequest.requestId, before: beforeMissing, after: sql(), identityAfterResponse: await pendingIdentity(page) };
  await expect(page.getByTestId("pending-file")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "New file path", exact: true })).toHaveValue(missingPath);
  await screenshot(page, "desktop-create-missing-parent-refused");

  await page.getByRole("textbox", { name: "New file path", exact: true }).fill(sourcePath);
  await page.getByRole("textbox", { name: "New file text", exact: true }).fill(initial);

  let releaseScope: () => void = () => {};
  const scopeRelease = new Promise<void>((resolve) => { releaseScope = resolve; });
  let scopeHeld = false;
  let scopeDelivered = false;
  let scopeError = "";
  const beforeScope = sql();
  const beforeScopePosts = posts("desktop", "create").length;
  await page.route(`${base}/api/auth/session`, async (route) => {
    if (scopeHeld || await page.getByTestId("file-status").textContent() !== "Checking CREATE authority…") return route.continue();
    scopeHeld = true;
    try {
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      const session = await actual.json();
      check(actual.status() === 200 && typeof session.userId === "string" && session.userId.length > 0, "Held CREATE authority GET did not confirm actual session.");
      await Promise.race([scopeRelease, delay(12_000)]);
      await route.fulfill({ response: actual });
      scopeDelivered = true;
    } catch (error) { scopeError = String(error); await route.abort().catch(() => {}); }
  });
  try {
    await page.getByRole("button", { name: "Create file", exact: true }).click();
    await expect.poll(() => scopeHeld).toBe(true);
    await select(page, b.name);
    await expect(page.getByRole("textbox", { name: "New file path", exact: true })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "New file text", exact: true })).toHaveValue("");
    releaseScope();
    await expect.poll(() => scopeDelivered || Boolean(scopeError)).toBe(true);
    check(!scopeError, `CREATE preflight delivery failed: ${scopeError}`);
    await delay(250);
    check(posts("desktop", "create").length === beforeScopePosts && JSON.stringify(sql()) === JSON.stringify(beforeScope) && !exactFile(a.id, sourcePath).exists && !exactFile(b.id, sourcePath).exists, "Stale CREATE preflight crossed workspace selection or submitted POST.");
    records.checks.createWorkspaceFence = { boundary: "hold actual authority GET then switch workspace before CREATE POST", submittedPosts: 0, sqlBefore: beforeScope, sqlAfter: sql() };
  } finally { releaseScope(); await page.unroute(`${base}/api/auth/session`); }
  await select(page, a.name);
  await expect(page.getByTestId("folder-status")).toHaveText("Folder provisioned on Linux.");
  await page.getByRole("textbox", { name: "New file path", exact: true }).fill(sourcePath);
  await page.getByRole("textbox", { name: "New file text", exact: true }).fill(initial);
  const beforeStorageCreate = sql();
  const storageCreateCount = posts("desktop", "create").length;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__rc029RestoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === sessionStorage && key.startsWith("remotecode.pending-file:")) throw new DOMException("RC029 controlled quota boundary", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  try {
    await page.getByRole("button", { name: "Create file", exact: true }).click();
    await expect(page.getByTestId("file-status")).toContainText("No CREATE request was sent");
    await expect(page.getByRole("button", { name: "Create file", exact: true })).toBeDisabled();
    check(posts("desktop", "create").length === storageCreateCount && JSON.stringify(sql()) === JSON.stringify(beforeStorageCreate) && !exactFile(a.id, sourcePath).exists, "CREATE storage failure reached POST or changed filesystem/SQL.");
    records.checks.createStorageFailure = { boundary: "sessionStorage setItem throws before POST", submittedPosts: 0, sqlBefore: beforeStorageCreate, sqlAfter: sql() };
    await screenshot(page, "desktop-create-storage-failure");
  } finally { await page.evaluate(() => { (window as any).__rc029RestoreStorage(); delete (window as any).__rc029RestoreStorage; }); }
  await page.reload({ waitUntil: "networkidle" });
  await select(page, a.name);
  await page.getByRole("textbox", { name: "New file path", exact: true }).fill(sourcePath);
  await page.getByRole("textbox", { name: "New file text", exact: true }).fill(initial);
  const created = await postFromUI(page, "Create file", createURL, 201);
  check(created.kind === "create" && created.workspaceId === a.id && created.path === sourcePath && created.version === digest(initial), "UI CREATE receipt binding/hash mismatch.");
  await expect(page.getByTestId("file-status")).toContainText("CREATE receipt confirmed");
  const createdState = assertDurable(a.id, sourcePath, initial, created.requestId, null, "create");
  records.checks.createUI = { receipt: created, existingParent: "nested", durable: createdState, expectedMode: "0600", exactBOM: true };
  await screenshot(page, "desktop-created-bom");
  const beforeTarget = sql();
  await page.getByRole("textbox", { name: "New file text", exact: true }).fill("Must not overwrite existing CREATE target.\n");
  const targetConflict = await postFromUI(page, "Create file", createURL, 409);
  check(targetConflict.error === "target_exists", "Existing CREATE target did not return 409 target_exists.");
  await expect(page.getByTestId("file-status")).toContainText("target already exists");
  await expect(page.getByTestId("pending-file")).toHaveCount(0);
  check(JSON.stringify(sql()) === JSON.stringify(beforeTarget) && JSON.stringify(exactFile(a.id, sourcePath)) === JSON.stringify(createdState.file), "Existing CREATE target was overwritten or allocated an intent/outcome.");
  records.checks.createTargetConflict = { response: targetConflict, requestId: posts("desktop", "create").at(-1)?.requestId, file: exactFile(a.id, sourcePath), sqlBefore: beforeTarget, sqlAfter: sql() };

  const lostCreate: any = { forwardedPosts: 0 };
  await page.route(createURL, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    try {
      await assertPendingBeforeForward(page, route.request());
      lostCreate.forwardedPosts++;
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      lostCreate.status = actual.status();
      lostCreate.receipt = await actual.json();
      await route.abort("failed");
    } catch (error) { lostCreate.error = String(error); await route.abort().catch(() => {}); }
  });
  const beforeLostCreate = posts("desktop", "create").length;
  try {
    await page.getByRole("textbox", { name: "New file path", exact: true }).fill(uncertainPath);
    await page.getByRole("textbox", { name: "New file text", exact: true }).fill(uncertainText);
    await page.getByRole("button", { name: "Create file", exact: true }).click();
    await expect.poll(() => lostCreate.receipt ?? lostCreate.error, { timeout: 12_000 }).toBeTruthy();
    check(!lostCreate.error && lostCreate.status === 201 && lostCreate.receipt.kind === "create" && lostCreate.receipt.path === uncertainPath && lostCreate.forwardedPosts === 1, "Lost CREATE did not commit exactly one real POST.");
    await expect(page.getByTestId("file-status")).toContainText(/unknown|not confirmed/);
    await expect(page.getByTestId("pending-file")).toContainText(lostCreate.receipt.requestId);
  } finally { await page.unroute(createURL); }
  const createPending = await pendingIdentity(page);
  check(createPending.length === 1 && createPending[0].value.kind === "create" && createPending[0].value.requestId === lostCreate.receipt.requestId && createPending[0].value.path === uncertainPath && createPending[0].value.resultSha256 === digest(uncertainText), "Lost CREATE persisted wrong identity/hash.");
  const uncertainState = assertDurable(a.id, uncertainPath, uncertainText, lostCreate.receipt.requestId, null, "create");
  await recoverPost(page, a, b, "create", lostCreate.receipt, createPending, [{ path: uncertainPath, state: uncertainState.file }]);
  check(posts("desktop", "create").length === beforeLostCreate + 1 && lostCreate.forwardedPosts === 1, "Unknown CREATE replayed POST.");
  records.checks.createLostResponse = { boundary: "real POST committed then actual browser response dropped", underlying: lostCreate, durable: uncertainState };
  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await page.getByRole("button", { name: "Open directory nested", exact: true }).click();
  await openFile(page, sourcePath, initial);

  await mobile.reload({ waitUntil: "networkidle" });
  await select(mobile, a.name);
  await mobile.getByRole("button", { name: "Open directory nested", exact: true }).click();
  await openFile(mobile, sourcePath, initial);
  const dirty = "Unsaved draft; MOVE must never submit SAVE.\n";
  await mobile.getByRole("textbox", { name: "File draft", exact: true }).fill(dirty);
  await mobile.getByRole("textbox", { name: "Move destination path", exact: true }).fill("nested/no-implicit-save.txt");
  const dirtyRequests = requests.length;
  const beforeDirty = sql();
  await expect(mobile.getByRole("button", { name: "Move file", exact: true })).toBeDisabled();
  await mobile.getByRole("button", { name: "Move file", exact: true }).focus();
  await mobile.keyboard.press("Enter");
  await delay(150);
  await expect(mobile.getByRole("textbox", { name: "File draft", exact: true })).toHaveValue(dirty);
  check(!requests.slice(dirtyRequests).some((row) => row.context === "mobile" && row.kind) && JSON.stringify(sql()) === JSON.stringify(beforeDirty) && JSON.stringify(exactFile(a.id, sourcePath)) === JSON.stringify(createdState.file) && !exactFile(a.id, "nested/no-implicit-save.txt").exists, "Dirty MOVE implicitly saved/submitted POST or changed files.");
  records.checks.moveDirtyDraft = { draftKept: true, submittedMutations: 0, sqlBefore: beforeDirty, sqlAfter: sql() };
  await screenshot(mobile, "mobile-dirty-move-refused");
  await mobile.getByRole("textbox", { name: "File draft", exact: true }).fill(initial);
  await mobile.getByRole("textbox", { name: "Move destination path", exact: true }).fill(movedPath);

  const beforeOccupiedMove = sql();
  await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill(uncertainPath);
  const occupiedMove = await postFromUI(page, "Move file", moveURL, 409);
  check(occupiedMove.error === "target_exists", "Existing MOVE destination did not return target_exists.");
  await expect(page.getByTestId("file-status")).toContainText("target already exists");
  await expect(page.getByTestId("pending-file")).toHaveCount(0);
  check(JSON.stringify(sql()) === JSON.stringify(beforeOccupiedMove) && JSON.stringify(exactFile(a.id, sourcePath)) === JSON.stringify(createdState.file) && JSON.stringify(exactFile(a.id, uncertainPath)) === JSON.stringify(uncertainState.file), "Rejected MOVE changed either file or allocated an intent/outcome.");
  records.checks.moveTargetConflict = { response: occupiedMove, requestId: posts("desktop", "move").at(-1)?.requestId, source: exactFile(a.id, sourcePath), destination: exactFile(a.id, uncertainPath), sqlBefore: beforeOccupiedMove, sqlAfter: sql() };
  await openFile(page, sourcePath, initial);
  const updated = "\uFEFFOther context changed the verified source\nUTF-8: café 🐎\n";
  await page.getByRole("textbox", { name: "File draft", exact: true }).fill(updated);
  const savedResponse = page.waitForResponse((row) => row.request().method() === "PUT" && new URL(row.url()).pathname.endsWith("/files/content"));
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  const saved = await savedResponse;
  const savedReceipt = await saved.json();
  check(saved.status() === 201 && savedReceipt.kind === "save", "Cross-context stale MOVE setup did not commit real UI SAVE.");
  await expect(page.getByTestId("file-status")).toContainText("SAVE receipt confirmed");
  const updatedState = assertDurable(a.id, sourcePath, updated, savedReceipt.requestId, digest(initial));
  const beforeStale = sql();
  const staleMove = await postFromUI(mobile, "Move file", moveURL, 409);
  check(staleMove.error === "version_conflict" && posts("mobile", "move").at(-1)?.expectedVersion === digest(initial), "Stale verified OPEN did not yield real MOVE version_conflict.");
  await expect(mobile.getByTestId("file-status")).toContainText("Version conflict");
  await expect(mobile.getByTestId("pending-file")).toHaveCount(0);
  check(JSON.stringify(sql()) === JSON.stringify(beforeStale) && JSON.stringify(exactFile(a.id, sourcePath)) === JSON.stringify(updatedState.file) && !exactFile(a.id, movedPath).exists, "Stale MOVE renamed or changed the source/SQL.");
  records.checks.moveStaleVersion = { initialVersion: digest(initial), currentVersion: digest(updated), response: staleMove, requestId: posts("mobile", "move").at(-1)?.requestId, durableSource: updatedState, sqlBefore: beforeStale, sqlAfter: sql() };
  const freshResponse = mobile.waitForResponse((row) => row.request().method() === "GET" && new URL(row.url()).pathname.endsWith("/files/content"));
  await mobile.getByRole("button", { name: "Read current file", exact: true }).click();
  const fresh = await freshResponse;
  const freshBody = await fresh.json();
  check(fresh.status() === 200 && freshBody.path === sourcePath && freshBody.content === updated && freshBody.version === digest(updated), "Explicit current GET did not establish the actual MOVE baseline.");
  await expect(mobile.getByRole("textbox", { name: "Last read host text", exact: true })).toHaveValue(updated);
  await mobile.getByRole("textbox", { name: "File draft", exact: true }).fill(updated);
  const moved = await postFromUI(mobile, "Move file", moveURL, 201);
  check(moved.kind === "move" && moved.sourcePath === sourcePath && moved.path === movedPath && moved.version === digest(updated), "Successful UI MOVE receipt binding mismatch.");
  await expect(mobile.getByTestId("file-status")).toContainText("MOVE receipt confirmed");
  const movedState = assertDurable(a.id, movedPath, updated, moved.requestId, digest(updated), "move", sourcePath);
  check(!exactFile(a.id, sourcePath).exists && JSON.stringify(movedState.file) === JSON.stringify(updatedState.file) && movedState.intent.source_device === updatedState.file.device && movedState.intent.source_inode === updatedState.file.inode, "MOVE copied/changed bytes, mode or inode instead of renaming verified source.");
  await expect(mobile.getByRole("button", { name: "Move file", exact: true })).toBeDisabled();
  await mobile.getByRole("textbox", { name: "File draft", exact: true }).fill("Historical receipt is not a writable current baseline.");
  await expect(mobile.getByRole("button", { name: "Save file", exact: true })).toBeDisabled();
  await mobile.getByRole("textbox", { name: "File draft", exact: true }).fill(updated);
  records.checks.moveUI = { receipt: moved, durable: movedState, sameInodeBytesMode: true, sourceAbsent: true, receiptLeftBaselineUnverified: true };
  await screenshot(mobile, "mobile-moved-awaiting-current-read");
  assertFrozen();

  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await openFile(page, movedPath, updated);
  await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill(finalPath);
  const beforeStorageMove = sql();
  const storageMoveCount = posts("desktop", "move").length;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__rc029RestoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === sessionStorage && key.startsWith("remotecode.pending-file:")) throw new DOMException("RC029 controlled quota boundary", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  try {
    await page.getByRole("button", { name: "Move file", exact: true }).click();
    await expect(page.getByTestId("file-status")).toContainText("No MOVE request was sent");
    check(posts("desktop", "move").length === storageMoveCount && JSON.stringify(sql()) === JSON.stringify(beforeStorageMove) && JSON.stringify(exactFile(a.id, movedPath)) === JSON.stringify(movedState.file) && !exactFile(a.id, finalPath).exists, "MOVE storage failure reached POST or renamed source.");
    records.checks.moveStorageFailure = { submittedPosts: 0, sqlBefore: beforeStorageMove, sqlAfter: sql(), source: exactFile(a.id, movedPath) };
  } finally { await page.evaluate(() => { (window as any).__rc029RestoreStorage(); delete (window as any).__rc029RestoreStorage; }); }
  await page.reload({ waitUntil: "networkidle" });
  await select(page, a.name);
  await page.getByRole("button", { name: "Open directory nested", exact: true }).click();
  await openFile(page, movedPath, updated);
  await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill(finalPath);
  const lostMove: any = { forwardedPosts: 0 };
  await page.route(moveURL, async (route) => {
    try {
      await assertPendingBeforeForward(page, route.request());
      lostMove.forwardedPosts++;
      const actual = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 });
      lostMove.status = actual.status();
      lostMove.receipt = await actual.json();
      await route.abort("failed");
    } catch (error) { lostMove.error = String(error); await route.abort().catch(() => {}); }
  });
  const beforeLostMove = posts("desktop", "move").length;
  try {
    await page.getByRole("button", { name: "Move file", exact: true }).click();
    await expect.poll(() => lostMove.receipt ?? lostMove.error, { timeout: 12_000 }).toBeTruthy();
    check(!lostMove.error && lostMove.status === 201 && lostMove.receipt.kind === "move" && lostMove.receipt.sourcePath === movedPath && lostMove.receipt.path === finalPath && lostMove.forwardedPosts === 1, "Lost MOVE did not commit exactly one real rename POST.");
    await expect(page.getByTestId("file-status")).toContainText(/unknown|not confirmed/);
    await expect(page.getByTestId("pending-file")).toContainText(lostMove.receipt.requestId);
  } finally { await page.unroute(moveURL); }
  const movePending = await pendingIdentity(page);
  check(movePending.length === 1 && movePending[0].value.kind === "move" && movePending[0].value.requestId === lostMove.receipt.requestId && movePending[0].value.sourcePath === movedPath && movePending[0].value.destinationPath === finalPath && movePending[0].value.expectedVersion === digest(updated), "Lost MOVE persisted wrong source/destination/version identity.");
  const finalState = assertDurable(a.id, finalPath, updated, lostMove.receipt.requestId, digest(updated), "move", movedPath);
  check(!exactFile(a.id, movedPath).exists && JSON.stringify(finalState.file) === JSON.stringify(movedState.file) && finalState.intent.source_device === movedState.file.device && finalState.intent.source_inode === movedState.file.inode, "Lost MOVE did not preserve source inode/mode/exact bytes.");
  await recoverPost(page, a, b, "move", lostMove.receipt, movePending, [{ path: movedPath, state: { exists: false } }, { path: finalPath, state: finalState.file }]);
  check(posts("desktop", "move").length === beforeLostMove + 1 && lostMove.forwardedPosts === 1, "Unknown MOVE replayed POST/rename.");
  const createHistory = await api(page, "GET", `${createURL}/receipts/${created.requestId}`);
  const moveHistory = await api(page, "GET", `${createURL}/receipts/${moved.requestId}`);
  check(createHistory.kind === "create" && createHistory.path === sourcePath && createHistory.version === digest(initial) && moveHistory.kind === "move" && moveHistory.path === movedPath && moveHistory.version === digest(updated) && !exactFile(a.id, sourcePath).exists && !exactFile(a.id, movedPath).exists, "Historical receipts were rewritten to infer current path/version.");
  records.checks.moveLostResponse = { boundary: "real rename POST committed then actual response dropped", underlying: lostMove, durable: finalState, createHistory, moveHistory };
  await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await page.getByRole("button", { name: "Open directory nested", exact: true }).click();
  await openFile(page, finalPath, updated);
  await page.getByRole("textbox", { name: "Move destination path", exact: true }).fill("nested/explicit-future-move.txt");
  await expect(page.getByRole("button", { name: "Move file", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "File draft", exact: true }).fill("Explicit current GET established writable baseline; not submitted.");
  await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "File draft", exact: true }).fill(updated);
  await screenshot(page, "desktop-create-move-current-baseline");
  await mobile.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  await openFile(mobile, finalPath, updated);
  await mobile.getByRole("textbox", { name: "Move destination path", exact: true }).fill("nested/archived-move.txt");
  await expect(mobile.getByRole("button", { name: "Move file", exact: true })).toBeEnabled();
  await mobile.getByRole("textbox", { name: "New file path", exact: true }).fill("nested/archived-create.txt");
  await mobile.getByRole("textbox", { name: "New file text", exact: true }).fill("Archived CREATE must be refused.");
  await expect(mobile.getByRole("button", { name: "Create file", exact: true })).toBeEnabled();
  await screenshot(mobile, "mobile-create-move-current-baseline");
  records.checks.createMovePostCounts = { desktopCreate: posts("desktop", "create"), desktopMove: posts("desktop", "move"), mobileMove: posts("mobile", "move") };
  check(posts("desktop", "create").length === 5 && posts("desktop", "move").length === 4 && posts("mobile", "move").length === 2, "CREATE/MOVE request counts differ from three CREATE commits, three MOVE commits and five explicit refusals.");
  assertFrozen();
  return { finalPath, content: updated };
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
    assertDurable(workspace.id, path, content, created.requestId, null, "create");
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
      await assertPendingBeforeForward(page, route.request());
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

  const extension = await createMoveJourney(page, mobile.page, a, b);
  const beforeArchive = sql();
  await mobile.page.getByRole("button", { name: "Archive workspace", exact: true }).click();
  await expect(mobile.page.getByTestId("workspace-status")).toContainText("Workspace change confirmed.");
  await expect(mobile.page.getByTestId("selected-workspace")).toContainText("Archived workspaces are read-only.");
  await expect(mobile.page.getByRole("button", { name: "Save file", exact: true })).toBeDisabled();
  await expect(mobile.page.getByRole("button", { name: "Create file", exact: true })).toBeDisabled();
  await expect(mobile.page.getByRole("button", { name: "Move file", exact: true })).toBeDisabled();
  await expect(mobile.page.getByRole("textbox", { name: "File draft", exact: true })).toHaveAttribute("readonly", "");
  await expect(mobile.page.getByRole("textbox", { name: "New file path", exact: true })).toHaveAttribute("readonly", "");
  await expect(mobile.page.getByRole("textbox", { name: "New file text", exact: true })).toHaveAttribute("readonly", "");
  const forbiddenId = randomUUID();
  const archived = await api(page, "PUT", `/api/workspaces/${a.id}/files/content`, { requestId: forbiddenId, path, content: "forbidden archived overwrite", expectedVersion: digest(lostText) }, 409);
  check(archived.error === "workspace_archived" && JSON.stringify(sql()) === JSON.stringify(beforeArchive) && exactFile(a.id, path).sha256 === digest(lostText), "Archived API SAVE mutated file/intent or did not refuse authority.");
  const archiveFile = exactFile(a.id, extension.finalPath);
  const archivedCreateId = randomUUID();
  const archivedMoveId = randomUUID();
  const archivedCreate = await api(page, "POST", `/api/workspaces/${a.id}/files`, { requestId: archivedCreateId, path: "nested/archived-create.txt", content: "Archived CREATE must be refused." }, 409);
  const archivedMove = await api(page, "POST", `/api/workspaces/${a.id}/files/move`, { requestId: archivedMoveId, sourcePath: extension.finalPath, destinationPath: "nested/archived-move.txt", expectedVersion: digest(extension.content) }, 409);
  check(archivedCreate.error === "workspace_archived" && archivedMove.error === "workspace_archived" && JSON.stringify(sql()) === JSON.stringify(beforeArchive) && JSON.stringify(exactFile(a.id, extension.finalPath)) === JSON.stringify(archiveFile) && !exactFile(a.id, "nested/archived-create.txt").exists && !exactFile(a.id, "nested/archived-move.txt").exists, "Archived CREATE/MOVE changed SQL/files or did not refuse authority.");
  records.checks.archive = { status: 409, error: archived.error, sqlBefore: beforeArchive, sqlAfter: sql(), refusedRequestId: forbiddenId, create: { requestId: archivedCreateId, response: archivedCreate }, move: { requestId: archivedMoveId, response: archivedMove }, file: archiveFile };
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
    const beforeUnauthorizedPosts = sql();
    const originalHeaders = { cookie: `remotecode_session=${originalAuthCookie.value}` };
    const unauthorizedCreate = await auth.page.request.post(`${base}/api/workspaces/${a.id}/files`, { headers: originalHeaders, data: { requestId: randomUUID(), path: "nested/revoked-create.txt", content: "Revoked session must not create." }, timeout: 12_000, maxRedirects: 0, maxRetries: 0 });
    const unauthorizedMove = await auth.page.request.post(`${base}/api/workspaces/${a.id}/files/move`, { headers: originalHeaders, data: { requestId: randomUUID(), sourcePath: extension.finalPath, destinationPath: "nested/revoked-move.txt", expectedVersion: digest(extension.content) }, timeout: 12_000, maxRedirects: 0, maxRetries: 0 });
    check(unauthorizedCreate.status() === 401 && unauthorizedMove.status() === 401 && JSON.stringify(sql()) === JSON.stringify(beforeUnauthorizedPosts) && JSON.stringify(exactFile(a.id, extension.finalPath)) === JSON.stringify(archiveFile) && !exactFile(a.id, "nested/revoked-create.txt").exists && !exactFile(a.id, "nested/revoked-move.txt").exists, "Revoked original session retained CREATE/MOVE authority or changed files/SQL.");
    records.checks.authFence = { boundary: "hold actual OPEN; real UI logout then deliver stale response", originalSessionStatusAfterLogout: unauthorized.status(), createStatus: unauthorizedCreate.status(), moveStatus: unauthorizedMove.status(), sqlBefore: beforeUnauthorizedPosts, sqlAfter: sql() };
    await screenshot(auth.page, "desktop-auth-fence");
  } finally { releaseAuth(); await auth.page.unroute(`${contentURL}?*`); await auth.context.close(); }

  records.sqlite = sql();
  check(records.sqlite.folders.length === 2 && records.sqlite.intents.length === expectedEffects.size && records.sqlite.outcomes.length === expectedEffects.size && records.sqlite.quickCheck.length === 1 && records.sqlite.quickCheck[0].quick_check === "ok", "Final SQL does not contain exactly the expected confirmed effects with intact database.");
  for (const [requestId, expected] of expectedEffects) {
    check(JSON.stringify(records.sqlite.outcomes.find((row: any) => row.request_id === requestId)) === JSON.stringify(expected.outcome) && JSON.stringify(records.sqlite.intents.find((row: any) => row.request_id === requestId)) === JSON.stringify(expected.intent), "Expected SQL binding/state or immutable historical receipt changed.");
  }
  records.expectedEffects = [...expectedEffects.values()];
  records.storageBeforeForward = boundaryChecks;
  check(!records.unexpectedDialog && !records.invalidBrowserRequest && !records.receiptBoundaryError && !records.storageBoundaryError, "Unexpected browser dialog/request or receipt boundary error occurred.");
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
  records.storageBeforeForward = boundaryChecks;
  records.expectedEffects = [...expectedEffects.values()];
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
