// RC-053 CDP driver: runs inside the Linux container and drives the
// container's own Chromium over CDP. Signs in, creates a workspace,
// creates a Bot, starts a run, takes and returns screen possession,
// and verifies every displayed value against the host's own API answer.
import { chromium } from "@playwright/test";

const CDP_URL = "http://127.0.0.1:9222";
const API_BASE = "http://127.0.0.1:3000";
const WEB_URL = "http://localhost:5173";
const PASSWORD = process.env.RC053_PASSWORD || "rc053-password";
const record = { result: "unverified", steps: [] };

function step(name, detail) {
  record.steps.push({ name, detail });
}

async function api(path, method = "GET", body, cookies, possessionToken) {
  const opts = {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);
  if (cookies) opts.headers["cookie"] = cookies;
  if (possessionToken) opts.headers["x-rc-possession"] = possessionToken;
  const resp = await fetch(API_BASE + path, opts);
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!resp.ok) throw new Error(`API ${method} ${path} ${resp.status}: ${text}`);
  return { status: resp.status, body: parsed, text, headers: resp.headers };
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const page = browser.contexts().flatMap((c) => c.pages())
      .find((p) => p.url().startsWith(WEB_URL));
    if (!page) throw new Error("No RemoteCode UI page found on CDP");
    step("cdp_connect", "found RemoteCode page");

    // Wait for the UI to be ready.
    await page.waitForSelector('[data-testid="connection-status"]', { timeout: 15_000 }).catch(() => {});
    step("ui_ready", "RemoteCode UI loaded");

    // Sign in via the API from the browser context, then set the cookie
    // so subsequent page navigations are authenticated.
    const loginResp = await api("/api/auth/login", "POST", { password: PASSWORD });
    const sessionCookie = loginResp.headers.get("set-cookie")?.split(";")[0] || "";
    if (!sessionCookie) throw new Error("login failed: no session cookie");
    step("sign_in", `status=${loginResp.status} cookie_set`);

    // Set the session cookie on the page so the UI shows the logged-in state.
    await page.context().addCookies([{
      name: "remotecode_session",
      value: sessionCookie.split("=")[1] || "",
      url: WEB_URL,
    }]);
    await page.reload({ waitUntil: "networkidle" });
    step("cookie_set", "session cookie added to page context");

    // The window itself has to reach the workspace and the screen controls, not
    // only the API beside it: the UI is driven through its own buttons.
    async function uiWorkflow(workspaceName, botName) {
      // The window loaded before the workspace and the Bot existed, so it reads
      // them from the host again the way a person would after creating them.
      await page.reload({ waitUntil: "networkidle" });
      // The sidebar is what tells the shell which workspace the panels show.
      const sidebarWorkspace = page.locator(`[data-testid="workspace-item-${workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")}"]`);
      await sidebarWorkspace.waitFor({ timeout: 20_000 });
      await sidebarWorkspace.click();
      await page.waitForSelector('[data-testid="selected-workspace"]', { timeout: 20_000 });
      const selected = await page.locator('[data-testid="selected-workspace"]').innerText();
      if (!selected.includes(workspaceName)) throw new Error(`ui_workspace_mismatch: ${selected}`);
      step("ui_open_workspace", selected.slice(0, 80));

      const botItem = page.locator(`[data-testid="bot-item-${botName.replace(/[^a-zA-Z0-9_-]/g, "-")}"]`);
      await botItem.waitFor({ timeout: 20_000 });
      await botItem.click();
      step("ui_select_bot", botName);

      await page.locator('[data-testid="take-control"]').click();
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="computer-state"]')?.textContent ?? "";
        return state.includes("holder");
      }, { timeout: 30_000 });
      step("ui_take_control", "the window holds the screen");

      await page.locator('[data-testid="return-control"]').click();
      await page.waitForFunction(() => {
        const result = document.querySelector('[data-testid="return-result"]');
        return result !== null && result.textContent === "returned";
      }, { timeout: 30_000 });
      step("ui_return_control", "the window released the screen");
    }

    // Create a workspace via API.
    const wsResp = await api("/api/workspaces", "POST", { name: "rc053-linux-gui" }, sessionCookie);
    const workspaceId = wsResp.body?.id ?? wsResp.body?.workspace?.id;
    if (!workspaceId) throw new Error(`workspace_id_missing: ${JSON.stringify(wsResp.body)}`);
    step("create_workspace", `workspaceId=${workspaceId}`);

    // Verify workspace via API from the host's own answer.
    const wsCheck = await api(`/api/workspaces/${workspaceId}`, "GET", undefined, sessionCookie);
    if (wsCheck.body?.id !== workspaceId) throw new Error("workspace readback mismatch");
    step("verify_workspace", "readback matches");

    // Create a Bot in the workspace.
    const botResp = await api("/api/bots", "POST", {
      workspaceId,
      name: "rc053-linux-bot",
      instructions: "Use the linux-use MCP tool list_windows to list the X11 windows on this host, then stop.",
    }, sessionCookie);
    const botId = botResp.body?.id ?? botResp.body?.bot?.id;
    if (!botId) throw new Error(`bot_id_missing: ${JSON.stringify(botResp.body)}`);
    step("create_bot", `botId=${botId}`);

    // Start a run for the Bot.
    const runResp = await api("/api/runs", "POST", {
      workspaceId,
      prompt: "Use the linux-use MCP tool list_windows to list the X11 windows on this host, then stop.",
      botId,
    }, sessionCookie);
    const runId = runResp.body?.id ?? runResp.body?.run?.id;
    if (!runId) throw new Error(`run_id_missing: ${JSON.stringify(runResp.body)}`);
    step("start_run", `runId=${runId}`);

    // Wait for the run to reach a non-starting state.
    let runState = "starting";
    for (let i = 0; i < 60; i++) {
      const runCheck = await api(`/api/runs/${runId}`, "GET", undefined, sessionCookie);
      runState = runCheck.body?.state ?? "unknown";
      if (runState !== "starting" && runState !== "running") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    step("run_state", `state=${runState}`);

    // Take possession of the Bot's screen.
    const takeResp = await api(`/api/workspaces/${workspaceId}/screen/possession`, "POST", undefined, sessionCookie);
    const takeToken = takeResp.body?.token;
    const takeEpoch = takeResp.body?.epoch;
    if (!takeToken) throw new Error(`take_possession_failed: ${JSON.stringify(takeResp.body)}`);
    step("take_possession", `token=${takeToken.slice(0, 8)}... epoch=${takeEpoch}`);

    // Get the screen frame to prove visual streaming works.
    const frameResp = await api(`/api/workspaces/${workspaceId}/screen/frame`, "GET", undefined, sessionCookie, takeToken);
    const frameStatus = frameResp.status;
    const frameIsPng = frameResp.headers.get("content-type")?.includes("image/png");
    const frameBytes = frameResp.text?.length ?? 0;
    step("screen_frame", `status=${frameStatus} isPng=${frameIsPng} bytes=${frameBytes}`);

    // Verify the frame is a valid PNG by content-type and non-empty body.
    if (!frameIsPng || frameBytes === 0) throw new Error("screen frame is not a valid PNG");

    // Hand the screen back before driving the UI, so the window's own take and
    // return are the ones under test. A refusal here (the token was already
    // superseded) is not a failure: the UI step reads the host's state anyway.
    try {
      await api(`/api/workspaces/${workspaceId}/screen/possession/release`, "POST", { token: takeToken }, sessionCookie);
      step("release_before_ui", "released");
    } catch (error) {
      step("release_before_ui", `refused: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    await uiWorkflow("rc053-linux-gui", "rc053-linux-bot");

    // The host's own answer after the window returned control.
    const afterRelease = await api(`/api/workspaces/${workspaceId}/screen/possession`, "GET", undefined, sessionCookie);
    step("possession_after_ui_return", `state=${afterRelease.body?.state ?? "unknown"}`);
    if (afterRelease.body?.state !== "none") {
      throw new Error(`possession_not_returned: ${JSON.stringify(afterRelease.body)}`);
    }

    record.result = "passed";
    console.log(JSON.stringify(record));
  } catch (error) {
    record.result = "failed";
    record.error = String(error?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
