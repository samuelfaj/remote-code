import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const apiUrl = process.env.RC003_API_URL ?? "http://127.0.0.1:33100";

async function confirmedIds() {
  const response = await fetch(`${apiUrl}/api/actions`);
  if (!response.ok) throw new Error(`Backend read failed: ${response.status}`);
  const { actions } = await response.json() as { actions: Array<{ id: string; action: string }> };
  return actions;
}

test("an external browser gets a backend receipt and renders cleanly on mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");

  const action = `external browser ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);

  const receiptText = await page.getByTestId("latest-receipt").innerText();
  const receiptId = receiptText.match(/Receipt ([\w-]+)/)?.[1];
  expect(receiptId).toBeTruthy();
  expect(await confirmedIds()).toContainEqual({
    id: receiptId,
    action,
    createdAt: expect.any(String),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "One backend, two browsers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Write backend receipt" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a late action-list response does not erase a receipt received over WebSocket", async ({ page }) => {
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  const requestStarted = new Promise<void>((resolve) => { readStarted = resolve; });

  await page.route("**/api/actions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    readStarted();
    await heldRead;
    await route.fulfill({ json: { actions: [] } });
  });

  try {
    await page.goto("/");
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    await requestStarted;

    const action = `websocket receipt ${crypto.randomUUID()}`;
    const response = await page.request.post(`${apiUrl}/api/actions`, { data: { action } });
    expect(response.status()).toBe(201);
    await expect(page.getByTestId("latest-receipt")).toContainText(action);

    releaseRead();
    await expect(page.getByText(action)).toHaveCount(2);
    expect(await confirmedIds()).toContainEqual(expect.objectContaining({ action }));
  } finally {
    releaseRead();
    await page.unroute("**/api/actions");
  }
});

test("Linux guest and external browsers observe receipts from the same backend", async ({ page }) => {
  const guestContainer = process.env.RC003_GUEST_CONTAINER;
  test.skip(!guestContainer, "Set RC003_GUEST_CONTAINER to the running isolated X11 guest.");

  async function useGuest(operation: "observe" | "create", action: string) {
    const output = execFileSync("docker", [
      "exec", guestContainer!, "node", "scripts/linux-guest-browser-proof.mjs", operation, action,
    ], { encoding: "utf8" });
    return JSON.parse(output) as { action: string; receiptId: string };
  }

  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");

  const externalAction = `external ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(externalAction);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(externalAction);
  const externalReceipt = (await page.getByTestId("latest-receipt").innerText()).match(/Receipt ([\w-]+)/)?.[1];
  expect(externalReceipt).toBeTruthy();

  const guestObserved = await useGuest("observe", externalAction);
  expect(guestObserved.receiptId).toBe(externalReceipt);
  expect(await confirmedIds()).toContainEqual(expect.objectContaining({ id: externalReceipt, action: externalAction }));

  const guestAction = `linux guest ${crypto.randomUUID()}`;
  const guestCreated = await useGuest("create", guestAction);
  expect(guestCreated.action).toBe(guestAction);
  await expect(page.getByTestId("latest-receipt")).toContainText(guestAction);
  const guestReceipt = (await page.getByTestId("latest-receipt").innerText()).match(/Receipt ([\w-]+)/)?.[1];
  expect(guestReceipt).toBe(guestCreated.receiptId);
  expect(await confirmedIds()).toContainEqual(expect.objectContaining({ id: guestReceipt, action: guestAction }));
});
