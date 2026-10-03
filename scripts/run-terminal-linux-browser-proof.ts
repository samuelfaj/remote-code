import { chromium, expect, request, type Page } from "@playwright/test";
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
const record: any = { run, volume, image, sourceBefore: hashes(), commands: [], result: "unverified", scope: "Web terminal disconnect/reconnect, ANSI rendering, explicit resize and unknown outcomes; not full RC031 acceptance" };
let id = "", vite: ReturnType<typeof Bun.spawn> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
let volumeCreated = false, volumeCreateAttempted = false, createAttempted = false, base = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
function port() { const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const value = socket.port; socket.stop(true); return value; }
const stateCode = `import{Database}from'bun:sqlite';import{existsSync,readFileSync,lstatSync}from'node:fs';import{createHash}from'node:crypto';const d=new Database(${JSON.stringify(databasePath)},{readonly:true,create:false});d.exec('PRAGMA busy_timeout=250');const workspaces=d.query('select id,name from workspaces').all();console.log(JSON.stringify({workspaces,folders:d.query('select workspace_id,state,folder_uid,folder_gid from workspace_folder_requests').all(),terminals:d.query('select terminal_id,request_id,workspace_id,container_id,state,cleanup,cols,rows,current_cols,current_rows,resize_state,input_sequence,input_state,start_sent,stop_sent,remove_sent,exit_code from terminal_sessions').all(),files:workspaces.map(w=>{const dir='/var/lib/remotecode/workspaces/'+w.id;const result={workspaceId:w.id};for(const name of ['created-by-terminal.txt','input-once.txt']){const p=dir+'/'+name;if(existsSync(p)){const b=readFileSync(p),s=lstatSync(p);result[name]={content:b.toString('utf8'),sha256:createHash('sha256').update(b).digest('hex'),uid:s.uid,gid:s.gid,mode:s.mode&0o777};}}return result}),sessions:d.query('select count(*) n from sessions').get().n,quickCheck:d.query('pragma quick_check').all()}));d.close();`;
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

function createApiContainer(name: string, publish: boolean) {
  return command("docker", "create", "--name", name, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`, "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`, "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly", "--workdir", "/workspace", ...(publish ? ["-p", `127.0.0.1:${record.ports.api}:3000`] : []), "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`, "-e", `REMOTECODE_WEB_ORIGIN=${base}`, "-e", `REMOTECODE_TERMINAL_VOLUME=${volume}`, "-e", `REMOTECODE_TERMINAL_IMAGE=${image}`, "--entrypoint", "bun", image, "/proof/server.ts");
}
// Runs the shipped startup watch + shutdown cleanup only after the original API container has exited.
async function reconcileAfterExit() {
  if (JSON.parse(command("docker", "inspect", id))[0].State.Status !== "exited") throw Error("Original API still running; no second controller");
  const name = `${run}-reconcile`;
  const controller = createApiContainer(name, false);
  record.reconcileId = controller;
  try {
    command("docker", "start", controller);
    const end = Date.now() + 15000;
    while (true) {
      try {
        const ready = JSON.parse(command("docker", "exec", controller, "bun", "-e", 'console.log(await Bun.file("/tmp/terminal-controller-ready.json").text())'));
        if (ready.ready !== true || ready.pid !== 1) throw Error("Reconcile controller readiness unverified");
        record.reconcileReady = ready;
        break;
      } catch (error) { if (Date.now() > end) throw error; await delay(200); }
    }
    command("docker", "exec", controller, "bun", "-e", "process.kill(1,'SIGTERM')");
    const stopEnd = Date.now() + 40000;
    while (JSON.parse(command("docker", "inspect", controller))[0].State.Status !== "exited") { if (Date.now() > stopEnd) throw Error("Reconcile controller shutdown unverified"); await delay(200); }
  } finally {
    const identity = JSON.parse(command("docker", "inspect", controller))[0];
    if (identity.Name !== `/${name}` || identity.Config.Labels[label] !== run) throw Error("Reconcile ownership changed");
    command("docker", "rm", "-f", controller);
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
const cleanRow = (value: string | null) => (value ?? "").replaceAll("\u00a0", " ").trimEnd();
const rowsOf = (target: Page) => target.locator(".xterm-rows > div").evaluateAll((els) => els.map((el) => (el.textContent ?? "").replaceAll("\u00a0", " ").trimEnd()));
const treeOf = (target: Page) => target.locator(".xterm-accessibility-tree > div").evaluateAll((els) => els.map((el) => (el.textContent ?? "").replaceAll("\u00a0", " ").trimEnd()));
async function showsText(target: Page, text: string) {
  await expect.poll(async () => (await rowsOf(target)).some((row) => row.includes(text)), { timeout: 20000 }).toBe(true);
}
async function waitRows(target: Page, ready: (rows: string[]) => boolean) {
  await expect.poll(async () => ready(await rowsOf(target)), { timeout: 20000 }).toBe(true);
  return rowsOf(target);
}
// Blank grid cells are padding, not output.
async function screenBlank(target: Page) {
  await expect.poll(async () => [...await rowsOf(target), ...await treeOf(target)].join("").trim(), { timeout: 5000 }).toBe("");
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
  writeFileSync(resolve(output, "server.ts"), `import{createApi}from'/workspace/apps/api/src/app.ts';const api=createApi(process.env.DATABASE_PATH,undefined,{password:process.env.REMOTECODE_AUTH_PASSWORD,webOrigin:process.env.REMOTECODE_WEB_ORIGIN,sessionTtlMs:300000});api.listen({hostname:'0.0.0.0',port:3000,tls:{cert:Bun.file('/proof/proof-ca.pem'),key:Bun.file('/proof/proof-key.pem')}});process.once('SIGTERM',async()=>{await api.stop();const{Database}=await import('bun:sqlite');const end=Date.now()+25000;let open=1;while(open&&Date.now()<end){try{const d=new Database(process.env.DATABASE_PATH,{readonly:true,create:false});open=d.query("select count(*) n from terminal_sessions where cleanup!='removed'").get().n;d.close()}catch{}if(open)await new Promise(r=>setTimeout(r,200))}process.exit(open?1:0)});await Bun.write('/tmp/terminal-controller-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  writeFileSync(resolve(output, "vite.mjs"), `import{createServer}from'${repo}/node_modules/vite/dist/node/index.js';const s=await createServer({configFile:'${repo}/apps/web/vite.config.ts',server:{host:'127.0.0.1',port:${webPort},strictPort:true,proxy:{'/api':{target:'https://127.0.0.1:${apiPort}',ws:true}}}});await s.listen();process.once('SIGTERM',async()=>{await s.close();process.exit(0)});`);
  volumeCreateAttempted = true;
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume); volumeCreated = true;
  createAttempted = true;
  id = createApiContainer(run, true);
  record.containerId = id;
  writeFileSync(resolve(output, "owner.json"), JSON.stringify({ containerId: id, containerName: run, volume, label, owner: run }) + "\n");
  command("docker", "start", id);
  await ready(`https://127.0.0.1:${apiPort}/api/health/ready`, cert);
  vite = Bun.spawn(["node", resolve(output, "vite.mjs")], { cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe" }); record.vitePid = vite.pid;
  await ready(base);
  browser = await chromium.launch({ headless: true }); record.chromium = browser.version();
  record.cases = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    let context = await browser.newContext({ viewport }); context.setDefaultTimeout(20000);
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
    const starts: string[] = [], inputs: number[] = [], polls: any[] = [], resizes: any[] = [];
    const resizeLog = () => resizes.length;
    const readRef = () => page!.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
    const terminalRow = (terminalId: string) => state().terminals.find((row: any) => row.terminal_id === terminalId);
    let resizeRequests = 0, inputRequests = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && /\/api\/terminals\/[0-9a-f-]+\/resize$/.test(path)) resizeRequests++;
      if (request.method() === "POST" && /\/api\/terminals\/[0-9a-f-]+\/input$/.test(path)) inputRequests++;
    });
    const edges: { head: string; tail: string; length: number }[] = [];
    let dropStart = false, dropInput = false, dropResize = false, holdResize = false;
    const late: any = { real: null, done: false, delivered: false, rejected: "" };
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
    await page.route(/\/api\/terminals\/[0-9a-f-]+\/resize$/, async (route) => {
      const body = route.request().postDataJSON();
      const stored = await page!.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
      if (!stored?.resizeUncertain || stored.terminalId !== new URL(route.request().url()).pathname.split("/")[3]) throw Error("Resize fence missing before POST");
      const entry: any = { cols: body.cols, rows: body.rows, fenceBeforePost: true };
      resizes.push(entry);
      if (!dropResize && !holdResize) return route.continue();
      const response = await route.fetch();
      if (response.status() !== 200) throw Error("Resize drop must follow an actual applied resize");
      entry.realStatus = 200;
      if (dropResize) {
        dropResize = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "request_outcome_unknown" }) });
      }
      holdResize = false; late.real = { status: 200, cols: body.cols, rows: body.rows };
      await delay(12_000);
      try { await route.fulfill({ response }); late.delivered = true; } catch (error) { late.rejected = String(error).slice(0, 160); }
      late.done = true;
    });
    page.on("response", async (response) => {
      if (/\/api\/terminals\/[0-9a-f-]+$/.test(new URL(response.url()).pathname) && response.request().method() === "GET" && response.status() === 200) {
        const value = await response.json().catch(() => null);
        if (value) {
          polls.push({ gap: value.gap, baseOffset: value.baseOffset, endOffset: value.endOffset });
          const chunk = typeof value.outputBase64 === "string" ? Buffer.from(value.outputBase64, "base64") : Buffer.alloc(0);
          if (chunk.length) edges.push({ head: chunk.subarray(0, 2).toString("hex"), tail: chunk.subarray(-2).toString("hex"), length: chunk.length });
        }
      }
    });
    await expect(page.getByRole("button", { name: "Start Linux terminal", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Start Linux terminal", exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    await send(page, "stty -echo; printf '\\nTTY=%s SIZE=%s\\n' \"$(id -u)\" \"$(stty size)\"; read line; printf '\\nREPLY=%s\\n' \"$line\"");
    await showsText(page, "TTY=65534 SIZE=24 80");
    const reply = `actual-browser-input-${viewport.width}`;
    await send(page, reply);
    await showsText(page, `REPLY=${reply}`);
    const content = `created through the terminal on ${viewport.width}`;
    await send(page, `printf '${content}\\n' > created-by-terminal.txt`);
    // Direct keyboard input is proved at component level (forwarder gated
    // on/off, no backend calls from the fixture) and shares the guarded
    // send() path with line input, which this journey proves end to end.
    // Only the toggle attach/detach is asserted here; per-keystroke live
    // delivery is not (keys typed while the panel is busy are ignored).
    if (viewport.width === 1440) {
      await page.getByRole("button", { name: "Turn on direct keyboard input", exact: true }).click();
      await expect(page.getByRole("button", { name: "Turn off direct keyboard input", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Turn off direct keyboard input", exact: true }).click();
      await expect(page.getByRole("button", { name: "Turn on direct keyboard input", exact: true })).toBeVisible();
    }
    // The shell writes after input is acknowledged; refresh until the host lists the file.
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
      await expect(page.getByRole("button", { name: "Open file created-by-terminal.txt", exact: true })).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20000 });
    await page.getByRole("button", { name: "Open file created-by-terminal.txt", exact: true }).click();
    await expect(page.getByLabel("File draft", { exact: true })).toHaveValue(`${content}\n`);
    const ansi: any = {};
    const noRaw = async () => {
      const text = [...await rowsOf(page!), ...await treeOf(page!)].join("\n");
      for (const raw of ["\u001b", "[31m", "[0m", "[2J", "[1;1H", "[3;1H", "?1049", "^[", "\\033", "\\r", "\ufffd"]) if (text.includes(raw)) throw Error(`Raw or damaged terminal bytes visible: ${JSON.stringify(raw)}`);
    };
    if (await page.locator(".terminal-panel pre").count() !== 0 || await page.locator(".terminal-panel .xterm-rows").count() !== 1) throw Error("Output is not an xterm DOM renderer");
    await send(page, "printf '\\nAAAA\\rBB\\n'");
    ansi.cr = (await waitRows(page, (rows) => rows.includes("BBAA"))).filter((row) => row.includes("AAAA") || row.includes("BBAA"));
    if (ansi.cr.length !== 1 || ansi.cr[0] !== "BBAA") throw Error("CR overwrite not rendered as BBAA");
    await noRaw();
    await send(page, "printf '\\nPLAINWORD \\033[31mREDTEXT\\033[0m ENDWORD\\n'");
    await waitRows(page, (rows) => rows.includes("PLAINWORD REDTEXT ENDWORD"));
    const red = page.locator(".xterm-rows span.xterm-fg-1", { hasText: "REDTEXT" });
    ansi.red = { spans: await red.count(), color: await red.first().evaluate((el) => getComputedStyle(el).color), plainClass: await page.locator(".xterm-rows span", { hasText: "ENDWORD" }).first().getAttribute("class") };
    if (ansi.red.spans !== 1 || ansi.red.color !== "rgb(204, 0, 0)" || /xterm-fg-/.test(ansi.red.plainClass ?? "")) throw Error("SGR red not rendered as a red span");
    await noRaw();
    await send(page, "printf '\\nMAINSCREEN-KEEP\\n'");
    await showsText(page, "MAINSCREEN-KEEP");
    await send(page, "printf '\\033[?1049h\\033[2J\\033[1;1HALTONLY\\n'");
    const alt = await waitRows(page, (rows) => rows[0] === "ALTONLY");
    if (alt.some((row) => row.includes("MAINSCREEN-KEEP"))) throw Error("Alternate screen shows main-screen text");
    await send(page, "printf '\\033[?1049l'");
    const back = await waitRows(page, (rows) => rows.includes("MAINSCREEN-KEEP"));
    if (back.some((row) => row.includes("ALTONLY"))) throw Error("Alternate screen was not restored");
    ansi.alt = { duringTop: alt[0], restored: true };
    await noRaw();
    await send(page, "printf '\\033[2J\\033[1;1HTOPROW\\033[3;1HBOTROW\\n'");
    const erased = await waitRows(page, (rows) => rows[0] === "TOPROW" && rows[2] === "BOTROW");
    if (erased[1] !== "" || erased.some((row) => row.includes("BBAA") || row.includes("MAINSCREEN-KEEP"))) throw Error("Erase and cursor positioning left stale or misplaced rows");
    ansi.cursor = erased.slice(0, 4);
    await noRaw();
    const euroBefore = edges.length;
    await send(page, "printf '\\nEUROSTART \\342\\202'; sleep 2; printf '\\254 EUROEND\\n'");
    await showsText(page, "EUROSTART");
    if ((await rowsOf(page)).some((row) => row.includes("\ufffd"))) throw Error("Partial UTF-8 rendered as a replacement character");
    await waitRows(page, (rows) => rows.includes("EUROSTART \u20ac EUROEND"));
    await noRaw();
    const split = edges.slice(euroBefore);
    ansi.split = { tailPartial: split.some((edge) => edge.tail === "e282"), headContinuation: split.some((edge) => edge.head.startsWith("ac")) };
    if (!ansi.split.tailPartial || !ansi.split.headContinuation) throw Error("Split UTF-8 bytes were not observed across separate polls");
    const euroPolls = polls.length;
    await page.getByRole("button", { name: "Inspect terminal state", exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    await expect.poll(() => polls.length).toBeGreaterThan(euroPolls + 1);
    ansi.euroCount = (await rowsOf(page)).filter((row) => row.includes("EUROSTART")).length;
    if (ansi.euroCount !== 1) throw Error("Reread appended duplicate output");
    await noRaw();
    const startRef = await readRef();
    const sized = viewport.width === 1440 ? { cols: 120, rows: 40 } : { cols: 40, rows: 18 };
    let colsInput = page.getByLabel("Columns (2\u2013300)"), rowsInput = page.getByLabel("Rows (2\u2013200)");
    let apply = page.getByRole("button", { name: "Apply size", exact: true });
    // A click during an in-flight state read is ignored by the UI before any POST; re-click only while no resize POST exists.
    const clickApply = async (before: number) => {
      for (let attempt = 0; attempt < 6 && resizeRequests === before; attempt++) {
        await expect(apply).toBeEnabled();
        await apply.click();
        await expect.poll(() => resizeRequests, { timeout: 1500 }).toBeGreaterThan(before).catch(() => {});
      }
      if (resizeRequests !== before + 1) throw Error(`Expected exactly one resize POST, saw ${resizeRequests - before}`);
    };
    const invalidSizes = [["1", "24"], ["301", "24"], ["80", "1"], ["80", "201"], ["0", "0"], ["", "24"], ["80", ""], ["2.5", "24"], ["1e2", "24"], ["-5", "24"]];
    const resizeBefore = resizeRequests;
    for (const [c, r] of invalidSizes) {
      await colsInput.fill(c); await rowsInput.fill(r);
      await expect(apply).toBeDisabled();
      await apply.click({ force: true, timeout: 1000 }).catch(() => {});
    }
    for (const [c, r] of [["2", "2"], ["300", "200"]]) { await colsInput.fill(c); await rowsInput.fill(r); await expect(apply).toBeEnabled(); }
    await delay(500);
    if (resizeRequests !== resizeBefore || resizeLog() !== 0) throw Error("Invalid size reached the resize endpoint");
    await colsInput.fill(String(sized.cols)); await rowsInput.fill(String(sized.rows));
    await clickApply(resizeBefore);
    await expect(page.getByTestId("terminal-host-state")).toContainText(`${sized.cols} columns \u00d7 ${sized.rows} rows; resize: applied`);
    await expect(page.getByTestId("terminal-status")).toContainText(`Host confirms ${sized.cols} columns \u00d7 ${sized.rows} rows.`);
    await send(page, "printf '\\nSTTYNOW=%s\\n' \"$(stty size)\"");
    await showsText(page, `STTYNOW=${sized.rows} ${sized.cols}`);
    await expect.poll(async () => (await rowsOf(page!)).length).toBe(sized.rows);
    const resizedRef = await readRef(), resizedRow = terminalRow(startRef.terminalId);
    if (resizeRequests !== resizeBefore + 1 || resizeLog() !== 1 || resizedRef.resizeUncertain || resizedRef.start.cols !== 80 || resizedRef.start.rows !== 24 ||
      resizedRow.current_cols !== sized.cols || resizedRow.current_rows !== sized.rows || resizedRow.cols !== 80 || resizedRow.rows !== 24 || resizedRow.resize_state !== "applied") throw Error("Confirmed resize readback mismatch");
    ansi.resize = { sized, sttyRows: sized.rows, sttyCols: sized.cols, row: { cols: resizedRow.cols, rows: resizedRow.rows, currentCols: resizedRow.current_cols, currentRows: resizedRow.current_rows, state: resizedRow.resize_state }, storedStart: resizedRef.start };
    resizes.length = 0;
    const spot = viewport.width === 1440 ? { row: 35, col: 100 } : { row: 15, col: 35 };
    await send(page, `printf '\\033[?1049h\\033[2J\\033[${spot.row};${spot.col}HX'`);
    const where = async () => (await rowsOf(page!)).flatMap((row, r) => [...row].flatMap((ch, c) => ch === "X" && r < sized.rows ? [{ row: r + 1, col: c + 1 }] : []));
    await expect.poll(where).toEqual([spot]);
    await page.reload();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText(`${sized.cols} columns \u00d7 ${sized.rows} rows; resize: applied`);
    await expect.poll(where).toEqual([spot]);
    await page.getByRole("button", { name: "Inspect terminal state", exact: true }).click();
    await expect(page.getByTestId("terminal-status")).toContainText("No start or input was resent");
    await expect.poll(where).toEqual([spot]);
    ansi.geometry = { sized, spot, afterReloadAndInspect: await where(), domRows: (await rowsOf(page)).length };
    await send(page, "printf '\\033[?1049l'");
    await expect.poll(async () => (await where()).length).toBe(0);
    await send(page, "i=0; while [ \"$i\" -lt 12000 ]; do printf 'browser-overflow-%06d\\n' \"$i\"; i=$((i+1)); done");
    await expect.poll(() => polls.some((value) => value.gap && value.endOffset > 65536)).toBe(true);
    await expect(page.getByText("Earlier output was discarded or is unavailable. Only received bytes are shown.", { exact: true })).toBeVisible();
    if ((await page.request.get(`${base}/api/health/ready`)).status() !== 200) throw Error("Noisy terminal blocked API");
    await showsText(page, "browser-overflow-011999");
    const ring = polls.find((value) => value.gap && value.endOffset > 65536);
    if (!polls.some((value) => value.endOffset - value.baseOffset === 65536) || !ring) throw Error("Root buffer did not stay at 64 KiB");
    const bounded = await page.evaluate(() => ({
      items: [...document.querySelectorAll(".xterm-accessibility-tree > div")].map((el) => el.getAttribute("aria-setsize")),
      overflowRows: [...document.querySelectorAll(".xterm-rows > div")].filter((el) => (el.textContent ?? "").includes("browser-overflow-")).length,
      domRows: document.querySelectorAll(".xterm-rows > div").length,
    }));
    if (bounded.domRows !== sized.rows || bounded.overflowRows > sized.rows || bounded.items.length > sized.rows || new Set(bounded.items).size !== 1 || bounded.items[0] !== String(1000 + sized.rows)) throw Error("Scrollback/viewport unbounded");
    ansi.overflow = { ...bounded, items: bounded.items.length, setsize: bounded.items[0], gapPoll: ring };
    const reconnectRef = await readRef();
    const reconnectStartCount = starts.length, reconnectInputCount = inputs.length;
    const reconnectInputSequence = terminalRow(reconnectRef.terminalId).input_sequence;
    const reconnectCookies = await context.storageState();
    const gateName = `.rc031-reconnect-${randomUUID()}`;
    await send(page, `while [ ! -f '${gateName}' ]; do sleep 0.05; done; i=0; while [ \"$i\" -lt 12000 ]; do printf 'reconnect-overflow-%06d\\n' \"$i\"; i=$((i+1)); done; printf '\\nRECONNECT-PRODUCER-COMPLETE\\n'`);
    await expect(page.getByTestId("terminal-status")).toContainText("Input queued by the host.");
    const mutationCountsBeforeDisconnect = { starts: starts.length, inputs: inputRequests, resizes: resizeRequests };
    await context.close();
    page = undefined;
    const observer = await request.newContext({ storageState: reconnectCookies });
    const pollPath = `${base}/api/terminals/${reconnectRef.terminalId}`;
    const snapshotResponse = await observer.get(`${pollPath}?offset=0`);
    if (snapshotResponse.status() !== 200) throw Error("Authenticated after-close output snapshot unavailable");
    const afterCloseSnapshot = await snapshotResponse.json();
    const afterCloseOffset = afterCloseSnapshot.endOffset;
    const reconnectObservation: any = { terminalId: reconnectRef.terminalId, afterCloseOffset, gateName, mutationCountsBeforeDisconnect };
    const heldResponse = await observer.get(`${pollPath}?offset=${afterCloseOffset}`);
    if (heldResponse.status() !== 200 || (await heldResponse.json()).endOffset !== afterCloseOffset) throw Error("Negative control failed: producer advanced before observer released gate");
    // This owned host-side file write releases test synchronization only; it does not send PTY input or represent a product action.
    command("docker", "exec", id, "bun", "-e", `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(`/var/lib/remotecode/workspaces/${workspaceId}/${gateName}`)},'release\\n',{mode:0o644})`);
    let disconnectedText = "", outputOffset = afterCloseOffset, highestOffset = afterCloseOffset;
    const disconnectedEnd = Date.now() + 30000;
    while (!disconnectedText.includes("RECONNECT-PRODUCER-COMPLETE") && Date.now() < disconnectedEnd) {
      const readiness = await observer.get(`${base}/api/health/ready`);
      if (readiness.status() !== 200) throw Error("API readiness failed while browser was disconnected");
      const response = await observer.get(`${pollPath}?offset=${outputOffset}`);
      if (response.status() !== 200) throw Error("Authenticated disconnected output poll failed");
      const value = await response.json();
      highestOffset = Math.max(highestOffset, value.endOffset);
      if (value.gap) outputOffset = value.baseOffset;
      const chunk = typeof value.outputBase64 === "string" ? Buffer.from(value.outputBase64, "base64") : Buffer.alloc(0);
      disconnectedText += chunk.toString("utf8");
      outputOffset = value.nextOffset;
      if (!disconnectedText.includes("RECONNECT-PRODUCER-COMPLETE")) await delay(100);
    }
    await observer.dispose();
    const disconnectedDelta = highestOffset - afterCloseOffset;
    if (!disconnectedText.includes("RECONNECT-PRODUCER-COMPLETE") || disconnectedDelta <= 65536) throw Error(`Disconnected producer proof incomplete: marker=${disconnectedText.includes("RECONNECT-PRODUCER-COMPLETE")}, bytes=${disconnectedDelta}`);
    reconnectObservation.disconnected = { producerComplete: true, afterCloseOffset, finalOffset: highestOffset, bytesProduced: disconnectedDelta, gateReleasedByObserver: true, heldOutputNegativeControl: true, apiReadyThroughout: true };
    context = await browser.newContext({ viewport, storageState: reconnectCookies }); context.setDefaultTimeout(20000);
    context.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === `/api/workspaces/${workspaceId}/terminals`) { starts.push(request.postDataJSON().requestId); }
      if (request.method() === "POST" && /\/api\/terminals\/[0-9a-f-]+\/resize$/.test(path)) { resizeRequests++; }
      if (request.method() === "POST" && /\/api\/terminals\/[0-9a-f-]+\/input$/.test(path)) { inputRequests++; inputs.push(request.postDataJSON().sequence); }
    });
    context.on("response", async (response) => {
      if (/\/api\/terminals\/[0-9a-f-]+$/.test(new URL(response.url()).pathname) && response.request().method() === "GET" && response.status() === 200) {
        const value = await response.json().catch(() => null);
        if (value) {
          polls.push({ gap: value.gap, baseOffset: value.baseOffset, endOffset: value.endOffset });
          const chunk = typeof value.outputBase64 === "string" ? Buffer.from(value.outputBase64, "base64") : Buffer.alloc(0);
          if (chunk.length) edges.push({ head: chunk.subarray(0, 2).toString("hex"), tail: chunk.subarray(-2).toString("hex"), length: chunk.length });
        }
      }
    });
    await context.route(`**/api/workspaces/${workspaceId}/terminals`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      const stored = await route.request().frame().evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
      if (stored?.start.requestId !== body.requestId || stored.start.workspaceId !== workspaceId || stored.start.cols !== body.cols || stored.start.rows !== body.rows) throw Error("Start identity was not stored before POST");
      if (!dropStart) return route.continue();
      dropStart = false;
      const response = await route.fetch();
      if (response.status() !== 201) throw Error("Start drop must follow a real committed start");
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "request_outcome_unknown" }) });
    });
    await context.route(/\/api\/terminals\/[0-9a-f-]+\/input$/, async (route) => {
      const body = route.request().postDataJSON();
      const stored = await route.request().frame().evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
      if (!stored?.inputUncertain || stored.terminalId !== new URL(route.request().url()).pathname.split("/")[3]) throw Error("Input fence missing before POST");
      if (!dropInput) return route.continue();
      dropInput = false;
      const response = await route.fetch();
      if (response.status() !== 200) throw Error("Input drop must follow actual queued input");
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "request_outcome_unknown" }) });
    });
    await context.route(/\/api\/terminals\/[0-9a-f-]+\/resize$/, async (route) => {
      const body = route.request().postDataJSON();
      const stored = await route.request().frame().evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), storageKey);
      if (!stored?.resizeUncertain || stored.terminalId !== new URL(route.request().url()).pathname.split("/")[3]) throw Error("Resize fence missing before POST");
      const entry: any = { cols: body.cols, rows: body.rows, fenceBeforePost: true };
      resizes.push(entry);
      if (!dropResize && !holdResize) return route.continue();
      const response = await route.fetch();
      if (response.status() !== 200) throw Error("Resize drop must follow an actual applied resize");
      entry.realStatus = 200;
      if (dropResize) {
        dropResize = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "request_outcome_unknown" }) });
      }
      holdResize = false; late.real = { status: 200, cols: body.cols, rows: body.rows };
      await delay(12_000);
      try { await route.fulfill({ response }); late.delivered = true; } catch (error) { late.rejected = String(error).slice(0, 160); }
      late.done = true;
    });
    page = await context.newPage();
    await page.goto(base);
    const resumedSession = await page.request.get(`${base}/api/auth/session`);
    if (resumedSession.status() !== 200 || (await resumedSession.json()).userId !== userId) throw Error("Original authenticated session did not survive browser context reconnect");
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: reconnectRef });
    await page.reload();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    const mutationCountsAfterBootstrap = { starts: starts.length, inputs: inputRequests, resizes: resizeRequests };
    if (mutationCountsAfterBootstrap.starts !== mutationCountsBeforeDisconnect.starts || mutationCountsAfterBootstrap.inputs !== mutationCountsBeforeDisconnect.inputs || mutationCountsAfterBootstrap.resizes !== mutationCountsBeforeDisconnect.resizes) throw Error("A mutation was submitted while disconnected or during replacement-context bootstrap");
    reconnectObservation.mutationCountsAfterBootstrap = mutationCountsAfterBootstrap;
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    await expect(page.getByText("Earlier output was discarded or is unavailable. Only received bytes are shown.", { exact: true })).toBeVisible();
    await showsText(page, "reconnect-overflow-011999");
    const reconnectReady = (await page.request.get(`${base}/api/health/ready`)).status();
    const resumedRef = await readRef();
    if (reconnectReady !== 200 || starts.length !== reconnectStartCount || inputs.length !== reconnectInputCount + 1 || resumedRef.terminalId !== reconnectRef.terminalId) throw Error(`Reconnect invariant mismatch: ready=${reconnectReady}, starts=${starts.length}/${reconnectStartCount}, inputs=${inputs.length}/${reconnectInputCount + 1}, terminal=${resumedRef.terminalId}/${reconnectRef.terminalId}`);
    const reconnectRow = terminalRow(reconnectRef.terminalId);
    if (!reconnectRow || reconnectRow.state !== "running" || reconnectRow.input_sequence !== reconnectInputSequence + 1) throw Error("Reconnect authoritative terminal state changed");
    const isolatedName = `reconnect-other-workspace-${viewport.width}-${randomUUID()}`;
    await page.getByLabel("Workspace name", { exact: true }).fill(isolatedName);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByTestId("workspace-status")).toContainText("Workspace change confirmed");
    await page.getByRole("button", { name: `Open workspace ${isolatedName}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
    await screenBlank(page);
    await expect(page.getByText("Select the original workspace to inspect its terminal reference.", { exact: true })).toBeVisible();
    const isolatedState = state().terminals.find((row: any) => row.terminal_id === reconnectRef.terminalId);
    if (isolatedState.input_sequence !== reconnectInputSequence + 1 || inputs.length !== reconnectInputCount + 1 || starts.length !== reconnectStartCount) throw Error("Different workspace read/input caused terminal mutation");
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    colsInput = page.getByLabel("Columns (2\u2013300)"); rowsInput = page.getByLabel("Rows (2\u2013200)");
    apply = page.getByRole("button", { name: "Apply size", exact: true });
    ansi.reconnect = { ...reconnectObservation, gapDisclosed: true, resumedEndMarker: true, readiness: 200, originalSessionRetained: true, differentWorkspaceHiddenAndInputDisabled: true, startPosts: starts.length, inputPosts: inputs.length, row: reconnectRow };
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
    await showsText(page, `recovered-original-start-${viewport.width}`);
    if (starts.length !== startCount) throw Error("Original start was resent");
    const current = state().terminals.filter((row: any) => row.workspace_id === workspaceId);
    if (current.length !== 2 || current.find((row: any) => row.request_id === pending.start.requestId)?.start_sent !== 1) throw Error("Duplicate start effects");
    const unsure: any = {};
    const unsureSize = viewport.width === 1440 ? { cols: 100, rows: 30 } : { cols: 36, rows: 20 };
    const drop = { cols: String(unsureSize.cols), rows: String(unsureSize.rows) };
    const secondActor = (await readRef()).terminalId;
    const resizeBeforeDrop = resizeRequests, inputBeforeDrop = inputRequests;
    dropResize = true;
    await colsInput.fill(drop.cols); await rowsInput.fill(drop.rows);
    await clickApply(resizeBeforeDrop);
    await expect(page.getByRole("alert").filter({ hasText: "Resize outcome remains unknown" })).toBeVisible();
    await expect(page.getByTestId("terminal-status")).toContainText("Resize outcome is unknown");
    const unsureRef = await readRef(), unsureRow = terminalRow(secondActor);
    const dropped = resizes[resizes.length - 1];
    if (resizeRequests !== resizeBeforeDrop + 1 || dropped.realStatus !== 200 || !dropped.fenceBeforePost || !unsureRef.resizeUncertain ||
      unsureRow.current_cols !== unsureSize.cols || unsureRow.current_rows !== unsureSize.rows || unsureRow.resize_state !== "applied" || unsureRow.cols !== 80 || unsureRow.rows !== 24 ||
      unsureRef.start.cols !== 80 || unsureRef.start.rows !== 24) throw Error("Dropped resize response did not follow an applied host resize with durable uncertainty");
    const expectUncertain = async (target: Page) => {
      await expect(target.getByRole("alert").filter({ hasText: "Resize outcome remains unknown" })).toBeVisible();
      await expect(target.getByRole("button", { name: "Apply size", exact: true })).toBeDisabled();
      await expect(target.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
      await expect(target.getByRole("button", { name: "Send Ctrl+C", exact: true })).toBeDisabled();
      await expect(target.getByTestId("terminal-host-state")).toContainText(`${unsureSize.cols} columns \u00d7 ${unsureSize.rows} rows; resize: applied`);
      if (!(await readRef()).resizeUncertain) throw Error("Resize uncertainty was cleared");
    };
    await expectUncertain(page);
    await page.reload();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expectUncertain(page);
    await page.getByRole("button", { name: "Inspect terminal state", exact: true }).click();
    await expect(page.getByTestId("terminal-status")).toContainText("No start or input was resent");
    await delay(1500);
    await expectUncertain(page);
    if (resizeRequests !== resizeBeforeDrop + 1 || inputRequests !== inputBeforeDrop) throw Error("Uncertain resize caused another resize or input POST");
    const afterReload = terminalRow(secondActor);
    if (afterReload.current_cols !== unsureSize.cols || afterReload.resize_state !== "applied" || afterReload.input_sequence !== 1) throw Error("Uncertain resize read changed host state");
    unsure.drop = { size: unsureSize, resizePosts: 1, realStatus: dropped.realStatus, ref: unsureRef, row: afterReload };
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
    await screenBlank(otherPage);
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
    await screenBlank(page);
    await expect(page.getByText("Select the original workspace to inspect its terminal reference.", { exact: true })).toBeVisible();
    const beforeReturnInputs = inputs.length;
    await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
    if (inputs.length !== beforeReturnInputs || starts.length !== startCount) throw Error("Workspace switch caused mutation");
    await expectUncertain(page);
    if (resizeRequests !== resizeBeforeDrop + 1 || inputRequests !== inputBeforeDrop) throw Error("Other login or switch caused resize/input POST");
    await stop(page);
    if (await readRef() !== null) throw Error("Confirmed stop did not release the uncertain-resize reference");
    await expect(page.getByRole("alert").filter({ hasText: "Resize outcome remains unknown" })).toHaveCount(0);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, outputLength: document.querySelector('[aria-label="Terminal output"]')?.textContent?.length ?? 0, hostRows: document.querySelectorAll(".xterm-rows > div").length }));
    if (layout.scroll > layout.width || layout.outputLength > 65536) throw Error("Terminal layout or scrollback unbounded");
    await page.screenshot({ path: resolve(output, `terminal-${viewport.width}.png`), fullPage: true });
    {
      await expect(page.getByRole("button", { name: "Start Linux terminal", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Start Linux terminal", exact: true }).click();
      await expect(page.getByTestId("terminal-host-state")).toContainText("Host state: running");
      const thirdActor = (await readRef()).terminalId;
      const lateSize = viewport.width === 1440 ? { cols: 90, rows: 28 } : { cols: 38, rows: 16 };
      const resizeBeforeLate = resizeRequests, inputBeforeLate = inputRequests;
      holdResize = true;
      await colsInput.fill(String(lateSize.cols)); await rowsInput.fill(String(lateSize.rows));
      const clicked = Date.now();
      await clickApply(resizeBeforeLate);
      // The fence is durable before the POST, so the alert may show while the request is in flight.
      await expect.poll(async () => (await readRef())?.resizeUncertain, { timeout: 5000 }).toBe(true);
      await expect(page.getByRole("alert").filter({ hasText: "Resize outcome remains unknown" })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("button", { name: "Apply size", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
      await expect.poll(() => late.done, { timeout: 25000 }).toBe(true);
      const uncertainAfter = Date.now() - clicked;
      if (uncertainAfter < 10000) throw Error("Late acknowledgement was not held beyond the 10 s tap budget");
      const lateRow = terminalRow(thirdActor);
      if (!late.delivered || late.rejected || late.real?.status !== 200 || (await readRef()).resizeUncertain !== true || lateRow.resize_state !== "applied" || lateRow.current_cols !== lateSize.cols || lateRow.current_rows !== lateSize.rows) throw Error("Late 200 cleared or contradicted durable uncertainty");
      await expect(page.getByRole("button", { name: "Apply size", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Send input", exact: true })).toBeDisabled();
      await expect(page.getByTestId("terminal-host-state")).toContainText(`${lateSize.cols} columns \u00d7 ${lateSize.rows} rows; resize: applied`);
      await page.reload();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
      await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Resize outcome remains unknown" })).toBeVisible();
      await page.getByRole("button", { name: "Inspect terminal state", exact: true }).click();
      await expect(page.getByTestId("terminal-host-state")).toContainText("resize: applied");
      await delay(1500);
      if (resizeRequests !== resizeBeforeLate + 1 || inputRequests !== inputBeforeLate || !(await readRef()).resizeUncertain) throw Error("Late acknowledgement or read changed resize fence or POST count");
      unsure.late = { size: lateSize, uncertainAfterMs: uncertainAfter, lateDelivered: late.delivered, lateRejected: late.rejected, row: lateRow, resizePosts: 1 };
      await stop(page);
      if (await readRef() !== null) throw Error("Confirmed stop did not release the late-resize reference");
    }
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
      if (starts.length !== beforeBlocked || state().terminals.filter((row: any) => row.workspace_id === workspaceId).length !== 3) throw Error("Storage failure allowed terminal allocation");
      await page.evaluate(() => { (window as any).restoreTerminalStorage(); delete (window as any).restoreTerminalStorage; });
    }
    record.cases.push({ viewport, workspaceId, secondName, otherLoginStatus: foreign.status(), starts, inputs, polls, originalActor: actor.terminal_id, secondActor, ansi, unsure, resizeRequests, inputRequests, uncertainInputPostCount: inputCount, originalRef, pending, layout, state: state() });
    const logout = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/logout" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    if ((await logout).status() !== 200) throw Error("Normal logout did not confirm");
    await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed logout");
    await expect(page.getByRole("region", { name: "Linux terminal", exact: true })).toHaveCount(0);
    await context.close();
  }
  const final = state();
  if (final.terminals.length !== 6 || final.terminals.some((row: any) => row.state !== "exited" || row.cleanup !== "removed") || final.sessions !== 0 || final.quickCheck[0].quick_check !== "ok") throw Error("Final terminal/session integrity mismatch");
  const createdFiles = final.files.filter((file: any) => file["created-by-terminal.txt"]);
  if (createdFiles.length !== 2) throw Error("Expected two CLI-created files");
  for (const file of createdFiles) if (file["created-by-terminal.txt"].uid !== 65534 || file["created-by-terminal.txt"].gid !== 65534) throw Error("CLI file owner mismatch");
  record.final = final; record.result = "web_terminal_disconnect_reconnect_renderer_resize_and_unknown_outcomes_passed";
} catch (error) {
  record.error = String(error).replaceAll(password, "[redacted]"); record.errorStack = error instanceof Error ? error.stack?.replaceAll(password, "[redacted]") : undefined; process.exitCode = 1;
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
      let ids = command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n");
      if (record.afterCleanup.terminals.some((row: any) => row.cleanup !== "removed" || ids.includes(row.container_id))) {
        await reconcileAfterExit();
        record.afterReconcile = stoppedState();
        ids = command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n");
        record.reconciled = true;
        process.exitCode = 1;
        if (record.afterReconcile.terminals.some((row: any) => row.cleanup !== "removed" || ids.includes(row.container_id))) throw Error("Actor cleanup unverified after reconciliation");
        record.afterCleanup = record.afterReconcile;
      }
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
  if (process.exitCode && record.result === "web_terminal_disconnect_reconnect_renderer_resize_and_unknown_outcomes_passed") record.result = "cleanup_unverified";
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ result: record.result, error: record.error, sourceUnchanged: record.sourceUnchanged, cleanup: record.cleanup, retainedContainer: record.retainedContainer }));
}
