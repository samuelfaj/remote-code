import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../app";
import { ApiClientError, actionReceiptFromResponse, createApiClient, isDefinitiveActionRejection, isUnknownOutcomeError } from "../../../../packages/client/src";

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "rc018-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const app = createApi(path);
  const database = new Database(path);
  for (const [token, user] of [["a".repeat(64), "alice"], ["b".repeat(64), "bob"]]) {
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(token!).digest("hex"), user!, Date.now() + 60_000);
  }
  database.close();
  return { app, path };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(method: string, route: string, body?: unknown, user = "a") {
  return new Request(`http://localhost/api/actions${route}`, {
    method,
    headers: { "content-type": "application/json", cookie: `remotecode_session=${user.repeat(64)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("recovers one canonical action after response loss and API recreation without repeating the effect", async () => {
  const { app, path } = setup();
  const requestId = "abcdef12-3456-4789-abcd-ef1234567890";
  expect((await app.handle(request("GET", `/receipts/${requestId}`))).status).toBe(404);
  const first = await app.handle(request("POST", "", { requestId: requestId.toUpperCase(), action: "persist exactly once" }));
  expect(first.status).toBe(201);
  // Discard the response; only a later authenticated lookup can confirm the effect.
  const recovered = createApi(path);
  const lookup = await recovered.handle(request("GET", `/receipts/${requestId}`));
  expect(lookup.status).toBe(200);
  const canonical = await lookup.json();
  expect(await (await recovered.handle(request("GET", `/receipts/${requestId.toUpperCase()}`))).json()).toEqual(canonical);
  const repeated = await recovered.handle(request("POST", "", { requestId, action: "persist exactly once" }));
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(canonical);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 1 });
    expect(database.query("SELECT request_id FROM action_requests").all()).toEqual([{ request_id: requestId }]);
  } finally { database.close(); }
});

it("rejects changed payloads for a used identity and scopes receipt lookup to the session owner", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  const created = await app.handle(request("POST", "", { requestId, action: "alice's action" }));
  const canonical = await created.json();
  const conflict = await app.handle(request("POST", "", { requestId: requestId.toUpperCase(), action: "different effect" }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "request_id_conflict" });
  expect((await app.handle(request("GET", `/receipts/${requestId.toUpperCase()}`, undefined, "b"))).status).toBe(404);
  expect((await app.handle(request("GET", `/receipts/${requestId}`, undefined, "c"))).status).toBe(401);
  const other = await app.handle(request("POST", "", { requestId: requestId.toUpperCase(), action: "bob's action" }, "b"));
  expect(other.status).toBe(201);
  const otherReceipt = await other.json();
  expect(otherReceipt.id).not.toBe(canonical.id);
  for (const identity of [requestId, requestId.toUpperCase()]) {
    expect(await (await app.handle(request("GET", `/receipts/${identity}`))).json()).toEqual(canonical);
    expect(await (await app.handle(request("GET", `/receipts/${identity}`, undefined, "b"))).json()).toEqual(otherReceipt);
  }
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 2 });
    expect(database.query("SELECT user_id, request_id FROM action_requests ORDER BY user_id").all()).toEqual([
      { user_id: "alice", request_id: requestId }, { user_id: "bob", request_id: requestId },
    ]);
  } finally { database.close(); }
});

it("leaves no accepted receipt after validation or storage failure and can later accept the same ID", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  expect((await app.handle(request("POST", "", { requestId, action: "" }))).status).toBe(422);
  expect((await app.handle(request("GET", `/receipts/${requestId}`))).status).toBe(404);
  const database = new Database(path);
  try {
    database.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON action_requests BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    const failed = await app.handle(request("POST", "", { requestId, action: "atomic receipt" }));
    expect(failed.status).toBe(500);
    expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM action_requests").get()).toEqual({ count: 0 });
    database.exec("DROP TRIGGER reject_receipt");
    expect((await app.handle(request("POST", "", { requestId, action: "atomic receipt" }))).status).toBe(201);
  } finally { database.close(); }
});

it("recovers a timed-out Eden submission by ID before explicitly repeating the same request", async () => {
  const { app, path } = setup();
  let loseResponse = true;
  let submissions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const response = await app.handle(request);
      if (request.method === "POST") {
        submissions++;
        if (loseResponse && response.status === 201) {
          loseResponse = false;
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
          }), { headers: { "content-type": "application/json" } });
        }
      }
      return response;
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const options = { timeoutMs: 100, headers: { cookie: `remotecode_session=${"a".repeat(64)}` } };
    const requestId = crypto.randomUUID();
    const body = { requestId, action: "recover dropped response" };
    const lost = await createApiClient(origin, options).api.actions.post(body);
    expect(lost.data).toBeNull();
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    const freshClient = createApiClient(origin, options);
    const lookup = await freshClient.api.actions.receipts({ requestId }).get();
    expect(lookup.error).toBeNull();
    expect(lookup.data).toMatchObject({ action: body.action });
    if (!lookup.data || !("id" in lookup.data)) throw new Error("Expected a canonical receipt");
    expect(submissions).toBe(1);
    const replay = await freshClient.api.actions.post(body);
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(lookup.data);
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => freshClient.api.actions.post(body)));
    for (const duplicate of duplicates) {
      expect(duplicate.error).toBeNull();
      expect(duplicate.data).toEqual(lookup.data);
    }
    const database = new Database(path);
    try {
      expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  } finally { server.stop(true); }
});

it("reports degraded readiness if the durable request identity store is unavailable", async () => {
  const { app, path } = setup();
  const database = new Database(path);
  database.exec("DROP TABLE action_requests");
  database.close();
  const response = await app.handle(new Request("http://localhost/api/health/ready"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "not_ready" });
});

it("accepts concurrent first submissions once and broadcasts no event for replay or conflict", async () => {
  const { app, path } = setup();
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("API did not bind");
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`ws://127.0.0.1:${port}/api/events`, {
    headers: { cookie: `remotecode_session=${"a".repeat(64)}`, origin: "http://localhost:5173" },
  });
  const created: Array<{ id: string; action: string }> = [];
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data));
    if (event.type === "action.created") created.push(event.receipt);
  });
  function waitForMessage(matches: (event: { type: string; receipt?: { action: string } }) => boolean) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener("message", listener);
        reject(new Error("Timed out waiting for the authoritative event"));
      }, 3000);
      function listener(message: MessageEvent) {
        if (!matches(JSON.parse(String(message.data)))) return;
        clearTimeout(timer);
        socket.removeEventListener("message", listener);
        resolve();
      }
      socket.addEventListener("message", listener);
    });
  }
  try {
    await waitForMessage((event) => event.type === "snapshot");
    const client = createApiClient(`http://127.0.0.1:${port}`, {
      headers: { cookie: `remotecode_session=${"a".repeat(64)}` },
    });
    const requestId = crypto.randomUUID();
    const submissions = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      client.api.actions.post({ requestId: index % 2 === 0 ? requestId : requestId.toUpperCase(), action: "concurrent first acceptance" })));
    expect(submissions.map((result) => result.status).sort()).toEqual([200, 200, 200, 201]);
    const receipt = submissions[0]!.data;
    if (!receipt || !("id" in receipt)) throw new Error("Expected confirmed action");
    for (const submission of submissions) {
      expect(submission.error).toBeNull();
      expect(submission.data).toEqual(receipt);
    }
    expect((await client.api.actions.post({ requestId: requestId.toUpperCase(), action: "conflicting effect" })).status).toBe(409);
    const barrier = waitForMessage((event) => event.receipt?.action === "event delivery barrier");
    expect((await client.api.actions.post({ requestId: crypto.randomUUID(), action: "event delivery barrier" })).status).toBe(201);
    await barrier;
    expect(created.filter((event) => event.id === receipt.id)).toHaveLength(1);
    expect(created).toHaveLength(2);
    const database = new Database(path);
    try {
      expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 2 });
      expect(database.query("SELECT count(*) AS count FROM action_requests").get()).toEqual({ count: 2 });
    } finally { database.close(); }
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.close();
      });
    }
    await server.stop(true);
  }
});

it("rejects malformed and URN action identities before durable effects", async () => {
  const { app, path } = setup();
  for (const requestId of ["not-a-uuid", "urn:uuid:abcdef12-3456-4789-abcd-ef1234567890", "abcdef12-3456-4789-abcd-ef1234567890 "]) {
    expect((await app.handle(request("POST", "", { requestId, action: "must not commit" }))).status).toBe(422);
    expect((await app.handle(request("GET", `/receipts/${encodeURIComponent(requestId)}`))).status).toBe(422);
  }
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM action_requests").get()).toEqual({ count: 0 });
  } finally { database.close(); }
});

for (const cut of ["before acceptance", "after commit before headers", "truncated body", "stream interruption"] as const) {
  it(`keeps a TCP cut ${cut} unknown and reconciles one effect by receipt without retry`, async () => {
    const { app, path } = setup();
    const api = app.listen(0);
    const port = api.server?.port;
    if (!port) throw new Error("API did not bind");
    let submissions = 0;
    let forwarded = 0;
    let streamSocket: Socket | undefined;
    const proxy = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const mutation = request.method === "POST";
        if (mutation) submissions++;
        if (mutation && submissions === 1 && cut === "before acceptance") {
          request.socket.destroy();
          return;
        }
        if (mutation) forwarded++;
        const upstream = await fetch(`http://127.0.0.1:${port}${request.url}`, {
          method: request.method,
          headers: { "content-type": "application/json", cookie: String(request.headers.cookie ?? "") },
          ...(mutation ? { body: Buffer.concat(chunks) } : {}),
        });
        const body = await upstream.text();
        if (mutation && submissions === 1) {
          if (upstream.status !== 201) throw new Error("Expected committed upstream action");
          if (cut === "after commit before headers") request.socket.destroy();
          else if (cut === "stream interruption") {
            streamSocket = request.socket;
            response.writeHead(upstream.status, { "content-type": "text/plain" });
            response.write(body.slice(0, 8));
          } else {
            request.socket.end(`HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n${body.slice(0, 8)}`);
          }
          return;
        }
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(body);
      } catch (error) { response.destroy(error as Error); }
    });
    try {
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const client = createApiClient(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, {
        headers: { cookie: `remotecode_session=${"a".repeat(64)}` },
      });
      const requestId = crypto.randomUUID();
      const body = { requestId, action: `recover ${cut}` };
      const lost = await client.api.actions.post(body);
      if (cut === "stream interruption") {
        const stream = lost.data as unknown as AsyncGenerator<string>;
        expect(String((await stream.next()).value)).toStartWith('{"id":');
        if (!streamSocket) throw new Error("Expected an active TCP stream");
        streamSocket.destroy();
        let streamError: unknown;
        try { await stream.next(); } catch (error) { streamError = error; }
        expect(streamError).toBeInstanceOf(ApiClientError);
        expect(isUnknownOutcomeError(streamError)).toBe(true);
      } else {
        expect(lost.data).toBeNull();
        expect(isUnknownOutcomeError(lost.error)).toBe(true);
      }
      expect(submissions).toBe(1);
      expect(forwarded).toBe(cut === "before acceptance" ? 0 : 1);
      const lookup = await client.api.actions.receipts({ requestId: requestId.toUpperCase() }).get();
      expect(lookup.status).toBe(cut === "before acceptance" ? 404 : 200);
      expect(submissions).toBe(1);
      const database = new Database(path);
      try {
        const count = cut === "before acceptance" ? 0 : 1;
        expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count });
        expect(database.query("SELECT count(*) AS count FROM action_requests").get()).toEqual({ count });
        const replay = await client.api.actions.post({ ...body, requestId: requestId.toUpperCase() });
        expect(replay.status).toBe(cut === "before acceptance" ? 201 : 200);
        expect(replay.error).toBeNull();
        if (!replay.data || !("id" in replay.data)) throw new Error("Expected a canonical replay receipt");
        if (cut !== "before acceptance") {
          if (!lookup.data || !("id" in lookup.data)) throw new Error("Expected a committed receipt after TCP failure");
          expect(replay.data).toEqual(lookup.data);
        }
        const confirmed = await client.api.actions.receipts({ requestId }).get();
        expect(confirmed.error).toBeNull();
        if (!confirmed.data || !("id" in confirmed.data)) throw new Error("Expected a confirmed receipt");
        expect(confirmed.data).toEqual(replay.data);
        expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 1 });
        expect(database.query("SELECT request_id FROM action_requests").all()).toEqual([{ request_id: requestId }]);
      } finally { database.close(); }
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await api.stop(true);
    }
  });
}


for (const ambiguous of [false, true]) {
  it(`recreates the API with legacy ${ambiguous ? "conflicting case aliases and fails closed" : "uppercase identity without repeating its effect"}`, async () => {
    const { path } = setup();
    const requestId = "abcdef12-3456-4789-abcd-ef1234567890";
    const receipts = Array.from({ length: ambiguous ? 2 : 1 }, (_, index) => ({
      id: crypto.randomUUID(), action: `legacy effect ${index}`, createdAt: "2026-09-29T12:00:00.000Z",
    }));
    const database = new Database(path);
    try {
      for (const [index, receipt] of receipts.entries()) {
        database.query("INSERT INTO actions (id, action, created_at) VALUES (?, ?, ?)")
          .run(receipt.id, receipt.action, receipt.createdAt);
        database.query("INSERT INTO action_requests (user_id, request_id, action_id) VALUES (?, ?, ?)")
          .run("alice", index === 0 ? requestId.toUpperCase() : requestId, receipt.id);
      }
    } finally { database.close(); }
    const api = createApi(path).listen(0);
    const port = api.server?.port;
    if (!port) throw new Error("API did not bind");
    const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const socket = new Socket(`ws://127.0.0.1:${port}/api/events`, {
      headers: { cookie: `remotecode_session=${"a".repeat(64)}`, origin: "http://localhost:5173" },
    });
    const events: unknown[] = [];
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data));
      if (event.type === "action.created") events.push(event);
    });
    function waitForSnapshot() {
      return new Promise<{ cursor: number; actions: Array<{ id: string }> }>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.removeEventListener("message", listener);
          reject(new Error("Timed out waiting for legacy action snapshot"));
        }, 3000);
        function listener(message: MessageEvent) {
          const event = JSON.parse(String(message.data));
          if (event.type !== "snapshot") return;
          clearTimeout(timer);
          socket.removeEventListener("message", listener);
          resolve(event);
        }
        socket.addEventListener("message", listener);
      });
    }
    try {
      const before = await waitForSnapshot();
      expect(before.actions.map((receipt) => receipt.id).sort()).toEqual(receipts.map((receipt) => receipt.id).sort());
      const origin = `http://127.0.0.1:${port}`;
      const client = createApiClient(origin, { headers: { cookie: `remotecode_session=${"a".repeat(64)}` } });
      const other = createApiClient(origin, { headers: { cookie: `remotecode_session=${"b".repeat(64)}` } });
      for (const identity of [requestId, requestId.toUpperCase()]) {
        expect((await other.api.actions.receipts({ requestId: identity }).get()).status).toBe(404);
        const lookup = await client.api.actions.receipts({ requestId: identity }).get();
        expect(lookup.status).toBe(ambiguous ? 500 : 200);
        if (ambiguous) {
          expect(lookup.data).toBeNull();
          expect(lookup.error).not.toBeNull();
          expect(actionReceiptFromResponse(lookup)).toBeNull();
          expect(isDefinitiveActionRejection(lookup)).toBe(false);
        } else expect(actionReceiptFromResponse(lookup)).toEqual(receipts[0]!);
        for (const receipt of receipts) {
          const replay = await client.api.actions.post({ requestId: identity, action: receipt.action });
          expect(replay.status).toBe(ambiguous ? 500 : 200);
          if (ambiguous) {
            expect(replay.data).toBeNull();
            expect(replay.error).not.toBeNull();
            expect(actionReceiptFromResponse(replay)).toBeNull();
            expect(isDefinitiveActionRejection(replay)).toBe(false);
          } else expect(actionReceiptFromResponse(replay)).toEqual(receipt);
        }
        expect((await client.api.actions.post({ requestId: identity, action: "another effect" })).status).toBe(ambiguous ? 500 : 409);
      }
      const synchronized = waitForSnapshot();
      socket.send(JSON.stringify({ type: "sync" }));
      expect(await synchronized).toEqual(before);
      expect(events).toHaveLength(0);
      const stored = new Database(path, { readonly: true });
      try {
        expect(stored.query("SELECT id, action, created_at AS createdAt FROM actions ORDER BY sequence").all()).toEqual(receipts);
        expect(stored.query("SELECT user_id, request_id, action_id FROM action_requests ORDER BY rowid").all()).toEqual(
          receipts.map((receipt, index) => ({ user_id: "alice", request_id: index === 0 ? requestId.toUpperCase() : requestId, action_id: receipt.id })),
        );
      } finally { stored.close(); }
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.close();
        });
      }
      await api.stop(true);
    }
  });
}
