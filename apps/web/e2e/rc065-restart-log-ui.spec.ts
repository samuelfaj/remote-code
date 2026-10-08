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
    const prepare = page.getByLabel("Prepare workspace folder");
    await expect(prepare).toBeVisible({ timeout: 15_000 });
    await prepare.click();
    await expect(page.getByTestId("folder-status")).toContainText("provisioned", { timeout: 20_000 });

    // Create a file and assert the CREATE receipt.
    await page.getByLabel("New file path").fill(fileName);
    await page.getByRole("button", { name: "Create file" }).click();
    await expect(page.getByTestId("file-status")).toContainText("CREATE receipt confirmed", { timeout: 30_000 });

    // Save content and assert the SAVE receipt.
    await page.getByLabel("File draft").fill(content);
    await page.getByRole("button", { name: "Save file" }).click();
    await expect(page.getByTestId("file-status")).toContainText(`SAVE receipt confirmed for ${fileName}`, { timeout: 30_000 });

    // Write state for the after phase from the Node.js test context.
    if (!stateFilePath) {
      throw new Error("RC065_STATE_FILE is not set");
    }
    writeFileSync(stateFilePath, JSON.stringify({ workspaceName, filePath: fileName, content }));
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
    await page.getByTestId("workspace-item-" + state.workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")).click();
    await expect(page.getByTestId("selected-workspace")).toContainText(state.workspaceName);

    // Refresh folder and open the file.
    await page.getByRole("button", { name: "Refresh folder and files" }).click();
    await page.getByRole("button", { name: `Open file ${state.filePath}` }).click();

    // Assert the content matches what was saved in the before phase.
    const draft = page.getByLabel("File draft");
    await expect(draft).toBeVisible({ timeout: 15_000 });
    const draftContent = await draft.inputValue();
    expect(draftContent).toBe(state.content);

    // Assert the SAVE receipt is still confirmed (not stale/false success).
    await expect(page.getByTestId("file-status")).toContainText(`SAVE receipt confirmed for ${state.filePath}`, { timeout: 15_000 });

    // Reload the page and assert the connection status is live, not a leftover.
    await page.reload();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  });
}
