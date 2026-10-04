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
    await expect(page.getByRole("button", { name: `Open workspace ${name}` })).toBeVisible();
    await page.getByRole("button", { name: `Open workspace ${name}` }).click();
    await page.getByLabel("New workspace name").fill(renamed);
    await page.getByRole("button", { name: "Rename workspace" }).click();
    await expect(page.getByTestId("selected-workspace")).toContainText(renamed);
    await page.reload();
    await expect(page.getByRole("button", { name: `Open workspace ${renamed}` })).toBeVisible();
    const response = await page.request.get(`${apiUrl}/api/workspaces`);
    const body = await response.json() as { workspaces: Array<{ id: string; name: string }> };
    const workspace = body.workspaces.find((row) => row.name === renamed);
    expect(workspace?.id).toBeTruthy();
    const actions = await (await page.request.get(`${apiUrl}/api/actions`)).json() as { actions: Array<{ action: string }> };
    expect(actions.actions.filter((row) => row.action === action)).toHaveLength(1);
    await page.getByRole("button", { name: `Open workspace ${renamed}` }).click();
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
      page.getByText(`${nameB} (archived, read-only)`),
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
  await expect(page.getByTestId("terminal-layout-state")).toContainText("Shared tabs: 2");

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signIn(other);
    await other.getByRole("button", { name: `Open workspace ${name}` }).click();
    await expect(other.getByTestId("selected-workspace")).toContainText(name);
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
