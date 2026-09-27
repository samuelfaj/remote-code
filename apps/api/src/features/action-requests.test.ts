import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../app";
import { createApiClient, isUnknownOutcomeError } from "../../../../packages/client/src";

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
  const requestId = crypto.randomUUID();
  expect((await app.handle(request("GET", `/receipts/${requestId}`))).status).toBe(404);
  const first = await app.handle(request("POST", "", { requestId, action: "persist exactly once" }));
  expect(first.status).toBe(201);
  // Discard the response; only a later authenticated lookup can confirm the effect.
  const recovered = createApi(path);
  const lookup = await recovered.handle(request("GET", `/receipts/${requestId}`));
  expect(lookup.status).toBe(200);
  const canonical = await lookup.json();
  const repeated = await recovered.handle(request("POST", "", { requestId, action: "persist exactly once" }));
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(canonical);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM actions").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM action_requests").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("rejects changed payloads for a used identity and scopes receipt lookup to the session owner", async () => {
  const { app } = setup();
  const requestId = crypto.randomUUID();
  const created = await app.handle(request("POST", "", { requestId, action: "alice's action" }));
  const canonical = await created.json();
  const conflict = await app.handle(request("POST", "", { requestId, action: "different effect" }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "request_id_conflict" });
  expect((await app.handle(request("GET", `/receipts/${requestId}`, undefined, "b"))).status).toBe(404);
  expect((await app.handle(request("GET", `/receipts/${requestId}`, undefined, "c"))).status).toBe(401);
  const other = await app.handle(request("POST", "", { requestId, action: "bob's action" }, "b"));
  expect(other.status).toBe(201);
  expect((await other.json()).id).not.toBe(canonical.id);
  expect(await (await app.handle(request("GET", `/receipts/${requestId}`))).json()).toEqual(canonical);
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
    const submissions = await Promise.all(Array.from({ length: 4 }, () =>
      client.api.actions.post({ requestId, action: "concurrent first acceptance" })));
    expect(submissions.map((result) => result.status).sort()).toEqual([200, 200, 200, 201]);
    const receipt = submissions[0]!.data;
    if (!receipt || !("id" in receipt)) throw new Error("Expected confirmed action");
    for (const submission of submissions) {
      expect(submission.error).toBeNull();
      expect(submission.data).toEqual(receipt);
    }
    expect((await client.api.actions.post({ requestId, action: "conflicting effect" })).status).toBe(409);
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
