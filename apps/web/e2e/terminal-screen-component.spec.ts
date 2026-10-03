import { expect, test, type Page } from "@playwright/test";

// Component tests: they prove the TerminalScreen emulator wrapper only, not PTY, task or backend behavior.
// Buttons feed fixed bytes through the public handle, so they cover the byte boundary, not a real shell.
const fixture = "/e2e/fixtures/terminal-screen.html";

async function feed(page: Page, button: string) {
  const before = Number(await page.locator("#settled").getAttribute("data-count"));
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(page.locator("#settled")).toHaveAttribute("data-count", String(before + 1));
}

const rows = (page: Page) => page.locator(".terminal-screen .xterm-rows > div");
const rowText = async (page: Page, index: number) => ((await rows(page).nth(index).textContent()) ?? "").replaceAll("\u00a0", " ");
// The DOM renderer paints on animation frames, after the write callback.
const expectRow = (page: Page, index: number) => expect.poll(async () => (await rowText(page, index)).trimEnd());

test.beforeEach(async ({ page }) => { await page.goto(fixture); await expect(rows(page).first()).toBeVisible(); });

test("carriage return overwrites cells instead of concatenating", async ({ page }) => {
  await feed(page, "Feed CR overwrite");
  await expectRow(page, 0).toBe("BBAA");
});

test("erase and cursor addressing hit row 35 column 100 after resize and reset", async ({ page }) => {
  await feed(page, "Resize 120x40");
  await expect(rows(page)).toHaveCount(40);
  await feed(page, "Reset screen");
  await expect(rows(page)).toHaveCount(40);
  await feed(page, "Feed erase and cursor");
  await expectRow(page, 34).toBe("x".repeat(99) + "<");
  expect(await rowText(page, 33)).toBe(await rowText(page, 36));
});

test("SGR colours only the red span and the alternate screen restores main content", async ({ page }) => {
  await feed(page, "Feed red text");
  const red = rows(page).first().locator("span.xterm-fg-1");
  await expect(red).toHaveText("red");
  await expectRow(page, 0).toBe("red plain");
  await expect(rows(page).first().locator("span:not(.xterm-fg-1)", { hasText: "plain" })).toBeVisible();

  await feed(page, "Reset screen");
  await feed(page, "Feed main text");
  await feed(page, "Enter alt screen");
  await expectRow(page, 0).toBe("ALT");
  await feed(page, "Leave alt screen");
  await expectRow(page, 0).toBe("MAIN");
});

test("a Euro sign split across writes renders once and reset drops a partial sequence", async ({ page }) => {
  await feed(page, "Feed Euro prefix");
  await feed(page, "Feed Euro byte 1");
  await feed(page, "Feed Euro byte 2");
  await expectRow(page, 0).toBe("euro:");
  await feed(page, "Feed Euro byte 3");
  await feed(page, "Feed Euro suffix");
  await expectRow(page, 0).toBe("euro:€:end");

  await feed(page, "Reset screen");
  await feed(page, "Feed Euro byte 1");
  await feed(page, "Reset screen");
  await feed(page, "Feed Euro byte 3");
  await feed(page, "Feed fresh text");
  await expectRow(page, 0).toBe("FRESH");
});

test("reset with a pending write settles it and leaves no stale output", async ({ page }) => {
  await feed(page, "Pending write then reset");
  await feed(page, "Feed fresh text");
  const screen = await rows(page).allTextContents();
  expect(screen.join("\n")).not.toContain("STALE-OUTPUT");
  await expectRow(page, 0).toBe("FRESH");
});

test("unmount with a pending write settles it and removes the terminal", async ({ page }) => {
  await feed(page, "Pending write then unmount");
  await expect(page.locator("#unmounted")).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toContain("STALE-OUTPUT");
});

test("focusing the screen and typing never calls the backend", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api")) calls.push(request.url()); });
  await page.locator(".terminal-screen").click();
  await expect(page.getByRole("textbox", { name: "Terminal screen focus" })).toBeFocused();
  await page.keyboard.type("ls -la");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+C");
  await feed(page, "Feed fresh text");
  await expectRow(page, 0).toBe("FRESH");
  expect(calls).toEqual([]);
});

test("direct keystrokes forward while gated on, and stay silent while gated off", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api")) calls.push(request.url()); });
  await page.locator(".terminal-screen").click();
  await page.keyboard.type("ab");
  await expect(page.locator("#keys")).toHaveAttribute("data-keys", JSON.stringify(["a", "b"]));
  await feed(page, "Toggle key gate");
  await expect(page.locator("#gate")).toHaveAttribute("data-gated", "true");
  await page.locator(".terminal-screen").click();
  await page.keyboard.type("cd");
  await expect(page.locator("#keys")).toHaveAttribute("data-keys", JSON.stringify(["a", "b"]));
  await feed(page, "Toggle key gate");
  await expect(page.locator("#gate")).toHaveAttribute("data-gated", "false");
  await page.locator(".terminal-screen").click();
  await page.keyboard.press("Enter");
  await expect(page.locator("#keys")).toHaveAttribute("data-keys", JSON.stringify(["a", "b", "\r"]));
  expect(calls).toEqual([]);
});

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`${viewport.name}: 120 columns overflow locally, not the page`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await feed(page, "Resize 120x40");
    await feed(page, "Feed erase and cursor");
    const metrics = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>(".terminal-screen")!;
      const rect = box.getBoundingClientRect();
      return {
        pageScroll: document.documentElement.scrollWidth, viewport: window.innerWidth,
        boxRight: rect.right, boxScroll: box.scrollWidth, boxClient: box.clientWidth,
      };
    });
    expect(metrics.pageScroll).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.boxRight).toBeLessThanOrEqual(metrics.viewport);
    if (viewport.name === "mobile") expect(metrics.boxScroll).toBeGreaterThan(metrics.boxClient);
  });
}
