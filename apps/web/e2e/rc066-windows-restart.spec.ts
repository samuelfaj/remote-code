import { expect, test } from "@playwright/test";

// RC-066's Windows browser leg for the injected-failure column: the browser saves
// a file, the host's API is restarted underneath it, and the browser has to read
// the same file back afterwards with exactly one effect. The restart itself is
// driven from the machine that owns the host (scripts/rc066/run-windows-restart-proof.sh),
// which watches for the workspace this spec creates.
const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";
const marker = process.env.RC066_RESTART_MARKER ?? "RC066-WIN-RESTART";

test.skip(
  process.env.RC054_LINUX_HOST !== "1",
  "this leg needs a Linux host whose API can be restarted; set RC066_LINUX_HOST=1 (see scripts/rc066/run-windows-restart-proof.sh)",
);

test("saves a file, survives an API restart and reads it back once", async ({ page }) => {
  test.setTimeout(300_000);
  const browser = process.env.RC054_BROWSER ?? "chromium";
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 20_000 });
  await expect(page.getByTestId("workspace-panel")).toBeVisible();

  const stamp = crypto.randomUUID().slice(0, 8);
  const workspaceName = `${marker} ${browser} ${stamp}`;
  await page.getByLabel("Workspace name", { exact: true }).fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(workspaceName, { timeout: 20_000 });

  const rowTestId = `workspace-item-${workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  await page.getByTestId(rowTestId).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(workspaceName);
  await page.getByRole("button", { name: "Prepare workspace folder" }).click();
  await expect(page.getByTestId("folder-status")).toContainText("Folder provisioned on Linux", { timeout: 60_000 });

  const fileName = "rc066-restart-note.txt";
  const content = "written before the restart\n";
  await page.getByLabel("New file path").fill(fileName);
  await page.getByRole("button", { name: "Create file" }).click();
  await expect(page.getByTestId("file-status")).toContainText("CREATE receipt confirmed", { timeout: 30_000 });
  await page.getByRole("button", { name: "Refresh folder and files" }).click();
  await page.getByRole("button", { name: `Open file ${fileName}` }).click();
  await page.getByLabel("File draft").fill(content);
  await page.getByRole("button", { name: "Save file" }).click();
  await expect(page.getByTestId("file-status")).toContainText(`SAVE receipt confirmed for ${fileName}`, { timeout: 30_000 });

  // The workspace exists now, which is what the driving machine waits for before
  // it restarts the API. This side watches the host go away and come back: a
  // request that fails is the restart beginning, and the same request answering
  // again is the restart over.
  const ready = async () => page.evaluate(async () => {
    try {
      const response = await fetch("/api/health/ready", { cache: "no-store" });
      return response.ok ? "ready" : `status ${response.status}`;
    } catch (error) {
      return `unreachable: ${String(error).slice(0, 60)}`;
    }
  });
  await expect.poll(async () => (await ready()) !== "ready", {
    message: "the host should go away while the restart runs",
    timeout: 120_000,
    intervals: [1_000],
  }).toBe(true);
  await expect.poll(ready, {
    message: "the host should answer again after the restart",
    timeout: 120_000,
    intervals: [1_000],
  }).toBe("ready");

  // Read the file back through the app after the restart.
  await page.reload();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 30_000 });
  await page.getByTestId(rowTestId).click();
  await expect(page.getByTestId("selected-workspace")).toContainText(workspaceName, { timeout: 20_000 });
  await page.getByRole("button", { name: "Refresh folder and files" }).click();
  await page.getByRole("button", { name: `Open file ${fileName}` }).click();
  await expect(page.getByLabel("File draft")).toHaveValue(content, { timeout: 30_000 });
  await expect(page.getByTestId("file-status")).toContainText("read from the host", { timeout: 30_000 });

  // Exactly one effect: the file listing after the restart holds one entry for it.
  const listing = await page.evaluate(async (name: string) => {
    const response = await fetch("/api/workspaces", { cache: "no-store" });
    const body = await response.json();
    return { status: response.status, names: (body.workspaces ?? []).map((entry: { name: string }) => entry.name), wanted: name };
  }, workspaceName);
  expect(listing.status).toBe(200);
  expect(listing.names.filter((name: string) => name === workspaceName)).toHaveLength(1);
});