import { chromium, expect } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, readdirSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC_FOLDER_PREP_PROOF_DIR!;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc021-prepare-${randomUUID()}`;
const image = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const password = randomBytes(32).toString("base64url");
const label = "remotecode.folder-preparation.proof";
const files = ["package.json", "bun.lock", "apps/api/src", "apps/web/src", "apps/web/vite.config.ts", "packages/client/src", "apps/mobile/src/features/files", "scripts/run-folder-preparation-linux-browser-proof.ts"];
function hashPath(path: string): string {
  const full = resolve(repo, path);
  if (lstatSync(full).isFile()) return createHash("sha256").update(readFileSync(full)).digest("hex");
  const hash = createHash("sha256");
  for (const entry of readdirSync(full).sort()) hash.update(entry).update(hashPath(`${path}/${entry}`));
  return hash.digest("hex");
}
const hashes = () => Object.fromEntries(files.map(p => [p, hashPath(p)]));
const record: any = { run, image, sourceBefore: hashes(), commands: [], result: "unverified", scope: "Folder preparation browser slice; not joined native/restart or aggregate RC-021 acceptance" };
let id = "", vite: any, browser: any, page: any, base = "", workspaceId = "";
function command(...args: string[]) {
  const r = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands.push({ argv: args.map(a => a.replaceAll(password, "[redacted]")), exitCode: r.exitCode });
  if (r.exitCode) throw Error(r.stderr.toString().replaceAll(password, "[redacted]"));
  return r.stdout.toString().trim();
}
function port() { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p; }
function state() { return JSON.parse(command("docker", "exec", id, "bun", "-e", `import{Database}from'bun:sqlite';import{existsSync,readFileSync,lstatSync}from'node:fs';import{createHash}from'node:crypto';const d=new Database('/var/lib/remotecode/red.sqlite',{readonly:true});console.log(JSON.stringify({workspaces:d.query('select id,name from workspaces').all(),folders:d.query('select workspace_id,request_id,state from workspace_folder_requests').all(),intents:d.query('select request_id,kind,state from file_operation_intents').all(),outcomes:d.query('select request_id,kind,workspace_id,result_path,result_sha256 from file_operation_outcomes').all(),actualFiles:d.query('select workspace_id,result_path,result_sha256 from file_operation_outcomes').all().map(r=>{const p='/var/lib/remotecode/workspaces/'+r.workspace_id+'/'+r.result_path;const bytes=readFileSync(p),st=lstatSync(p);return{workspaceId:r.workspace_id,path:r.result_path,content:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex'),mode:st.mode&0o777}}),sessions:d.query('select count(*) n from sessions').get().n,workspaceFolderExists:existsSync('/var/lib/remotecode/workspaces/'+${JSON.stringify(workspaceId)}),quickCheck:d.query('pragma quick_check').all()}));d.close();`)); }
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Id !== image || metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Approved actual Linux ARM64 image required");
  const apiPort = port(), webPort = port(); base = `http://localhost:${webPort}`;
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import{createApi}from'/workspace/apps/api/src/app.ts';const api=createApi(process.env.DATABASE_PATH,undefined,{password:process.env.REMOTECODE_AUTH_PASSWORD,webOrigin:process.env.REMOTECODE_WEB_ORIGIN});api.listen({hostname:'0.0.0.0',port:3000,tls:{cert:Bun.file('/proof/proof-ca.pem'),key:Bun.file('/proof/proof-key.pem')}});`);
  writeFileSync(resolve(output, "vite.mjs"), `import{createServer}from'${repo}/node_modules/vite/dist/node/index.js';const s=await createServer({configFile:'${repo}/apps/web/vite.config.ts',server:{host:'127.0.0.1',port:${webPort},strictPort:true,proxy:{'/api':{target:'https://127.0.0.1:${apiPort}',ws:true}}}});await s.listen();process.once('SIGTERM',async()=>{await s.close();process.exit(0)});`);
  vite = Bun.spawn(["node", resolve(output, "vite.mjs")], { cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe" });
  record.vitePid = vite.pid;
  record.commands.push({ action: "Normal Node Vite CLI", pid: vite.pid, host: "127.0.0.1", apiPort, webPort });
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=700", "--tmpfs", "/var/lib/remotecode:rw,nosuid,nodev,size=64m,mode=700", "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`, "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`, "-e", "API_PORT=3000", "-e", "DATABASE_PATH=/var/lib/remotecode/red.sqlite", "-e", `REMOTECODE_AUTH_PASSWORD=${password}`, "-e", `REMOTECODE_WEB_ORIGIN=${base}`, "--entrypoint", "bun", image, "/proof/server.ts");
  record.containerId = id;
  command("docker", "start", id);
  let ready = false;
  for (let n = 0; n < 100; n++) { try { if ((await fetch(`https://127.0.0.1:${apiPort}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls: { ca: readFileSync(cert) } })).status === 200) { ready = true; break; } } catch {} await delay(200); }
  if (!ready) throw Error("Actual API not ready");
  let webReady = false;
  for (let n = 0; n < 100; n++) { try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).status === 200) { webReady = true; break; } } catch {} await delay(200); }
  if (!webReady) throw Error("Normal Vite CLI not ready");
  browser = await chromium.launch({ headless: true });
  record.chromium = browser.version(); record.environment = { host: `${process.platform}/${process.arch}`, bun: Bun.version, apiPort, webPort };
  record.cases = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); context.setDefaultTimeout(15_000);
    page = await context.newPage();
    await page.goto(base);
    await page.getByLabel("Host passphrase").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15_000 });
    const sessionResponse = await page.request.get(`${base}/api/auth/session`);
    if (sessionResponse.status() !== 200) throw Error("Normal browser cookie not confirmed");
    const userId = (await sessionResponse.json()).userId;
    const name = `rc021-prepare-${randomUUID()}`;
    await page.getByLabel("Workspace name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("Workspace change confirmed");
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByTestId("file-status")).toContainText("no provisioned folder");
    const rows = await (await page.request.get(`${base}/api/workspaces`)).json(); workspaceId = rows.workspaces.find((r: any) => r.name === name).id;
    const folderKey = `remotecode.pending-file:${JSON.stringify([base, userId])}:folder`;
    const posts: string[] = [];
    const folderResponses: Array<{ method: string; status: number; state?: string; requestId?: string }> = [];
    page.on("response", async (response: any) => {
      if (new URL(response.url()).pathname !== `/api/workspaces/${workspaceId}/folder`) return;
      const body = await response.json().catch(() => ({}));
      folderResponses.push({ method: response.request().method(), status: response.status(), state: body.state, requestId: body.requestId });
    });
    await page.route(`**/api/workspaces/${workspaceId}/folder`, async (route: any) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      const stored = await page.evaluate((key: string) => JSON.parse(sessionStorage.getItem(key) ?? "null"), folderKey);
      if (stored?.requestId !== body.requestId || stored.workspaceId !== workspaceId) throw Error("Folder ID not stored before actual POST");
      posts.push(body.requestId); await route.continue();
    });
    if (viewport.width === 1440) command("docker", "exec", id, "bun", "-e", `import{Database}from'bun:sqlite';const d=new Database('/var/lib/remotecode/red.sqlite');d.exec(\"CREATE TRIGGER rc021_deny_folder_accept BEFORE UPDATE OF state ON workspace_folder_requests WHEN NEW.state='provisioned' BEGIN SELECT RAISE(FAIL,'owned folder acceptance fault'); END\");d.close();`);
    const beforeLayout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    if (beforeLayout.scroll > beforeLayout.width) throw Error("Preparation control overflows viewport");
    await page.screenshot({ path: resolve(output, `prepare-control-${viewport.width}.png`), fullPage: true });
    if (viewport.width === 1440) { await page.getByRole("button", { name: "Prepare workspace folder", exact: true }).focus(); await page.keyboard.press("Enter"); }
    else await page.getByRole("button", { name: "Prepare workspace folder", exact: true }).click();
    if (viewport.width === 1440) {
      await expect(page.getByTestId("pending-folder")).toBeVisible();
      await expect.poll(() => folderResponses.some(r => r.method === "POST" && r.status === 503)).toBe(true);
      const original = posts[0];
      await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
      await expect(page.getByRole("button", { name: "Prepare workspace folder", exact: true })).toBeEnabled();
      await expect.poll(() => folderResponses.some(r => r.method === "GET" && r.status === 200 && r.state === "unknown" && r.requestId === original)).toBe(true);
      const before = state(); if (before.folders.find((r: any) => r.workspace_id === workspaceId)?.state !== "pending") throw Error("Actual backend pending folder required");
      await expect(page.getByRole("button", { name: "Create file", exact: true })).toBeDisabled();
      command("docker", "exec", id, "bun", "-e", "import{Database}from'bun:sqlite';const d=new Database('/var/lib/remotecode/red.sqlite');d.exec('DROP TRIGGER rc021_deny_folder_accept');d.close();");
      await page.getByRole("button", { name: "Prepare workspace folder", exact: true }).click();
      await expect(page.getByText("Folder provisioned on Linux.", { exact: true })).toBeVisible();
      if (posts.length !== 2 || posts.some(v => v !== original)) throw Error("Explicit recovery must keep original ID with one canonical folder");
    }
    await expect(page.getByText("Folder provisioned on Linux.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("pending-folder")).toHaveCount(0);
    await expect(page.getByText("Directory: Workspace root", { exact: true })).toBeVisible();
    if (await page.evaluate((key: string) => sessionStorage.getItem(key), folderKey) !== null) throw Error("Confirmed folder identity did not clear");
    const content = `prepared on ${viewport.width} viewport`;
    await page.getByLabel("New file path", { exact: true }).fill("rc021-readable.txt");
    await page.getByLabel("New file text", { exact: true }).fill(content);
    await page.getByRole("button", { name: "Create file", exact: true }).click();
    await expect(page.getByTestId("file-status")).toContainText("receipt confirmed");
    await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
    await page.getByRole("button", { name: "Open file rc021-readable.txt", exact: true }).click();
    await expect(page.getByLabel("File draft", { exact: true })).toHaveValue(content);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    if (layout.scroll > layout.width) throw Error("Changed folder interface overflows viewport");
    await page.screenshot({ path: resolve(output, `prepared-${viewport.width}.png`), fullPage: true });
    const observed = state();
    const actual = observed.actualFiles.find((r: any) => r.workspaceId === workspaceId && r.path === "rc021-readable.txt");
    if (!actual || actual.content !== content || actual.mode !== 0o600 || actual.sha256 !== createHash("sha256").update(content).digest("hex")) throw Error("Actual Linux file does not match confirmed UI");
    record.cases.push({ viewport, workspaceId, posts, folderResponses, state: observed, content, layout });
    const logout = page.waitForResponse((r: any) => new URL(r.url()).pathname === "/api/auth/logout" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    if ((await logout).status() !== 200) throw Error("Actual logout receipt not confirmed before closing browser");
    await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed logout");
    await context.close();
  }
  const final = state();
  if (final.workspaces.length !== 2 || final.folders.length !== 2 || final.intents.length !== 2 || final.outcomes.length !== 2 || final.sessions !== 0 || final.quickCheck[0].quick_check !== "ok") throw Error("Final authoritative folder/file/session counts mismatch");
  record.result = "folder_ui_and_same_id_recovery_passed";

} catch (e) {
  record.error = String(e).replaceAll(password, "[redacted]"); process.exitCode = 1;
  if (page) {
    try { record.visibleFailureText = (await page.locator("body").innerText()).replaceAll(password, "[redacted]"); await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }); }
    catch (captureError) { record.captureError = String(captureError); }
  }
}
finally {
  let reconciled = !id;
  if (id) { try { record.exitState = state(); reconciled = true; } catch (e) { record.exitStateError = String(e); record.retainedContainer = id; record.result = "state_unknown_retained"; process.exitCode = 1; } }
  record.cleanup = {};
  const cleanupError = (name: string, e: unknown) => { record.cleanup[name] = false; record.cleanup[`${name}Error`] = String(e); process.exitCode = 1; };
  try { if (browser) await browser.close(); record.cleanup.browser = !browser || !browser.isConnected(); } catch (e) { cleanupError("browser", e); }
  try { if (vite) { vite.kill("SIGTERM"); await vite.exited; } record.cleanup.vite = !vite || vite.exitCode !== null; } catch (e) { cleanupError("vite", e); }
  try {
    if (id && reconciled) {
      const identity = command("docker", "inspect", id, "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "${label}"}}`);
      if (identity !== `${id} /${run} ${run}`) throw Error("Ownership changed; preserve container");
      command("docker", "rm", "-f", id);
      if (command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n").includes(id)) throw Error("Owned container remains");
    }
    record.cleanup.container = reconciled;
  } catch (e) { cleanupError("container", e); }
  for (const name of reconciled ? ["proof-key.pem", "proof-ca.pem"] : []) {
    try { unlinkSync(resolve(output, name)); } catch (e: any) { if (e.code !== "ENOENT") cleanupError("tls", e); }
  }
  record.sourceAfter = hashes(); record.sourceUnchanged = JSON.stringify(record.sourceBefore) === JSON.stringify(record.sourceAfter);
  if (!record.sourceUnchanged) { record.result = "invalidated_source_changed"; process.exitCode = 1; }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ result: record.result, expectedFailure: record.expectedFailure, error: record.error, sourceUnchanged: record.sourceUnchanged, cleanup: record.cleanup }));
}
