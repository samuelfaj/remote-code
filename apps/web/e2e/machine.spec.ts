import { expect, test, type Page } from "@playwright/test";

const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

const safe = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "-");

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
}

// The machine surface belongs to a workspace, and the sidebar row opens it into
// the selected workspace, so the journey prepares one the shipped way first.
async function openWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: "New Workspace", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-list")).toContainText(name);
  await page.getByTestId(`workspace-item-${safe(name)}`).click();
}

test("the Machine row opens the machine surface and it reports an honest state", async ({ page }) => {
  await signIn(page);
  await openWorkspace(page, `RC machine ${crypto.randomUUID()}`);

  // The sidebar action is the shipped way to reach the surface.
  await page.getByRole("button", { name: "Machine", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Machine", exact: true })).toBeVisible();
  await expect(page.getByTestId("machine-panel")).toBeVisible();

  const unavailable = page.getByTestId("machine-unavailable");
  const status = page.getByTestId("machine-status");

  // On this host there is no VNC server, so the panel must settle on one of two
  // honest outcomes — no desktop, or a real connection — never a fake success.
  await expect
    .poll(async () => {
      if (await unavailable.isVisible()) return "unavailable";
      if ((await status.textContent())?.startsWith("Connected to ")) return "connected";
      return "pending";
    }, { message: "the machine surface reached an honest state", timeout: 20_000 })
    .not.toBe("pending");

  if (await unavailable.isVisible()) {
    await expect(unavailable).toHaveText(/\S/);
  } else {
    await expect(status).toContainText("Connected to ");
  }
});
