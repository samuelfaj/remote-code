import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createApi } from "./app";
import { Elysia } from "elysia";
import { createApiClient, isUnknownOutcomeError } from "../../../packages/client/src";

const password = "auth-receipt-test-password";
const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "rc018-auth-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  return { path, app: createApi(path, undefined, { password }) };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function call(app: ReturnType<typeof createApi>, route: string, body?: unknown, cookie?: string, method = "POST") {
  return app.handle(new Request(`https://localhost/api/auth${route}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
function cookieFrom(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Expected first-login cookie");
  return cookie;
}
function count(path: string, table: "sessions" | "auth_requests") {
  const db = new Database(path);
  try { return db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count; }
  finally { db.close(); }
}

it("accepts one keyed login, replays only its canonical receipt and correlates the actual cookie session", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => call(app, "/login", { password, requestId })));
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  const cookieResponses = responses.filter((response) => response.headers.has("set-cookie"));
  expect(cookieResponses).toHaveLength(1);
  const cookie = cookieFrom(cookieResponses[0]!);
  const results = await Promise.all(responses.map((response) => response.json()));
  for (const result of results) expect(result).toEqual(results[0]);
  expect(results[0].receipt).toMatchObject({ requestId, kind: "login", outcome: "session_created" });
  expect(count(path, "sessions")).toBe(1);
  expect(count(path, "auth_requests")).toBe(1);
  const session = await call(app, "/session", undefined, cookie, "GET");
  expect(await session.json()).toEqual({ userId: "local", loginRequestId: requestId });
  const restarted = createApi(path, undefined, { password });
  const replay = await call(restarted, "/login", { password, requestId });
  expect(await replay.json()).toEqual(results[0]);
  expect(replay.headers.has("set-cookie")).toBe(false);
  expect(replay.headers.get("cache-control")).toBe("no-store");
  expect(count(path, "sessions")).toBe(1);
});

it("reconciles a lost-cookie login, revokes it under a separate identity and never resurrects it", async () => {
  const { app, path } = setup();
  const loginId = crypto.randomUUID();
  const first = await call(app, "/login", { password, requestId: loginId });
  const oldCookie = cookieFrom(first);
  const firstResult = await first.json();
  const restarted = createApi(path, undefined, { password });
  const lookup = await call(restarted, `/receipts/${loginId}/lookup`, { password });
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toEqual({ receipt: firstResult.receipt, sessionStatus: "active" });
  expect(lookup.headers.has("set-cookie")).toBe(false);
  const revokeId = crypto.randomUUID();
  const revoked = await call(restarted, `/login/${loginId}/revoke`, { password, requestId: revokeId });
  expect(revoked.status).toBe(200);
  const revokedReceipt = await revoked.json();
  expect(revokedReceipt).toMatchObject({ requestId: revokeId, kind: "revoke_login", targetRequestId: loginId, outcome: "login_revoked" });
  expect(count(path, "sessions")).toBe(0);
  const again = createApi(path, undefined, { password });
  expect((await call(again, "/session", undefined, oldCookie, "GET")).status).toBe(401);
  const recoveredRevocation = await call(again, `/receipts/${revokeId}/lookup`, { password });
  expect((await recoveredRevocation.json()).receipt).toEqual(revokedReceipt);
  const replay = await call(again, "/login", { password, requestId: loginId });
  expect(await replay.json()).toEqual(firstResult);
  expect(replay.headers.has("set-cookie")).toBe(false);
  expect(count(path, "sessions")).toBe(0);
  const fresh = await call(again, "/login", { password, requestId: crypto.randomUUID() });
  expect(fresh.status).toBe(200);
  expect(cookieFrom(fresh)).not.toBe(oldCookie);
  expect(count(path, "sessions")).toBe(1);
});

it("fences an unaccepted login so a delayed original request cannot create a session", async () => {
  const { app, path } = setup();
  const loginId = crypto.randomUUID();
  const revokeId = crypto.randomUUID();
  expect((await call(app, `/receipts/${loginId}/lookup`, { password })).status).toBe(404);
  const revoke = await call(app, `/login/${loginId}/revoke`, { password, requestId: revokeId });
  expect(revoke.status).toBe(200);
  const receipt = await revoke.json();
  const restarted = createApi(path, undefined, { password });
  const late = await call(restarted, "/login", { password, requestId: loginId });
  expect(late.status).toBe(409);
  expect((await late.json()).receipt).toMatchObject({ requestId: loginId, outcome: "closed_before_acceptance" });
  expect(late.headers.has("set-cookie")).toBe(false);
  expect(count(path, "sessions")).toBe(0);
  expect(await (await call(restarted, `/login/${loginId}/revoke`, { password, requestId: revokeId })).json()).toEqual(receipt);
  const conflicting = await call(restarted, `/login/${crypto.randomUUID()}/revoke`, { password, requestId: revokeId });
  expect(conflicting.status).toBe(409);
  expect(count(path, "auth_requests")).toBe(2);
});

it("does not let an old keyed logout revoke a newer session or clear its cookie", async () => {
  const { app, path } = setup();
  const firstId = crypto.randomUUID();
  const oldCookie = cookieFrom(await call(app, "/login", { password, requestId: firstId }));
  const logoutId = crypto.randomUUID();
  const logout = await call(app, "/logout", { requestId: logoutId }, oldCookie);
  expect(logout.status).toBe(200);
  const receipt = await logout.json();
  expect(receipt).toMatchObject({ kind: "logout", requestId: logoutId, outcome: "sessions_revoked" });
  expect(count(path, "sessions")).toBe(0);
  const newId = crypto.randomUUID();
  const freshCookie = cookieFrom(await call(app, "/login", { password, requestId: newId }));
  const replay = await call(app, "/logout", { requestId: logoutId }, freshCookie);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(replay.headers.has("set-cookie")).toBe(false);
  expect((await call(app, "/session", undefined, freshCookie, "GET")).status).toBe(200);
  expect((await call(app, "/logout", { requestId: crypto.randomUUID() }, oldCookie)).status).toBe(401);
  const oldLogin = await call(app, "/login", { password, requestId: firstId });
  expect(oldLogin.headers.has("set-cookie")).toBe(false);
  expect(count(path, "sessions")).toBe(1);
});

it("requires real authority for known IDs and never stores or echoes credentials in receipts", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  const login = await call(app, "/login", { password, requestId });
  const token = cookieFrom(login).split("=")[1]!;
  const known = await login.json();
  for (const [route, body] of [
    ["/login", { password: "incorrect-password", requestId }],
    [`/receipts/${requestId}/lookup`, { password: "incorrect-password" }],
    [`/login/${requestId}/revoke`, { password: "incorrect-password", requestId: crypto.randomUUID() }],
  ] as const) expect((await call(app, route, body)).status).toBe(401);
  expect((await call(app, `/receipts/${requestId}/lookup`, {})).status).toBe(401);
  const other = "c".repeat(64);
  const db = new Database(path);
  try {
    db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(other).digest("hex"), "other", Date.now() + 60_000);
    const stored = JSON.stringify(db.query("SELECT * FROM auth_requests").all());
    expect(stored.includes(token)).toBe(false);
    expect(stored.includes(password)).toBe(false);
  } finally { db.close(); }
  expect((await call(app, `/receipts/${requestId}/lookup`, {}, `remotecode_session=${other}`)).status).toBe(404);
  const invalid = await call(app, "/login", { password, requestId: "not-a-uuid" });
  expect(invalid.status).toBe(422);
  expect((await invalid.text()).includes(password)).toBe(false);
  expect(JSON.stringify(known.receipt).includes(token)).toBe(false);
  expect(count(path, "auth_requests")).toBe(1);
});

it("rolls back the session when its durable auth receipt cannot be inserted", async () => {
  const { app, path } = setup();
  const db = new Database(path);
  try {
    db.exec("CREATE TRIGGER fail_auth_receipt BEFORE INSERT ON auth_requests BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    const failed = await call(app, "/login", { password, requestId: crypto.randomUUID() });
    expect(failed.status).toBe(500);
    expect(failed.headers.has("set-cookie")).toBe(false);
    expect(count(path, "sessions")).toBe(0);
    expect(count(path, "auth_requests")).toBe(0);
  } finally { db.close(); }
});

it("enforces login transport restrictions on credential-bearing receipt and revocation routes", async () => {
  const { app } = setup();
  const id = crypto.randomUUID();
  for (const route of [`/receipts/${id}/lookup`, `/login/${id}/revoke`]) {
    const response = await app.handle(new Request(`http://untrusted.example/api/auth${route}`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password, requestId: crypto.randomUUID() }),
    }));
    expect(response.status).toBe(403);
    expect(response.headers.has("set-cookie")).toBe(false);
  }
});

it("retains canonical login history after expiry and rejects operation-kind reuse without effects", async () => {
  const { app, path } = setup();
  const id = crypto.randomUUID();
  const first = await call(app, "/login", { password, requestId: id });
  const cookie = cookieFrom(first);
  const canonical = await first.json();
  expect((await call(app, "/logout", { requestId: id }, cookie)).status).toBe(409);
  expect(count(path, "sessions")).toBe(1);
  const db = new Database(path);
  db.query("UPDATE sessions SET expires_at = 0").run();
  db.close();
  expect((await call(app, "/session", undefined, cookie, "GET")).status).toBe(401);
  const restart = createApi(path, undefined, { password });
  const replay = await call(restart, "/login", { password, requestId: id });
  expect(await replay.json()).toEqual(canonical);
  expect(replay.headers.has("set-cookie")).toBe(false);
  expect(count(path, "sessions")).toBe(0);
  const status = await call(restart, `/receipts/${id}/lookup`, { password });
  expect((await status.json()).sessionStatus).toBe("inactive");
});

it("marks readiness degraded when durable auth outcome storage disappears", async () => {
  const { app, path } = setup();
  const db = new Database(path);
  db.exec("DROP TABLE auth_requests");
  db.close();
  const ready = await app.handle(new Request("http://localhost/api/health/ready"));
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({ status: "not_ready" });
});

function listenerRefused(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => {
      socket.destroy();
      if ("code" in error && error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Listener cleanup is unverified: TCP connection timed out")); });
  });
}

function socketMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error("Missing authenticated snapshot")); }, 2000);
    function receive(event: MessageEvent) { clearTimeout(timer); socket.removeEventListener("message", receive); resolve(String(event.data)); }
    socket.addEventListener("message", receive);
  });
}

it("closes only the revoked login's socket after commit and keeps both sockets live on rollback", async () => {
  const { app, path } = setup();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const firstCookie = cookieFrom(await call(app, "/login", { password, requestId: firstId }));
  const secondCookie = cookieFrom(await call(app, "/login", { password, requestId: secondId }));
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("API did not bind");
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const sockets = [firstCookie, secondCookie].map((cookie) => new Socket(`ws://127.0.0.1:${port}/api/events`, { headers: { cookie, origin: "http://localhost:5173" } }));
  const first = sockets[0]!;
  const second = sockets[1]!;
  try {
    const snapshots = await Promise.all(sockets.map(socketMessage));
    expect(snapshots.every((message) => JSON.parse(message).type === "snapshot")).toBe(true);
    const db = new Database(path);
    db.exec("CREATE TRIGGER fail_revoke BEFORE INSERT ON auth_requests WHEN NEW.kind = 'revoke_login' BEGIN SELECT RAISE(ABORT, 'injected revoke failure'); END");
    db.close();
    const revokeId = crypto.randomUUID();
    expect((await call(app, `/login/${firstId}/revoke`, { password, requestId: revokeId })).status).toBe(500);
    expect(count(path, "sessions")).toBe(2);
    const before = Promise.all(sockets.map(socketMessage));
    sockets.forEach((socket) => socket.send(JSON.stringify({ type: "sync" })));
    expect((await before).every((message) => JSON.parse(message).type === "snapshot")).toBe(true);
    const unlocked = new Database(path);
    unlocked.exec("DROP TRIGGER fail_revoke");
    unlocked.close();
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Targeted session socket remained open")), 2000);
      first.addEventListener("close", (event) => { clearTimeout(timer); resolve(event.code); }, { once: true });
    });
    expect((await call(app, `/login/${firstId}/revoke`, { password, requestId: revokeId })).status).toBe(200);
    expect(await closed).toBe(4401);
    const stillLive = socketMessage(second);
    second.send(JSON.stringify({ type: "sync" }));
    expect(JSON.parse(await stillLive).type).toBe("snapshot");
    expect((await call(app, "/session", undefined, secondCookie, "GET")).status).toBe(200);
    expect(count(path, "sessions")).toBe(1);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.close();
      });
    }
    // Bun can close the listener but leave stop pending after a server-initiated socket close.
    await Promise.race([server.stop(true), new Promise((resolve) => setTimeout(resolve, 500))]);
    expect(await listenerRefused(port)).toBe(true);
  }
});

it("recovers lost login and revocation responses through fresh Eden clients after API-instance restarts", async () => {
  const { path } = setup();
  const loginId = crypto.randomUUID();
  const revokeId = crypto.randomUUID();
  let loginPosts = 0;
  let revokePosts = 0;
  function start(drop: "login" | "revoke" | null) {
    const app = new Elysia()
      .onAfterHandle({ as: "global" }, ({ request, set }) => {
        const pathname = new URL(request.url).pathname;
        if (request.method !== "POST") return;
        if (pathname === "/api/auth/login") loginPosts++;
        if (pathname.endsWith("/revoke")) revokePosts++;
        if ((drop === "login" && pathname === "/api/auth/login") || (drop === "revoke" && pathname.endsWith("/revoke"))) {
          delete set.headers["set-cookie"];
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"receipt":')); } }), {
            headers: { "content-type": "application/json" },
          });
        }
      })
      .use(createApi(path, undefined, { password }));
    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("API did not bind");
    return { server, client: createApiClient(`http://127.0.0.1:${port}`, { timeoutMs: 100 }) };
  }
  const first = start("login");
  try {
    const lost = await first.client.api.auth.login.post({ password, requestId: loginId });
    expect(lost.data).toBeNull();
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    expect(count(path, "sessions")).toBe(1);
  } finally { await first.server.stop(true); }
  const second = start("revoke");
  try {
    const lookup = await second.client.api.auth.receipts({ requestId: loginId }).lookup.post({ password });
    expect(lookup.error).toBeNull();
    expect(lookup.data).toMatchObject({ receipt: { requestId: loginId, outcome: "session_created" }, sessionStatus: "active" });
    const lost = await second.client.api.auth.login({ loginRequestId: loginId }).revoke.post({ password, requestId: revokeId });
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    expect(count(path, "sessions")).toBe(0);
  } finally { await second.server.stop(true); }
  const third = start(null);
  try {
    const lookup = await third.client.api.auth.receipts({ requestId: revokeId }).lookup.post({ password });
    expect(lookup.error).toBeNull();
    expect(lookup.data).toMatchObject({ receipt: { requestId: revokeId, outcome: "login_revoked", targetRequestId: loginId } });
    expect(loginPosts).toBe(1);
    expect(revokePosts).toBe(1);
    const next = await third.client.api.auth.login.post({ password, requestId: crypto.randomUUID() });
    expect(next.error).toBeNull();
    expect(count(path, "sessions")).toBe(1);
  } finally { await third.server.stop(true); }
});

it.each(["accepted", "pending"] as const)("treats UUID aliases as one %s login when revoking or fencing", async (state) => {
  const { app, path } = setup();
  const loginId = "abcdefab-1234-4abc-8def-abcdefabcdef";
  let cookie: string | undefined;
  if (state === "accepted") cookie = cookieFrom(await call(app, "/login", { password, requestId: loginId.toUpperCase() }));
  const revoked = await call(app, `/login/${loginId.toUpperCase()}/revoke`, {
    password, requestId: "BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB",
  });
  expect(revoked.status).toBe(200);
  if (cookie) expect((await call(app, "/session", undefined, cookie, "GET")).status).toBe(401);
  const late = await call(app, "/login", { password, requestId: loginId });
  expect(late.status).toBe(state === "accepted" ? 200 : 409);
  expect(late.headers.has("set-cookie")).toBe(false);
  expect(count(path, "sessions")).toBe(0);
  const lookup = await call(app, `/receipts/${loginId.toUpperCase()}/lookup`, { password });
  expect((await lookup.json()).receipt.requestId).toBe(loginId);
  const replay = await call(app, `/login/${loginId}/revoke`, {
    password, requestId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  });
  expect(await replay.json()).toEqual(await revoked.json());
  expect(count(path, "auth_requests")).toBe(2);
});


it("never mistakes a live listener with stalled HTTP for confirmed TCP refusal", async () => {
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    arrived();
    return new Promise<Response>(() => {});
  } });
  const controller = new AbortController();
  const stalled = fetch(`http://127.0.0.1:${server.port}`, { signal: controller.signal }).catch(() => undefined);
  try {
    await requestArrived;
    expect(await listenerRefused(server.port!)).toBe(false);
  } finally {
    controller.abort();
    await stalled;
    await server.stop(true);
  }
  expect(await listenerRefused(server.port!)).toBe(true);
});

it("rejects UUID URN aliases before they can create a separate login or fence", async () => {
  const { app, path } = setup();
  const id = "abcdefab-1234-4abc-8def-abcdefabcdef";
  const urn = `urn:uuid:${id}`;
  const cookie = cookieFrom(await call(app, "/login", { password, requestId: id }));
  expect((await call(app, "/login", { password, requestId: urn })).status).toBe(422);
  expect((await call(app, `/login/${urn}/revoke`, { password, requestId: crypto.randomUUID() })).status).toBe(422);
  expect((await call(app, `/receipts/${urn}/lookup`, { password })).status).toBe(422);
  expect((await call(app, "/logout", { requestId: urn }, cookie)).status).toBe(422);
  expect(count(path, "sessions")).toBe(1);
  expect(count(path, "auth_requests")).toBe(1);
});
