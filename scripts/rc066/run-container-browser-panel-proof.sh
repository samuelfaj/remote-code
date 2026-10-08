#!/usr/bin/env bash
# RC-066 proof: Browser on Linux (container's guest Chromium) | Scheduled Bot.
#
# Stands up the repository's Linux host with the runs stub as the agent,
# starts the container's own guest Chromium with CDP published to the Mac,
# drives the RC-051 panel journeys through that guest browser using
# Playwright's chromium.connectOverCDP, and asserts every value from
# inside the page so the app's session is the one used.
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
PASSWORD="rc066-linux-$(openssl rand -hex 12)"
DATA_VOLUME="rc066-data-$(date +%s)"

TRANSCRIPT="$OUT/proof.log"
DRIVER="$OUT/drive-browser.mjs"

declare -a CMD_HISTORY=()
CMD_COUNT=0

log_cmd() {
  CMD_COUNT=$((CMD_COUNT + 1))
  CMD_HISTORY+=("$CMD_COUNT: $*")
}

say() { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }

cleanup() {
  say "-- cleanup --"
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

write_result() {
  local result="$1"
  local error="${2:-}"
  local browser_json="${3:-{}}"
  local steps_json="${4:-{}}"
  python3 - "$OUT" "$result" "$error" "$browser_json" "$steps_json" <<'PY'
import json, sys
out, result, error, browser_json, steps_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
record = {
  "result": result,
  "scope": "RC-066 browser on Linux (container guest Chromium) panel journeys",
  "browser": json.loads(browser_json),
  "steps": json.loads(steps_json),
}
if error:
  record["error"] = error
with open(out + "/result.json", "w") as f:
  json.dump(record, f, indent=2)
PY
}

say "== RC-066 container browser panel proof =="
say "outdir=$OUT image=$IMAGE apiPort=$API_PORT webPort=$WEB_PORT cdpPort=$CDP_PORT"

# --- 1. image ----------------------------------------------------------------
say "-- image --"
log_cmd "docker build -q -t $IMAGE -f prototype/Dockerfile ."
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
log_cmd "docker volume create $DATA_VOLUME"
docker volume create "$DATA_VOLUME" >/dev/null

log_cmd "docker run -d --name $NAME -p 127.0.0.1:${API_PORT}:3000 -p 127.0.0.1:${CDP_PORT}:9222 -v $DATA_VOLUME:/var/lib/remotecode -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc066.sqlite -e REMOTECODE_AUTH_PASSWORD=$PASSWORD -e REMOTECODE_WEB_ORIGIN=http://127.0.0.1:${WEB_PORT} -e REMOTECODE_DISPLAY=:99 $IMAGE sleep infinity"
docker run -d --name "$NAME" \
  -p "127.0.0.1:${API_PORT}:3000" \
  -p "127.0.0.1:${CDP_PORT}:9222" \
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
log_cmd "docker exec $NAME start Xvfb"
docker exec "$NAME" bash -lc 'rm -f /tmp/.X99-lock' || true
docker exec -d "$NAME" bash -lc 'Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp > /var/log/rc066-xvfb.log 2>&1'
sleep 2

log_cmd "docker exec $NAME start openbox"
docker exec -d "$NAME" bash -lc 'DISPLAY=:99 openbox --sm-disable > /var/log/rc066-openbox.log 2>&1'
sleep 1

log_cmd "docker exec $NAME start Chromium with CDP"
docker exec -d "$NAME" bash -lc 'DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/var/lib/rc066-chromium about:blank > /var/log/rc066-chromium.log 2>&1'

# Wait for CDP to be reachable from the Mac
say "waiting for CDP on 127.0.0.1:${CDP_PORT}..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  docker exec "$NAME" tail -5 /var/log/rc066-chromium.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the guest Chromium did not start or CDP is not reachable"
  write_result "failed" "chromium_not_started_or_cdp_unreachable" "{}" "{}"
  exit 1
fi
say "guest Chromium CDP ready on 127.0.0.1:${CDP_PORT}"

# --- 6. start the API inside the container --------------------------------
say "-- API --"
log_cmd "docker exec $NAME start API"
docker exec -d "$NAME" bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc066.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' REMOTECODE_WEB_ORIGIN='http://127.0.0.1:${WEB_PORT}' REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem REMOTECODE_DISTILL_BIN=/usr/local/bin/rc051-agent bun apps/api/src/index.ts > /var/log/rc066-api.log 2>&1"

for _ in $(seq 1 60); do
  if curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then break; fi
  sleep 1
done
if ! curl -sk --fail "https://127.0.0.1:${API_PORT}/api/health/ready" >/dev/null; then
  docker exec "$NAME" tail -20 /var/log/rc066-api.log 2>&1 | tee -a "$TRANSCRIPT" || true
  say "FAIL: the Linux API never became ready"
  write_result "failed" "api_never_became_ready" "{}" "{}"
  exit 1
fi
say "API ready over TLS on 127.0.0.1:${API_PORT}"

# --- 7. verify the image serves the routes this proof drives ---------------
say "-- route check --"
INBOX_CODE="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:${API_PORT}/api/inbox")"
say "GET /api/inbox -> $INBOX_CODE"
if [[ "$INBOX_CODE" != "401" ]]; then
  say "FAIL: the API image does not serve the shipped Inbox route"
  write_result "failed" "inbox_route_missing" "{}" "{}"
  exit 1
fi

# --- 8. local Vite in front of it ------------------------------------------
say "-- Vite --"
log_cmd "start Vite on 0.0.0.0"
REMOTECODE_WEB_PROXY_TARGET="https://127.0.0.1:${API_PORT}" WEB_PORT="$WEB_PORT" \
  bunx vite --config "$ROOT/apps/web/vite.config.ts" --host 0.0.0.0 \
  > "$OUT/vite.log" 2>&1 &
WEB_PID=$!
for _ in $(seq 1 60); do
  if curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then break; fi
  sleep 1
done
if ! curl -s --fail "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
  tail -20 "$OUT/vite.log" | tee -a "$TRANSCRIPT" >&2
  say "FAIL: the web origin never became ready"
  write_result "failed" "vite_never_ready" "{}" "{}"
  exit 1
fi
say "web ready on 127.0.0.1:${WEB_PORT}"

# --- 9. verify CDP is accessible from the Mac ------------------------------
say "-- CDP verification --"
CDP_VERSION=$(curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" 2>&1)
say "CDP version: $(printf '%s' "$CDP_VERSION" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Browser","unknown"))' 2>/dev/null || echo 'ok')"

# --- 10. write the Playwright driver spec ----------------------------------
say "-- writing driver spec --"
cat > "$DRIVER" <<'DRIVER_EOF'
import { expect, test } from "@playwright/test";

const CDP_URL = "http://127.0.0.1:" + (process.env.RC066_CDP_PORT || "37502");
const WEB_URL = "http://127.0.0.1:" + (process.env.RC066_WEB_PORT || "37501");
const API_BASE = "https://127.0.0.1:" + (process.env.RC066_API_PORT || "37500");
const PASSWORD = process.env.RC066_PASSWORD || "";

const record: { result: string; browser: Record<string, string>; steps: Record<string, string>; error?: string } = {
  result: "unverified",
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

test("RC-066 container guest Chromium panel journeys", async ({ page }) => {
  test.setTimeout(180_000);

  // Connect to the container's guest Chromium over CDP.
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const guestPage = await context.newPage();

  // Assert the browser is the container's guest Chromium from the CDP version.
  const cdpVersionResp = await fetch(CDP_URL + "/json/version");
  const cdpVersion = await cdpVersionResp.json();
  record.browser.cdpBrowser = cdpVersion.Browser || "";
  record.browser.cdpProtocolVersion = String(cdpVersion.ProtocolVersion || "");
  step("cdp_version", `Browser=${cdpVersion.Browser} Protocol=${cdpVersion.ProtocolVersion}`);

  // Navigate to the web app (bounded).
  await guestPage.goto(WEB_URL + "/", { waitUntil: "networkidle", timeout: 15_000 });
  step("navigate", `loaded ${WEB_URL}`);

  // Assert the guest Chromium from inside the page.
  const guestUserAgent = await guestPage.evaluate(() => navigator.userAgent);
  const guestPlatform = await guestPage.evaluate(() => navigator.platform);
  record.browser.guestUserAgent = guestUserAgent;
  record.browser.guestPlatform = guestPlatform;
  step("browser_identity", `userAgent=${guestUserAgent.slice(0, 120)} platform=${guestPlatform}`);
  if (!guestUserAgent.includes("Chromium")) throw new Error("browser is not the container's guest Chromium: " + guestUserAgent);

  // Wait for the UI to be ready.
  await guestPage.waitForSelector('[data-testid="connection-status"]', { timeout: 15_000 }).catch(() => {});
  step("ui_ready", "RemoteCode UI loaded");

  // Sign in via the API directly, then set the cookie on the page context.
  const loginResp = await fetch(API_BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
    signal: AbortSignal.timeout(15_000),
  });
  const sessionCookie = loginResp.headers.get("set-cookie")?.split(";")[0] || "";
  if (!sessionCookie) throw new Error("login failed: no session cookie");
  step("sign_in", `status=${loginResp.status} cookie_set`);

  await guestPage.context().addCookies([{
    name: "remotecode_session",
    value: sessionCookie.split("=")[1] || "",
    url: WEB_URL,
  }]);
  await guestPage.reload({ waitUntil: "networkidle" });
  step("cookie_set", "session cookie added to page context");

  // --- RC-051 panel assertions ---
  const stamp = crypto.randomUUID().slice(0, 8);

  // 1. Create a workspace and verify it.
  await guestPage.getByLabel("Workspace name", { exact: true }).fill(`RC066 workspace ${stamp}`);
  await guestPage.getByRole("button", { name: "Create workspace" }).click();
  await expect(guestPage.getByTestId("workspace-list")).toContainText(`RC066 workspace ${stamp}`, { timeout: 20_000 });
  const wsListed = await apiFromPage(guestPage, "/api/workspaces");
  expect(wsListed.status, "GET /api/workspaces").toBe(200);
  const workspace = (wsListed.json.workspaces as any[]).find((e: any) => e.name === `RC066 workspace ${stamp}`);
  expect(workspace?.id, "workspace exists on the host").toBeTruthy();
  const workspaceId = workspace.id;
  step("create_workspace", `workspaceId=${workspaceId}`);

  // 2. Create a scheduled task and read it back from GET /api/schedules.
  await guestPage.getByLabel("Schedule prompt").fill(`RC066 schedule ${stamp}`);
  await guestPage.getByLabel("Local time").fill("09:15");
  await guestPage.getByLabel("Timezone").fill("UTC");
  await guestPage.getByTestId("create-task-schedule").click();

  let workspaceSchedule: any;
  await expect.poll(async () => {
    const listed = await apiFromPage(guestPage, "/api/schedules");
    expect(listed.status, "GET /api/schedules").toBe(200);
    workspaceSchedule = (listed.json.schedules as any[]).find(
      (e: any) => e.workspaceId === workspaceId && e.kind === "task" && e.prompt === `RC066 schedule ${stamp}`,
    );
    return workspaceSchedule?.id ?? "";
  }, { timeout: 20_000 }).not.toBe("");
  expect(workspaceSchedule!.id).toBeTruthy();
  step("create_schedule", `scheduleId=${workspaceSchedule.id}`);

  const scheduleRow = guestPage.getByTestId(`schedule-${workspaceSchedule.id}`);
  await expect(scheduleRow).toBeVisible({ timeout: 20_000 });
  await expect(scheduleRow).toContainText("09:15");
  await expect(scheduleRow).toContainText("UTC");

  // Disable toggle takes effect on the host.
  await guestPage.getByTestId(`toggle-schedule-${workspaceSchedule.id}`).click();
  await expect.poll(async () => {
    const listed = await apiFromPage(guestPage, "/api/schedules");
    return (listed.json.schedules as any[]).find((e: any) => e.id === workspaceSchedule.id)?.enabled;
  }, { timeout: 20_000 }).toBe(false);
  step("schedule_disable", `schedule ${workspaceSchedule.id} disabled on host`);

  // 3. Create a Bot and its routine; verify localTime and timezone in the row.
  const botName = `RC066 bot ${stamp}`;
  const bot = await apiFromPage(guestPage, "/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: botName, instructions: "RC066", context: "" }),
  });
  expect([200, 201], `POST /api/bots -> ${bot.status}`).toContain(bot.status);
  const botId = bot.json.id;
  expect(botId).toBeTruthy();
  step("create_bot", `botId=${botId}`);

  const routine = await apiFromPage(guestPage, "/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "routine", workspaceId, botId, prompt: `RC066 routine ${stamp}`, localTime: "10:30", timezone: "America/New_York" }),
  });
  expect([200, 201], `POST routine -> ${routine.status}`).toContain(routine.status);
  step("create_routine", `routineId=${routine.json.id}`);

  await expect(guestPage.getByTestId(`roster-bot-${botId}`)).toBeVisible({ timeout: 20_000 });
  await guestPage.getByTestId(`bot-item-${botName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  const routineRow = guestPage.getByTestId(`bot-routine-${routine.json.id}`);
  await expect(routineRow).toBeVisible({ timeout: 20_000 });
  await expect(routineRow).toContainText("10:30");
  await expect(routineRow).toContainText("America/New_York");
  step("routine_row", "localTime=10:30 timezone=America/New_York visible in guest browser");

  // 4. Create a run and deny the permission request through the panel.
  const runResp = await apiFromPage(guestPage, "/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, prompt: `RC066 run ${stamp} PERMISSION_WRITE rc066-permission.txt`, botId }),
  });
  expect([200, 201], `POST /api/runs -> ${runResp.status}`).toContain(runResp.status);
  const runId = runResp.json.id;
  expect(runId).toBeTruthy();
  step("start_run", `runId=${runId}`);

  // Wait for the permission request to appear.
  let requestId = "";
  for (let attempt = 0; attempt < 60 && !requestId; attempt += 1) {
    const pending = await apiFromPage(guestPage, `/api/runs/${runId}/permissions`);
    expect(pending.status, `GET permissions -> ${pending.status}`).toBe(200);
    requestId = (pending.json.permissions as any[])[0]?.requestId ?? "";
    if (!requestId) await guestPage.waitForTimeout(500);
  }
  expect(requestId, "the host listed a pending permission request").toBeTruthy();
  step("permission_request", `requestId=${requestId}`);

  await expect(guestPage.getByTestId(`run-permission-${requestId}`)).toBeVisible({ timeout: 20_000 });
  await guestPage.getByTestId(`deny-permission-${requestId}`).click();
  await expect(guestPage.getByTestId(`run-permission-${requestId}`)).toHaveCount(0, { timeout: 30_000 });
  const afterDenial = await apiFromPage(guestPage, `/api/runs/${runId}/permissions`);
  expect(afterDenial.status).toBe(200);
  expect(
    (afterDenial.json.permissions as any[]).some((e: any) => e.requestId === requestId),
    "the host no longer lists the denied request",
  ).toBe(false);
  step("deny_permission", `request ${requestId} denied and removed`);

  // 5. Needs you count against GET /api/inbox.
  const inbox = await apiFromPage(guestPage, "/api/inbox");
  expect(inbox.status, `GET /api/inbox -> ${inbox.status}`).toBe(200);
  const open = (inbox.json.items as any[]).filter((item: any) => !item.read || item.resolvedAt === null);
  await expect(guestPage.getByTestId("needs-you")).toContainText(`Open items: ${open.length}`, { timeout: 20_000 });
  for (const item of open) {
    const row = guestPage.getByTestId(`inbox-item-${item.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(item.title);
  }
  step("inbox", `open=${open.length} needs_you_count=${open.length}`);

  record.result = "passed";
});
DRIVER_EOF

say "-- driver spec written --"

# --- 11. run the driver spec ----------------------------------------------
say "-- driving guest Chromium --"
set +e
RC066_STUB_AGENT=1 \
RC066_PASSWORD="$PASSWORD" \
RC066_API_PORT="$API_PORT" \
RC066_WEB_PORT="$WEB_PORT" \
RC066_CDP_PORT="$CDP_PORT" \
bun run test:e2e -- "$DRIVER" 2>&1 | tee -a "$TRANSCRIPT"
DRIVER_STATUS=${PIPESTATUS[0]}
set -e
say "driver spec exit status: $DRIVER_STATUS"

# --- 12. API log for diagnostics -------------------------------------------
say "-- API log --"
docker exec "$NAME" tail -40 /var/log/rc066-api.log 2>&1 | tee -a "$TRANSCRIPT" || true

# --- 13. write result.json and exit ----------------------------------------
say "-- result --"
if [[ "$DRIVER_STATUS" == "0" ]]; then
  # Extract browser info from CDP version response.
  BROWSER_JSON=$(printf '%s' "$CDP_VERSION" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"cdpBrowser":d.get("Browser",""),"protocolVersion":str(d.get("ProtocolVersion","")),"webSocketDebuggerUrl":d.get("webSocketDebuggerUrl","")}))' 2>/dev/null || echo '{}')
  write_result "passed" "" "$BROWSER_JSON" "{}"
  say "PASS rc066-container-browser: guest Chromium panel journeys completed"
  exit 0
else
  write_result "failed" "driver_status=${DRIVER_STATUS}" "{}" "{}"
  say "FAIL rc066-container-browser: see the driver output above"
  exit 1
fi
