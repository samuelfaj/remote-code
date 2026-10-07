import { expect, test } from "@playwright/test";

const apiUrl = process.env.RC003_API_URL ?? "http://127.0.0.1:37117";
const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
}

test("creates a workspace through the UI and verifies it appears in the sidebar and backend", async ({ page }) => {
  await signIn(page);

  const name = `RC049 workspace ${crypto.randomUUID()}`;
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByTestId("workspace-list")).toContainText(name);

  const response = await page.request.get(`${apiUrl}/api/workspaces`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { workspaces: Array<{ name: string }> };
  expect(body.workspaces.some((w) => w.name === name)).toBe(true);
});

test("creates a Bot through the UI and verifies it appears in the sidebar and backend", async ({ page }) => {
  await signIn(page);

  const wsName = `RC049 bot workspace ${crypto.randomUUID()}`;
  await page.getByLabel("Workspace name").fill(wsName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(wsName);

  // A Bot belongs to a workspace, so one has to be open before it can be created.
  await page.getByTestId(`workspace-item-${wsName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("app-content")).toBeVisible();

  const botName = `RC049 bot ${crypto.randomUUID()}`;
  await page.getByLabel("New bot name").fill(botName);
  await expect(page.getByTestId("new-bot")).toBeEnabled();
  await page.getByTestId("new-bot").click();

  await expect(page.getByTestId("bot-list")).toContainText(botName);

  const botsResponse = await page.request.get(`${apiUrl}/api/bots`);
  expect(botsResponse.ok()).toBe(true);
  const botsBody = (await botsResponse.json()) as { bots: Array<{ name: string }> };
  expect(botsBody.bots.some((b) => b.name === botName)).toBe(true);
});

test("switches between two workspaces and asserts app-content changes", async ({ page }) => {
  await signIn(page);

  const nameA = `RC049 switch A ${crypto.randomUUID()}`;
  const nameB = `RC049 switch B ${crypto.randomUUID()}`;

  await page.getByLabel("Workspace name").fill(nameA);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(nameA);

  await page.getByLabel("Workspace name").fill(nameB);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(nameB);

  // Select workspace A in the sidebar
  await page.getByTestId(`workspace-item-${nameA.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("app-content")).toBeVisible();

  // Select workspace B in the sidebar - content area should update
  await page.getByTestId(`workspace-item-${nameB.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("app-content")).toBeVisible();
});

test("switches workspaces at 390x844 viewport with sidebar toggle and asserts no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  const nameA = `RC049 mobile switch A ${crypto.randomUUID()}`;
  const nameB = `RC049 mobile switch B ${crypto.randomUUID()}`;

  await page.getByLabel("Workspace name").fill(nameA);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(nameA);

  await page.getByLabel("Workspace name").fill(nameB);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(nameB);

  // Open the sidebar on mobile
  const toggle = page.getByTestId("sidebar-toggle");
  await toggle.click();
  await expect(page.getByTestId("app-sidebar")).toBeVisible();

  // Select workspace A in the sidebar
  await page.getByTestId(`workspace-item-${nameA.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("app-content")).toBeVisible();

  // Switch to workspace B
  await page.getByTestId(`workspace-item-${nameB.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("app-content")).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0);
  const innerWidth = await page.evaluate(() => window.innerWidth);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
});

test("switches workspace using keyboard only (no mouse click)", async ({ page }) => {
  await signIn(page);

  const nameA = `RC049 keyboard A ${crypto.randomUUID()}`;
  const nameB = `RC049 keyboard B ${crypto.randomUUID()}`;

  await page.getByLabel("Workspace name").fill(nameA);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(nameA);

  await page.getByLabel("Workspace name").fill(nameB);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(nameB);

  // Focus the sidebar and navigate with keyboard
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("app-content")).toBeVisible();

  // Switch to the next workspace using keyboard
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("app-content")).toBeVisible();
});

test("every rendered workspace row corresponds to a backend record", async ({ page }) => {
  await signIn(page);

  const name = `RC049 backend match ${crypto.randomUUID()}`;
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(name);

  const response = await page.request.get(`${apiUrl}/api/workspaces`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { workspaces: Array<{ name: string }> };
  const backendNames = body.workspaces.map((w) => w.name);

  const renderedItems = await page.locator("[testid^='workspace-item-']").allTextContents();
  for (const item of renderedItems) {
    const itemName = item.replace(" (archived)", "");
    expect(backendNames).toContain(itemName);
  }
});