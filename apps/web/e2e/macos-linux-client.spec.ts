import { expect, test } from "@playwright/test";

const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

// A browser on this machine driving a Linux host, with no shell or agent
// running here: the engine is chosen by the runner so the same journey runs on
// Chromium and on WebKit. Skipping elsewhere is honest; running the assertions
// on a host that cannot serve them would not be.
test.skip(
  process.env.RC054_LINUX_HOST !== "1",
  "RC-054's journey needs a Linux host serving the file and screen routes; set RC054_LINUX_HOST=1 (see scripts/rc054/run-macos-browsers-proof.sh)",
);

test.use({ browserName: (process.env.RC054_BROWSER ?? "chromium") as "chromium" | "webkit" });

async function api(page: import("@playwright/test").Page, path: string, init?: RequestInit) {
  // Read inside the page, so the session the app holds is the one used.
  return page.evaluate(async ({ path, init }: { path: string; init?: RequestInit }) => {
    const response = await fetch(path, init);
    return { status: response.status, json: await response.json().catch(() => null) };
  }, { path, init }) as Promise<{ status: number; json: any }>;
}

async function openSurface(page: import("@playwright/test").Page, title: "Workspace" | "Agent" | "Terminal" | "Files" | "Computer") {
  const tab = page.getByRole("tab", { name: title, exact: true });
  if (await tab.count()) { await tab.click(); return; }
  await page.getByRole("button", { name: "Open a surface" }).click();
  await page.getByRole("menuitemradio", { name: `Open ${title}` }).click();
}

test("edits a file, follows a thread and takes the screen, then reconnects after a cut", async ({ page }) => {
  test.setTimeout(240_000);
  const browser = process.env.RC054_BROWSER ?? "chromium";
  // The live channel is closed the way a real drop closes it, which is the
  // pattern the reconnect suite already uses.
  let drop!: () => void;
  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    drop = () => socket.close();
  });
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  await expect(page.getByTestId("workspace-panel")).toBeVisible();

  const stamp = crypto.randomUUID().slice(0, 8);
  const workspaceName = `RC054 ${browser} ${stamp}`;
  await page.getByLabel("Workspace name", { exact: true }).fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(workspaceName);
  const listed = await api(page, "/api/workspaces");
  expect(listed.status).toBe(200);
  const workspace = listed.json.workspaces.find((entry: any) => entry.name === workspaceName);
  expect(workspace?.id, "the host holds the workspace this browser created").toBeTruthy();
  const workspaceId = workspace.id as string;
  await page.getByTestId(`workspace-item-${workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(workspaceName);

  // Edit a file on the host through the browser's own editor: create it, then
  // save the draft, and read the host's copy back.
  await openSurface(page, "Files");
  await page.getByRole("button", { name: "Prepare workspace folder" }).click();
  await expect(page.getByTestId("folder-status")).toContainText("Folder provisioned on Linux", { timeout: 60_000 });
  await expect(page.getByTestId("file-status")).toContainText("Workspace folder confirmed", { timeout: 60_000 });
  await page.getByLabel("New file path").fill("rc054-note.txt");
  await page.getByRole("button", { name: "Create file" }).click();
  await expect(page.getByTestId("file-status")).toContainText("CREATE receipt confirmed", { timeout: 30_000 });
  await page.getByRole("button", { name: "Refresh folder and files" }).click();
  await page.getByRole("button", { name: "Open file rc054-note.txt" }).click();
  await page.getByLabel("File draft").fill("written from this browser\n");
  await page.getByRole("button", { name: "Save file" }).click();
  await expect(page.getByTestId("file-status")).toContainText("SAVE receipt confirmed for rc054-note.txt", { timeout: 30_000 });
  const hosted = await api(page, `/api/workspaces/${workspaceId}/files/content?path=rc054-note.txt`);
  expect(hosted.status, "the host can read back the file").toBe(200);
  expect(hosted.json.content).toBe("written from this browser\n");

  // Follow a thread: the browser posts a message and reads the host's copy.
  const thread = await api(page, `/api/workspaces/${workspaceId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `RC054 thread ${stamp}` }),
  });
  expect([200, 201], `POST thread -> ${thread.status}`).toContain(thread.status);
  const message = await api(page, `/api/threads/${thread.json.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: `RC054 message ${stamp}` }),
  });
  expect([200, 201], `POST message -> ${message.status}`).toContain(message.status);
  const messages = await api(page, `/api/threads/${thread.json.id}/messages`);
  expect(messages.status).toBe(200);
  expect(messages.json.messages.map((entry: any) => entry.body)).toContain(`RC054 message ${stamp}`);

  // Take the Bot screen and hand it back, with the host as the authority.
  const taken = await api(page, `/api/workspaces/${workspaceId}/screen/possession`, { method: "POST" });
  expect([200, 201], `take possession -> ${taken.status}`).toContain(taken.status);
  const held = await api(page, `/api/workspaces/${workspaceId}/screen/possession`);
  expect(held.json.state).toBe("holder");
  const released = await api(page, `/api/workspaces/${workspaceId}/screen/possession/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: taken.json.token }),
  });
  expect([200, 201], `release -> ${released.status}`).toContain(released.status);
  const afterRelease = await api(page, `/api/workspaces/${workspaceId}/screen/possession`);
  expect(afterRelease.json.state).toBe("none");

  // Cut the live channel, then reconnect: the client must re-derive the host's
  // state rather than keep a stale claim.
  drop();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates disconnected", { timeout: 30_000 });
  const reconnect = page.getByRole("button", { name: "Reconnect live updates" });
  if (await reconnect.count()) {
    await reconnect.click();
  } else {
    await page.reload();
  }
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 60_000 });
  const afterReconnect = await api(page, `/api/workspaces/${workspaceId}/files/content?path=rc054-note.txt`);
  expect(afterReconnect.status, "the host still holds the file after the cut").toBe(200);
  expect(afterReconnect.json.content).toBe("written from this browser\n");

  // Nothing on this machine ran the work: the host's own record is the proof.
  const receipts = await api(page, `/api/workspaces/${workspaceId}/files`);
  expect(receipts.status).toBe(200);
  expect((receipts.json.entries ?? []).filter((entry: any) => entry.type === "file").map((entry: any) => entry.name))
    .toContain("rc054-note.txt");
});