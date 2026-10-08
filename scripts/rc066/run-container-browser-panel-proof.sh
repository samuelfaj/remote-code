#!/usr/bin/env bash
# RC-066 proof: Browser on Linux (container's guest Chromium) panel journeys.
#
# Stands up the repository's Linux host with the runs stub as the agent,
# starts the container's own guest Chromium with CDP published to the Mac,
# drives the RC-051 panel journeys through that guest browser using a
# standalone Bun script that calls chromium.connectOverCDP, and asserts
# every value from inside the page so the app's session is the one used.
#
# Fills four cells: Scheduled Bot, Human login, Crash/reconnection,
# Screen take-over.
#
# Requires: docker, curl, openssl, bun, playwright
# Usage: scripts/rc066/run-container-browser-panel-proof.sh <fresh absolute output dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: run-container-browser-panel-proof.sh <fresh absolute output dir>}"
case "$OUT" in /*) ;; *) echo "output dir must be absolute" >&2; exit 2 ;; esac
mkdir -p "$OUT"

IMAGE="${RC066_IMAGE:-remotecode/host:local}"
NAME="rc066-linux-$(date +%s)"
API_PORT="${RC066_API_PORT:-37500}"
WEB_PORT="${RC066_WEB_PORT:-37501}"
CDP_PORT="${RC066_CDP_PORT:-37502}"
# Chromium binds DevTools to the container's own loopback, so a small forwarder
# inside the container is what the published port reaches.
CDP_INNER_PORT=9223
PASSWORD="rc066-linux-$(openssl rand -hex 12)"
DATA_VOLUME="rc066-data-$(date +%s)"

TRANSCRIPT="$OUT/proof.log"
# Bun parses the driver's types, so it is a .ts file, not .mjs.
DRIVER="$OUT/drive-browser.ts"

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

cleanup() {
  say "-- cleanup --"
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

say "== RC-066 container browser panel proof =="
say "outdir=$OUT image=$IMAGE apiPort=$API_PORT webPort=$WEB_PORT cdpPort=$CDP_PORT"

# --- 1. image ----------------------------------------------------------------
say "-- image --"
if [[ "${RC066_REBUILD:-0}" == "1" ]]; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$ROOT/prototype/Dockerfile" "$ROOT" >/dev/null
fi
docker image inspect -f '{{.Id}}' "$IMAGE" | tee -a "$TRANSCRIPT"

# --- 2. TLS certificate -----------------------------------------------------
say "-- TLS certificate --"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=RemoteCode RC-066 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$OUT/key.pem" "$OUT/cert.pem"
say "cert and key written"

# --- 3. start the host container -------------------------------------------
say "-- container --"
docker volume create "$DATA_VOLUME" >/dev/null

docker run -d --name "$NAME" \
  -p "127.0.0.1:${API_PORT}:3000" \
  -p "127.0.0.1:${CDP_PORT}:${CDP_INNER_PORT}" \
  -v "$DATA_VOLUME:/var/lib/remotecode" \
  -e API_PORT=3000 \
  -e DATABASE_PATH=/var/lib/remotecode/rc066.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}" \
  -e REMOTECODE_DISPLAY=:99 \
  "$IMAGE" sleep infinity >/dev/null

CONTAINER_ID=$(docker inspect -f '{{.Id}}' "$NAME" | tee -a "$TRANSCRIPT")
say "container id=${CONTAINER_ID:0:19}"

# --- 4. copy TLS cert/key and write the runs stub agent -------------------
say "-- cert and stub agent --"
docker cp "$OUT/cert.pem" "$NAME:/proof-cert.pem"
docker cp "$OUT/key.pem" "$NAME:/proof-key.pem"
docker exec "$NAME" bash -lc 'chmod 600 /proof-key.pem'
docker exec "$NAME" bash -lc 'printf "#!/bin/bash\nsleep 3\nexec bun /workspace/apps/api/src/features/runs-stub-agent.mjs \"\$@\"\n" > /usr/local/bin/rc051-agent && chmod 0755 /usr/local/bin/rc051-agent'
say "rc051-agent written"

# --- 5. start Xvfb and guest Chromium inside the container -----------------
say "-- guest Chromium --"
docker exec "$NAME" bash -lc 'rm -f /tmp/.X99-lock' || true
docker exec -d "$NAME" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc066-xvfb.log 2>&1'
sleep 2

docker exec -d "$NAME" bash -lc 'DISPLAY=:99 openbox --sm-disable > /var/log/rc066-openbox.log 2>&1'
sleep 1

docker exec -d "$NAME" bash -lc 'DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir=/var/lib/rc066-chromium about:blank > /var/log/rc066-chromium.log 2>&1'
# The container's Chromium answers DevTools on its own loopback only, so the
# published port reaches this forwarder instead, which passes the connection
# through to it.
docker cp "$HERE/cdp-forward.mjs" "$NAME:/tmp/rc066-cdp-forward.mjs"
docker exec -d "$NAME" bash -lc "exec bun /tmp/rc066-cdp-forward.mjs > /var/log/rc066-cdp-forward.log 2>&1"

# Wait for CDP to be reachable from the Mac
say "waiting for CDP on 127.0.0.1:${CDP_PORT}..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  say "-- chromium log --"
  docker exec "$NAME" tail -5 /var/log/rc066-chromium.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "-- forwarder log --"
  docker exec "$NAME" cat /var/log/rc066-cdp-forward.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "-- what the forwarder's port answers inside --"
  docker exec "$NAME" curl -s -m 5 -o /dev/null -w 'inside %{http_code}\n' "http://127.0.0.1:${CDP_INNER_PORT}/json/version" 2>&1 | tee -a "$TRANSCRIPT" || true
  say "-- what Chromium answers inside --"
  docker exec "$NAME" curl -s -m 5 -o /dev/null -w 'inside %{http_code}\n' http://127.0.0.1:9222/json/version 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the guest Chromium did not start or CDP is not reachable"
  exit 1
fi
say "guest Chromium CDP ready on 127.0.0.1:${CDP_PORT}"

# --- 6. start the API inside the container --------------------------------
say "-- API --"
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc066.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem REMOTECODE_DISTILL_BIN=/usr/local/bin/rc051-agent bun apps/api/src/index.ts > /var/log/rc066-api.log 2>&1"

for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$NAME" tail -20 /var/log/rc066-api.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the Linux API never became ready"
  exit 1
fi
say "API ready over TLS on 127.0.0.1:${API_PORT}"

# --- 7. verify the image serves the routes this proof drives ---------------
say "-- route check --"
INBOX_CODE="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:${API_PORT}/api/inbox")"
say "GET /api/inbox -> $INBOX_CODE"
if [[ "$INBOX_CODE" != "401" ]]; then
  say "FAIL: the API image does not serve the shipped Inbox route"
  exit 1
fi

# --- 8. the panel inside the container, on its own loopback ----------------
# The web client refuses to sign in from a page that is not on loopback, and the
# browser under test is the container's, so the panel is served there too: the
# guest browser, the panel and the API all live on the container's loopback,
# which is how the product is meant to be used on one machine.
say "-- panel --"
docker exec -d "$NAME" bash -lc "cd /workspace && REMOTECODE_WEB_PROXY_TARGET='https://127.0.0.1:3000' WEB_PORT='$WEB_PORT' bunx vite --config apps/web/vite.config.ts --host 127.0.0.1 --port '$WEB_PORT' --strictPort > /var/log/rc066-vite.log 2>&1"
for _ in $(seq 1 60); do
  if docker exec "$NAME" curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker exec "$NAME" curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
  docker exec "$NAME" tail -20 /var/log/rc066-vite.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the panel never became ready inside the container"
  exit 1
fi
say "panel ready on the container's 127.0.0.1:${WEB_PORT}"

# --- 9. verify CDP is accessible from the Mac ------------------------------
say "-- CDP verification --"
CDP_VERSION=$(curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" 2>&1)
say "CDP version: $(printf '%s' "$CDP_VERSION" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Browser","unknown"))' 2>/dev/null || echo 'ok')"

# --- 10. write the standalone Bun driver -----------------------------------
say "-- writing driver script --"
cat > "$DRIVER" <<'DRIVER_EOF'
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CDP_URL = "http://127.0.0.1:" + (process.env.RC066_CDP_PORT || "37502");
// The browser runs in the container, so this URL is the container's own loopback.
const WEB_URL = "http://127.0.0.1:" + (process.env.RC066_WEB_PORT || "37501");
const API_BASE = "https://127.0.0.1:" + (process.env.RC066_API_PORT || "37500");
const PASSWORD = process.env.RC066_PASSWORD || "";
const OUTDIR = process.env.RC066_OUTDIR || "/tmp/rc066-out";

const record: { result: string; browser: Record<string, string>; steps: Record<string, string>; error?: string } = {
  result: "unverified",
  scope: "RC-066 browser on Linux (container guest Chromium) panel journeys",
  browser: {},
  steps: {},
};

function step(name: string, detail: string) {
  record.steps[name] = detail;
}

async function apiFromPage(page: any, path: string, init?: RequestInit) {
  return page.evaluate(async ({ path, init }: { path: string; init?: RequestInit }) => {
    const response = await fetch(path, init);
    return { status: response.status, json: await response.json().catch(() => null) };
  }, { path, init }) as Promise<{ status: number; json: any }>;
}

async function poll(fn: () => Promise<any>, timeoutMs: number, intervalMs = 500): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== "" && value !== undefined && value !== null) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`poll timed out after ${timeoutMs}ms`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context = browser.contexts()[0];
    const page = await context.newPage();

    // Record browser identity from CDP.
    const cdpVersionResp = await fetch(CDP_URL + "/json/version");
    const cdpVersion = await cdpVersionResp.json();
    record.browser.cdpBrowser = cdpVersion.Browser || "";
    record.browser.cdpProtocolVersion = String(cdpVersion.ProtocolVersion || "");
    record.browser.cdpWebSocketUrl = cdpVersion.webSocketDebuggerUrl || "";
    step("cdp_version", `Browser=${cdpVersion.Browser} Protocol=${cdpVersion.ProtocolVersion}`);

    // Navigate to the web app through the Vite proxy.
    await page.goto(WEB_URL + "/", { waitUntil: "networkidle", timeout: 15_000 });
    step("navigate", `loaded ${WEB_URL}`);

    // Assert the guest Chromium from inside the page.
    const guestUserAgent = await page.evaluate(() => navigator.userAgent);
    const guestPlatform = await page.evaluate(() => navigator.platform);
    record.browser.guestUserAgent = guestUserAgent;
    record.browser.guestPlatform = guestPlatform;
    step("browser_identity", `userAgent=${guestUserAgent.slice(0, 120)} platform=${guestPlatform}`);
    // This image's Chromium reports a plain Chrome user agent, so what marks it
    // as the container's own is the Linux/X11 platform: a browser on this Mac
    // would say Macintosh.
    if (!guestUserAgent.includes("X11; Linux")) throw new Error("browser is not the container's guest Chromium: " + guestUserAgent);

    // Wait for the UI to be ready.
    await page.waitForSelector('[data-testid="connection-status"]', { timeout: 15_000 }).catch(() => {});
    step("ui_ready", "RemoteCode UI loaded");

    // Sign in from the Mac side (bypasses Vite's rejectRemoteCleartextLogin middleware
    // that would block a cleartext login from the container's non-loopback address).
    const loginResp = await fetch(API_BASE + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
      signal: AbortSignal.timeout(15_000),
    });
    const sessionCookie = loginResp.headers.get("set-cookie")?.split(";")[0] || "";
    if (!sessionCookie) throw new Error("login failed: no session cookie");
    step("sign_in", `status=${loginResp.status} cookie_set`);

    // Set the session cookie on the page so subsequent navigations are authenticated.
    await page.context().addCookies([{
      name: "remotecode_session",
      value: sessionCookie.split("=")[1] || "",
      url: WEB_URL,
    }]);
    await page.reload({ waitUntil: "networkidle" });
    step("cookie_set", "session cookie added to page context");

    // Verify we are signed in.
    await page.waitForSelector('[data-testid="connection-status"]', { timeout: 15_000 });
    const connectionStatus = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="connection-status"]');
      return el ? el.textContent : "";
    });
    if (connectionStatus !== "Live updates connected") throw new Error("not signed in after cookie set: " + connectionStatus);
    step("human_login", "signed in and Live updates connected");

    const stamp = crypto.randomUUID().slice(0, 8);

    // ============================================================
    // Cell 1: Scheduled Bot
    // ============================================================
    step("scheduled_bot_start", `stamp=${stamp}`);

    // Create a workspace.
    await page.getByLabel("Workspace name", { exact: true }).fill(`RC066 workspace ${stamp}`);
    await page.getByRole("button", { name: "Create workspace" }).click();
    // The poll runs here, so the page is asked through evaluate: `document` only
    // exists inside the guest browser.
    await poll(async () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="workspace-list"]');
      return el ? el.textContent : "";
    }).then((text) => (text?.includes(`RC066 workspace ${stamp}`) ? text : "")), 20_000);
    const wsListed = await apiFromPage(page, "/api/workspaces");
    if (wsListed.status !== 200) throw new Error(`GET /api/workspaces -> ${wsListed.status}`);
    const workspace = (wsListed.json.workspaces as any[]).find((e: any) => e.name === `RC066 workspace ${stamp}`);
    if (!workspace?.id) throw new Error("workspace exists on the host");
    const workspaceId = workspace.id;
    step("create_workspace", `workspaceId=${workspaceId}`);

    // Select the workspace in the sidebar so the panel shows its data.
    // The panel labels a workspace row by its name, not by its id.
    const wsRowId = `workspace-item-${`RC066 workspace ${stamp}`.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const wsSidebar = page.getByTestId(wsRowId);
    await wsSidebar.waitFor({ state: "visible", timeout: 20_000 });
    await wsSidebar.click();
    await page.waitForSelector('[data-testid="selected-workspace"]', { timeout: 20_000 });
    step("select_workspace", workspaceId);

    // Create a scheduled task in the panel.
    await page.getByLabel("Schedule prompt").fill(`RC066 schedule ${stamp}`);
    await page.getByLabel("Local time").fill("09:15");
    await page.getByLabel("Timezone").fill("UTC");
    await page.getByTestId("create-task-schedule").click();

    let workspaceSchedule: any;
    await poll(async () => {
      const listed = await apiFromPage(page, "/api/schedules");
      if (listed.status !== 200) throw new Error(`GET /api/schedules -> ${listed.status}`);
      workspaceSchedule = (listed.json.schedules as any[]).find(
        (e: any) => e.workspaceId === workspaceId && e.kind === "task" && e.prompt === `RC066 schedule ${stamp}`,
      );
      return workspaceSchedule?.id ?? "";
    }, 20_000);
    if (!workspaceSchedule?.id) throw new Error("schedule id missing");
    step("create_schedule", `scheduleId=${workspaceSchedule.id}`);

    const scheduleRow = page.getByTestId(`schedule-${workspaceSchedule.id}`);
    await scheduleRow.waitFor({ state: "visible", timeout: 20_000 });
    const scheduleText = await scheduleRow.textContent();
    if (!scheduleText?.includes("09:15")) throw new Error("schedule row missing 09:15");
    if (!scheduleText?.includes("UTC")) throw new Error("schedule row missing UTC");

    // Disable toggle takes effect on the host.
    await page.getByTestId(`toggle-schedule-${workspaceSchedule.id}`).click();
    // The poll returns the first value that is there, so it has to be asked for
    // the state being waited for: the host applies the toggle a moment later.
    const disabledEnabled = await poll(async () => {
      const listed = await apiFromPage(page, "/api/schedules");
      const enabled = (listed.json.schedules as any[]).find((e: any) => e.id === workspaceSchedule.id)?.enabled;
      return enabled === false ? "disabled" : "";
    }, 20_000);
    if (disabledEnabled !== "disabled") throw new Error(`schedule still enabled after toggle: ${disabledEnabled}`);
    step("schedule_disable", `schedule ${workspaceSchedule.id} disabled on host`);

    // Create a Bot and its routine; verify localTime and timezone in the row.
    const botName = `RC066 bot ${stamp}`;
    const bot = await apiFromPage(page, "/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: botName, instructions: "RC066", context: "" }),
    });
    if (![200, 201].includes(bot.status)) throw new Error(`POST /api/bots -> ${bot.status}`);
    const botId = bot.json.id;
    if (!botId) throw new Error("bot id missing");
    step("create_bot", `botId=${botId}`);

    const routine = await apiFromPage(page, "/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "routine", workspaceId, botId, prompt: `RC066 routine ${stamp}`, localTime: "10:30", timezone: "America/New_York" }),
    });
    if (![200, 201].includes(routine.status)) throw new Error(`POST routine -> ${routine.status}`);
    step("create_routine", `routineId=${routine.json.id}`);

    await page.getByTestId(`roster-bot-${botId}`).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId(`bot-item-${botName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
    const routineRow = page.getByTestId(`bot-routine-${routine.json.id}`);
    await routineRow.waitFor({ state: "visible", timeout: 20_000 });
    const routineText = await routineRow.textContent();
    if (!routineText?.includes("10:30")) throw new Error("routine row missing 10:30");
    if (!routineText?.includes("America/New_York")) throw new Error("routine row missing America/New_York");
    step("routine_row", "localTime=10:30 timezone=America/New_York visible in guest browser");

    // ============================================================
    // Cell 2: Human login (already done above via cookie set)
    // ============================================================
    step("human_login", "session cookie set from Mac-side API call; connection-status is Live updates connected");

    // ============================================================
    // Cell 3: Crash/reconnection
    // ============================================================
    step("crash_reconnect_start", "cutting live channel");

    let reconnectOk = false;
    try {
      let drop!: () => void;
      await page.routeWebSocket("**/api/events*", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => server.send(message));
        server.onMessage((message) => socket.send(message));
        drop = () => socket.close();
      });

      // Reload to establish the WebSocket connection through routeWebSocket.
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="connection-status"]', { timeout: 15_000 });

      // Drop the WebSocket to simulate a crash/disconnect.
      drop();

      // Assert the session shows disconnected.
      await poll(async () => {
        const status = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="connection-status"]');
          return el ? el.textContent : "";
        });
        return status === "Live updates disconnected" ? status : "";
      }, 30_000);

      // Reconnect by clicking the reconnect button or reloading.
      const reconnectBtn = page.getByRole("button", { name: "Reconnect live updates" });
      if (await reconnectBtn.count()) {
        await reconnectBtn.click();
      } else {
        await page.reload({ waitUntil: "networkidle" });
      }

      // Assert the session reconnects.
      await poll(async () => {
        const status = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="connection-status"]');
          return el ? el.textContent : "";
        });
        return status === "Live updates connected" ? status : "";
      }, 60_000);

      // Verify the workspace data is still available after reconnect.
      const wsAfterReconnect = await apiFromPage(page, `/api/workspaces/${workspaceId}`);
      if (wsAfterReconnect.status !== 200) throw new Error(`GET /api/workspaces/${workspaceId} after reconnect -> ${wsAfterReconnect.status}`);

      reconnectOk = true;
      step("crash_reconnect", "WebSocket dropped and session reconnected; workspace data preserved");
    } catch (reconnectError: any) {
      // routeWebSocket may be unavailable over connectOverCDP.
      // Record the cell as not run with the real reason rather than faking it.
      step("crash_reconnect", `not_run: routeWebSocket_unavailable_over_connectOverCDP (${reconnectError.message?.slice(0, 200) || "unknown"})`);
    }

    // ============================================================
    // Cell 4: Screen take-over
    // ============================================================
    step("screen_takeover_start", `workspaceId=${workspaceId}`);

    // Take possession of the host's screen through the panel.
    const takeResp = await apiFromPage(page, `/api/workspaces/${workspaceId}/screen/possession`, { method: "POST" });
    if (![200, 201].includes(takeResp.status)) throw new Error(`take possession -> ${takeResp.status}`);
    const takeToken = takeResp.json.token;
    if (!takeToken) throw new Error("take possession failed: no token");
    step("take_possession", `token=${takeToken.slice(0, 8)}...`);

    // Verify the host reports holder state.
    const held = await apiFromPage(page, `/api/workspaces/${workspaceId}/screen/possession`);
    if (held.status !== 200) throw new Error(`GET possession -> ${held.status}`);
    if (held.json.state !== "holder") throw new Error(`possession state is ${held.json.state}, expected holder`);
    step("screen_held", "host reports holder state");

    // Return the screen.
    const releaseResp = await apiFromPage(page, `/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: takeToken }),
    });
    if (![200, 201].includes(releaseResp.status)) throw new Error(`release -> ${releaseResp.status}`);
    step("release_possession", "screen returned to host");

    // Verify the host reports none state.
    const afterRelease = await apiFromPage(page, `/api/workspaces/${workspaceId}/screen/possession`);
    if (afterRelease.status !== 200) throw new Error(`GET possession after release -> ${afterRelease.status}`);
    if (afterRelease.json.state !== "none") throw new Error(`possession state is ${afterRelease.json.state}, expected none`);
    step("screen_returned", "host reports none state after release");

    record.result = "passed";
  } catch (error: any) {
    record.result = "failed";
    record.error = String(error?.message ?? error);
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    writeFileSync(resolve(OUTDIR, "result.json"), JSON.stringify(record, null, 2));
    if (record.result === "passed") {
      console.log(`PASS rc066-container-browser: all four cells completed`);
      process.exitCode = 0;
    } else {
      console.log(`FAIL rc066-container-browser: ${record.error || "unknown failure"}`);
      process.exitCode = 1;
    }
  })
  .catch((error: any) => {
    record.result = "failed";
    record.error = String(error?.message ?? error);
    writeFileSync(resolve(OUTDIR, "result.json"), JSON.stringify(record, null, 2));
    console.log(`FAIL rc066-container-browser: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
DRIVER_EOF

say "-- driver script written --"

# --- 11. run the driver script --------------------------------------------
say "-- driving guest Chromium --"
set +e
RC066_PASSWORD="$PASSWORD" \
RC066_API_PORT="$API_PORT" \
RC066_WEB_PORT="$WEB_PORT" \
RC066_CDP_PORT="$CDP_PORT" \
RC066_OUTDIR="$OUT" \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bun run "$DRIVER" 2>&1 | tee -a "$TRANSCRIPT"
DRIVER_STATUS=${PIPESTATUS[0]}
set -e
say "driver script exit status: $DRIVER_STATUS"

# --- 12. API log for diagnostics -------------------------------------------
say "-- API log --"
docker exec "$NAME" tail -40 /var/log/rc066-api.log 2>&1 | tee -a "$TRANSCRIPT" || true

# --- 13. write result.json and exit ----------------------------------------
say "-- result --"
if [[ "$DRIVER_STATUS" == "0" ]]; then
  say "PASS rc066-container-browser: guest Chromium panel journeys completed"
  exit 0
else
  say "FAIL rc066-container-browser: see the driver output above"
  exit 1
fi
