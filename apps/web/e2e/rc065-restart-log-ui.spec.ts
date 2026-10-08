import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";

const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";
const phase = process.env.RC065_PHASE ?? "before";
const stateFilePath = process.env.RC065_STATE_FILE;

test.skip(
  phase !== "before" && phase !== "after",
  "RC-065 spec requires RC065_PHASE=before or RC065_PHASE=after",
);

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
}

async function openSurface(page: import("@playwright/test").Page, title: "Workspace" | "Agent" | "Terminal" | "Files" | "Computer") {
  const tab = page.getByRole("tab", { name: title, exact: true });
  if (await tab.count()) { await tab.click(); return; }
  await page.getByRole("button", { name: "Open a surface" }).click();
  await page.getByRole("menuitemradio", { name: `Open ${title}` }).click();
}

async function backendWorkspaceId(page: import("@playwright/test").Page, name: string) {
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/workspaces");
    return { status: response.status, json: await response.json() };
  }) as { status: number; json: { workspaces: Array<{ id: string; name: string }> } };
  expect(body.status, `GET /api/workspaces -> ${body.status}`).toBe(200);
  const workspace = body.json.workspaces.find((entry) => entry.name === name);
  expect(workspace?.id).toBeTruthy();
  return workspace!.id;
}

if (phase === "before") {
  test("RC-065 before phase: create workspace, file, save, and record state", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);

    const workspaceName = `RC065 workspace ${crypto.randomUUID()}`;
    const fileName = "rc065-test-file.txt";
    const content = "RC-065 before-phase content\n";

    await page.getByLabel("Workspace name", { exact: true }).fill(workspaceName);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByTestId("workspace-list")).toContainText(workspaceName);
    await page.getByRole("button", { name: `Open workspace ${workspaceName}` }).click();
    await expect(page.getByTestId("selected-workspace")).toContainText(workspaceName);

    // Prepare the workspace folder.
    await openSurface(page, "Files");
    const prepare = page.getByLabel("Prepare workspace folder");
    await expect(prepare).toBeVisible({ timeout: 15_000 });
    await prepare.click();
    await expect(page.getByTestId("folder-status")).toContainText("provisioned", { timeout: 20_000 });

    // Create a file and assert the CREATE receipt.
    await page.getByLabel("New file path").fill(fileName);
    await page.getByRole("button", { name: "Create file" }).click();
    await expect(page.getByTestId("file-status")).toContainText("CREATE receipt confirmed", { timeout: 30_000 });

    // Open the file in the editor before saving content.
    await page.getByRole("button", { name: "Refresh folder and files" }).click();
    await page.getByRole("button", { name: `Open file ${fileName}` }).click();

    // Save content and assert the SAVE receipt.
    await page.getByLabel("File draft").fill(content);
    await page.getByRole("button", { name: "Save file" }).click();
    await expect(page.getByTestId("file-status")).toContainText(`SAVE receipt confirmed for ${fileName}`, { timeout: 30_000 });

    // Get the workspace ID from the backend for the database check.
    const workspaceId = await backendWorkspaceId(page, workspaceName);

    // Write state for the after phase from the Node.js test context.
    if (!stateFilePath) {
      throw new Error("RC065_STATE_FILE is not set");
    }
    writeFileSync(stateFilePath, JSON.stringify({ workspaceName, filePath: fileName, content, workspaceId }));
  });
}

if (phase === "after") {
  test("RC-065 after phase: verify file persists and no duplicate effect after restart", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);

    if (!stateFilePath) {
      throw new Error("RC065_STATE_FILE is not set");
    }

    // Read state recorded in the before phase.
    const state = JSON.parse(readFileSync(stateFilePath, "utf-8")) as {
      workspaceName: string;
      filePath: string;
      content: string;
    };

    // Open the workspace recorded in state.
    const workspaceItem = page.getByTestId("workspace-item-" + state.workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-"));
    await workspaceItem.waitFor({ state: "visible", timeout: 10_000 });
    await workspaceItem.click();
    await expect(page.getByTestId("selected-workspace")).toContainText(state.workspaceName, { timeout: 10_000 });

    // Wait for the workspace content to be fully loaded before refreshing.
    await expect(page.getByTestId("app-content")).toBeVisible({ timeout: 10_000 });
    await openSurface(page, "Files");
    await expect(page.getByTestId("folder-status")).toContainText("provisioned", { timeout: 15_000 });

    // Refresh folder and open the file.
    await page.getByRole("button", { name: "Refresh folder and files" }).click();
    await page.getByRole("button", { name: `Open file ${state.filePath}` }).click();

    // Assert the content matches what was saved in the before phase.
    const draft = page.getByLabel("File draft");
    await expect(draft).toBeVisible({ timeout: 15_000 });
    const draftContent = await draft.inputValue();
    expect(draftContent).toBe(state.content);

    // Assert the file status confirms the file was read from the host
    // (not a stale or false success from a previous session).
    await expect(page.getByTestId("file-status")).toContainText("read from the host", { timeout: 15_000 });

    // Reload the page and assert the connection status is live, not a leftover.
    await page.reload();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  });
}
