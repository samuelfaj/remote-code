import { chromium, expect, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC_TERMINAL_WEB_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc031-web-${randomUUID()}`;
const volume = `${run}-data`;
const image = "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc031.webproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/terminal-web.sqlite";
const paths = ["package.json", "bun.lock", "apps/api/src", "apps/web/src", "apps/web/vite.config.ts", "packages/client/src", "scripts/run-terminal-linux-browser-proof.ts"];
function hashPath(path: string): string {
  const full = resolve(repo, path);
  if (lstatSync(full).isFile()) return createHash("sha256").update(readFileSync(full)).digest("hex");
  const hash = createHash("sha256");
  for (const child of readdirSync(full).sort()) hash.update(child).update(hashPath(`${path}/${child}`));
  return hash.digest("hex");
}
const hashes = () => Object.fromEntries(paths.map((path) => [path, hashPath(path)]));
const record: any = { run, volume, image, sourceBefore: hashes(), commands: [], result: "unverified", scope: "Web line terminal and unknown outcomes; not full RC031/native/ANSI/resize acceptance" };
let id = "", vite: ReturnType<typeof Bun.spawn> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
let volumeCreated = false, volumeCreateAttempted = false, createAttempted = false, base = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
function port() { const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const value = socket.port; socket.stop(true); return value; }
const stateCode = `import{Database}from'bun:sqlite';import{existsSync,readFileSync,lstatSync}from'node:fs';import{createHash}from'node:crypto';const d=new Database(${JSON.stringify(databasePath)},{readonly:true,create:false});d.exec('PRAGMA busy_timeout=250');const workspaces=d.query('select id,name from workspaces').all();console.log(JSON.stringify({workspaces,folders:d.query('select workspace_id,state,folder_uid,folder_gid from workspace_folder_requests').all(),terminals:d.query('select terminal_id,request_id,workspace_id,container_id,state,cleanup,input_sequence,input_state,start_sent,stop_sent,remove_sent,exit_code from terminal_sessions').all(),files:workspaces.map(w=>{const dir='/var/lib/remotecode/workspaces/'+w.id;const result={workspaceId:w.id};for(const name of ['created-by-terminal.txt','input-once.txt']){const p=dir+'/'+name;if(existsSync(p)){const b=readFileSync(p),s=lstatSync(p);result[name]={content:b.toString('utf8'),sha256:createHash('sha256').update(b).digest('hex'),uid:s.uid,gid:s.gid,mode:s.mode&0o777};}}return result}),sessions:d.query('select count(*) n from sessions').get().n,quickCheck:d.query('pragma quick_check').all()}));d.close();`;
function state() { return JSON.parse(command("docker", "exec", id, "bun", "-e", stateCode)); }
function stoppedState() {
  const name = `${run}-readback`;
  record.readbackName = name;
  const reader = command("docker", "create", "--name", name, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never", "--read-only", "--network", "none", "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode,readonly`, "--entrypoint", "bun", image, "-e", stateCode);
  record.readbackId = reader;
  try { return JSON.parse(command("docker", "start", "--attach", reader)); }
  finally {
    const identity = JSON.parse(command("docker", "inspect", reader))[0];
    if (identity.Name !== `/${name}` || identity.Config.Labels[label] !== run) throw Error("Readback ownership changed");
    command("docker", "rm", "-f", reader);
    if (command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n").includes(reader)) throw Error("Readback worker remains");
  }
}

async function ready(url: string, cert?: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000), ...(cert ? { tls: { ca: readFileSync(cert) } } : {}) })).status === 200) return; } catch { /* Service is starting. */ }
    await delay(200);
  }
  throw Error("Service readiness unverified");
}
async function signIn(target: Page) {
  await target.goto(base);
  await target.getByLabel("Host passphrase").fill(password);
  await target.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(target.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15000 });
}
async function send(target: Page, text: string) {
  await target.getByLabel("Terminal input", { exact: true }).fill(text);
  await expect(target.getByRole("button", { name: "Send input", exact: true })).toBeEnabled();
  await target.getByRole("button", { name: "Send input", exact: true }).click();
}
async function stop(target: Page) {
  await target.getByRole("button", { name: "Stop terminal", exact: true }).click();
  await expect(target.getByTestId("terminal-host-state")).toContainText("cleanup: removed", { timeout: 15000 });
  await expect(target.getByRole("button", { name: "Start Linux terminal", exact: true })).toBeEnabled();
}
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Id !== image || metadata.Os !== "linux" || metadata.Architecture !== "arm64" || Object.keys(metadata.Config.Volumes ?? {}).length) throw Error("Approved volume-free Linux ARM64 image required");
  const apiPort = port(), webPort = port(); base = `http://localhost:${webPort}`;
  record.ports = { api: apiPort, web: webPort };
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import{createApi}from'/workspace/apps/api/src/app.ts';const api=createApi(process.env.DATABASE_PATH,undefined,{password:process.env.REMOTECODE_AUTH_PASSWORD,webOrigin:process.env.REMOTECODE_WEB_ORIGIN,sessionTtlMs:300000});api.listen({hostname:'0.0.0.0',port:3000,tls:{cert:Bun.file('/proof/proof-ca.pem'),key:Bun.file('/proof/proof-key.pem')}});process.once('SIGTERM',async()=>{await api.stop();process.exit(0)});`);
  writeFileSync(resolve(output, "vite.mjs"), `import{createServer}from'${repo}/node_modules/vite/dist/node/index.js';const s=await createServer({configFile:'${repo}/apps/web/vite.config.ts',server:{host:'127.0.0.1',port:${webPort},strictPort:true,proxy:{'/api':{target:'https://127.0.0.1:${apiPort}',ws:true}}}});await s.listen();process.once('SIGTERM',async()=>{await s.close();process.exit(0)});`);
  volumeCreateAttempted = true;
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume); volumeCreated = true;
  createAttempted = true;
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`, "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`, "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly", "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`, "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`, "-e", `REMOTECODE_WEB_ORIGIN=${base}`, "-e", `REMOTECODE_TERMINAL_VOLUME=${volume}`, "-e", `REMOTECODE_TERMINAL_IMAGE=${image}`, "--entrypoint", "bun", image, "/proof/server.ts");
  record.containerId = id;
  writeFileSync(resolve(output, "owner.json"), JSON.stringify({ containerId: id, containerName: run, volume, label, owner: run }) + "\n");
  command("docker", "start", id);
  await ready(`https://127.0.0.1:${apiPort}/api/health/ready`, cert);
  vite = Bun.spawn(["node", resolve(output, "vite.mjs")], { cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe" }); record.vitePid = vite.pid;
  await ready(base);
  browser = await chromium.launch({ headless: true }); record.chromium = browser.version();
  record.cases = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); context.setDefaultTimeout(20000);
    page = await context.newPage(); await signIn(page);
    const session = await page.request.get(`${base}/api/auth/session`); if (session.status() !== 200) throw Error("Normal browser session required");
    const userId = (await session.json()).userId;
    const name = `terminal-${viewport.width}-${randomUUID()}`;
    await page.getByLabel("Workspace name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("Workspace change confirmed");
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Prepare workspace folder", exact: true }).click();
    await expect(page.getByText("Folder provisioned on Linux.", { exact: true })).toBeVisible();
    const list = await (await page.request.get(`${base}/api/workspaces`)).json();
    const workspaceId = list.workspaces.find((row: any) => row.name === name).id;
    const storageKey = `remotecode.terminal:${JSON.stringify([base, userId])}`;
    const starts: string[] = [], inputs: number[] = [], polls: any[] = [];
    let dropStart = false, dropInput = false;
    await page.route(`**/api/workspaces/${workspaceId}/terminals`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      const stored = await page!.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
      if (stored?.start.requestId !== body.requestId || stored.start.workspaceId !== workspaceId || stored.start.cols !== body.cols || stored.start.rows !== body.rows) throw Error("Start identity was not stored before POST");
      starts.push(body.requestId);
      if (!dropStart) return route.continue();
      dropStart = false;
      const response = await route.fetch();
      if (response.status() !== 201) throw Error("Start drop must follow a real committed start");
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "request_outcome_unknown" }) });
    });
    await page.route(/\/api\/terminals\/[0-9a-f-]+\/input$/, async (route) => {
      const body = route.request().postDataJSON();
      const stored = await page!.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
      if (!stored?.inputUncertain || stored.terminalId !== new URL(route.request().url()).pathname.split("/")[3]) throw Error("Input fence missing before POST");
      inputs.push(body.sequence);
      if (!dropInput) return route.continue();
      dropInput = false;
      const response = await route.fetch();
      if (response.status() !== 200) throw Error("Input drop must follow actual queued input");
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "request_outcome_unknown" }) });
    });
    page.on("response", async (response) => {
      if (/\/api\/terminals\/[0-9a-f-]+$/.test(new URL(response.url()).pathname) && response.request().method() === "GET" && response.status() === 200) {
        const value = await response.json().catch(() => null); if (value) polls.push({ gap: value.gap, baseOffset: value.baseOffset, endOffset: value.endOffset });
      }
    });
    await expect(page.getByRole("button", { name: "Start Linux terminal", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Start Linux terminal", exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    await send(page, "stty -echo; printf '\\nTTY=%s SIZE=%s\\n' \"$(id -u)\" \"$(stty size)\"; read line; printf '\\nREPLY=%s\\n' \"$line\"");
    await expect(page.getByLabel("Terminal output", { exact: true })).toContainText("TTY=65534 SIZE=24 80");
    const reply = `actual-browser-input-${viewport.width}`;
    await send(page, reply);
    await expect(page.getByLabel("Terminal output", { exact: true })).toContainText(`REPLY=${reply}`);
    const content = `created through the terminal on ${viewport.width}`;
    await send(page, `printf '${content}\\n' > created-by-terminal.txt`);
    await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
    await page.getByRole("button", { name: "Open file created-by-terminal.txt", exact: true }).click();
    await expect(page.getByLabel("File draft", { exact: true })).toHaveValue(`${content}\n`);
    await send(page, "i=0; while [ \"$i\" -lt 12000 ]; do printf 'browser-overflow-%06d\\n' \"$i\"; i=$((i+1)); done");
    await expect.poll(() => polls.some((value) => value.gap && value.endOffset > 65536)).toBe(true);
    await expect(page.getByText("Earlier output was discarded or is unavailable. Only received bytes are shown.", { exact: true })).toBeVisible();
    if ((await page.request.get(`${base}/api/health/ready`)).status() !== 200) throw Error("Noisy terminal blocked API");
    dropInput = true;
    const once = `unknown-input-${viewport.width}`;
    await send(page, `printf '${once}\\n' >> input-once.txt`);
    await expect(page.getByRole("alert").filter({ hasText: "Input delivery remains unknown" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
    const inputCount = inputs.length;
    const known = state();
    const actor = known.terminals.find((row: any) => row.workspace_id === workspaceId);
    const originalRef = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
    if (!originalRef.inputUncertain || known.files.find((row: any) => row.workspaceId === workspaceId)["input-once.txt"].content !== `${once}\n`) throw Error("Actual uncertain input effect/fence missing");
    if (JSON.stringify(originalRef).includes(once) || JSON.stringify(originalRef).includes(content)) throw Error("Command or output persisted in browser reference");
    await page.reload();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Input delivery remains unknown" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Terminal input", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Inspect terminal state", exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    await delay(1500);
    if (inputs.length !== inputCount || state().files.find((row: any) => row.workspaceId === workspaceId)["input-once.txt"].content !== `${once}\n`) throw Error("Uncertain input was replayed after reload/read");
    await stop(page);
    if (await page.evaluate((key) => sessionStorage.getItem(key), storageKey) !== null) throw Error("Confirmed stop did not release original reference");
    dropStart = true;
    await page.getByRole("button", { name: "Start Linux terminal", exact: true }).click();
    await expect(page.getByTestId("terminal-status")).toContainText("start outcome is unknown");
    const pending = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
    const startCount = starts.length;
    if (startCount !== 2 || pending.start.requestId !== starts[1]) throw Error("Unknown start identity mismatch");
    await expect(page.getByRole("button", { name: "Start Linux terminal", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Inspect terminal state", exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    await send(page, `printf '\\nrecovered-original-start-${viewport.width}\\n'`);
    await expect(page.getByLabel("Terminal output", { exact: true })).toContainText(`recovered-original-start-${viewport.width}`);
    if (starts.length !== startCount) throw Error("Original start was resent");
    const current = state().terminals.filter((row: any) => row.workspace_id === workspaceId);
    if (current.length !== 2 || current.find((row: any) => row.request_id === pending.start.requestId)?.start_sent !== 1) throw Error("Duplicate start effects");
    const liveReference = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
    const otherContext = await browser.newContext({ viewport });
    const otherPage = await otherContext.newPage(); await signIn(otherPage);
    const otherSession = await otherPage.request.get(`${base}/api/auth/session`);
    if ((await otherSession.json()).userId !== userId) throw Error("Same owner, distinct login required");
    await otherPage.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: liveReference });
    await otherPage.reload();
    await expect(otherPage.getByTestId("connection-status")).toHaveText("Live updates connected");
    await otherPage.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(otherPage.getByTestId("terminal-host-state")).toContainText("unconfirmed");
    await expect(otherPage.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
    await expect(otherPage.getByLabel("Terminal output", { exact: true })).toHaveText("");
    const foreign = await otherPage.request.post(`${base}/api/terminals/${liveReference.terminalId}/input`, { data: { sequence: 2, text: "printf forbidden > other-login.txt\n" } });
    if (foreign.status() !== 404 || (await otherPage.request.get(`${base}/api/terminals/${liveReference.terminalId}`)).status() !== 404) throw Error("Other login could access original terminal");
    const afterForeign = state().terminals.find((row: any) => row.terminal_id === liveReference.terminalId);
    if (afterForeign.input_sequence !== 1 || afterForeign.state !== "running") throw Error("Rejected other login changed terminal");
    await otherContext.close();
    const secondName = `other-workspace-${viewport.width}-${randomUUID()}`;
    await page.getByLabel("Workspace name", { exact: true }).fill(secondName);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("Workspace change confirmed");
    await page.getByRole("button", { name: `Open workspace ${secondName}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Terminal output", { exact: true })).toHaveText("");
    await expect(page.getByText("Select the original workspace to inspect its terminal reference.", { exact: true })).toBeVisible();
    const beforeReturnInputs = inputs.length;
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    if (inputs.length !== beforeReturnInputs || starts.length !== startCount) throw Error("Workspace switch caused mutation");
    await stop(page);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, outputLength: document.querySelector('[aria-label="Terminal output"]')?.textContent?.length ?? 0 }));
    if (layout.scroll > layout.width || layout.outputLength > 65536) throw Error("Terminal layout or scrollback unbounded");
    await page.screenshot({ path: resolve(output, `terminal-${viewport.width}.png`), fullPage: true });
    if (viewport.width === 1440) {
      const beforeBlocked = starts.length;
      await page.evaluate((key) => {
        const original = Storage.prototype.setItem;
        (window as any).restoreTerminalStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function(name, value) { if (this === sessionStorage && name === key) throw new Error("owned terminal storage fault"); original.call(this, name, value); };
      }, storageKey);
      await page.getByRole("button", { name: "Start Linux terminal", exact: true }).click();
      await expect(page.getByTestId("terminal-status")).toContainText("No start was sent");
      await expect(page.getByRole("button", { name: "Start Linux terminal", exact: true })).toBeDisabled();
      if (starts.length !== beforeBlocked || state().terminals.filter((row: any) => row.workspace_id === workspaceId).length !== 2) throw Error("Storage failure allowed terminal allocation");
      await page.evaluate(() => { (window as any).restoreTerminalStorage(); delete (window as any).restoreTerminalStorage; });
    }
    record.cases.push({ viewport, workspaceId, secondName, otherLoginStatus: foreign.status(), starts, inputs, polls, originalActor: actor.terminal_id, uncertainInputPostCount: inputCount, originalRef, pending, layout, state: state() });
    const logout = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/logout" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    if ((await logout).status() !== 200) throw Error("Normal logout did not confirm");
    await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed logout");
    await expect(page.getByRole("region", { name: "Linux terminal", exact: true })).toHaveCount(0);
    await context.close();
  }
  const final = state();
  if (final.terminals.length !== 4 || final.terminals.some((row: any) => row.state !== "exited" || row.cleanup !== "removed") || final.sessions !== 0 || final.quickCheck[0].quick_check !== "ok") throw Error("Final terminal/session integrity mismatch");
  const createdFiles = final.files.filter((file: any) => file["created-by-terminal.txt"]);
  if (createdFiles.length !== 2) throw Error("Expected two CLI-created files");
  for (const file of createdFiles) if (file["created-by-terminal.txt"].uid !== 65534 || file["created-by-terminal.txt"].gid !== 65534) throw Error("CLI file owner mismatch");
  record.final = final; record.result = "web_terminal_and_unknown_outcomes_passed";
} catch (error) {
  record.error = String(error).replaceAll(password, "[redacted]"); process.exitCode = 1;
  if (page) { try { record.visibleFailureText = (await page.locator("body").innerText()).replaceAll(password, "[redacted]"); await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }); } catch {} }
} finally {
  record.cleanup = {};
  let reconciled = !createAttempted;
  if (createAttempted && !id) record.retainedUnknownAllocation = { name: run, volume, label, owner: run };
  if (volumeCreateAttempted && !volumeCreated) record.retainedUnknownVolume = { volume, label, owner: run };
  try { if (browser) await browser.close(); record.cleanup.browser = !browser || !browser.isConnected(); } catch (error) { record.cleanup.browserError = String(error); process.exitCode = 1; }
  try { if (vite) { vite.kill("SIGTERM"); await vite.exited; } record.cleanup.vite = !vite || vite.exitCode !== null; } catch (error) { record.cleanup.viteError = String(error); process.exitCode = 1; }
  if (id) {
    try {
      record.exitState = state();
      const identity = JSON.parse(command("docker", "inspect", id))[0];
      if (identity.Name !== `/${run}` || identity.Config.Labels[label] !== run) throw Error("Owned API identity changed");
      // The existing API owns shutdown; a second controller must not race its rows.
      command("docker", "exec", id, "bun", "-e", "process.kill(1,'SIGTERM')");
      const end = Date.now() + 20000;
      let exited = false;
      do {
        exited = JSON.parse(command("docker", "inspect", id))[0].State.Status === "exited";
        if (!exited) await delay(100);
      } while (!exited && Date.now() < end);
      if (!exited) throw Error("API shutdown unverified; retain state and volume");
      record.afterCleanup = stoppedState();
      const ids = command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n");
      if (record.afterCleanup.terminals.some((row: any) => row.cleanup !== "removed" || ids.includes(row.container_id))) throw Error("Actor cleanup unverified");
      reconciled = true;
      command("docker", "rm", "-f", id);
      if (command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n").includes(id)) throw Error("Owned API remains");
      record.cleanup.api = true;
    } catch (error) { record.cleanup.apiError = String(error); record.retainedContainer = id; process.exitCode = 1; }
  }
  if (volumeCreated && reconciled && (!id || record.cleanup.api)) {
    try {
      if (command("docker", "volume", "inspect", volume, "--format", `{{index .Labels "${label}"}}`) !== run) throw Error("Owned volume identity changed");
      command("docker", "volume", "rm", volume);
      if (command("docker", "volume", "ls", "--format", "{{.Name}}").split("\n").includes(volume)) throw Error("Owned volume remains");
      record.cleanup.volume = true;
    } catch (error) { record.cleanup.volumeError = String(error); process.exitCode = 1; }
  }
  if (reconciled && (!id || record.cleanup.api)) for (const name of ["proof-ca.pem", "proof-key.pem"]) { try { unlinkSync(resolve(output, name)); } catch (error: any) { if (error.code !== "ENOENT") { record.cleanup.tlsError = String(error); process.exitCode = 1; } } }
  record.sourceAfter = hashes(); record.sourceUnchanged = JSON.stringify(record.sourceBefore) === JSON.stringify(record.sourceAfter);
  if (!record.sourceUnchanged) { record.result = "invalidated_source_changed"; process.exitCode = 1; }
  if (process.exitCode && record.result === "web_terminal_and_unknown_outcomes_passed") record.result = "cleanup_unverified";
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ result: record.result, error: record.error, sourceUnchanged: record.sourceUnchanged, cleanup: record.cleanup, retainedContainer: record.retainedContainer }));
}
