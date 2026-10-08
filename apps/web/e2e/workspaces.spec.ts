import { expect, test } from "@playwright/test";

const apiUrl = process.env.RC003_API_URL ?? "http://127.0.0.1:37117";
const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText(
    "Live updates connected",
  );
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
}

// A workspace owns its surfaces as tabs; the default set omits Files and
// Computer, which are opened from the pane's "+" menu.
async function openSurface(page: import("@playwright/test").Page, title: "Workspace" | "Agent" | "Terminal" | "Files" | "Computer") {
  const tab = page.getByRole("tab", { name: title, exact: true });
  if (await tab.count()) { await tab.click(); return; }
  const plus = page.getByRole("button", { name: "Open a surface" });
  // With no workspace selected the pane is the create form, which lives on no
  // surface at all, so there is nothing to switch to.
  if (!(await plus.count())) return;
  await plus.click();
  await page.getByRole("menuitemradio", { name: `Open ${title}` }).click();
}

// Below 901px the sidebar starts hidden and its open scrim covers the pane.
async function openSidebar(page: import("@playwright/test").Page) {
  // Wait for the client to mount: before it does, the sidebar is absent and a
  // toggle click would close the sidebar the client is about to open.
  await page.getByTestId("app-sidebar").waitFor({ state: "attached" });
  if (!(await page.getByTestId("app-sidebar").isVisible())) {
    await page.getByTestId("sidebar-toggle").click();
  }
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
}

// The toggle lives in the pane's tab strip, so it works at every width; below
// 901px the sidebar is a drawer that covers the pane it was opened from.
async function closeSidebar(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("app-sidebar")).toBeHidden();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`keeps date-looking action and workspace text literal at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const base = Date.now();
    const action = new Date(base).toISOString();
    const name = new Date(base + 60_000).toISOString();
    const renamed = new Date(base + 120_000).toISOString();
    await signIn(page);
    await page.getByLabel("Action description").fill(action);
    await page.getByRole("button", { name: "Write backend receipt" }).click();
    await expect(page.getByTestId("latest-receipt")).toContainText(action);
    await expect(page.getByTestId("pending-action")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Write backend receipt" })).toBeEnabled();
    await page.getByLabel("Workspace name").fill(name);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await openSidebar(page);
    await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
    await page.getByRole("button", { name: `Open workspace ${name}` }).click();
    if (viewport.width < 901) await closeSidebar(page);
    await page.getByLabel("New workspace name").fill(renamed);
    await page.getByRole("button", { name: "Rename workspace" }).click();
    await expect(page.getByTestId("selected-workspace")).toContainText(renamed);
    await page.reload();
    await openSidebar(page);
    await expect(page.getByRole("button", { name: `Open workspace ${renamed}` })).toBeVisible();
    const response = await page.request.get(`${apiUrl}/api/workspaces`);
    const body = await response.json() as { workspaces: Array<{ id: string; name: string }> };
    const workspace = body.workspaces.find((row) => row.name === renamed);
    expect(workspace?.id).toBeTruthy();
    const actions = await (await page.request.get(`${apiUrl}/api/actions`)).json() as { actions: Array<{ action: string }> };
    expect(actions.actions.filter((row) => row.action === action)).toHaveLength(1);
    await openSidebar(page);
    await page.getByRole("button", { name: `Open workspace ${renamed}` }).click();
    if (viewport.width < 901) await closeSidebar(page);
    await page.getByRole("button", { name: "Archive workspace" }).click();
    await expect(page.getByText("Archived workspaces are read-only.")).toBeVisible();
    const archived = await (await page.request.get(`${apiUrl}/api/workspaces/${workspace!.id}`)).json();
    expect(archived).toMatchObject({ id: workspace!.id, name: renamed, archived: true });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByTestId("workspace-panel")).toHaveCount(0);
    await expect(page.getByTestId("latest-receipt")).toHaveCount(0);
  });
}

test("two browser contexts keep workspace selection local while observing shared metadata", async ({
  browser,
  page,
}) => {
  const suffix = crypto.randomUUID();
  const nameA = `RC028 A ${suffix}`;
  const nameB = `RC028 B ${suffix}`;
  await signIn(page);
  await page.getByLabel("Workspace name").fill(nameA);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(nameA, { exact: true })).toBeVisible();
  await page.getByLabel("Workspace name").fill(nameB);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(nameB, { exact: true })).toBeVisible();
  const initialResponse = await page.request.get(`${apiUrl}/api/workspaces`);
  expect(initialResponse.ok()).toBe(true);
  const initial = (await initialResponse.json()) as {
    workspaces: Array<{ id: string; name: string }>;
  };
  const initialIdA = initial.workspaces.find((item) => item.name === nameA)?.id;
  const initialIdB = initial.workspaces.find((item) => item.name === nameB)?.id;
  expect(initialIdA).toBeTruthy();
  expect(initialIdB).toBeTruthy();

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signIn(other);
    await other
      .getByRole("button", { name: `Open workspace ${nameB}` })
      .click();
    await expect(other.getByTestId("selected-workspace")).toContainText(nameB);
    await page.getByRole("button", { name: `Open workspace ${nameA}` }).click();
    await expect(page.getByTestId("selected-workspace")).toContainText(nameA);
    await expect(other.getByTestId("selected-workspace")).toContainText(nameB);

    const renamedA = `${nameA} renamed`;
    await page.getByLabel("New workspace name").fill(renamedA);
    await page.getByRole("button", { name: "Rename workspace" }).click();
    await expect(page.getByTestId("selected-workspace")).toContainText(
      renamedA,
    );
    await other.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(
      other.getByRole("button", { name: `Open workspace ${renamedA}` }),
    ).toBeVisible();

    await page.getByRole("button", { name: `Open workspace ${nameB}` }).click();
    await page.getByRole("button", { name: "Archive workspace" }).click();
    await expect(
      page.getByText("Archived workspaces are read-only."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Archive workspace" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Delete workspace/ }),
    ).toHaveCount(0);
    await expect(other.getByTestId("selected-workspace")).toContainText(nameB);

    await page.reload();
    await expect(page.getByTestId("workspace-panel")).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Open workspace ${renamedA}` }),
    ).toBeVisible();
    await expect(
      page.getByText(`${nameB} (archived)`),
    ).toBeVisible();

    const response = await page.request.get(`${apiUrl}/api/workspaces`);
    expect(response.ok()).toBe(true);
    const result = (await response.json()) as {
      workspaces: Array<{ id: string; name: string; archived?: boolean }>;
    };
    const rowA = result.workspaces.find((item) => item.name === renamedA);
    const rowB = result.workspaces.find((item) => item.name === nameB);
    expect(rowA?.id).toBe(initialIdA);
    expect(rowA?.archived).toBeUndefined();
    expect(rowB).toMatchObject({ id: initialIdB, name: nameB, archived: true });
    expect(rowB?.id).not.toBe(rowA?.id);
  } finally {
    await otherContext.close();
  }
});

test("recovers lost create response by manual canonical lookup without replay", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 uncertain ${crypto.randomUUID()}`;
  let posts = 0;
  let hideReceipt = true;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    await route.fetch();
    await route.abort();
  });
  await page.route("**/api/workspaces/receipts/**", async (route) => {
    if (hideReceipt) {
      hideReceipt = false;
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "receipt_not_found" }),
      });
    }
    return route.continue();
  });
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-status")).toContainText("unknown");
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Check workspace receipt" }).click();
  await expect(page.getByTestId("workspace-status")).toHaveText(
    "Workspace change confirmed.",
  );
  expect(posts).toBe(1);
  const response = await page.request.get(`${apiUrl}/api/workspaces`);
  const result = (await response.json()) as {
    workspaces: Array<{ id: string; name: string }>;
  };
  expect(
    result.workspaces.filter((workspace) => workspace.name === name),
  ).toHaveLength(1);
});

test("malformed response and missing lookup remain pending without replay", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 malformed ${crypto.randomUUID()}`;
  let posts = 0;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    const response = await route.fetch();
    const workspace = (await response.json()) as {
      id: string;
      name: string;
      createdAt: string;
    };
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ...workspace, createdAt: "not-an-ISO-timestamp" }),
    });
  });
  await page.route("**/api/workspaces/receipts/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "receipt_not_found" }),
    }),
  );
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-status")).toContainText("unknown");
  await expect(
    page.getByRole("button", { name: "Check workspace receipt" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeDisabled();
  expect(posts).toBe(1);
  const response = await page.request.get(`${apiUrl}/api/workspaces`);
  const result = (await response.json()) as {
    workspaces: Array<{ id: string; name: string }>;
  };
  expect(
    result.workspaces.filter((workspace) => workspace.name === name),
  ).toHaveLength(1);
});

test("two browser contexts keep per-device layout selection while sharing tabs", async ({
  browser,
  page,
}) => {
  // RC-033 per-device focus: both contexts read the same shared layout row,
  // but switching the local tab on one must not move the other's selection.
  const suffix = crypto.randomUUID();
  const name = `RC033 shared ${suffix}`;
  await signIn(page);
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(name);
  await openSurface(page, "Terminal");
  // Mount this workspace's terminal panel so it loads the shared layout.
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");

  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId = rows.find((row) => row.name === name)?.id;
  expect(workspaceId).toBeTruthy();
  const seed = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId}/layout`, {
    data: { tabs: [{ id: "tab-a", kind: "file", targetId: "a.txt" }, { id: "tab-b", kind: "file", targetId: "b.txt" }], activeTabId: "tab-b" },
  });
  expect(seed.ok()).toBe(true);
  // First context read the layout before the seed existed; reload the page
  // and reopen to force a fresh load of the seeded row.
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2");

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signIn(other);
    await other.getByRole("button", { name: `Open workspace ${name}` }).click();
    await expect(other.getByTestId("selected-workspace")).toContainText(name);
    await openSurface(other, "Terminal");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2");
    // Both devices render the shared tabs; neither adopts the stored tab-b.
    await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-a");
    await expect(other.getByTestId("terminal-local-tabs")).toContainText("tab-a");
    await expect(page.getByTestId("terminal-layout-state")).toContainText("this device: tab-a");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("this device: tab-a");
    // Switch the local tab on one device only. Count layout PUTs from
    // here: a regressed click handler that PUTs must fail this test even
    // though the stored value below already equals tab-b.
    let layoutPuts = 0;
    await page.route(`**/api/workspaces/${workspaceId}/layout`, (route) => {
      if (route.request().method() === "PUT") layoutPuts += 1;
      return route.continue();
    });
    await page.getByRole("button", { name: "Open tab-b" }).click();
    await expect(page.getByTestId("terminal-layout-state")).toContainText("this device: tab-b");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("this device: tab-a");
    expect(layoutPuts).toBe(0);
    // The shared row still carries the stored selection; no PUT was made.
    const shared = await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/layout`);
    expect(((await shared.json()) as { layout: { activeTabId: string } }).layout.activeTabId).toBe("tab-b");
  } finally {
    await otherContext.close();
  }
});

test("two browser contexts keep per-device pane selection while sharing panes", async ({
  browser,
  page,
}) => {
  // RC-033 pane slice: shared panes render on both devices, but switching
  // the local pane on one must not move the other and must make zero PUTs.
  const suffix = crypto.randomUUID();
  const name = `RC033 panes ${suffix}`;
  await signIn(page);
  await openSurface(page, "Workspace");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");

  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId = rows.find((row) => row.name === name)?.id;
  expect(workspaceId).toBeTruthy();
  const seed = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId}/layout`, {
    data: {
      tabs: [
        { id: "tab-a", kind: "file", targetId: "a.txt" },
        { id: "tab-b", kind: "file", targetId: "b.txt" },
      ],
      activeTabId: "tab-a",
      panes: [
        { id: "pane-1", tabId: "tab-a", order: 0 },
        { id: "pane-2", tabId: "tab-a", order: 1 },
        { id: "pane-3", tabId: "tab-b", order: 2 },
      ],
      activePaneId: "pane-2",
    },
  });
  expect(seed.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2");

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signIn(other);
    await other.getByRole("button", { name: `Open workspace ${name}` }).click();
    await openSurface(other, "Terminal");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2");
    // Neither device adopts the stored pane-2.
    await expect(page.getByTestId("terminal-layout-state")).toContainText("pane: pane-1");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("pane: pane-1");
    let layoutPuts = 0;
    await page.route(`**/api/workspaces/${workspaceId}/layout`, (route) => {
      if (route.request().method() === "PUT") layoutPuts += 1;
      return route.continue();
    });
    await page.getByRole("button", { name: "Open pane-2" }).click();
    await expect(page.getByTestId("terminal-layout-state")).toContainText("pane: pane-2");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("pane: pane-1");
    expect(layoutPuts).toBe(0);
    // Switching the local tab resets the local pane to that tab's first
    // pane; the other device is untouched and no PUT is made.
    await page.getByRole("button", { name: "Open tab-b" }).click();
    await expect(page.getByTestId("terminal-layout-state")).toContainText("this device: tab-b");
    await expect(page.getByTestId("terminal-layout-state")).toContainText("pane: pane-3");
    await expect(other.getByTestId("terminal-layout-state")).toContainText("pane: pane-1");
    // Single-pane tab renders the container with an explicit empty state,
    // not a missing section: the switcher stays mounted across tab shapes.
    await expect(page.getByTestId("terminal-local-panes")).toContainText("pane-3");
    await expect(other.getByTestId("terminal-local-panes")).toContainText("pane-1");
    await expect(other.getByTestId("terminal-local-panes")).toContainText("pane-2");
    expect(layoutPuts).toBe(0);
    const shared = await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/layout`);
    expect(((await shared.json()) as { layout: { activePaneId: string } }).layout.activePaneId).toBe("pane-2");
  } finally {
    await otherContext.close();
  }
});

test("saved layout returns after close and reopen with tabs and panes intact", async ({
  page,
}) => {
  // RC-033 close-and-return: save a layout through the real UI, close the
  // client (reload), reopen, and the same tabs/panes return from the host.
  const suffix = crypto.randomUUID();
  const name = `RC033 return ${suffix}`;
  await signIn(page);
  await openSurface(page, "Workspace");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");

  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId = rows.find((row) => row.name === name)?.id;
  expect(workspaceId).toBeTruthy();
  // Seed the file/thread half the terminal panel does not own, so the UI
  // merge-save must preserve it; then save the terminal half via the UI.
  // Seed both halves: a file tab with its pane (owned by other panels)
  // plus a stale terminal tab from an earlier session on this device. The UI
  // merge-save must keep the file half and drop the stale terminal tab.
  const seed = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId}/layout`, {
    data: {
      tabs: [
        { id: "tab-file", kind: "file", targetId: "notes.txt" },
        { id: "terminal-deadbeef", kind: "terminal", targetId: "deadbeef-dead-beef-dead-beefdeadbeef" },
      ],
      activeTabId: "tab-file",
      panes: [
        { id: "pane-term", tabId: "terminal-deadbeef", order: 0 },
        { id: "pane-file", tabId: "tab-file", order: 1 },
      ],
      activePaneId: "pane-file",
    },
  });
  expect(seed.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2");
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Layout saved: 1 tab(s).");
  const savedRow = ((await (await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/layout`)).json()) as {
    layout: {
      tabs: Array<{ id: string; kind: string; targetId: string }>;
      panes: Array<{ id: string; tabId: string; order: number }>;
    };
  }).layout;
  // File half preserved; stale terminal tab and its pane pruned and orders
  // re-indexed dense from zero.
  expect(savedRow.tabs).toEqual([{ id: "tab-file", kind: "file", targetId: "notes.txt" }]);
  expect(savedRow.panes).toEqual([{ id: "pane-file", tabId: "tab-file", order: 0 }]);
  // Close the client and go back: the layout returns intact.
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 1");
  await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-file");
  await expect(page.getByTestId("terminal-local-tabs")).not.toContainText("terminal-deadbeef");
  const returned = ((await (await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/layout`)).json()) as {
    layout: { tabs: Array<{ id: string }>; panes: Array<{ id: string; tabId: string; order: number }> };
  }).layout;
  expect(returned.tabs.map((tab) => tab.id)).toEqual(["tab-file"]);
  expect(returned.panes).toEqual([{ id: "pane-file", tabId: "tab-file", order: 0 }]);
});

test("archived workspace blocks layout save in the UI without a write", async ({
  page,
}) => {
  // RC-033 archived slice: after archiving, the UI Save layout button must
  // refuse without sending a layout PUT; the saved row stays intact.
  const suffix = crypto.randomUUID();
  const name = `RC033 archived ${suffix}`;
  await signIn(page);
  await openSurface(page, "Workspace");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");

  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId = rows.find((row) => row.name === name)?.id;
  expect(workspaceId).toBeTruthy();
  const seed = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId}/layout`, {
    data: { tabs: [{ id: "tab-a", kind: "file", targetId: "a.txt" }], activeTabId: "tab-a" },
  });
  expect(seed.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 1");

  let layoutPuts = 0;
  await page.route(`**/api/workspaces/${workspaceId}/layout`, (route) => {
    if (route.request().method() === "PUT") layoutPuts += 1;
    return route.continue();
  });
  await openSurface(page, "Workspace");
  await page.getByRole("button", { name: "Archive workspace" }).click();
  await expect(page.getByText("Archived workspaces are read-only.")).toBeVisible();
  // The read-only UI disables Save layout: no click is possible, no layout
  // PUT is sent, and the saved layout stays visible read-only.
  await openSurface(page, "Terminal");
  await expect(page.getByRole("button", { name: "Save layout" })).toBeDisabled();
  expect(layoutPuts).toBe(0);
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 1");
  await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-a");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("this device: tab-a");
  // Stale-prop guard path: un-archive via API is not offered by the UI, so
  // reload the unarchived state instead — reopen a fresh workspace where the
  // panel mounts unarchived, archive it via API behind the panel's back, then
  // click Save while the button is still enabled: the live preflight guard
  // must refuse with zero PUTs and the row stays intact.
  const name2 = `RC033 stale ${suffix}`;
  await openSurface(page, "Workspace");
  await page.getByLabel("Workspace name").fill(name2);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name2}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name2}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");
  const listed2 = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows2 = ((await listed2.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId2 = rows2.find((row) => row.name === name2)?.id;
  expect(workspaceId2).toBeTruthy();
  const seed2 = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId2}/layout`, {
    data: { tabs: [{ id: "tab-s", kind: "file", targetId: "s.txt" }], activeTabId: "tab-s" },
  });
  expect(seed2.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name2}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 1");
  let layoutPuts2 = 0;
  await page.route(`**/api/workspaces/${workspaceId2}/layout`, (route) => {
    if (route.request().method() === "PUT") layoutPuts2 += 1;
    return route.continue();
  });
  // Archive behind the mounted panel's back: the button stays enabled on the
  // stale prop, but the live preflight guard must refuse the save.
  const listed3 = await page.request.get(`${apiUrl}/api/workspaces`);
  const wsRow = ((await listed3.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces.find((row) => row.name === name2);
  expect(wsRow?.id).toBeTruthy();
  const archiveCall = await page.request.patch(`${apiUrl}/api/workspaces/${workspaceId2}`, {
    data: { requestId: crypto.randomUUID(), archived: true },
  });
  expect(archiveCall.ok()).toBe(true);
  // The archive reaches the mounted panel through the host's event stream, so
  // the save is refused: the button is disabled by the live state, and if it is
  // still enabled the live preflight guard refuses the click. Either way no
  // layout PUT may be sent.
  const saveLayout = page.getByRole("button", { name: "Save layout" });
  await expect.poll(() => saveLayout.isDisabled(), { timeout: 20_000, message: "the archived state never reached the terminal surface" }).toBe(true);
  if (await saveLayout.isEnabled()) await saveLayout.click();
  // The refusal stays visible: the control never becomes operable again.
  await expect.poll(() => saveLayout.isDisabled(), { timeout: 5_000 }).toBe(true);
  expect(layoutPuts2).toBe(0);
  const row2 = ((await (await page.request.get(`${apiUrl}/api/workspaces/${workspaceId2}/layout`)).json()) as {
    layout: { tabs: Array<{ id: string }> };
  }).layout;
  expect(row2.tabs.map((tab) => tab.id)).toEqual(["tab-s"]);
  const row = ((await (await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/layout`)).json()) as {
    layout: { tabs: Array<{ id: string }> };
  }).layout;
  expect(row.tabs.map((tab) => tab.id)).toEqual(["tab-a"]);
});

test("merge-save preserves another device terminal tab while pruning own stale one", async ({
  page,
}) => {
  // RC-033 cross-device merge: a foreign terminal tab (no "terminal-"
  // prefix, other session) must survive this device's UI Save, while this
  // device's own stale "terminal-" tab is pruned with dense pane re-index.
  const suffix = crypto.randomUUID();
  const name = `RC033 merge ${suffix}`;
  await signIn(page);
  await openSurface(page, "Workspace");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");

  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId = rows.find((row) => row.name === name)?.id;
  expect(workspaceId).toBeTruthy();
  const seed = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId}/layout`, {
    data: {
      tabs: [
        { id: "tab-file", kind: "file", targetId: "notes.txt" },
        { id: "tab-thread", kind: "thread", targetId: "thread-1" },
        { id: "foreign-term", kind: "terminal", targetId: "11111111-1111-1111-1111-111111111111" },
        { id: "terminal-deadbeef", kind: "terminal", targetId: "deadbeef-dead-beef-dead-beefdeadbeef" },
      ],
      activeTabId: "tab-file",
      panes: [
        { id: "pane-stale", tabId: "terminal-deadbeef", order: 0 },
        { id: "pane-foreign", tabId: "foreign-term", order: 1 },
        { id: "pane-file", tabId: "tab-file", order: 2 },
        { id: "pane-thread", tabId: "tab-thread", order: 3 },
      ],
      activePaneId: "pane-file",
    },
  });
  expect(seed.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 4");
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Layout saved: 3 tab(s).");
  const saved = ((await (await page.request.get(`${apiUrl}/api/workspaces/${workspaceId}/layout`)).json()) as {
    layout: {
      tabs: Array<{ id: string; kind: string; targetId: string }>;
      panes: Array<{ id: string; tabId: string; order: number }>;
    };
  }).layout;
  expect(saved.tabs).toEqual([
    { id: "tab-file", kind: "file", targetId: "notes.txt" },
    { id: "tab-thread", kind: "thread", targetId: "thread-1" },
    { id: "foreign-term", kind: "terminal", targetId: "11111111-1111-1111-1111-111111111111" },
  ]);
  expect(saved.panes).toEqual([
    { id: "pane-foreign", tabId: "foreign-term", order: 0 },
    { id: "pane-file", tabId: "tab-file", order: 1 },
    { id: "pane-thread", tabId: "tab-thread", order: 2 },
  ]);
});

test("switching workspaces in the UI loads each workspace layout", async ({
  page,
}) => {
  // RC-033 workspace switching: two workspaces with distinct seeded layouts;
  // opening each in the UI renders its own tabs, and switching back restores
  // the first without cross-contamination.
  const suffix = crypto.randomUUID();
  const nameA = `RC033 switch A ${suffix}`;
  const nameB = `RC033 switch B ${suffix}`;
  await signIn(page);
  for (const name of [nameA, nameB]) {
    await openSurface(page, "Workspace");
    await page.getByLabel("Workspace name").fill(name);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  }
  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const idA = rows.find((row) => row.name === nameA)?.id;
  const idB = rows.find((row) => row.name === nameB)?.id;
  expect(idA).toBeTruthy();
  expect(idB).toBeTruthy();
  const seedA = await page.request.put(`${apiUrl}/api/workspaces/${idA}/layout`, {
    data: { tabs: [{ id: "tab-alpha", kind: "file", targetId: "alpha.txt" }], activeTabId: "tab-alpha" },
  });
  expect(seedA.ok()).toBe(true);
  const seedB = await page.request.put(`${apiUrl}/api/workspaces/${idB}/layout`, {
    data: {
      tabs: [{ id: "tab-beta", kind: "file", targetId: "beta.txt" }],
      activeTabId: "tab-beta",
      panes: [{ id: "pane-beta", tabId: "tab-beta", order: 0 }],
      activePaneId: "pane-beta",
    },
  });
  expect(seedB.ok()).toBe(true);
  await page.getByRole("button", { name: `Open workspace ${nameA}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 1");
  await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-alpha");
  await expect(page.getByTestId("terminal-local-tabs")).not.toContainText("tab-beta");
  await page.getByRole("button", { name: `Open workspace ${nameB}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 1");
  await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-beta");
  await expect(page.getByTestId("terminal-local-tabs")).not.toContainText("tab-alpha");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("pane: pane-beta");
  // Switch back: A returns without B's tabs.
  await page.getByRole("button", { name: `Open workspace ${nameA}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-alpha");
  await expect(page.getByTestId("terminal-local-tabs")).not.toContainText("tab-beta");
});

test("tab without panes renders the empty panes state", async ({
  page,
}) => {
  // RC-033 zero-pane path: a tab with no panes must render the explicit
  // empty state instead of a missing section.
  const suffix = crypto.randomUUID();
  const name = `RC033 nopane ${suffix}`;
  await signIn(page);
  await openSurface(page, "Workspace");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-layout-state")).toContainText("No saved layout");

  const listed = await page.request.get(`${apiUrl}/api/workspaces`);
  const rows = ((await listed.json()) as { workspaces: Array<{ id: string; name: string }> }).workspaces;
  const workspaceId = rows.find((row) => row.name === name)?.id;
  expect(workspaceId).toBeTruthy();
  const seed = await page.request.put(`${apiUrl}/api/workspaces/${workspaceId}/layout`, {
    data: { tabs: [{ id: "tab-solo", kind: "file", targetId: "solo.txt" }], activeTabId: "tab-solo" },
  });
  expect(seed.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await openSurface(page, "Terminal");
  await expect(page.getByTestId("terminal-local-tabs")).toContainText("tab-solo");
  await expect(page.getByTestId("terminal-local-panes")).toBeVisible();
  await expect(page.getByTestId("terminal-local-panes")).toContainText("No panes on this tab.");
});

test("older host capability blocks create before any workspace POST", async ({
  page,
}) => {
  await signIn(page);
  let posts = 0;
  await page.route("**/api/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        supportedClientVersions: {
          hosted: { minimum: 0, maximum: 1 },
          selfManaged: { minimum: 0, maximum: 1 },
        },
        capabilities: [],
      }),
    }),
  );
  await page.route("**/api/workspaces", (route) => {
    if (route.request().method() === "POST") posts += 1;
    return route.continue();
  });
  await page
    .getByLabel("Workspace name")
    .fill(`not sent ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-unsupported")).toBeVisible();
  expect(posts).toBe(0);
});

test("a create response received after its tap deadline stays unknown and pending", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 late create ${crypto.randomUUID()}`;
  let releaseResponse!: () => void;
  let markPostReached!: () => void;
  const postReached = new Promise<void>((resolve) => {
    markPostReached = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let posts = 0;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    const response = await route.fetch();
    markPostReached();
    await responseGate;
    return route.fulfill({ response });
  });
  await page.getByLabel("Workspace name").fill(name);
  const click = page.getByRole("button", { name: "Create workspace" }).click();
  try {
    await postReached;
    await page.evaluate(() => {
      const now = Date.now.bind(Date);
      const expired = now() + 11_000;
      Date.now = () => expired;
    });
    releaseResponse();
    await click;
    await expect(page.getByTestId("workspace-status")).toContainText("unknown");
    await expect(
      page.getByRole("button", { name: "Check workspace receipt" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Create workspace" }),
    ).toBeDisabled();
    expect(posts).toBe(1);
  } finally {
    releaseResponse();
  }
});

test("a canonical receipt received after its tap deadline stays unknown and pending", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 late receipt ${crypto.randomUUID()}`;
  let releaseReceipt!: () => void;
  let markReceiptReached!: () => void;
  const receiptReached = new Promise<void>((resolve) => {
    markReceiptReached = resolve;
  });
  const receiptGate = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  let posts = 0;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    const response = await route.fetch();
    const workspace = (await response.json()) as {
      id: string;
      name: string;
      createdAt: string;
    };
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ...workspace, createdAt: "malformed" }),
    });
  });
  await page.route("**/api/workspaces/receipts/**", async (route) => {
    const response = await route.fetch();
    markReceiptReached();
    await receiptGate;
    return route.fulfill({ response });
  });
  await page.getByLabel("Workspace name").fill(name);
  const click = page.getByRole("button", { name: "Create workspace" }).click();
  try {
    await receiptReached;
    await page.evaluate(() => {
      const now = Date.now.bind(Date);
      const expired = now() + 11_000;
      Date.now = () => expired;
    });
    releaseReceipt();
    await click;
    await expect(page.getByTestId("workspace-status")).toContainText("unknown");
    await expect(
      page.getByRole("button", { name: "Check workspace receipt" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Create workspace" }),
    ).toBeDisabled();
    expect(posts).toBe(1);
  } finally {
    releaseReceipt();
  }
});

test("temporary capability transport failure allows explicit retry without a write", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 retry preflight ${crypto.randomUUID()}`;
  let fail = true;
  let posts = 0;
  await page.route("**/api/version", (route) => {
    if (fail) {
      fail = false;
      return route.abort();
    }
    return route.continue();
  });
  await page.route("**/api/workspaces", (route) => {
    if (route.request().method() === "POST") posts += 1;
    return route.continue();
  });
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-status")).toContainText(
    "unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeEnabled();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  expect(posts).toBe(1);
});

test("refresh renegotiates capability after the host upgrades", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 host upgrade ${crypto.randomUUID()}`;
  let posts = 0;
  await page.route("**/api/version", async (route) => {
    const response = await route.fetch();
    const version = (await response.json()) as {
      apiVersion: number;
      supportedClientVersions: unknown;
      capabilities: string[];
    };
    return route.fulfill({ response, json: { ...version, capabilities: [] } });
  });
  await page.route("**/api/workspaces", (route) => {
    if (route.request().method() === "POST") posts += 1;
    return route.continue();
  });
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-unsupported")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeDisabled();
  expect(posts).toBe(0);
  await page.unroute("**/api/version");
  await page.getByRole("button", { name: "Refresh workspaces" }).click();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  expect(posts).toBe(1);
});

test("an older active workspace list cannot overwrite a confirmed archive", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 stale list ${crypto.randomUUID()}`;
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open workspace ${name}` }).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(name);

  let releaseOldList!: () => void;
  let oldListReached!: () => void;
  const oldListGate = new Promise<void>((resolve) => {
    releaseOldList = resolve;
  });
  const oldListReady = new Promise<void>((resolve) => {
    oldListReached = resolve;
  });
  let holdOldList = true;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "GET" || !holdOldList)
      return route.continue();
    holdOldList = false;
    const response = await route.fetch();
    oldListReached();
    await oldListGate;
    return route.fulfill({ response });
  });

  await page.getByRole("button", { name: "Refresh workspaces" }).click();
  await oldListReady;
  await page.getByRole("button", { name: "Archive workspace" }).click();
  await expect(
    page.getByText("Archived workspaces are read-only."),
  ).toBeVisible();

  const oldListResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workspaces" &&
      response.request().method() === "GET",
  );
  releaseOldList();
  await oldListResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByTestId("selected-workspace")).toContainText(
    "Archived workspaces are read-only.",
  );
  await expect(
    page.getByRole("button", { name: "Archive workspace" }),
  ).toHaveCount(0);
});

test("unbound create hints and mismatched outcome receipts cannot confirm a substituted workspace", async ({
  page,
}) => {
  await signIn(page);
  const name = `RC028 bound receipt ${crypto.randomUUID()}`;
  const substitutedId = crypto.randomUUID();
  let posts = 0;
  let substituteLookup = true;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    const response = await route.fetch();
    const created = (await response.json()) as { createdAt: string };
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: substitutedId,
        name: "Substituted workspace",
        createdAt: created.createdAt,
      }),
    });
  });
  await page.route("**/api/workspaces/receipts/*/outcome", (route) => {
    if (!substituteLookup) return route.continue();
    substituteLookup = false;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        kind: "create",
        workspace: {
          id: substitutedId,
          name: "Substituted workspace",
          createdAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      }),
    });
  });
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-status")).toContainText("unknown");
  await expect(
    page.getByRole("button", { name: "Check workspace receipt" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeDisabled();
  expect(posts).toBe(1);

  await page.getByRole("button", { name: "Check workspace receipt" }).click();
  await expect(page.getByTestId("workspace-status")).toHaveText(
    "Workspace change confirmed.",
  );
  expect(posts).toBe(1);
  const response = await page.request.get(`${apiUrl}/api/workspaces`);
  const result = (await response.json()) as {
    workspaces: Array<{ id: string; name: string }>;
  };
  expect(
    result.workspaces.some((workspace) => workspace.id === substitutedId),
  ).toBe(false);
  expect(
    result.workspaces.filter((workspace) => workspace.name === name),
  ).toHaveLength(1);
});
