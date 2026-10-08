import { expect, test } from "@playwright/test";

const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
}

async function api(page: import("@playwright/test").Page, path: string, init?: RequestInit) {
  // Read from inside the page, so the session and possession cookie the app
  // holds are the ones used.
  return page.evaluate(async ({ path, init }: { path: string; init?: RequestInit }) => {
    const response = await fetch(path, init);
    return { status: response.status, json: await response.json().catch(() => null) };
  }, { path, init }) as Promise<{ status: number; json: any }>;
}

async function createWorkspace(page: import("@playwright/test").Page, name: string) {
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(name);
  const listed = await api(page, "/api/workspaces");
  expect(listed.status, `GET /api/workspaces -> ${listed.status}`).toBe(200);
  const workspace = listed.json.workspaces.find((entry: any) => entry.name === name);
  expect(workspace?.id, `workspace ${name} exists on the host`).toBeTruthy();
  await page.getByTestId(`workspace-item-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("app-content")).toBeVisible();
  return workspace.id as string;
}

async function createBot(page: import("@playwright/test").Page, workspaceId: string, name: string) {
  const created = await api(page, "/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, instructions: "RC052", context: "" }),
  });
  expect([200, 201], `POST /api/bots -> ${created.status}`).toContain(created.status);
  const botId = created.json.id as string;
  expect(botId).toBeTruthy();
  await page.getByTestId(`bot-item-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  return botId;
}

// Possession is shown on the computer surface. A workspace starts with the
// workspace, agent and terminal surfaces, so the computer surface is opened
// from the pane's own "+" menu, one step, like the macOS pane.
async function showComputer(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Open a surface" }).click();
  await page.getByRole("menuitemradio", { name: "Open Computer" }).click();
  await expect(page.getByTestId("computer-panel")).toBeVisible();
}

test("computer panel: two clients take the same screen, one is superseded, and control returns", async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);

  const suffix = crypto.randomUUID().slice(0, 8);
  const workspaceName = `RC052 workspace ${suffix}`;
  const workspaceId = await createWorkspace(page, workspaceName);
  await createBot(page, workspaceId, `RC052 bot A ${suffix}`);
  await createBot(page, workspaceId, `RC052 bot B ${suffix}`);
  await showComputer(page);

  // Client A takes the Bot's screen and the host confirms it.
  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("computer-owner")).toHaveText("Owner: You");
  await expect(page.getByTestId("computer-state")).toHaveText("State: holder");
  await expect(page.getByTestId("computer-connection")).toHaveText("Connected");
  await expect(page.getByTestId("computer-heartbeat")).toContainText("Heartbeat: confirmed");
  const heldByA = await api(page, `/api/workspaces/${workspaceId}/screen/possession`);
  expect(heldByA.status).toBe(200);
  expect(heldByA.json.state).toBe("holder");

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signIn(other);
    await other.getByTestId(`workspace-item-${workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
    await other.getByTestId(`bot-item-${`RC052 bot A ${suffix}`.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
    await showComputer(other);

    // Possession is reported against this client's own token, so B holds nothing
    // of its own before it takes.
    await expect(other.getByTestId("computer-owner")).toHaveText("Owner: No possession from this client");
    await expect(other.getByTestId("computer-state")).toHaveText("State: none");

    // A later takeover supersedes the earlier holder (RC-043), so the host lets
    // B take it — and the host is the one that says B holds it.
    await other.getByTestId("take-control").click();
    await expect(other.getByTestId("computer-owner")).toHaveText("Owner: You");
    await expect(other.getByTestId("computer-state")).toHaveText("State: holder");

    // The displaced client learns it was displaced and stops claiming control:
    // exactly one client reads "holder" at any time.
    await expect(page.getByTestId("computer-state")).toHaveText("State: superseded", { timeout: 30_000 });
    await expect(page.getByTestId("computer-owner")).toHaveText("Owner: Another client took it");
    await expect(page.getByTestId("return-control")).toHaveAttribute("aria-disabled", "true");
    const displaced = await api(page, `/api/workspaces/${workspaceId}/screen/possession`);
    expect(displaced.status).toBe(200);
    expect(displaced.json.state).toBe("superseded");

    // A dropped link must not read as a live claim on the holder's side.
    await otherContext.setOffline(true);
    await expect(other.getByTestId("computer-connection")).toHaveText("Connection dropped");
    await expect(other.getByTestId("return-control")).toHaveAttribute("aria-disabled", "true");
    await otherContext.setOffline(false);
    await expect(other.getByTestId("computer-connection")).toHaveText("Connected");

    // Returning control is confirmed by the host, not by the panel.
    await other.getByTestId("return-control").click();
    await expect(other.getByTestId("return-result")).toHaveText("returned");
    await expect(other.getByTestId("computer-owner")).toHaveText("Owner: No possession from this client");
    const released = await api(other, `/api/workspaces/${workspaceId}/screen/possession`);
    expect(released.status).toBe(200);
    expect(released.json.state).toBe("none");

    // Control is recoverable: the displaced client can take it again.
    await page.getByTestId("take-control").click();
    await expect(page.getByTestId("computer-state")).toHaveText("State: holder", { timeout: 20_000 });
    const retaken = await api(page, `/api/workspaces/${workspaceId}/screen/possession`);
    expect(retaken.status).toBe(200);
    expect(retaken.json.state).toBe("holder");
    await expect(other.getByTestId("computer-state")).toHaveText("State: superseded", { timeout: 30_000 });
  } finally {
    await otherContext.close();
  }
});