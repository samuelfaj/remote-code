import { expect, test, type Page } from "@playwright/test";

const password = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";
const pendingKey = "remotecode.pending-auth";

async function enterPassword(page: Page) {
  await page.getByLabel("Host passphrase").fill(password);
}

async function login(page: Page) {
  await page.goto("/");
  await enterPassword(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
}

async function pending(page: Page) {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), pendingKey);
}

async function startLostCookieLogin(page: Page) {
  let posts = 0;
  let requestId = "";
  await page.route("**/api/auth/login", async (route) => {
    posts++;
    requestId = route.request().postDataJSON().requestId;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await page.context().clearCookies();
    await route.abort("failed");
  });
  await page.goto("/");
  await enterPassword(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revoke old login" })).toBeEnabled();
  expect(posts).toBe(1);
  expect(await pending(page)).toEqual({ kind: "login", requestId });
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(password);
  return requestId;
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport });
    test("persists login/logout IDs before POST and confirms the actual cookie", async ({ page }) => {
      const operations: string[] = [];
      await page.route("**/api/auth/login", async (route) => {
        const body = route.request().postDataJSON();
        expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(await pending(page)).toEqual({ kind: "login", requestId: body.requestId });
        operations.push(body.requestId);
        await route.continue();
      });
      await page.route("**/api/auth/logout", async (route) => {
        const body = route.request().postDataJSON();
        expect(await pending(page)).toEqual({ kind: "logout", requestId: body.requestId });
        operations.push(body.requestId);
        await route.continue();
      });
      await login(page);
      const session = await (await page.request.get("/api/auth/session")).json();
      expect(session.loginRequestId).toBe(operations[0]);
      expect(await pending(page)).toBeNull();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
      expect(await pending(page)).toBeNull();
      expect(new Set(operations).size).toBe(2);
    });

    test("preflight deadline starts at the Sign in tap and permits only an explicit retry", async ({ page }) => {
      let versionRequests = 0;
      let loginPosts = 0;
      let holdCapability = true;
      let capabilityEntered = false;
      let releaseCapability: (() => void) | undefined;
      let markCapabilityStarted: (() => void) | undefined;
      let markRouteFinished: (() => void) | undefined;
      const capabilityGate = new Promise<void>((resolve) => { releaseCapability = resolve; });
      const capabilityStarted = new Promise<void>((resolve) => { markCapabilityStarted = resolve; });
      const routeFinished = new Promise<void>((resolve) => { markRouteFinished = resolve; });
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/login") loginPosts++;
      });
      await page.goto("/");
      const signIn = page.getByRole("button", { name: "Sign in", exact: true });
      await expect(signIn).toBeEnabled();
      await enterPassword(page);
      await page.route("**/api/version", async (route) => {
        versionRequests++;
        if (!holdCapability) {
          await route.continue();
          return;
        }
        holdCapability = false;
        capabilityEntered = true;
        try {
          const response = await route.fetch();
          markCapabilityStarted?.();
          await capabilityGate;
          await route.fulfill({ response }).catch(() => {});
        } finally {
          markRouteFinished?.();
        }
      });

      try {
        const tapStarted = Date.now();
        const capabilityRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/version", { timeout: 5_000 });
        await signIn.click();
        await capabilityRequest;
        await capabilityStarted;
        const recovery = page.getByTestId("auth-recovery-status");
        await expect(recovery).toContainText("The sign-in deadline expired before the host could be checked. No login request was sent.", { timeout: 15_000 });
        const elapsed = Date.now() - tapStarted;
        expect(elapsed).toBeGreaterThanOrEqual(12_500);
        expect(elapsed).toBeLessThan(14_500);
        expect(loginPosts).toBe(0);
        expect(await pending(page)).toBeNull();
        expect(await page.context().cookies()).toEqual([]);
        expect(await page.request.get("/api/auth/session").then((response) => response.status())).toBe(401);

        releaseCapability?.();
        if (capabilityEntered) await routeFinished;
        expect(versionRequests).toBe(1);
        expect(loginPosts).toBe(0);
        expect(await pending(page)).toBeNull();
        await expect(recovery).toContainText("No login request was sent");

        await enterPassword(page);
        await signIn.click();
        await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15_000 });
        expect(versionRequests).toBe(2);
        expect(loginPosts).toBe(1);
        const session = await (await page.request.get("/api/auth/session")).json();
        expect(session.loginRequestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(await pending(page)).toBeNull();
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await expect(signIn).toBeEnabled();
        expect(await page.request.get("/api/auth/session").then((response) => response.status())).toBe(401);
      } finally {
        releaseCapability?.();
        if (capabilityEntered) await routeFinished;
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    for (const failure of ["503 unknown outcome", "network error"]) {
      test(`immediate capability preflight ${failure} reports unreachable host, not deadline expiry`, async ({ page }) => {
        let versionRequests = 0;
        let loginPosts = 0;
        page.on("request", (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/login") loginPosts++;
        });
        await page.goto("/");
        const signIn = page.getByRole("button", { name: "Sign in", exact: true });
        await expect(signIn).toBeEnabled();
        await page.route("**/api/version", async (route) => {
          versionRequests++;
          if (failure === "503 unknown outcome") {
            await route.fulfill({ status: 503, json: { error: "request_outcome_unknown" } });
          } else {
            await route.abort("failed");
          }
        });
        await enterPassword(page);
        const tapStarted = Date.now();
        const versionRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/version", { timeout: 5_000 });
        await signIn.click();
        await versionRequest;
        await expect(page.getByTestId("auth-recovery-status")).toHaveText("The host could not be checked. No login request was sent. Try again when the host is reachable.");
        expect(Date.now() - tapStarted).toBeLessThan(5_000);
        expect(await pending(page)).toBeNull();
        expect(await page.context().cookies()).toEqual([]);
        expect(await page.request.get("/api/auth/session").then((response) => response.status())).toBe(401);
        await expect(page.getByTestId("connection-status")).toHaveCount(0);
        await expect(signIn).toBeEnabled();
        expect(versionRequests).toBe(1);
        expect(loginPosts).toBe(0);
      });
    }

    test("login POST that crosses the tap deadline stays unknown and is never replayed", async ({ page }) => {
      let loginPosts = 0;
      let holdLogin = true;
      let loginRouteEntered = false;
      let loginRequestId = "";
      let releaseLogin: (() => void) | undefined;
      let markLoginStarted: (() => void) | undefined;
      let markRouteFinished: (() => void) | undefined;
      const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
      const loginStarted = new Promise<void>((resolve) => { markLoginStarted = resolve; });
      const routeFinished = new Promise<void>((resolve) => { markRouteFinished = resolve; });
      let holdReceiptLookups = true;
      let receiptLookups = 0;
      let releaseReceiptLookups: (() => void) | undefined;
      let markReceiptLookupStarted: (() => void) | undefined;
      const receiptLookupGate = new Promise<void>((resolve) => { releaseReceiptLookups = resolve; });
      const receiptLookupStarted = new Promise<void>((resolve) => { markReceiptLookupStarted = resolve; });
      const heldReceiptHandlers: Promise<void>[] = [];
      await page.goto("/");
      const signIn = page.getByRole("button", { name: "Sign in", exact: true });
      await expect(signIn).toBeEnabled();
      await enterPassword(page);
      await page.route("**/api/auth/login", async (route) => {
        loginPosts++;
        const body = route.request().postDataJSON();
        if (!holdLogin) {
          await route.continue();
          return;
        }
        holdLogin = false;
        loginRouteEntered = true;
        loginRequestId = body.requestId;
        markLoginStarted?.();
        try {
          await loginGate;
          await route.abort("failed").catch(() => {});
        } finally {
          markRouteFinished?.();
        }
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        if (!holdReceiptLookups) {
          await route.continue();
          return;
        }
        receiptLookups++;
        markReceiptLookupStarted?.();
        let finish!: () => void;
        heldReceiptHandlers.push(new Promise<void>((resolve) => { finish = resolve; }));
        try {
          await receiptLookupGate;
          await route.abort("failed").catch(() => {});
        } finally {
          finish();
        }
      });

      try {
        const tapStarted = Date.now();
        await signIn.click();
        await loginStarted;
        await receiptLookupStarted;
        expect(loginRequestId).toMatch(/^[a-f0-9-]{36}$/);
        const recovery = page.getByTestId("auth-recovery-status");
        await expect(recovery).toHaveText(/^(The auth outcome is unknown\. Check its receipt later without resending\.|No auth receipt is confirmed yet\.)/, { timeout: 15_000 });
        const elapsed = Date.now() - tapStarted;
        expect(elapsed).toBeGreaterThanOrEqual(12_500);
        expect(elapsed).toBeLessThan(14_500);
        expect(loginPosts).toBe(1);
        expect(receiptLookups).toBe(2);
        expect(await pending(page)).toEqual({ kind: "login", requestId: loginRequestId });
        expect(await page.context().cookies()).toEqual([]);
        expect(await page.request.get("/api/auth/session").then((response) => response.status())).toBe(401);

        holdReceiptLookups = false;
        releaseLogin?.();
        releaseReceiptLookups?.();
        if (loginRouteEntered) await routeFinished;
        await Promise.all(heldReceiptHandlers);
        expect(loginPosts).toBe(1);
        expect(await pending(page)).toEqual({ kind: "login", requestId: loginRequestId });
        const missingReceipt = await page.request.post(`/api/auth/receipts/${loginRequestId}/lookup`, { data: { password } });
        expect(missingReceipt.status()).toBe(404);
        expect(await missingReceipt.json()).toMatchObject({ error: "receipt_not_found" });

        await enterPassword(page);
        await page.getByRole("button", { name: "Check auth receipt" }).click();
        await expect(recovery).toContainText("No auth receipt is confirmed yet");
        expect(await pending(page)).toEqual({ kind: "login", requestId: loginRequestId });
        await expect(signIn).toBeDisabled();
        await enterPassword(page);
        await page.getByRole("button", { name: "Revoke old login" }).click();
        await expect(recovery).toContainText("Confirmed old login revoked or fenced.");
        expect(await pending(page)).toBeNull();

        await enterPassword(page);
        await signIn.click();
        await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15_000 });
        const session = await (await page.request.get("/api/auth/session")).json();
        expect(session.loginRequestId).not.toBe(loginRequestId);
        expect(loginPosts).toBe(2);
        expect(await pending(page)).toBeNull();
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await expect(signIn).toBeEnabled();
        expect(await page.request.get("/api/auth/session").then((response) => response.status())).toBe(401);
      } finally {
        holdReceiptLookups = false;
        releaseLogin?.();
        releaseReceiptLookups?.();
        if (loginRouteEntered) await routeFinished;
        await Promise.all(heldReceiptHandlers);
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("lost login cookie survives reload; credential lookup never authenticates and explicit revocation permits a distinct login", async ({ page }) => {
      let loginId = "";
      let posts = 0;
      await page.route("**/api/auth/login", async (route) => {
        posts++;
        loginId = route.request().postDataJSON().requestId;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await page.context().clearCookies();
        await route.abort("failed");
      });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("no matching cookie");
      await page.context().clearCookies();
      await page.reload();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      expect(await pending(page)).toEqual({ kind: "login", requestId: loginId });
      await enterPassword(page);
      await page.getByRole("button", { name: "Check auth receipt" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("matching cookie");
      await expect(page.getByTestId("connection-status")).toHaveCount(0);
      expect(posts).toBe(1);
      await enterPassword(page);
      await page.getByRole("button", { name: "Revoke old login" }).click();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
      const receipt = await page.request.post(`/api/auth/receipts/${loginId}/lookup`, { data: { password } });
      expect((await receipt.json()).sessionStatus).toBe("inactive");
      await page.unroute("**/api/auth/login");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
      expect((await (await page.request.get("/api/auth/session")).json()).loginRequestId).not.toBe(loginId);
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(password);
    });

    test("unknown login body automatically confirms only the matching cookie", async ({ page }) => {
      let posts = 0;
      await page.route("**/api/auth/login", async (route) => {
        posts++;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.fulfill({ response, body: "" });
      });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected", { timeout: 15_000 });
      expect(await pending(page)).toBeNull();
      expect(posts).toBe(1);
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(password);
    });

    test("unknown login with lost cookie consults receipt without authenticating or retrying", async ({ page }) => {
      let posts = 0;
      let lookups = 0;
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        lookups++;
        expect(route.request().postDataJSON()).toEqual({ password });
        await route.continue();
      });
      await page.route("**/api/auth/login", async (route) => {
        posts++;
        expect((await route.fetch()).status()).toBe(200);
        await page.context().clearCookies();
        await route.abort("failed");
      });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("no matching cookie", { timeout: 15_000 });
      expect(lookups).toBe(1);
      expect(posts).toBe(1);
      expect((await pending(page)).kind).toBe("login");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      await expect(page.getByTestId("connection-status")).toHaveCount(0);
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(password);
    });

    test("unknown login and missing receipt remain pending after automatic lookups", async ({ page }) => {
      let posts = 0;
      let lookups = 0;
      await page.route("**/api/auth/login", async (route) => { posts++; await route.abort("failed"); });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => { lookups++; await route.continue(); });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("No auth receipt", { timeout: 15_000 });
      expect(posts).toBe(1);
      expect(lookups).toBe(2);
      expect((await pending(page)).kind).toBe("login");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    });

    test("a delayed login receipt is confirmed on the second automatic read without resending", async ({ page }) => {
      let posts = 0;
      let lookups = 0;
      // Commit the login, then lose the response and cookie so the browser
      // must observe the receipt rather than authenticate from the session.
      await page.route("**/api/auth/login", async (route) => {
        posts++;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await page.context().clearCookies();
        await route.abort("failed");
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        lookups++;
        expect(route.request().postDataJSON()).toEqual({ password });
        if (lookups === 1) {
          await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
        } else {
          await route.continue();
        }
      });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("no matching cookie", { timeout: 20_000 });
      expect(posts).toBe(1);
      expect(lookups).toBe(2);
      const operation = await pending(page);
      expect(operation.kind).toBe("login");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      await expect(page.getByTestId("connection-status")).toHaveCount(0);
      expect((await page.request.get("/api/auth/session")).status()).toBe(401);
      const receipt = await page.request.post(`/api/auth/receipts/${operation.requestId}/lookup`, { data: { password } });
      expect(receipt.status()).toBe(200);
      expect(await receipt.json()).toMatchObject({
        receipt: { requestId: operation.requestId, kind: "login", outcome: "session_created" },
      });
    });

    test("stalled automatic receipt lookup ends with an unknown pending login", async ({ page }) => {
      let posts = 0;
      let lookups = 0;
      await page.route("**/api/auth/login", async (route) => { posts++; await route.abort("failed"); });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        lookups++;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await route.abort("failed").catch(() => {});
      });
      await page.goto("/");
      await enterPassword(page);
      const started = Date.now();
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("button", { name: "Check auth receipt" })).toBeEnabled({ timeout: 15_000 });
      await expect(page.getByTestId("auth-recovery-status")).toContainText("remains unknown; do not resend");
      expect(Date.now() - started).toBeLessThan(11_000);
      expect(posts).toBe(1);
      expect(lookups).toBe(2);
      expect((await pending(page)).kind).toBe("login");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      await expect(page.getByTestId("connection-status")).toHaveCount(0);
    });

    test("lost logout response is looked up after reload without revoking a newer session", async ({ page }) => {
      await login(page);
      let posts = 0;
      let logoutId = "";
      await page.route("**/api/auth/logout", async (route) => {
        posts++;
        logoutId = route.request().postDataJSON().requestId;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort("failed");
      });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("unknown");
      const newerId = crypto.randomUUID();
      expect((await page.request.post("/api/auth/login", { data: { password, requestId: newerId } })).status()).toBe(200);
      await page.reload();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      expect(await pending(page)).toEqual({ kind: "logout", requestId: logoutId });
      await page.getByRole("button", { name: "Check auth receipt" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed logout");
      expect(posts).toBe(1);
      expect((await (await page.request.get("/api/auth/session")).json()).loginRequestId).toBe(newerId);
      await page.reload();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    });

    test("lost body with retained cookie is recovered by matching session after reload", async ({ page }) => {
      let posts = 0;
      await page.route("**/api/auth/login", async (route) => {
        posts++;
        const response = await route.fetch();
        await route.fulfill({ response, body: "" });
      });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
      const id = (await (await page.request.get("/api/auth/session")).json()).loginRequestId;
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      await page.reload();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
      expect(posts).toBe(1);
      expect(await pending(page)).toBeNull();
    });

    test("an older session observation cannot confirm the new login", async ({ page }) => {
      const oldId = crypto.randomUUID();
      await page.request.post("/api/auth/login", { data: { password, requestId: oldId } });
      const oldSession = await (await page.request.get("/api/auth/session")).json();
      await page.context().clearCookies();
      await page.goto("/");
      await expect(page.getByLabel("Host passphrase")).toBeVisible();
      await page.route("**/api/auth/session", (route) => route.fulfill({ json: oldSession }));
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("no matching cookie");
      await expect(page.getByTestId("connection-status")).toHaveCount(0);
      expect((await pending(page)).requestId).not.toBe(oldId);
      await page.unroute("**/api/auth/session");
      await page.getByRole("button", { name: "Check auth receipt" }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    });

    test("a committed targeted revocation is confirmed by its delayed receipt without resending", async ({ page }) => {
      let revokePosts = 0;
      let revokeLookups = 0;
      let revokeId = "";
      const loginId = await startLostCookieLogin(page);
      await page.route("**/api/auth/login/*/revoke", async (route) => {
        revokePosts++;
        revokeId = route.request().postDataJSON().requestId;
        expect(route.request().postDataJSON().password).toBe(password);
        expect((await route.fetch()).status()).toBe(200);
        await route.abort("failed");
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        expect(route.request().postDataJSON()).toEqual({ password });
        const path = new URL(route.request().url()).pathname;
        if (revokeId && path.endsWith(`/receipts/${revokeId}/lookup`)) {
          revokeLookups++;
          if (revokeLookups === 1) {
            await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
          } else {
            await route.continue();
          }
        } else {
          await route.continue();
        }
      });
      await enterPassword(page);
      const started = Date.now();
      await page.getByRole("button", { name: "Revoke old login" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed old login revoked", { timeout: 15_000 });
      expect(Date.now() - started).toBeLessThan(13_000);
      expect(revokePosts).toBe(1);
      expect(revokeLookups).toBe(2);
      expect(await pending(page)).toBeNull();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
      expect((await page.request.get("/api/auth/session")).status()).toBe(401);
      const receipt = await page.request.post(`/api/auth/receipts/${revokeId}/lookup`, { data: { password } });
      expect(receipt.status()).toBe(200);
      expect(await receipt.json()).toMatchObject({
        receipt: { requestId: revokeId, kind: "revoke_login", targetRequestId: loginId, outcome: "login_revoked" },
        sessionStatus: "not_applicable",
      });
    });

    test("a missing targeted revocation receipt stays unknown without resending", async ({ page }) => {
      let revokePosts = 0;
      let revokeLookups = 0;
      let revokeId = "";
      const loginId = await startLostCookieLogin(page);
      await page.route("**/api/auth/login/*/revoke", async (route) => {
        revokePosts++;
        revokeId = route.request().postDataJSON().requestId;
        await route.abort("failed");
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (revokeId && path.endsWith(`/receipts/${revokeId}/lookup`)) revokeLookups++;
        await route.continue();
      });
      await enterPassword(page);
      const started = Date.now();
      await page.getByRole("button", { name: "Revoke old login" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("remains unknown; do not resubmit", { timeout: 10_000 });
      expect(Date.now() - started).toBeLessThan(13_000);
      expect(revokePosts).toBe(1);
      expect(revokeLookups).toBe(2);
      expect(await pending(page)).toMatchObject({ kind: "revoke_login", targetRequestId: loginId });
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      await expect(page.getByTestId("connection-status")).toHaveCount(0);
      expect((await page.request.get("/api/auth/session")).status()).toBe(401);
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(password);
    });

    test("stalled targeted-revocation receipt reads leave the committed result unknown", async ({ page }) => {
      let revokePosts = 0;
      let receiptLookups = 0;
      let revokeId = "";
      const loginId = await startLostCookieLogin(page);
      await page.route("**/api/auth/login/*/revoke", async (route) => {
        revokePosts++;
        revokeId = route.request().postDataJSON().requestId;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort("failed");
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (revokeId && path.endsWith(`/receipts/${revokeId}/lookup`)) {
          receiptLookups++;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          await route.abort("failed").catch(() => {});
        } else {
          await route.continue();
        }
      });
      await enterPassword(page);
      const started = Date.now();
      await page.getByRole("button", { name: "Revoke old login" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("No revocation receipt is confirmed yet", { timeout: 15_000 });
      expect(Date.now() - started).toBeLessThan(11_000);
      expect(revokePosts).toBe(1);
      expect(receiptLookups).toBe(2);
      expect(await pending(page)).toMatchObject({ kind: "revoke_login", targetRequestId: loginId });
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      expect((await page.request.get("/api/auth/session")).status()).toBe(401);
      const receipt = await page.request.post(`/api/auth/receipts/${revokeId}/lookup`, { data: { password } });
      expect(await receipt.json()).toMatchObject({ receipt: { requestId: revokeId, outcome: "login_revoked", targetRequestId: loginId } });
    });

    test("a mismatched targeted-revocation receipt does not clear the pending operation", async ({ page }) => {
      let revokePosts = 0;
      let receiptLookups = 0;
      const loginId = await startLostCookieLogin(page);
      let revokeId = "";
      await page.route("**/api/auth/login/*/revoke", async (route) => {
        revokePosts++;
        revokeId = route.request().postDataJSON().requestId;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort("failed");
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (revokeId && path.endsWith(`/receipts/${revokeId}/lookup`)) {
          receiptLookups++;
          await route.fulfill({ json: {
            receipt: { requestId: revokeId, kind: "revoke_login", targetRequestId: crypto.randomUUID(), outcome: "login_revoked", createdAt: new Date().toISOString(), expiresAt: null },
            sessionStatus: "not_applicable",
          } });
        } else {
          await route.continue();
        }
      });
      await enterPassword(page);
      await page.getByRole("button", { name: "Revoke old login" }).click();
      await expect(page.getByRole("button", { name: "Check auth receipt" })).toBeEnabled();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("Check its receipt later without resending");
      expect(revokePosts).toBe(1);
      expect(receiptLookups).toBe(1);
      expect(await pending(page)).toMatchObject({ kind: "revoke_login", targetRequestId: loginId });
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      expect((await page.request.get("/api/auth/session")).status()).toBe(401);
      const receipt = await page.request.post(`/api/auth/receipts/${revokeId}/lookup`, { data: { password } });
      expect(await receipt.json()).toMatchObject({ receipt: { requestId: revokeId, kind: "revoke_login", targetRequestId: loginId, outcome: "login_revoked" } });
    });

    for (const malformed of [
      { label: "missing createdAt", createdAt: undefined },
      { label: "non-ISO but parseable createdAt", createdAt: "September 28, 2026" },
    ]) {
      test(`a matching targeted-revocation receipt with ${malformed.label} remains unknown`, async ({ page }) => {
        let revokePosts = 0;
        let receiptLookups = 0;
        let revokeId = "";
        const loginId = await startLostCookieLogin(page);
        await page.route("**/api/auth/login/*/revoke", async (route) => {
          revokePosts++;
          revokeId = route.request().postDataJSON().requestId;
          expect((await route.fetch()).status()).toBe(200);
          await route.abort("failed");
        });
        await page.route("**/api/auth/receipts/*/lookup", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (revokeId && path.endsWith(`/receipts/${revokeId}/lookup`)) {
            receiptLookups++;
            await route.fulfill({ json: {
              receipt: {
                requestId: revokeId,
                kind: "revoke_login",
                targetRequestId: loginId,
                outcome: "login_revoked",
                ...(malformed.createdAt === undefined ? {} : { createdAt: malformed.createdAt }),
                expiresAt: null,
              },
              sessionStatus: "not_applicable",
            } });
          } else {
            await route.continue();
          }
        });
        await enterPassword(page);
        await page.getByRole("button", { name: "Revoke old login" }).click();
        await expect(page.getByRole("button", { name: "Check auth receipt" })).toBeEnabled();
        await expect(page.getByTestId("auth-recovery-status")).toContainText("Check its receipt later without resending");
        expect(revokePosts).toBe(1);
        expect(receiptLookups).toBe(1);
        expect(await pending(page)).toMatchObject({ kind: "revoke_login", targetRequestId: loginId });
        await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
        expect((await page.request.get("/api/auth/session")).status()).toBe(401);
        expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(password);
        const receipt = await page.request.post(`/api/auth/receipts/${revokeId}/lookup`, { data: { password } });
        expect(await receipt.json()).toMatchObject({
          receipt: { requestId: revokeId, kind: "revoke_login", targetRequestId: loginId, outcome: "login_revoked" },
          sessionStatus: "not_applicable",
        });
      });
    }

    test("lost targeted revocation response is recovered without repeating the mutation", async ({ page }) => {
      let posts = 0;
      let revokeId = "";
      let revokeLookups = 0;
      const loginId = await startLostCookieLogin(page);
      await page.route("**/api/auth/login/*/revoke", async (route) => {
        posts++;
        revokeId = route.request().postDataJSON().requestId;
        expect(await pending(page)).toEqual({ kind: "revoke_login", requestId: revokeId, targetRequestId: loginId });
        expect((await route.fetch()).status()).toBe(200);
        await route.abort();
      });
      await page.route("**/api/auth/receipts/*/lookup", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (revokeId && path.endsWith(`/receipts/${revokeId}/lookup`)) {
          revokeLookups++;
          if (revokeLookups <= 2) {
            await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
            return;
          }
        }
        await route.continue();
      });
      await enterPassword(page);
      await page.getByRole("button", { name: "Revoke old login" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("remains unknown; do not resubmit", { timeout: 10_000 });
      expect(revokeLookups).toBe(2);
      expect((await pending(page)).kind).toBe("revoke_login");
      await page.reload();
      await page.getByLabel("Host passphrase").fill("wrong-password");
      await page.getByRole("button", { name: "Check auth receipt" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("current host passphrase");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      await enterPassword(page);
      await page.getByRole("button", { name: "Check auth receipt" }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed old login revoked");
      expect(posts).toBe(1);
      expect(revokeLookups).toBe(4);
      expect(await pending(page)).toBeNull();
    });

    test("missing receipt remains unknown and explicit fence rejects the delayed original login", async ({ page }) => {
      let release!: () => void;
      let arrived!: () => void;
      let finished!: (status: number) => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { arrived = resolve; });
      const delivered = new Promise<number>((resolve) => { finished = resolve; });
      let posts = 0;
      await page.route("**/api/auth/login", async (route) => {
        posts++;
        arrived();
        await held;
        const response = await route.fetch();
        finished(response.status());
        await route.fulfill({ response }).catch(() => {});
      });
      try {
        await page.goto("/");
        await enterPassword(page);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await ready;
        await expect(page.getByRole("button", { name: "Check auth receipt" })).toBeEnabled({ timeout: 15_000 });
        await enterPassword(page);
        await page.getByRole("button", { name: "Check auth receipt" }).click();
        await expect(page.getByTestId("auth-recovery-status")).toContainText("No auth receipt");
        await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
        await enterPassword(page);
        await page.getByRole("button", { name: "Revoke old login" }).click();
        await expect(page.getByTestId("auth-recovery-status")).toContainText("Confirmed old login revoked");
        release();
        expect(await delivered).toBe(409);
        expect(posts).toBe(1);
        expect((await page.request.get("/api/auth/session")).status()).toBe(401);
        await expect(page.getByTestId("connection-status")).toHaveCount(0);
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });

    test("storage failure and missing capability prevent auth mutations", async ({ page }) => {
      let posts = 0;
      page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/auth/login")) posts++; });
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => { throw new Error("storage denied"); };
      });
      await page.goto("/");
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("Browser storage");
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      expect(posts).toBe(0);
      await page.route("**/api/version", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({ response, json: { ...data, capabilities: data.capabilities.filter((item: string) => item !== "auth-request-recovery-v1") } });
      });
      await page.reload();
      await expect(page.getByText("This host does not confirm auth-request-recovery-v1. Update the host and reload before signing in or out.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
      expect(posts).toBe(0);
    });

    test("definitive wrong-password rejection permits an explicit distinct attempt", async ({ page }) => {
      const ids: string[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/auth/login")) ids.push(request.postDataJSON().requestId); });
      await page.goto("/");
      await page.getByLabel("Host passphrase").fill("wrong-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("auth-recovery-status")).toContainText("rejected before acceptance");
      expect(await pending(page)).toBeNull();
      await enterPassword(page);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
      expect(new Set(ids).size).toBe(2);
    });
  });
}
