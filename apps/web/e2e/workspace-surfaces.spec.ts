import { expect, test, type Page } from "@playwright/test";

const apiUrl = process.env.RC003_API_URL ?? "http://127.0.0.1:37117";
const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

const safe = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "-");

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
}

async function createWorkspace(page: Page, name: string) {
  // The sidebar action is the shipped way to reach the create surface.
  await page.getByRole("button", { name: "New Workspace", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(name);
}

async function openWorkspace(page: Page, name: string) {
  await page.getByTestId(`workspace-item-${safe(name)}`).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(name);
}

// Both clients read the same host state; a second client is how the product is
// really used, so it is the honest way to prove the event stream.
async function secondClient(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await signIn(page);
  return { context, page };
}

test("a workspace owns its surface tabs, and each workspace keeps its own set", async ({ page }) => {
  await signIn(page);

  const nameA = `RC tabs A ${crypto.randomUUID()}`;
  const nameB = `RC tabs B ${crypto.randomUUID()}`;

  // Nothing selected: the create form is the empty state, and no surface tab is shown.
  await expect(page.getByLabel("Workspace name", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);

  await createWorkspace(page, nameA);
  await openWorkspace(page, nameA);

  // The tabs belong to the workspace and are its default surfaces.
  await expect(page.getByRole("tab", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Agent", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("selected-workspace")).toContainText(nameA);

  // Opening a surface adds it to this workspace's tab set and shows its content.
  await page.getByRole("button", { name: "Open a surface" }).click();
  await page.getByRole("menuitemradio", { name: "Open Files" }).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  await expect(page.getByTestId("folder-status")).toBeVisible();

  // A second workspace has its own set: it never inherits the first one's tabs.
  await createWorkspace(page, nameB);
  await openWorkspace(page, nameB);
  await expect(page.getByRole("tab", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);

  // Back to the first: its own tab set (with Files) is restored.
  await openWorkspace(page, nameA);
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
});

test("clicking a bot opens that bot's chat in one step and the composer starts a real run", async ({ page }) => {
  await signIn(page);

  const workspace = `RC chat ${crypto.randomUUID()}`;
  const bot = `RC chat bot ${crypto.randomUUID()}`;
  const prompt = `hello from the composer ${crypto.randomUUID()}`;

  await createWorkspace(page, workspace);
  await openWorkspace(page, workspace);

  // A bot is created through the shipped sidebar form.
  await page.getByLabel("New bot name").fill(bot);
  await page.getByTestId("new-bot").click();
  await expect(page.getByTestId("bot-list")).toContainText(bot);

  // One click on the bot: its chat is the visible surface, named for that bot.
  await page.getByTestId(`bot-item-${safe(bot)}`).click();
  await expect(page.getByRole("tab", { name: "Agent", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await expect(page.getByTestId("chat-target")).toContainText(bot);

  const workspaceId = await page.evaluate(async (name: string) => {
    const response = await fetch("/api/workspaces");
    const body = await response.json() as { workspaces: Array<{ id: string; name: string }> };
    return body.workspaces.find((row) => row.name === name)?.id ?? "";
  }, workspace);
  expect(workspaceId).toBeTruthy();

  // The send is held for a moment so the pending state is observable, then it
  // goes to the real route: the run is the bot's run, on the bot's route.
  let postedTo = "";
  await page.route("**/api/bots/*/run", async (route) => {
    postedTo = route.request().url();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });

  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("pending-prompt")).toContainText(prompt);
  await expect(page.getByTestId("pending-prompt")).toContainText("Sending");

  const runResponse = await page.waitForResponse((response) => response.url().includes("/run") && response.request().method() === "POST");
  expect(postedTo).toContain(`/api/bots/`);
  expect([200, 201]).toContain(runResponse.status());
  const run = await runResponse.json() as { id: string; state: string; workspaceId: string };
  expect(run.workspaceId).toBe(workspaceId);

  // The pending row clears once the host has confirmed the run.
  await expect(page.getByTestId("pending-prompt")).toHaveCount(0);

  // The authoritative read contains the run.
  const listed = await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/runs`);
  expect(listed.ok()).toBe(true);
  const runs = (await listed.json() as { runs: Array<{ id: string; prompt: string }> }).runs;
  expect(runs.map((row) => row.id)).toContain(run.id);

  // The host cannot start an agent in this environment (see playwright.config.ts),
  // so its rejection must reach the UI through the event stream, not a reload.
  await expect(page.getByTestId(`run-state-${run.id}`)).toHaveText("failed", { timeout: 30_000 });
  await expect(page.getByTestId(`run-${run.id}`)).toContainText("spawn_failed");
});

test("a rejected send surfaces a failure with retry instead of a fake success", async ({ page }) => {
  await signIn(page);

  const workspace = `RC reject ${crypto.randomUUID()}`;
  await createWorkspace(page, workspace);
  await openWorkspace(page, workspace);
  await page.getByRole("tab", { name: "Agent", exact: true }).click();

  // The host's own rejection shape for an unknown workspace.
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "workspace_not_found" }) });
  });

  await page.getByLabel("Prompt", { exact: true }).fill("this send must fail");
  await page.getByTestId("send-prompt").click();

  await expect(page.getByTestId("pending-prompt-failed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry prompt" })).toBeVisible();
  await page.getByRole("button", { name: "Discard prompt" }).click();
  await expect(page.getByTestId("pending-prompt-failed")).toHaveCount(0);
  // No run was ever invented.
  await expect(page.getByTestId("run-error")).toHaveCount(0);
});

test("another client's work appears live, and an idle client issues no polls", async ({ page, browser }) => {
  await signIn(page);
  const workspace = `RC live ${crypto.randomUUID()}`;
  const bot = `RC live bot ${crypto.randomUUID()}`;
  await createWorkspace(page, workspace);
  await openWorkspace(page, workspace);
  await page.getByRole("tab", { name: "Agent", exact: true }).click();

  const other = await secondClient(browser);
  try {
    await other.page.getByTestId(`workspace-item-${safe(workspace)}`).click();
    await expect(other.page.getByTestId("selected-workspace")).toContainText(workspace);

    // Count what the idle first client asks the host for.
    const reads: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/")) reads.push(request.url());
    });
    reads.length = 0;
    await page.waitForTimeout(3_000);
    expect(reads, `idle client polled ${reads.join(", ")}`).toHaveLength(0);

    // The second client creates a bot through the shipped form.
    await other.page.getByLabel("New bot name").fill(bot);
    await other.page.getByTestId("new-bot").click();
    await expect(other.page.getByTestId("bot-list")).toContainText(bot);

    // The first client learns about it from the event stream alone.
    await expect(page.getByTestId("bot-list")).toContainText(bot, { timeout: 10_000 });

    // And a scheduled task created in the second client appears in the first.
    const schedulePrompt = `RC live schedule ${crypto.randomUUID()}`;
    await other.page.getByRole("tab", { name: "Agent", exact: true }).click();
    await other.page.getByLabel("Schedule prompt").fill(schedulePrompt);
    await other.page.getByRole("button", { name: "Create task schedule" }).click();
    await expect(page.locator("[data-testid^='schedule-']", { hasText: schedulePrompt })).toBeVisible({ timeout: 10_000 });

    // A run started in the second client reaches the first client's Inbox and
    // run list through the stream: this host cannot start an agent, so the run
    // is recorded as an intervention instead of a success.
    const openBefore = Number((await page.getByTestId("needs-you").textContent())?.match(/(\d+)/)?.[1] ?? "0");
    await other.page.getByLabel("Prompt", { exact: true }).fill(`RC live run ${crypto.randomUUID()}`);
    await other.page.getByTestId("send-prompt").click();
    await expect.poll(async () => {
      const text = await page.getByTestId("needs-you").textContent();
      return Number(text?.match(/(\d+)/)?.[1] ?? "0");
    }, { timeout: 20_000, message: "the first client never saw the second client's run in its Inbox" }).toBeGreaterThan(openBefore);
    await expect(page.getByTestId("run-error")).toHaveCount(0);
  } finally {
    await other.context.close();
  }
});

test("cutting and restoring the event channel resyncs from the snapshot without duplicates", async ({ page, browser }) => {
  // The channel is cut the way the other specs cut it: from the client side,
  // because a network emulation toggle does not close an established socket.
  const channel = { drop: null as null | (() => void) };
  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    channel.drop = () => socket.close();
  });

  await signIn(page);
  const workspace = `RC resync ${crypto.randomUUID()}`;
  const before = `RC resync before ${crypto.randomUUID()}`;
  const after = `RC resync after ${crypto.randomUUID()}`;
  await createWorkspace(page, workspace);
  await openWorkspace(page, workspace);

  const other = await secondClient(browser);
  try {
    await other.page.getByTestId(`workspace-item-${safe(workspace)}`).click();
    await other.page.getByLabel("New bot name").fill(before);
    await other.page.getByTestId("new-bot").click();
    await expect(page.getByTestId("bot-list")).toContainText(before, { timeout: 10_000 });

    // Cut the first client's channel, then let the second client work.
    channel.drop?.();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates disconnected", { timeout: 20_000 });

    await other.page.getByLabel("New bot name").fill(after);
    await other.page.getByTestId("new-bot").click();
    await expect(other.page.getByTestId("bot-list")).toContainText(after);

    // Restore: the snapshot resync must bring the client current, once.
    await page.getByRole("button", { name: "Reconnect live updates" }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 20_000 });
    await expect(page.getByTestId("bot-list")).toContainText(after, { timeout: 10_000 });
    await expect(page.getByTestId(`bot-item-${safe(after)}`)).toHaveCount(1);
    await expect(page.getByTestId(`bot-item-${safe(before)}`)).toHaveCount(1);
  } finally {
    await other.context.close();
  }
});
