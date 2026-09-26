import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { expect, test } from "@playwright/test";

const apiUrl = process.env.RC003_API_URL ?? "http://127.0.0.1:37117";
const webUrl = process.env.RC003_WEB_URL ?? "http://127.0.0.1:37118";
const authPassword = process.env.RC003_AUTH_PASSWORD ?? "remotecode-e2e-passphrase";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(authPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
}

test("rejects canonical and normalized cleartext login paths from a non-loopback interface", async () => {
  const address = Object.values(networkInterfaces()).flat().find((item) => item?.family === "IPv4" && !item.internal)?.address;
  test.skip(!address, "No non-loopback IPv4 interface is available for ingress verification.");
  const port = Number(new URL(webUrl).port);
  const responses = await Promise.all(["/api/auth/login", "/api/auth/./login"].map((path) =>
    new Promise<{ status: number; setCookie?: string }>((resolve, reject) => {
      const request = httpRequest({ hostname: address, port, path, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0, setCookie: response.headers["set-cookie"]?.toString() }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ password: authPassword }));
    }),
  ));
  expect(responses.map((response) => response.status)).toEqual([403, 403]);
  expect(responses.every((response) => !response.setCookie)).toBe(true);
});

async function confirmedIds(page: import("@playwright/test").Page) {
  const response = await page.request.get(`${apiUrl}/api/actions`);
  if (!response.ok) throw new Error(`Backend read failed: ${response.status}`);
  const { actions } = await response.json() as { actions: Array<{ id: string; action: string }> };
  return actions;
}

test("the frozen previous client receives snapshots and live action events from the current server", async ({ page }) => {
  const socketUrls: string[] = [];
  page.on("websocket", (socket) => socketUrls.push(socket.url()));
  await page.goto("/e2e/fixtures/legacy-client.html");
  await page.getByLabel("Host passphrase").fill(authPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Legacy client connected")).toBeVisible();
  const actionSockets = socketUrls.filter((url) => new URL(url).pathname === "/api/events");
  expect(actionSockets).toHaveLength(1);
  expect(new URL(actionSockets[0]!).searchParams.has("clientVersion")).toBe(false);

  const externalAction = `current server event for legacy client ${crypto.randomUUID()}`;
  const response = await page.request.post(`${apiUrl}/api/actions`, { data: { action: externalAction } });
  expect(response.status()).toBe(201);
  await expect(page.locator("#status")).toContainText("Legacy event received at cursor");
  await expect(page.locator("#receipt")).toHaveText(externalAction);

  const previousCursor = Number((await page.locator("#status").innerText()).match(/cursor ([0-9]+)/)?.[1]);
  const legacyAction = `previous client write ${crypto.randomUUID()}`;
  await page.locator("#action").fill(legacyAction);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.locator("#status")).toContainText(`cursor ${previousCursor + 1}`);
  await expect(page.locator("#receipt")).toHaveText(legacyAction);
  expect(await confirmedIds(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: externalAction }),
    expect.objectContaining({ action: legacyAction }),
  ]));
});

test("shows the server's actionable compatibility response before login", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => {
    const headers = { ...route.request().headers(), "x-remotecode-client-version": "99" };
    void route.continue({ headers });
  });
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(authPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This RemoteCode client version is not supported. Update the host or use a supported client version.")).toBeVisible();
  expect(await page.context().cookies()).toEqual([]);
});

test("shows actionable guidance when the current client's event socket is rejected", async ({ page }) => {
  await page.routeWebSocket("**/api/events?clientVersion=1", (socket) => {
    socket.close({ code: 4406, reason: "unsupported client version" });
  });
  await page.goto("/");
  await page.getByLabel("Host passphrase").fill(authPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This RemoteCode client version is not supported. Update the host or use a supported client version.")).toBeVisible();
});

test("shows compatibility guidance when initial session validation is rejected", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => {
    const headers = { ...route.request().headers(), "x-remotecode-client-version": "99" };
    void route.continue({ headers });
  });
  await page.goto("/");
  await expect(page.getByText("This RemoteCode client version is not supported. Update the host or use a supported client version.")).toBeVisible();
  expect(await page.context().cookies()).toEqual([]);
});

test("shows compatibility guidance during reconnect without restoring private state or writing", async ({ page }) => {
  let disconnect!: () => void;
  let actionPosts = 0;
  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    disconnect = () => socket.close();
  });
  await page.route("**/api/actions", (route) => {
    if (route.request().method() === "POST") actionPosts += 1;
    void route.continue();
  });
  await signIn(page);
  const action = `clear before incompatible reconnect ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);
  const actionPostsBeforeReconnect = actionPosts;
  disconnect();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates disconnected");
  await expect(page.getByText("No action has been recorded in this session.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect live updates" })).toBeEnabled();
  await page.route("**/api/auth/session", (route) => {
    const headers = { ...route.request().headers(), "x-remotecode-client-version": "99" };
    void route.continue({ headers });
  });
  await page.getByRole("button", { name: "Reconnect live updates" }).click();
  await expect(page.getByText("This RemoteCode client version is not supported. Update the host or use a supported client version.")).toBeVisible();
  await expect(page.getByText("The host session expired or was revoked.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
  await expect(page.getByText(action, { exact: true })).toHaveCount(0);
  expect(actionPosts).toBe(actionPostsBeforeReconnect);
});

test("renders shared API health and reports a failed request", async ({ page }) => {
  await signIn(page);

  await expect(page.getByTestId("host-health-status")).toHaveText("API ready");
  await page.route("**/api/health/ready", (route) => route.abort());
  await page.getByRole("button", { name: "Refresh host health" }).click();
  await expect(page.getByTestId("host-health-status")).toHaveText("API health unavailable");
  await page.unroute("**/api/health/ready");
  await page.getByRole("button", { name: "Refresh host health" }).click();
  await expect(page.getByTestId("host-health-status")).toHaveText("API ready");
});

test("an external browser gets a backend receipt and renders cleanly on mobile", async ({ page }) => {
  await signIn(page);

  const action = `external browser ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);

  const receiptText = await page.getByTestId("latest-receipt").innerText();
  const receiptId = receiptText.match(/Receipt ([\w-]+)/)?.[1];
  expect(receiptId).toBeTruthy();
  expect(await confirmedIds(page)).toContainEqual({
    id: receiptId,
    action,
    createdAt: expect.any(String),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "One backend, two browsers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Write backend receipt" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("reconnect snapshot restores a committed action without replaying its POST", async ({ page }) => {
  let disconnect!: () => void;
  let reconnectSocket!: import("@playwright/test").WebSocketRoute;
  let committed!: () => void;
  let releaseResponse!: () => void;
  let eventSuppressed!: () => void;
  let responseFinished!: () => void;
  const postCommitted = new Promise<void>((resolve) => { committed = resolve; });
  const heldResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const droppedEventObserved = new Promise<void>((resolve) => { eventSuppressed = resolve; });
  const postResponseFinished = new Promise<void>((resolve) => { responseFinished = resolve; });
  let droppedEvent = "";
  let actionPostCount = 0;
  let postIntercepted = false;

  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    reconnectSocket = socket;
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const raw = String(message);
      const event = JSON.parse(raw) as { type?: string };
      if (!droppedEvent && event.type === "action.created") {
        droppedEvent = raw;
        eventSuppressed();
        return;
      }
      socket.send(message);
    });
    disconnect = () => socket.close();
  });
  await page.route("**/api/actions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postIntercepted = true;
    actionPostCount += 1;
    const response = await route.fetch();
    committed();
    await heldResponse;
    await route.fulfill({ response });
    responseFinished();
  });

  try {
    await signIn(page);
    const action = `recovered receipt ${crypto.randomUUID()}`;
    await page.getByLabel("Action description").fill(action);
    await page.getByRole("button", { name: "Write backend receipt" }).click();
    await postCommitted;
    await droppedEventObserved;
    expect(droppedEvent).toContain(action);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    disconnect();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates disconnected");
    await expect(page.getByText(action)).toHaveCount(0);

    const postedResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/actions") && response.request().method() === "POST",
    );
    releaseResponse();
    await postedResponse;
    await page.waitForTimeout(50);
    await expect(page.getByText(action)).toHaveCount(0);

    await page.getByRole("button", { name: "Reconnect live updates" }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    await expect(page.getByTestId("latest-receipt")).toContainText(action);
    const receiptId = (JSON.parse(droppedEvent) as { receipt: { id: string } }).receipt.id;
    expect(await confirmedIds(page)).toContainEqual({
      id: receiptId,
      action,
      createdAt: expect.any(String),
    });

    const countBeforeDuplicate = await page.getByText(action, { exact: true }).count();
    reconnectSocket.send(droppedEvent);
    await page.waitForTimeout(50);
    expect(await page.getByText(action, { exact: true }).count()).toBe(countBeforeDuplicate);
    expect(actionPostCount).toBe(1);
  } finally {
    releaseResponse();
    if (postIntercepted) await postResponseFinished;
    await page.unroute("**/api/actions");
  }
});

test("malformed live events clear private state and offer reconnect", async ({ page }) => {
  let sendMalformed!: () => void;
  let ready!: () => void;
  const snapshotReceived = new Promise<void>((resolve) => { ready = resolve; });
  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const raw = String(message);
      const event = JSON.parse(raw) as { type?: string };
      socket.send(message);
      if (event.type === "snapshot") {
        sendMalformed = () => socket.send("not-json");
        ready();
      }
    });
  });

  await signIn(page);
  await snapshotReceived;
  const action = `private receipt ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);
  sendMalformed();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates disconnected");
  await expect(page.getByText(action)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reconnect live updates" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Write backend receipt" })).toBeDisabled();
});

 test("a later cursor gap repairs missed events from the authoritative snapshot", async ({ page }) => {
  let firstEvent = true;
  let missedEvent = "";
  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const raw = String(message);
      const event = JSON.parse(raw) as { type?: string };
      if (firstEvent && event.type === "action.created") {
        firstEvent = false;
        missedEvent = raw;
        return;
      }
      socket.send(message);
    });
  });

  await signIn(page);
  const firstAction = `missed event ${crypto.randomUUID()}`;
  const secondAction = `gap trigger ${crypto.randomUUID()}`;
  const firstResponse = await page.request.post(`${apiUrl}/api/actions`, { data: { action: firstAction } });
  const secondResponse = await page.request.post(`${apiUrl}/api/actions`, { data: { action: secondAction } });
  expect(firstResponse.status()).toBe(201);
  expect(secondResponse.status()).toBe(201);
  expect(missedEvent).toContain(firstAction);
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
  await expect(page.getByTestId("latest-receipt")).toContainText(secondAction);
  await expect(page.getByText(firstAction, { exact: true })).toBeVisible();
  expect(await confirmedIds(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: firstAction }),
    expect.objectContaining({ action: secondAction }),
  ]));
});

test("logging out revokes distinct sessions opened in two tabs", async ({ page }) => {
  const otherTab = await page.context().newPage();
  try {
    await otherTab.goto("/");
    await expect(otherTab.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();

    await signIn(page);
    const firstCookie = (await page.context().cookies()).find((cookie) => cookie.name === "remotecode_session")?.value;
    expect(firstCookie).toBeTruthy();
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${firstCookie}` },
    })).status()).toBe(200);

    const action = `private history ${crypto.randomUUID()}`;
    await page.getByLabel("Action description").fill(action);
    await page.getByRole("button", { name: "Write backend receipt" }).click();
    await expect(page.getByTestId("latest-receipt")).toContainText(action);

    const secondLogin = await otherTab.request.post(`${webUrl}/api/auth/login`, {
      data: { password: authPassword },
    });
    expect(secondLogin.status()).toBe(200);
    const secondCookie = secondLogin.headers()["set-cookie"]?.match(/remotecode_session=([^;]+)/)?.[1];
    expect(secondCookie).toBeTruthy();
    expect(secondCookie).not.toBe(firstCookie);
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${firstCookie}` },
    })).status()).toBe(200);
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${secondCookie}` },
    })).status()).toBe(200);

    await otherTab.goto("/");
    await expect(otherTab.getByTestId("connection-status")).toHaveText("Live updates connected");
    await expect(otherTab.getByText(action)).toHaveCount(2);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(otherTab.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
    await expect(otherTab.getByText(action)).toHaveCount(0);
    expect((await otherTab.request.get(`${apiUrl}/api/actions`)).status()).toBe(401);
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${firstCookie}` },
    })).status()).toBe(401);
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${secondCookie}` },
    })).status()).toBe(401);
  } finally {
    await otherTab.close();
  }
});

test("a login response arriving after logout cannot restore private UI", async ({ page }) => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstCommitted!: () => void;
  let firstReleased!: () => void;
  let firstResponseFinished!: () => void;
  let secondCommitted!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstReady = new Promise<void>((resolve) => { firstCommitted = resolve; });
  const firstResponseReleased = new Promise<void>((resolve) => { firstReleased = resolve; });
  const firstResponseCompleted = new Promise<void>((resolve) => { firstResponseFinished = resolve; });
  const secondReady = new Promise<void>((resolve) => { secondCommitted = resolve; });
  let loginCount = 0;
  let firstCookie = "";
  let secondCookie = "";

  await page.route("**/api/auth/login", async (route) => {
    const response = await route.fetch();
    const cookie = response.headers()["set-cookie"]?.match(/remotecode_session=([^;]+)/)?.[1];
    if (loginCount++ === 0) {
      firstCookie = cookie ?? "";
      firstCommitted();
      await firstHeld;
      firstReleased();
      await route.fulfill({ response });
      firstResponseFinished();
      return;
    } else {
      secondCookie = cookie ?? "";
      secondCommitted();
      await secondHeld;
    }
    await route.fulfill({ response });
  });

  try {
    await page.goto("/");
    await page.getByLabel("Host passphrase").fill(authPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await firstReady;
    await page.getByRole("button", { name: "Sign in" }).click();
    await secondReady;

    expect(firstCookie).toBeTruthy();
    expect(secondCookie).toBeTruthy();
    expect(secondCookie).not.toBe(firstCookie);
    releaseSecond();
    await expect(page.getByTestId("connection-status")).toHaveText("Live updates connected");
    const action = `stale login response ${crypto.randomUUID()}`;
    await page.getByLabel("Action description").fill(action);
    await page.getByRole("button", { name: "Write backend receipt" }).click();
    await expect(page.getByTestId("latest-receipt")).toContainText(action);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
    releaseFirst();
    await firstResponseReleased;
    await firstResponseCompleted;
    await firstResponse;
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel("Host passphrase")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
    await expect(page.getByText(action)).toHaveCount(0);
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${firstCookie}` },
    })).status()).toBe(401);
    expect((await page.request.get(`${apiUrl}/api/auth/session`, {
      headers: { cookie: `remotecode_session=${secondCookie}` },
    })).status()).toBe(401);
  } finally {
    releaseFirst();
    releaseSecond();
    await page.unroute("**/api/auth/login");
  }
});

test("returns to sign-in and clears private receipts when the session expires", async ({ page }) => {
  const sessionTtlMs = Number(process.env.REMOTECODE_AUTH_SESSION_TTL_MS);
  test.skip(!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0, "Set a short session TTL to verify expiry in the browser.");
  await signIn(page);
  const action = `expiring private receipt ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);
  await page.waitForTimeout(sessionTtlMs + 100);
  await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
  await expect(page.getByText(action)).toHaveCount(0);
  expect((await page.request.get(`${apiUrl}/api/actions`)).status()).toBe(401);
});

test("clears private UI on WebSocket loss and remains clear when the session expires", async ({ page }) => {
  const sessionTtlMs = Number(process.env.REMOTECODE_AUTH_SESSION_TTL_MS);
  test.skip(!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0, "Set a short session TTL to verify expiry after socket loss.");
  let disconnect!: () => void;
  let socketReady!: () => void;
  const ready = new Promise<void>((resolve) => { socketReady = resolve; });
  await page.routeWebSocket("**/api/events*", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    disconnect = () => socket.close();
    socketReady();
  });

  await signIn(page);
  await ready;
  const action = `socket loss private receipt ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);
  expect((await page.request.get(`${apiUrl}/api/auth/session`)).status()).toBe(200);

  disconnect();
  await expect(page.getByTestId("connection-status")).toHaveText("Live updates disconnected");
  await expect(page.getByText(action)).toHaveCount(0);
  expect((await page.request.get(`${apiUrl}/api/auth/session`)).status()).toBe(200);
  await page.waitForTimeout(sessionTtlMs + 100);
  expect((await page.request.get(`${apiUrl}/api/auth/session`)).status()).toBe(401);
  await page.getByRole("button", { name: "Reconnect live updates" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
  await expect(page.getByText(action)).toHaveCount(0);
});

test("clears private UI when logout commits but its response is lost", async ({ page }) => {
  await signIn(page);
  const action = `uncertain logout ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(action);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(action);
  let logoutCommitted!: () => void;
  let releaseLogout!: () => void;
  let logoutRequestAborted!: () => void;
  let logoutResponseFailed!: () => void;
  const committed = new Promise<void>((resolve) => { logoutCommitted = resolve; });
  const heldResponse = new Promise<void>((resolve) => { releaseLogout = resolve; });
  const logoutAborted = new Promise<void>((resolve) => { logoutRequestAborted = resolve; });
  const logoutFailed = new Promise<void>((resolve) => { logoutResponseFailed = resolve; });
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/api/auth/logout")) logoutResponseFailed();
  });

  await page.route("**/api/auth/logout", async (route) => {
    await route.fetch();
    logoutCommitted();
    await heldResponse;
    await route.abort();
    logoutRequestAborted();
  });
  try {
    await page.getByRole("button", { name: "Sign out" }).click();
    await committed;
    await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
    await expect(page.getByText(action)).toHaveCount(0);
  } finally {
    releaseLogout();
    await logoutAborted;
    await logoutFailed;
    await page.unroute("**/api/auth/logout");
  }
  await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
  await expect(page.getByText(action)).toHaveCount(0);
  await expect(page.getByText("The host could not confirm logout.")).toBeVisible();
  expect((await page.request.get(`${apiUrl}/api/actions`)).status()).toBe(401);
});

test("does not restore private receipts when a pending write returns after logout", async ({ page }) => {
  await signIn(page);
  const action = `delayed private receipt ${crypto.randomUUID()}`;
  let releaseResponse!: () => void;
  let markCommitted!: () => void;
  let markResponseFulfilled!: () => void;
  const heldResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
  const responseFulfilled = new Promise<void>((resolve) => { markResponseFulfilled = resolve; });
  const browserResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/actions") && response.request().method() === "POST",
  );
  const browserRequestFinished = page.waitForEvent("requestfinished", (request) =>
    request.url().endsWith("/api/actions") && request.method() === "POST",
  );

  await page.route("**/api/actions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    markCommitted();
    await heldResponse;
    await route.fulfill({ response });
    markResponseFulfilled();
  });

  try {
    await page.getByLabel("Action description").fill(action);
    await page.getByRole("button", { name: "Write backend receipt" }).click();
    await committed;
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
    releaseResponse();
    await responseFulfilled;
    const response = await browserResponse;
    expect(response.status()).toBe(201);
    const finishedRequest = await browserRequestFinished;
    expect(finishedRequest).toBe(response.request());
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(page.getByRole("heading", { name: "Sign in to your host" })).toBeVisible();
    await expect(page.getByText(action)).toHaveCount(0);

    await signIn(page);
    await expect(page.getByText(action)).toHaveCount(2);
  } finally {
    releaseResponse();
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

  await signIn(page);

  const externalAction = `external ${crypto.randomUUID()}`;
  await page.getByLabel("Action description").fill(externalAction);
  await page.getByRole("button", { name: "Write backend receipt" }).click();
  await expect(page.getByTestId("latest-receipt")).toContainText(externalAction);
  const externalReceipt = (await page.getByTestId("latest-receipt").innerText()).match(/Receipt ([\w-]+)/)?.[1];
  expect(externalReceipt).toBeTruthy();

  const guestObserved = await useGuest("observe", externalAction);
  expect(guestObserved.receiptId).toBe(externalReceipt);
  expect(await confirmedIds(page)).toContainEqual(expect.objectContaining({ id: externalReceipt, action: externalAction }));

  const guestAction = `linux guest ${crypto.randomUUID()}`;
  const guestCreated = await useGuest("create", guestAction);
  expect(guestCreated.action).toBe(guestAction);
  await expect(page.getByTestId("latest-receipt")).toContainText(guestAction);
  const guestReceipt = (await page.getByTestId("latest-receipt").innerText()).match(/Receipt ([\w-]+)/)?.[1];
  expect(guestReceipt).toBe(guestCreated.receiptId);
  expect(await confirmedIds(page)).toContainEqual(expect.objectContaining({ id: guestReceipt, action: guestAction }));
});
