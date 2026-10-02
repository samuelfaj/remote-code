import { chromium, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const repo = resolve(import.meta.dirname, "..");
function input(name: string) { const value = process.env[`RC_JOINED_${name}`]; if (!value) throw Error(`Missing RC_JOINED_${name}`); return value; }
const output = input("WORK_DIR"), volume = input("VOLUME"), device = input("DEVICE_ID"), api = input("API_ORIGIN"), web = input("WEB_ORIGIN"), password = input("PASSWORD"), ca = input("CA");
let id = input("CONTAINER_ID");
const apiPort = Number(input("API_PORT")), webURL = new URL(web);
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw Error("TLS verification must not be disabled");
if (!isAbsolute(output) || realpathSync(output) !== output || !lstatSync(output).isDirectory() || lstatSync(output).uid !== process.getuid?.() || (lstatSync(output).mode & 0o077)) throw Error("Owned private absolute work directory required");
if (output === repo || output.startsWith(`${repo}/`)) throw Error("Evidence must stay outside checkout");
if (!isAbsolute(ca) || !lstatSync(ca).isFile() || lstatSync(ca).isSymbolicLink() || (lstatSync(ca).mode & 0o077)) throw Error("Private regular CA required");
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || api !== `https://127.0.0.1:${apiPort}` || web !== `http://localhost:${webURL.port}` || !webURL.port || password.length < 16 || !/^[0-9a-f]{64}$/.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume) || !/^[0-9a-f-]{36}$/i.test(device)) throw Error("Invalid shell proof inputs");
for (const name of ["joined-evidence.json", "joined-vite.mjs", "joined-vite.log", "joined-save.xcresult", "joined-recreated.xcresult", "joined-current-container.json"]) if (existsSync(resolve(output, name))) throw Error("Fresh joined proof artifacts required; never retry an uncertain journey");
const run = `rc021-joined-${randomUUID()}`, path = "cross-client.txt", original = "web created on shared Linux host", saved = "native save on shared Linux host";
const sources = ["package.json", "bun.lock", "apps/api/src", "apps/api/test-support/native-file-api.ts", "apps/web/src", "apps/web/vite.config.ts", "packages/client/src", "apps/mobile/src", "apps/mobile/native-tests", "apps/mobile/ios/RemoteCodeMobileProof.xcodeproj", "scripts/run-mobile-native-test.sh", "scripts/run-joined-workspace-proof.ts"];
function hashPath(path: string): string { const full = resolve(repo, path); if (lstatSync(full).isFile()) return digest(readFileSync(full)); const hash = createHash("sha256"); for (const entry of readdirSync(full).sort()) hash.update(entry).update(hashPath(`${path}/${entry}`)); return hash.digest("hex"); }
function digest(bytes: string | Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
const hashes = () => Object.fromEntries(sources.map(p => [p, hashPath(p)]));
const record: any = { run, result: "unverified", sourceBefore: hashes(), initialContainerId: id, volume, deviceId: device, environment: { host: `${process.platform}/${process.arch}`, bun: Bun.version, apiPort, webPort: Number(webURL.port) }, stages: [] };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined, vite: Bun.Subprocess | undefined, native: Bun.Subprocess | undefined;
let workspaceId = "", createBody: any, createReceipt: any, initial: any, replacementAttempted = false, cancelled = false;
const abort = new AbortController();
function check(value: unknown, message: string): asserts value { if (cancelled) throw Error("Proof cancelled; effects require reconciliation"); if (!value) throw Error(message); }
function sanitize(value: string) { return value.replaceAll(password, "[redacted]").replaceAll(output, "[proof-directory]"); }
function persist(name: string, value: unknown) { writeFileSync(resolve(output, name), sanitize(JSON.stringify(value, null, 2)) + "\n", { mode: 0o600 }); }
function command(...args: string[]) { const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 }); if (result.exitCode) throw Error(sanitize(`${args[0]} failed (${result.exitCode}): ${result.stderr.toString()}`)); return result.stdout.toString().trim(); }
function marker(metadata: any) { if (metadata.Config.Labels?.["remotecode.rc029.native"] !== device || metadata.Name !== initial.Name || !/^[0-9a-f]{64}$/.test(metadata.Id)) throw Error("Replacement ownership changed"); id = metadata.Id; const value = { containerId: id, name: metadata.Name.slice(1), ownedDeviceId: device }; persist("joined-current-container.json", value); if (JSON.stringify(JSON.parse(readFileSync(resolve(output, "joined-current-container.json"), "utf8"))) !== JSON.stringify(value)) throw Error("Cleanup target readback mismatch"); }
function state() {
  return JSON.parse(command("docker", "exec", id, "bun", "-e", `import{Database}from'bun:sqlite';import{readFileSync,lstatSync,readdirSync,existsSync}from'node:fs';import{createHash}from'node:crypto';const d=new Database(process.env.DATABASE_PATH,{readonly:true,create:false});const roots='/var/lib/remotecode/workspaces';const workspaceDirectories=existsSync(roots)?readdirSync(roots).sort():[];const files=workspaceDirectories.flatMap(w=>readdirSync(roots+'/'+w).sort().map(p=>{const f=roots+'/'+w+'/'+p,st=lstatSync(f,{bigint:true});if(!st.isFile())throw Error('Unexpected non-file');const bytes=readFileSync(f);return{workspaceId:w,path:p,content:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex'),mode:Number(st.mode&0o777n),inode:String(st.ino),device:String(st.dev)}}));console.log(JSON.stringify({workspaceDirectories,workspaces:d.query('select id,name from workspaces order by id').all(),workspaceReceipts:d.query('select request_id,workspace_id,kind,name from workspace_receipts order by request_id').all(),folders:d.query('select workspace_id,request_id,state from workspace_folder_requests order by request_id').all(),intents:d.query('select request_id,workspace_id,kind,destination_path,expected_sha256,state from file_operation_intents order by request_id').all(),outcomes:d.query('select request_id,workspace_id,kind,result_path,result_sha256,completed_at from file_operation_outcomes order by request_id').all(),files:files.filter(r=>r.path!=='.remotecode-workspace'),markers:files.filter(r=>r.path==='.remotecode-workspace'),sessions:d.query('select count(*) n from sessions').get().n,quickCheck:d.query('pragma quick_check').all()}));d.close();`));
}
function durable(observed: any, content: string, count: number) {
  check(observed.workspaces.length === 1 && observed.workspaces[0].id === workspaceId && observed.workspaces[0].name === run && observed.workspaceReceipts.length === 1 && observed.workspaceReceipts[0].workspace_id === workspaceId && observed.workspaceReceipts[0].kind === "create", "Sole original workspace and receipt required");
  check(observed.workspaceDirectories.length === 1 && observed.workspaceDirectories[0] === workspaceId && observed.folders.length === 1 && observed.folders[0].workspace_id === workspaceId && observed.folders[0].request_id === record.folderRequestId && observed.folders[0].state === "provisioned" && observed.intents.length === count && observed.outcomes.length === count && observed.intents.every((r: any) => r.workspace_id === workspaceId && r.destination_path === path && r.state === "completed"), "Single folder and exact completed operation counts required");
  check(observed.markers.length === 1 && observed.markers[0].workspaceId === workspaceId && observed.markers[0].content === `${record.folderRequestId}\n` && observed.markers[0].mode === 0o600, "Canonical Linux folder marker mismatch");
  check(observed.files.length === 1 && observed.files[0].workspaceId === workspaceId && observed.files[0].path === path && observed.files[0].content === content && observed.files[0].sha256 === digest(content) && observed.files[0].mode === 0o600 && observed.quickCheck.length === 1 && observed.quickCheck[0].quick_check === "ok", "Authoritative Linux bytes, file mode or quick_check mismatch");
  const created = observed.outcomes.find((r: any) => r.kind === "create"), intent = observed.intents.find((r: any) => r.kind === "create");
  check(created?.request_id === createBody.requestId && created.workspace_id === workspaceId && created.result_path === path && created.result_sha256 === digest(original) && intent?.request_id === created.request_id && intent.expected_sha256 === null, "Historical CREATE outcome or intent changed");
  if (count === 2) { const save = observed.outcomes.find((r: any) => r.kind === "save"), intent = observed.intents.find((r: any) => r.kind === "save"); check(save?.workspace_id === workspaceId && save.result_path === path && save.result_sha256 === digest(saved) && intent?.request_id === save.request_id && intent.expected_sha256 === digest(original), "One native SAVE with original current version required"); }
}
function effects(observed: any) { const { sessions, ...durableState } = observed; return JSON.stringify(durableState); }
async function ready(url: string, tls = false) { for (let n = 0; n < 100; n++) { check(!vite || vite.exitCode === null, "Owned Vite exited"); try { if ((await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)]), ...(tls ? { tls: { ca: readFileSync(ca) } } : {}) })).status === 200) return; } catch {} await delay(200, undefined, { signal: abort.signal }); } throw Error("Service readiness unverified"); }
async function openCurrent(content: string) {
  await page!.reload();
  await page!.getByRole("button", { name: `Open workspace ${run}`, exact: true }).click();
  await page!.getByRole("button", { name: "Refresh folder and files", exact: true }).click();
  const response = page!.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/workspaces/${workspaceId}/files/content`);
  await page!.getByRole("button", { name: `Open file ${path}`, exact: true }).click();
  const actual = await response, body = await actual.json();
  check(actual.status() === 200 && body.path === path && body.content === content && body.version === digest(content), "Browser current OPEN bytes/version mismatch");
  await expect(page!.getByLabel("File draft", { exact: true })).toHaveValue(content);
  return body;
}
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RC_JOINED_")));
function signalOwned(process: Bun.Subprocess | undefined, signal: NodeJS.Signals) { if (!process) return; try { globalThis.process.kill(-process.pid, signal); } catch (error: any) { if (error.code !== "ESRCH") throw error; } }
async function closeOwned(process: Bun.Subprocess | undefined) {
  if (!process) return;
  signalOwned(process, "SIGTERM"); const timer = setTimeout(() => signalOwned(process, "SIGKILL"), 5000);
  try { await process.exited; signalOwned(process, "SIGKILL"); } finally { clearTimeout(timer); }
  for (let n = 0; n < 50; n++) { try { globalThis.process.kill(-process.pid, 0); } catch (error: any) { if (error.code === "ESRCH") return; throw error; } await delay(100); }
  throw Error("Owned subprocess group remains after shutdown");
}
async function installed(stage: string, test: string) {
  const result = resolve(output, `joined-${stage}.xcresult`), log = openSync(resolve(output, `joined-${stage}-xcodebuild.log`), "wx", 0o600);
  try { native = Bun.spawn(["xcodebuild", "-workspace", resolve(repo, "apps/mobile/ios/RemoteCodeMobileProof.xcworkspace"), "-scheme", "RemoteCodeMobileProof", "-destination", `platform=iOS Simulator,id=${device}`, `RC_NATIVE_TEST_API_ORIGIN=${api}`, `-only-testing:RemoteCodeMobileProofUITests/RemoteCodeMobileProofUITests/${test}`, "-resultBundlePath", result, "test"], { cwd: repo, env: { ...childEnv, EXPO_PUBLIC_API_ORIGIN: api, EXPO_PUBLIC_CLIENT_ORIGIN: web }, stdout: log, stderr: log, detached: true }); } finally { closeSync(log); }
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; try { signalOwned(native, "SIGKILL"); } catch (error) { record.nativeShutdownError = sanitize(String(error)); } }, 900_000);
  let exitCode: number;
  try { exitCode = await native.exited; await closeOwned(native); } finally { clearTimeout(deadline); }
  check(!timedOut, `Native ${stage} deadline expired; effects require reconciliation`);
  check(existsSync(result), `Native ${stage} produced no xcresult; see owned output log`);
  const summary = JSON.parse(command("xcrun", "xcresulttool", "get", "test-results", "summary", "--path", result));
  persist(`joined-${stage}-summary.json`, summary); record.stages.push({ stage, test, exitCode, summary });
  check(exitCode === 0 && summary.result === "Passed" && summary.passedTests === 1 && summary.failedTests === 0 && summary.skippedTests === 0, `Native ${stage} requires 1 passed, 0 failed, 0 skipped; see xcresult and log`);
}
async function recreate() {
  const observed = state(); durable(observed, saved, 2); record.beforeRecreation = observed;
  const current = JSON.parse(command("docker", "inspect", id))[0];
  check(current.Id === initial.Id && current.Name === initial.Name && current.Config.Labels?.["remotecode.rc029.native"] === device && JSON.stringify(current.Config) === JSON.stringify(initial.Config) && JSON.stringify(current.HostConfig) === JSON.stringify(initial.HostConfig), "Initial container identity/config changed; preserve it");
  const host = command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}");
  check(host.startsWith("unix://"), "Owned Docker Unix endpoint required");
  const payload = JSON.stringify({ ...initial.Config, Image: initial.Image, HostConfig: initial.HostConfig });
  command("docker", "rm", "-f", id);
  check(!command("docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}").split("\n").includes(id), "Original container still exists");
  replacementAttempted = true;
  const replacement: any = await new Promise((accept, reject) => {
    const req = request({ socketPath: host.slice(7), path: `/containers/create?name=${encodeURIComponent(initial.Name.slice(1))}&platform=linux%2Farm64`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, signal: abort.signal }, response => {
      let bytes = ""; response.setEncoding("utf8"); response.on("data", chunk => { bytes += chunk; }); response.on("error", reject); response.on("end", () => { try { if (response.statusCode !== 201) throw Error(`Docker replacement CREATE status ${response.statusCode}; do not retry`); accept(JSON.parse(bytes)); } catch (error) { reject(error); } });
    }); req.setTimeout(30_000, () => req.destroy(Error("Docker replacement CREATE outcome unknown"))); req.on("error", reject); req.end(payload);
  });
  check(/^[0-9a-f]{64}$/.test(replacement.Id), "Docker returned invalid replacement ID");
  // Publish cleanup ownership before starting or inspecting the replacement.
  id = replacement.Id; persist("joined-current-container.json", { containerId: id, name: initial.Name.slice(1), ownedDeviceId: device });
  const actual = JSON.parse(command("docker", "inspect", id))[0]; marker(actual);
  // Docker normalizes OomKillDisable at create; compare running configuration again after start.
  const expectedHost = { ...initial.HostConfig, OomKillDisable: initial.HostConfig.OomKillDisable ?? false };
  check(id !== initial.Id && actual.Image === initial.Image && isDeepStrictEqual(actual.Config, { ...initial.Config, Image: initial.Image }) && isDeepStrictEqual(actual.HostConfig, expectedHost), "Replacement controlled configuration differs");
  record.createdConfigurationMatches = true;
  command("docker", "start", id); await ready(`${api}/api/health/ready`, true);
  const running = JSON.parse(command("docker", "inspect", id))[0];
  check(isDeepStrictEqual(running.Config, { ...initial.Config, Image: initial.Image }) && isDeepStrictEqual(running.HostConfig, initial.HostConfig), "Replacement running configuration differs");
  record.runningConfigurationMatches = true;
  const after = state(); durable(after, saved, 2); check(effects(after) === effects(observed), "Container recreation changed durable identity or bytes"); record.afterRecreation = after; record.replacementContainerId = id;
}
const stop = () => { cancelled = true; abort.abort(); signalOwned(native, "SIGKILL"); signalOwned(vite, "SIGTERM"); void browser?.close().catch(() => {}); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  record.gitHead = command("git", "rev-parse", "HEAD");
  initial = JSON.parse(command("docker", "inspect", id))[0];
  const env = Object.fromEntries(initial.Config.Env.map((value: string) => { const at = value.indexOf("="); return [value.slice(0, at), value.slice(at + 1)]; }));
  check(initial.Id === id && initial.Config.Labels?.["remotecode.rc029.native"] === device && initial.State.Running && initial.HostConfig.ReadonlyRootfs && initial.Config.WorkingDir === "/workspace" && initial.Config.Entrypoint?.join(" ") === "bun" && initial.Config.Cmd?.join(" ") === "run /workspace/apps/api/test-support/native-file-api.ts", "Runner-owned actual API container required");
  check(env.API_PORT === String(apiPort) && env.REMOTECODE_WEB_ORIGIN === web && env.REMOTECODE_AUTH_PASSWORD === password && env.RC_NATIVE_TEST_TLS_CERT === `/proof/${ca.split("/").at(-1)}` && env.DATABASE_PATH === "/var/lib/remotecode/remotecode-native.sqlite", "Shell/container TLS and authentication config mismatch");
  check(initial.Mounts.filter((m: any) => m.Type === "volume").length === 1 && initial.Mounts.some((m: any) => m.Type === "volume" && m.Name === volume && m.Destination === "/var/lib/remotecode" && m.RW) && initial.Mounts.some((m: any) => m.Type === "bind" && m.Source === repo && m.Destination === "/workspace" && !m.RW) && initial.Mounts.some((m: any) => m.Type === "bind" && m.Source === output && m.Destination === "/proof" && !m.RW) && initial.Mounts.filter((m: any) => m.Type === "bind").every((m: any) => !m.RW), "Same owned volume and read-only source/TLS binds required");
  check(command("docker", "volume", "inspect", volume, "--format", '{{index .Labels "remotecode.rc021.joined"}}') === device && JSON.stringify(initial.HostConfig.PortBindings) === JSON.stringify({ [`${apiPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(apiPort) }] }) && Object.keys(initial.NetworkSettings.Networks).join(",") === "bridge", "Owned volume/loopback published port/default network mismatch");
  const image = JSON.parse(command("docker", "image", "inspect", initial.Image))[0]; check(image.Os === "linux" && image.Architecture === "arm64", "Actual Linux ARM64 image required"); record.image = image.Id; marker(initial);
  const baseline = state(); check(baseline.workspaces.length === 0 && baseline.folders.length === 0 && baseline.intents.length === 0 && baseline.outcomes.length === 0 && baseline.files.length === 0 && baseline.sessions === 0 && baseline.quickCheck[0]?.quick_check === "ok", "Fresh authoritative volume required"); record.baseline = baseline;
  writeFileSync(resolve(output, "joined-vite.mjs"), `import{createServer}from${JSON.stringify(resolve(repo, "node_modules/vite/dist/node/index.js"))};const s=await createServer({configFile:${JSON.stringify(resolve(repo, "apps/web/vite.config.ts"))},server:{host:'127.0.0.1',port:${Number(webURL.port)},strictPort:true,proxy:{'/api':{target:${JSON.stringify(api)},ws:true}}}});await s.listen();process.once('SIGTERM',async()=>{await s.close();process.exit(0)});`, { mode: 0o600 });
  const log = openSync(resolve(output, "joined-vite.log"), "wx", 0o600);
  try { vite = Bun.spawn(["node", resolve(output, "joined-vite.mjs")], { cwd: repo, env: { ...childEnv, NODE_EXTRA_CA_CERTS: ca }, stdout: log, stderr: log, detached: true }); } finally { closeSync(log); }
  await ready(`${api}/api/health/ready`, true); await ready(web);
  browser = await chromium.launch({ headless: true }); record.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(15_000); page = await context.newPage();
  await page.goto(web); await page.getByLabel("Host passphrase").fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  check((await page.request.get(`${web}/api/auth/session`)).status() === 200, "Normal browser authenticated cookie required");
  await page.getByLabel("Workspace name", { exact: true }).fill(run); await page.getByRole("button", { name: "Create workspace", exact: true }).click(); await expect(page.getByTestId("workspace-status")).toContainText("Workspace change confirmed");
  const rows = await (await page.request.get(`${web}/api/workspaces`)).json(); check(rows.workspaces.length === 1 && rows.workspaces[0].name === run, "Browser must create sole real workspace"); workspaceId = rows.workspaces[0].id; record.workspaceId = workspaceId;
  await page.getByRole("button", { name: `Open workspace ${run}`, exact: true }).click();
  const prepared = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/workspaces/${workspaceId}/folder`);
  await page.getByRole("button", { name: "Prepare workspace folder", exact: true }).click(); const folderResponse = await prepared; check(folderResponse.ok(), "Real folder POST must confirm"); record.folderReceipt = await folderResponse.json(); record.folderRequestId = folderResponse.request().postDataJSON().requestId; check(record.folderReceipt.workspaceId === workspaceId && record.folderReceipt.state === "provisioned", "Browser folder receipt must match real workspace"); await expect(page.getByText("Folder provisioned on Linux.", { exact: true })).toBeVisible();
  await page.getByLabel("New file path", { exact: true }).fill(path); await page.getByLabel("New file text", { exact: true }).fill(original);
  const created = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/workspaces/${workspaceId}/files`);
  await page.getByRole("button", { name: "Create file", exact: true }).click(); const response = await created; createBody = response.request().postDataJSON(); createReceipt = await response.json();
  check(response.status() === 201 && createBody.path === path && createBody.content === original && createReceipt.requestId === createBody.requestId && createReceipt.workspaceId === workspaceId && createReceipt.kind === "create" && createReceipt.path === path && createReceipt.version === digest(original), "Original browser CREATE body/receipt must confirm"); record.createBody = createBody; record.createReceipt = createReceipt;
  await expect(page.getByTestId("file-status")).toContainText("receipt confirmed"); record.webCreated = await openCurrent(original); const beforeNative = state(); durable(beforeNative, original, 1); record.beforeNative = beforeNative;
  await installed("save", "testInstalledAppJoinsWebCreatedWorkspaceAndSavesSharedLinuxFile"); record.webAfterNative = await openCurrent(saved); const savedState = state(); durable(savedState, saved, 2); record.afterNative = savedState;
  await recreate();
  record.webAfterRecreation = await openCurrent(saved);
  await installed("recreated", "testInstalledAppReadsJoinedWorkspaceAfterAPIContainerRecreationWithoutReplay");
  const stable = state(); durable(stable, saved, 2); check(effects(stable) === effects(savedState), "Native reread duplicated or changed an effect");
  for (const altered of [false, true]) {
    const body = altered ? { ...createBody, content: "altered same-ID CREATE must not write" } : createBody;
    const actual = await page.evaluate(async ({ url, body }) => { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }, { url: `/api/workspaces/${workspaceId}/files`, body });
    check(actual.status === (altered ? 409 : 200) && (altered ? actual.body.error === "request_id_conflict" : JSON.stringify(actual.body) === JSON.stringify(createReceipt)), "Canonical same-ID receipt or altered-body rejection mismatch");
    const observed = state(); durable(observed, saved, 2); check(effects(observed) === effects(stable), "Same-ID POST changed Linux state or duplicated effect"); record[altered ? "counterexample" : "canonicalReplay"] = actual;
    await openCurrent(saved);
  }
  record.webViewports = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); const current = await openCurrent(saved);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    check(layout.scroll <= layout.width, "Joined file screen overflows viewport");
    await page.screenshot({ path: resolve(output, `joined-web-${viewport.width}.png`), fullPage: true });
    record.webViewports.push({ viewport, current, layout });
  }
  const logout = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/auth/logout");
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); check((await logout).status() === 200, "Real global browser logout must confirm"); await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed logout");
  record.finalState = state(); durable(record.finalState, saved, 2); check(record.finalState.sessions === 0 && effects(record.finalState) === effects(stable), "Global logout must revoke all sessions without changing files"); record.result = "joined_workspace_journey_passed";
} catch (error) {
  record.error = sanitize(String(error)); process.exitCode = 1;
  if (replacementAttempted && initial) { try { marker(JSON.parse(command("docker", "inspect", initial.Name.slice(1)))[0]); record.recoveredCleanupContainerId = id; } catch (recoveryError) { record.containerRecoveryError = sanitize(String(recoveryError)); } }
  if (page && !cancelled) { try { record.visibleFailureText = sanitize(await page.locator("body").innerText()); } catch (captureError) { record.captureError = sanitize(String(captureError)); } }
} finally {
  try { record.exitState = state(); } catch (error) { record.exitStateError = sanitize(String(error)); process.exitCode = 1; }
  record.cleanup = {};
  for (const [name, close] of [ ["browser", async () => { if (browser) await browser.close(); if (browser?.isConnected()) throw Error("Owned browser still connected"); }], ["native", () => closeOwned(native)], ["vite", () => closeOwned(vite)] ] as const) {
    try { await close(); record.cleanup[name] = true; } catch (error) { record.cleanup[name] = false; record.cleanup[`${name}Error`] = sanitize(String(error)); process.exitCode = 1; }
  }
  try { record.sourceAfter = hashes(); record.sourceUnchanged = JSON.stringify(record.sourceBefore) === JSON.stringify(record.sourceAfter); } catch (error) { record.sourceHashError = sanitize(String(error)); record.sourceUnchanged = false; }
  if (!record.sourceUnchanged) { record.result = "invalidated_source_changed"; process.exitCode = 1; }
  if (process.exitCode && record.result === "joined_workspace_journey_passed") record.result = "joined_proof_cleanup_or_readback_failed";
  persist("joined-evidence.json", record); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  console.log(JSON.stringify({ result: record.result, error: record.error, sourceUnchanged: record.sourceUnchanged, cleanup: record.cleanup, containerId: id }));
}
