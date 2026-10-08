// RC-033 proof: the shared layout is saved per workspace, returns after the
// client is closed and reopened, and one device's tab selection never changes
// another device's focus.
//
// Two real browser contexts (desktop 1440 and mobile 390) drive the shipped web
// panel against the shipped API in a Docker container. The shared row is seeded
// through the real PUT route with two tabs and two panes on one tab.
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC033_LAYOUT_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc033-layout-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC033_LAYOUT_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc033.layoutproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/layout-proof.sqlite";
let id = "", vite: ReturnType<typeof Bun.spawn> | undefined, browser: Browser | undefined, base = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-033 shared layout persists per workspace and device focus stays local across two clients" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}
function port() { const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const value = socket.port; socket.stop(true); return value; }
async function ready(url: string, cert?: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000), ...(cert ? { tls: { ca: readFileSync(cert) } } : {}) } as any)).status === 200) return; } catch { /* starting */ }
    await delay(200);
  }
  throw Error("Service readiness unverified");
}

const tabs = [
  { id: "tab-file", kind: "file", targetId: "seed.txt" },
  { id: "tab-thread", kind: "thread", targetId: "thread-1" },
];
// The validator requires pane orders to be dense from zero across the layout.
const panes = [
  { id: "pane-1", tabId: "tab-file", order: 0 },
  { id: "pane-2", tabId: "tab-file", order: 1 },
];
const seeded = { tabs, activeTabId: "tab-file", panes, activePaneId: "pane-1" };

try {
  const apiPort = port(), webPort = port(); base = `http://localhost:${webPort}`;
  record.ports = { api: apiPort, web: webPort };
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import{createApi}from'/workspace/apps/api/src/app.ts';const api=createApi(process.env.DATABASE_PATH,undefined,{password:process.env.REMOTECODE_AUTH_PASSWORD,webOrigin:process.env.REMOTECODE_WEB_ORIGIN,sessionTtlMs:300000});api.listen({hostname:'0.0.0.0',port:3000,tls:{cert:Bun.file('/proof/proof-ca.pem'),key:Bun.file('/proof/proof-key.pem')}});`);
  writeFileSync(resolve(output, "vite.mjs"),
    `import{createServer}from'${repo}/node_modules/vite/dist/node/index.js';const s=await createServer({configFile:'${repo}/apps/web/vite.config.ts',server:{host:'127.0.0.1',port:${webPort},strictPort:true,proxy:{'/api':{target:'https://127.0.0.1:${apiPort}',ws:true}}}});await s.listen();process.once('SIGTERM',async()=>{await s.close();process.exit(0)});`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_WEB_ORIGIN=${base}`,
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);
  await ready(`https://127.0.0.1:${apiPort}/api/health/ready`, cert);
  vite = Bun.spawn(["node", resolve(output, "vite.mjs")], { cwd: repo, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe" });
  await ready(base);
  browser = await chromium.launch({ headless: true });
  record.chromium = browser.version();

  const signIn = async (target: Page) => {
    await target.goto(base);
    await target.getByLabel("Host passphrase").fill(password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(target.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15000 });
  };
  const createWorkspace = async (target: Page, name: string) => {
    await target.getByLabel("Workspace name", { exact: true }).fill(name);
    await target.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(target.getByTestId("workspace-status")).toContainText("Workspace change confirmed");
    const list = await (await target.request.get(`${base}/api/workspaces`)).json();
    return list.workspaces.find((row: any) => row.name === name).id as string;
  };
  // The panel loads the shared row when the workspace is first opened, so the
  // row is seeded before the first open.
  const openWorkspace = async (target: Page, name: string) => {
    await target.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
    await target.getByRole("button", { name: "Prepare workspace folder", exact: true }).click();
    await expect(target.getByText("Folder provisioned on Linux.", { exact: true })).toBeVisible();
  };
  const deviceFocus = async (target: Page) => {
    const text = (await target.getByTestId("terminal-layout-state").textContent()) ?? "";
    return { text, shared: /Shared tabs: (\d+)/.exec(text)?.[1] ?? null, device: /this device: ([^;]+)/.exec(text)?.[1]?.trim() ?? null, pane: /pane: ([^;]+)/.exec(text)?.[1]?.trim() ?? null };
  };

  // Desktop creates the workspace and seeds the shared row through the real route.
  const desktop: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  desktop.setDefaultTimeout(20000);
  const desktopPage = await desktop.newPage();
  await signIn(desktopPage);
  const name = `layout-${randomUUID()}`;
  const workspaceId = await createWorkspace(desktopPage, name);
  const seededResponse = await desktopPage.request.put(`${base}/api/workspaces/${workspaceId}/layout`, { data: seeded });
  if (seededResponse.status() !== 200) throw Error(`seed_${seededResponse.status()}`);
  await openWorkspace(desktopPage, name);
  await expect(desktopPage.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2", { timeout: 15000 });
  const desktopInitial = await deviceFocus(desktopPage);
  if (desktopInitial.shared !== "2" || desktopInitial.device !== "tab-file") throw Error(`desktop_initial_${JSON.stringify(desktopInitial)}`);

  // Mobile opens the same workspace and switches its own tab.
  const mobile: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  mobile.setDefaultTimeout(20000);
  const mobilePage = await mobile.newPage();
  const layoutWrites: string[] = [];
  mobilePage.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/layout")) layoutWrites.push(request.url());
  });
  await signIn(mobilePage);
  await mobilePage.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
  await expect(mobilePage.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2", { timeout: 15000 });
  const mobileInitial = await deviceFocus(mobilePage);
  if (mobileInitial.device !== "tab-file") throw Error(`mobile_initial_${JSON.stringify(mobileInitial)}`);
  await mobilePage.getByRole("button", { name: "Open tab-thread", exact: true }).click();
  await expect(mobilePage.getByTestId("terminal-layout-state")).toContainText("this device: tab-thread", { timeout: 10000 });
  await delay(500);
  const mobileAfter = await deviceFocus(mobilePage);
  const desktopAfter = await deviceFocus(desktopPage);
  if (mobileAfter.device !== "tab-thread") throw Error(`mobile_switch_${JSON.stringify(mobileAfter)}`);
  if (desktopAfter.device !== "tab-file" || desktopAfter.pane !== desktopInitial.pane) {
    throw Error(`desktop_focus_hijacked_${JSON.stringify({ desktopInitial, desktopAfter })}`);
  }
  if (layoutWrites.length !== 0) throw Error(`device_switch_wrote_the_shared_row_${JSON.stringify(layoutWrites)}`);
  record.deviceFocus = { desktopInitial, mobileInitial, mobileAfter, desktopAfter, layoutWritesDuringSwitch: layoutWrites.length };

  // Close the desktop client, then come back: the shared layout returns.
  const storedBefore = await (await desktopPage.request.get(`${base}/api/workspaces/${workspaceId}/layout`)).json();
  if (JSON.stringify(storedBefore.layout) !== JSON.stringify(seeded)) throw Error(`seeded_row_changed_${JSON.stringify(storedBefore.layout)}`);
  await desktopPage.close();
  await desktop.close();
  const desktopAgain: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  desktopAgain.setDefaultTimeout(20000);
  const desktopAgainPage = await desktopAgain.newPage();
  await signIn(desktopAgainPage);
  await desktopAgainPage.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
  await expect(desktopAgainPage.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2", { timeout: 15000 });
  const returned = await deviceFocus(desktopAgainPage);
  const storedAfter = await (await desktopAgainPage.request.get(`${base}/api/workspaces/${workspaceId}/layout`)).json();
  if (returned.shared !== "2") throw Error(`layout_did_not_return_${JSON.stringify(returned)}`);
  if (returned.pane === "none") throw Error(`returned_without_panes_${JSON.stringify(returned)}`);
  if (JSON.stringify(storedAfter.layout) !== JSON.stringify(seeded)) throw Error(`layout_row_changed_${JSON.stringify(storedAfter.layout)}`);
  record.returned = { focus: returned, row: storedAfter.layout };
  await desktopAgain.close();
  await mobile.close();

  record.result = "shared_layout_persists_and_device_focus_is_local_passed";
  console.log(JSON.stringify({ result: record.result, deviceFocus: record.deviceFocus, returned: record.returned }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  try { if (browser) await browser.close(); record.cleanup = { browser: true }; } catch { record.cleanup = { browser: false }; }
  try { if (vite) { vite.kill("SIGTERM"); await vite.exited; } } catch {}
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}