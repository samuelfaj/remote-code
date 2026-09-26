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
