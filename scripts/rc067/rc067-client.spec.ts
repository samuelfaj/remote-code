// RC-067 browser journey spec: creates a workspace, prepares its folder,
// creates and saves a file, and reads the host's copy back from a
// published artifact served by a local Vite proxy.
import { expect, test } from "@playwright/test";

const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

test("creates workspace, saves file and reads it back from the published host", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15_000 });
  await expect(page.getByTestId("workspace-panel")).toBeVisible();

  const stamp = crypto.randomUUID().slice(0, 8);
  const workspaceName = `RC067 ${stamp}`;
  await page.getByLabel("Workspace name", { exact: true }).fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(workspaceName, { timeout: 15_000 });

  const listed = await page.evaluate(async () => {
    const response = await fetch("/api/workspaces");
    return response.json();
  });
  const workspace = listed.workspaces.find((entry: any) => entry.name === workspaceName);
  expect(workspace?.id, "the host holds the workspace this browser created").toBeTruthy();
  const workspaceId = workspace.id as string;

  await page.getByTestId(`workspace-item-${workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")}`).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(workspaceName);

  await page.getByRole("button", { name: "Prepare workspace folder" }).click();
  await expect(page.getByTestId("folder-status")).toContainText("Folder provisioned on Linux", { timeout: 60_000 });
  await expect(page.getByTestId("file-status")).toContainText("Workspace folder confirmed", { timeout: 60_000 });

  await page.getByLabel("New file path").fill("rc067-note.txt");
  await page.getByRole("button", { name: "Create file" }).click();
  await expect(page.getByTestId("file-status")).toContainText("CREATE receipt confirmed", { timeout: 30_000 });
  await page.getByRole("button", { name: "Refresh folder and files" }).click();
  await page.getByRole("button", { name: "Open file rc067-note.txt" }).click();
  await page.getByLabel("File draft").fill("written from RC-067 browser\n");
  await page.getByRole("button", { name: "Save file" }).click();
  await expect(page.getByTestId("file-status")).toContainText("SAVE receipt confirmed for rc067-note.txt", { timeout: 30_000 });

  const hosted = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/workspaces/${id}/files/content?path=rc067-note.txt`);
    return response.json();
  }, workspaceId as string);
  expect(hosted.content).toBe("written from RC-067 browser\n");
});