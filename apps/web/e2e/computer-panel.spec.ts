import { expect, test } from "@playwright/test";

const apiUrl = process.env.RC003_API_URL ?? "http://127.0.0.1:37117";
const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
}

async function api(page: import("@playwright/test").Page, path: string, init?: RequestInit) {
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
  return botId;
}

test("computer panel: take, return, and network-drop recovery across two contexts", async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);

  const suffix = crypto.randomUUID();
  const workspaceName = `RC052 workspace ${suffix}`;
  const botNameA = `RC052 bot A ${suffix}`;
  const botNameB = `RC052 bot B ${suffix}`;

  const workspaceId = await createWorkspace(page, workspaceName);

  const botAId = await createBot(page, workspaceId, botNameA);
  const botBId = await createBot(page, workspaceId, botNameB);

  // Select Bot A in the sidebar so the ComputerPanel shows it.
  await page.getByTestId(`bot-item-${botNameA.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();

  // Context A takes control of Bot A's screen.
  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("computer-owner")).toHaveText("Owner: You");
  await expect(page.getByTestId("computer-state")).toHaveText("State: holder");
  await expect(page.getByTestId("computer-connection")).toHaveText("Connected");

  // Open the same workspace in context B.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signIn(other);

    // Select the workspace in context B.
    await other.getByTestId(`workspace-item-${workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
    await expect(other.getByTestId("app-content")).toBeVisible();

    // Select Bot A in context B.
    await other.getByTestId(`bot-item-${botNameA.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();

    // Context B sees A as the owner and cannot take control.
    await expect(other.getByTestId("computer-owner")).toHaveText("Owner: You");
    await expect(other.getByTestId("take-control")).toBeDisabled();

    // Drop the network in context A.
    await page.context().setOffline(true);
    await expect(page.getByTestId("computer-connection")).toHaveText("Connection dropped");
    // After going offline, the panel must not show a live claim.
    await expect(page.getByTestId("computer-state")).not.toHaveText("State: holder");

    // Restore the network in context A.
    await page.context().setOffline(false);

    // Return control from A.
    await page.getByTestId("return-control").click();
    await expect(page.getByTestId("computer-owner")).toHaveText("Owner: No one");
    await expect(page.getByTestId("computer-state")).toHaveText("State: none");

    // Verify the host confirms no owner via backend read.
    const hostState = await api(page, `/api/workspaces/${workspaceId}/screen/possession`);
    expect(hostState.status).toBe(200);
    expect(hostState.json.state).toBe("none");

    // Context B can now take control.
    await other.getByTestId("take-control").click();
    await expect(other.getByTestId("computer-owner")).toHaveText("Owner: You");
    await expect(other.getByTestId("computer-state")).toHaveText("State: holder");
  } finally {
    await otherContext.close();
  }
});
