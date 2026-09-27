import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getMobileHealth } from "../../../apps/mobile/src/features/health/api";
import { getWebHealth } from "../../../apps/web/src/features/health/api";
import { createApi } from "../../../apps/api/src/app";
import { ApiClientError, createApiClient, isUnknownOutcomeError } from "./index";

const databasePath = () => `/tmp/rc013-client-${crypto.randomUUID()}.sqlite`;

function expectUnknownOutcome(error: unknown) {
  expect(isUnknownOutcomeError(error)).toBe(true);
  if (!isUnknownOutcomeError(error)) throw new Error("Expected a typed unknown-outcome error");
  const code: "request_outcome_unknown" = error.value.error;
  expect(code).toBe("request_outcome_unknown");
}

it("uses the same typed API and session cookie from web and mobile callers", async () => {
  const app = createApi(databasePath(), undefined, { password: "client-test-password" });
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Elysia did not bind an ephemeral client test port");
  const origin = `http://127.0.0.1:${port}`;

  try {
    expect(await getWebHealth(origin)).toBe("ready");
    expect(await getMobileHealth(origin)).toBe("ready");

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "client-test-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const { data, error } = await createApiClient(origin, { headers: { cookie: cookie! } })
      .api.auth.session.get();
    expect(error).toBeNull();
    expect(data).toEqual({ userId: "local" });

    const unauthorized = await createApiClient(origin).api.auth.session.get();
    expect(unauthorized.data).toBeNull();
    expect(unauthorized.error?.status).toBe(401);
  } finally {
    await server.stop(true);
  }
});

it("does not return empty history when the API is offline before a read", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ actions: [] }) });
  const origin = `http://127.0.0.1:${server.port}`;
  server.stop(true);

  let result: Awaited<ReturnType<ReturnType<typeof createApiClient>["api"]["actions"]["get"]>> | undefined;
  let transportFailure: unknown;
  try {
    result = await createApiClient(origin, { timeoutMs: 100 }).api.actions.get();
  } catch (error) {
    transportFailure = error;
  }

  expect(transportFailure !== undefined || (result?.data === null && result.error !== null)).toBe(true);
  expect(result?.data).not.toEqual({ actions: [] });
});

it("recovers authoritative history after the API restarts following a successful read", async () => {
  const path = databasePath();
  const authConfig = { password: "client-test-password" };
  const app = createApi(path, undefined, authConfig);
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: authConfig.password }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test auth cookie missing");

  const write = await app.handle(new Request("http://localhost/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ action: "recover history after API restart" }),
  }));
  const receipt = await write.json() as { id: string; action: string };
  expect(write.status).toBe(201);

  const firstServer = app.listen(0);
  const firstPort = firstServer.server?.port;
  if (!firstPort) throw new Error("Elysia did not bind the initial read test port");
  try {
    const firstRead = await createApiClient(`http://127.0.0.1:${firstPort}`, { headers: { cookie } })
      .api.actions.get();
    expect(firstRead.error).toBeNull();
    if (!firstRead.data || !("actions" in firstRead.data) || !Array.isArray(firstRead.data.actions)) {
      throw new Error("Expected an action history response");
    }
    expect(firstRead.data.actions.some((stored) => stored.id === receipt.id && stored.action === receipt.action)).toBe(true);
  } finally {
    await firstServer.stop(true);
  }

  const recoveredApi = createApi(path, undefined, authConfig);
  const recoveredServer = recoveredApi.listen(0);
  const recoveredPort = recoveredServer.server?.port;
  if (!recoveredPort) throw new Error("Elysia did not bind after the API restart");
  try {
    const recoveredRead = await createApiClient(`http://127.0.0.1:${recoveredPort}`, { headers: { cookie } })
      .api.actions.get();
    expect(recoveredRead.error).toBeNull();
    if (!recoveredRead.data || !("actions" in recoveredRead.data) || !Array.isArray(recoveredRead.data.actions)) {
      throw new Error("Expected recovered action history");
    }
    expect(recoveredRead.data.actions.some((stored) => stored.id === receipt.id && stored.action === receipt.action)).toBe(true);
  } finally {
    await recoveredServer.stop(true);
  }
});

it("keeps a committed write unknown when its response is lost and reconciles from API history", async () => {
  const app = createApi(databasePath(), undefined, { password: "client-test-password" });
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test auth cookie missing");

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const response = await app.handle(request);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/actions") return response;
      if (response.status !== 201) return response;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"receipt":'));
        },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  const action = `commit-before-response-loss-${crypto.randomUUID()}`;

  try {
    const { data, error } = await createApiClient(`http://127.0.0.1:${server.port}`, {
      timeoutMs: 100,
      headers: { cookie },
    }).api.actions.post({ action });
    expect(data).toBeNull();
    expectUnknownOutcome(error);

    const history = await app.handle(new Request("http://localhost/api/actions", { headers: { cookie } }));
    expect(history.status).toBe(200);
    const receipts = (await history.json() as { actions: Array<{ action: string }> }).actions;
    expect(receipts.filter((receipt) => receipt.action === action)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

it("keeps the confirmed write receipt when the later history read times out", async () => {
  const app = createApi(databasePath(), undefined, { password: "client-test-password" });
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test auth cookie missing");

  let delayHistoryResponse = true;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const response = await app.handle(request);
      if (request.method !== "GET" || new URL(request.url).pathname !== "/api/actions" || !delayHistoryResponse) {
        return response;
      }
      delayHistoryResponse = false;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"actions":['));
        },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  const action = `confirmed-before-history-timeout-${crypto.randomUUID()}`;

  try {
    const { data: receipt, error: writeError } = await createApiClient(`http://127.0.0.1:${server.port}`, {
      timeoutMs: 100,
      headers: { cookie },
    }).api.actions.post({ action });
    expect(writeError).toBeNull();
    if (!receipt || !("id" in receipt)) throw new Error("Expected a confirmed write receipt");

    const history = await createApiClient(`http://127.0.0.1:${server.port}`, {
      timeoutMs: 100,
      headers: { cookie },
    }).api.actions.get();
    expect(history.data).toBeNull();
    expectUnknownOutcome(history.error);

    const authoritativeHistory = await app.handle(new Request("http://localhost/api/actions", { headers: { cookie } }));
    expect(authoritativeHistory.status).toBe(200);
    const receipts = (await authoritativeHistory.json() as { actions: Array<{ id: string; action: string }> }).actions;
    expect(receipts.filter((stored) => stored.id === receipt.id && stored.action === action)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

it("does not create a session when shared-client login is rejected before acceptance", async () => {
  const path = databasePath();
  const app = createApi(path, undefined, { password: "client-test-password" });
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Elysia did not bind an ephemeral auth test port");

  try {
    const { data, error } = await createApiClient(`http://127.0.0.1:${port}`)
      .api.auth.login.post({ password: "incorrect-password" });
    expect(data).toBeNull();
    expect(error).toMatchObject({ status: 401, value: { error: "unauthorized" } });

    const database = new Database(path);
    try {
      const sessions = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get();
      expect(sessions?.count).toBe(0);
    } finally {
      database.close();
    }
  } finally {
    await server.stop(true);
  }
});

it("recovers session validation after the login response was confirmed", async () => {
  const app = createApi(databasePath(), undefined, { password: "client-test-password" });
  const apiServer = app.listen(0);
  const apiPort = apiServer.server?.port;
  if (!apiPort) throw new Error("Elysia did not bind an ephemeral auth test port");
  let cookie: string | undefined;
  let failSessionCheck = true;
  const proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/auth/session" && failSessionCheck) {
        failSessionCheck = false;
        return Response.json({ error: "session_observation_unavailable" }, { status: 503 });
      }
      const body = request.method === "GET" ? undefined : await request.text();
      const response = await fetch(`http://127.0.0.1:${apiPort}${url.pathname}`, {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      });
      if (url.pathname === "/api/auth/login" && response.status === 200) {
        cookie = response.headers.get("set-cookie")?.split(";")[0];
      }
      return response;
    },
  });
  const origin = `http://127.0.0.1:${proxy.port}`;

  try {
    const login = await createApiClient(origin).api.auth.login.post({ password: "client-test-password" });
    expect(login.error).toBeNull();
    expect(login.data?.userId).toBe("local");
    if (!cookie) throw new Error("Login response did not include a session cookie");

    const sessionClient = createApiClient(origin, { headers: { cookie } });
    const failedObservation = await sessionClient.api.auth.session.get();
    expect(failedObservation.data).toBeNull();
    expect(failedObservation.error?.status).toBe(503);

    const recoveredSession = await sessionClient.api.auth.session.get();
    expect(recoveredSession.error).toBeNull();
    expect(recoveredSession.data).toEqual({ userId: "local" });
  } finally {
    proxy.stop(true);
    await apiServer.stop(true);
  }
});

it("leaves a login outcome unknown when session storage commits before the cookie response is lost", async () => {
  const path = databasePath();
  const app = createApi(path, undefined, { password: "client-test-password" });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const response = await app.handle(url.pathname === "/api/auth/login"
        ? new Request(`https://localhost${url.pathname}`, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        })
        : request);
      if (url.pathname !== "/api/auth/login" || response.status !== 200) return response;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"userId":'));
        },
      }), { headers: { "content-type": "application/json" } });
    },
  });

  try {
    const { data, error } = await createApiClient(`http://127.0.0.1:${server.port}`, { timeoutMs: 100 })
      .api.auth.login.post({ password: "client-test-password" });
    expect(data).toBeNull();
    expectUnknownOutcome(error);

    const database = new Database(path);
    try {
      const sessions = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get();
      expect(sessions?.count).toBe(1);
    } finally {
      database.close();
    }
  } finally {
    server.stop(true);
  }
});

it("identifies the shared client version on requests", async () => {
  let clientVersion: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      clientVersion = request.headers.get("x-remotecode-client-version");
      return Response.json({ status: "ready" });
    },
  });

  try {
    const { data, error } = await createApiClient(`http://127.0.0.1:${server.port}`).api.health.ready.get();
    expect(error).toBeNull();
    expect(data).toEqual({ status: "ready" });
    expect(clientVersion as string | null).toBe("1");
  } finally {
    server.stop(true);
  }
});

it("returns a typed unknown-outcome error when a JSON response body exceeds the timeout", async () => {
  let markBodyStarted!: () => void;
  const bodyStarted = new Promise<void>((resolve) => { markBodyStarted = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'));
        markBodyStarted();
      },
    }), { headers: { "content-type": "application/json" } }),
  });

  try {
    const request = createApiClient(`http://127.0.0.1:${server.port}`, { timeoutMs: 100 })
      .api.health.ready.get();
    await bodyStarted;
    const result = await request;
    expect(result.data).toBeNull();
    expectUnknownOutcome(result.error);
  } finally {
    server.stop(true);
  }
});

it("uses the shared client when a native runtime omits AbortSignal timeout helpers", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ready" }) });

  try {
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    const { data, error } = await createApiClient(`http://127.0.0.1:${server.port}`).api.health.ready.get();
    expect(error).toBeNull();
    expect(data).toEqual({ status: "ready" });
  } finally {
    if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
    server.stop(true);
  }
});

it("normalizes native timeouts without static Response.json", async () => {
  const responseConstructor = Response as unknown as { json?: typeof Response.json };
  const originalJson = responseConstructor.json;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(JSON.stringify({ status: "ready" }), { headers: { "content-type": "application/json" } });
    },
  });

  try {
    responseConstructor.json = undefined;
    const result = await createApiClient(`http://127.0.0.1:${server.port}`, { timeoutMs: 20 })
      .api.health.ready.get();
    expect(result.data).toBeNull();
    expectUnknownOutcome(result.error);
  } finally {
    responseConstructor.json = originalJson;
    server.stop(true);
  }
});

it("normalizes a timeout before response headers", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ status: "ready" });
    },
  });

  try {
    const result = await createApiClient(`http://127.0.0.1:${server.port}`, { timeoutMs: 30 })
      .api.health.ready.get();
    expect(result.data).toBeNull();
    expectUnknownOutcome(result.error);
  } finally {
    server.stop(true);
  }
});

it("normalizes a stalled non-streaming text response", async () => {
  let markBodyStarted!: () => void;
  const bodyStarted = new Promise<void>((resolve) => { markBodyStarted = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
    response.write("partial response");
    markBodyStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const request = createApiClient(`http://127.0.0.1:${port}`, { timeoutMs: 100 })
      .api.health.ready.get();
    await bodyStarted;
    const result = await request;
    expect(result.data).toBeNull();
    expectUnknownOutcome(result.error);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("throws a typed unknown-outcome error when a streaming response times out", async () => {
  let markChunkStarted!: () => void;
  const chunkStarted = new Promise<void>((resolve) => { markChunkStarted = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first chunk"));
        markChunkStarted();
      },
    }), { headers: { "content-type": "text/plain" } }),
  });

  try {
    const result = await createApiClient(`http://127.0.0.1:${server.port}`, { timeoutMs: 100 })
      .api.health.ready.get();
    await chunkStarted;
    const stream = result.data as unknown as AsyncGenerator<string>;
    expect((await stream.next()).value).toBe("first chunk");
    let streamError: unknown;
    try {
      await stream.next();
    } catch (error) {
      streamError = error;
    }
    expect(streamError).toBeInstanceOf(ApiClientError);
    expectUnknownOutcome(streamError);
  } finally {
    server.stop(true);
  }
});

it("propagates caller cancellation while a request is in flight", async () => {
  let markRequestStarted!: () => void;
  let markRequestAborted!: () => void;
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const requestAborted = new Promise<void>((resolve) => { markRequestAborted = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch: (request) => new Promise<Response>((resolve) => {
      markRequestStarted();
      request.signal.addEventListener("abort", () => {
        markRequestAborted();
        resolve(Response.json({ status: "not_ready" }));
      }, { once: true });
    }),
  });
  const controller = new AbortController();

  try {
    const pending = createApiClient(`http://127.0.0.1:${server.port}`).api.health.ready.get({
      fetch: { signal: controller.signal },
    });
    await requestStarted;
    controller.abort();
    const result = await pending;
    await requestAborted;
    expectUnknownOutcome(result.error);
  } finally {
    server.stop(true);
  }
});

it("honors a caller's already-aborted request signal", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests++;
      return Response.json({ status: "ready" });
    },
  });

  try {
    const result = await createApiClient(`http://127.0.0.1:${server.port}`).api.health.ready.get({
      fetch: { signal: AbortSignal.abort() },
    });
    expect(result.error?.status).toBe(503);
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});
