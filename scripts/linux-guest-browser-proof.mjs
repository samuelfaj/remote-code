import { chromium, expect } from "@playwright/test";

const [operation, action] = process.argv.slice(2);
if (!new Set(["observe", "create"]).has(operation) || !action) {
  throw new Error("Usage: node scripts/linux-guest-browser-proof.mjs <observe|create> <action>");
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("http://127.0.0.1:5173/"));
  if (!page) throw new Error("Linux Chromium has no RemoteCode UI open.");
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");

  if (operation === "observe") {
    await expect(page.getByTestId("latest-receipt")).toContainText(action);
  } else {
    await page.getByLabel("Action description").fill(action);
    await page.getByRole("button", { name: "Write backend receipt" }).click();
    await expect(page.getByTestId("latest-receipt")).toContainText(action);
  }

  const receiptText = await page.getByTestId("latest-receipt").innerText();
  const receiptId = receiptText.match(/Receipt ([\w-]+)/)?.[1];
  if (!receiptId) throw new Error("The Linux UI did not show a confirmed receipt ID.");
  process.stdout.write(JSON.stringify({ action, receiptId }));
} finally {
  await browser.close();
}
