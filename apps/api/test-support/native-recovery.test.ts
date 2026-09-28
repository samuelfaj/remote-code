import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeRecoveryTestApi } from "./native-recovery";

const scratch = process.env.RC_NATIVE_TEST_WORK_DIR ?? tmpdir();
it("native fixture holds a real SQLite lock until released and preserves authentication", async () => {
  const directory = mkdtempSync(join(scratch, "health-fixture-"));
  const databasePath = join(directory, "host.sqlite");
  const password = "native-health-fixture-password";
  const app = createNativeRecoveryTestApi(databasePath, password).listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;
  try {
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const lock = (locked: boolean, credential = cookie) => locked
      ? fetch(`${origin}/__test__/storage-lock`, {
        method: "POST", headers: { "content-type": "application/json", cookie: credential }, body: JSON.stringify({ locked: true }),
      })
      : fetch(`${origin}/__test__/storage-unlock`, { headers: { cookie: credential } });
    expect((await lock(true, "")).status).toBe(401);
    expect((await lock(true)).status).toBe(200);
    expect((await fetch(`${origin}/api/health/ready`)).status).toBe(503);
    const blocked = await fetch(`${origin}/api/actions`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ action: "must not commit under lock", requestId: crypto.randomUUID() }),
    });
    expect(blocked.status).not.toBe(201);
    expect((await lock(false)).status).toBe(200);
    expect((await fetch(`${origin}/api/health/ready`)).status).toBe(200);
    expect((await fetch(`${origin}/api/auth/session`, { headers: { cookie } })).status).toBe(200);
  } finally {
    await app.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("native auth faults lose transport evidence, not real committed effects; fencing blocks delayed login", async () => {
  const directory = mkdtempSync(join(scratch, "auth-fixture-"));
  const databasePath = join(directory, "host.sqlite");
  const password = "native-auth-fixture-password";
  const app = createNativeRecoveryTestApi(databasePath, password).listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;
  const post = (path: string, body: object, cookie = "") => fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  });
  const admin = await post("/api/auth/login", { password });
  const cookie = admin.headers.get("set-cookie")!.split(";")[0]!;
  const count = () => {
    const db = new Database(databasePath);
    try { return db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()!.count; }
    finally { db.close(); }
  };
  try {
    expect((await post("/__test__/auth-fault", { fault: "login-cookie" })).status).toBe(401);
    expect((await post("/__test__/auth-fault", { fault: "login-cookie" }, cookie)).status).toBe(200);
    const loginId = crypto.randomUUID();
    const lost = await post("/api/auth/login", { password, requestId: loginId });
    expect(lost.headers.get("set-cookie")).toBeNull();
    expect(lost.status).toBe(200);
    await lost.body!.cancel();
    expect(count()).toBe(2);
    const lookup = await post(`/api/auth/receipts/${loginId}/lookup`, { password });
    expect(await lookup.json()).toMatchObject({ receipt: { requestId: loginId, outcome: "session_created" }, sessionStatus: "active" });
    expect((await post(`/api/auth/receipts/${loginId}/lookup`, { password: "wrong" })).status).toBe(401);
    expect((await post("/__test__/auth-fault", { fault: "revoke-body" }, cookie)).status).toBe(200);
    const revokeId = crypto.randomUUID();
    const lostRevoke = await post(`/api/auth/login/${loginId}/revoke`, { password, requestId: revokeId });
    expect(lostRevoke.status).toBe(200);
    await lostRevoke.body!.cancel();
    expect(count()).toBe(1);
    expect(await (await post(`/api/auth/receipts/${revokeId}/lookup`, { password })).json()).toMatchObject({ receipt: { kind: "revoke_login", targetRequestId: loginId, outcome: "login_revoked" } });
    expect((await post("/__test__/auth-fault", { fault: "login-before" }, cookie)).status).toBe(200);
    const delayedId = crypto.randomUUID();
    expect((await post("/api/auth/login", { password, requestId: delayedId })).status).toBe(503);
    expect((await post(`/api/auth/receipts/${delayedId}/lookup`, { password })).status).toBe(404);
    expect((await post(`/api/auth/login/${delayedId}/revoke`, { password, requestId: crypto.randomUUID() })).status).toBe(200);
    expect(await (await post(`/api/auth/receipts/${delayedId}/lookup`, { password })).json())
      .toMatchObject({ receipt: { requestId: delayedId, kind: "login", outcome: "closed_before_acceptance" } });
    expect((await post("/api/auth/login", { password, requestId: delayedId })).status).toBe(409);
    expect(count()).toBe(1);
    expect((await post("/__test__/auth-fault", { fault: "logout-body" }, cookie)).status).toBe(200);
    const logoutId = crypto.randomUUID();
    const lostLogout = await post("/api/auth/logout", { requestId: logoutId }, cookie);
    expect(lostLogout.status).toBe(200);
    await lostLogout.body!.cancel();
    expect(count()).toBe(0);
    expect(await (await post(`/api/auth/receipts/${logoutId}/lookup`, { password })).json()).toMatchObject({ receipt: { requestId: logoutId, outcome: "sessions_revoked" } });
  } finally {
    await app.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("synthetic 401 after a real commit is not authoritative rejection of login or revocation", async () => {
  const directory = mkdtempSync(join(scratch, "auth-401-fixture-"));
  const databasePath = join(directory, "host.sqlite");
  const password = "native-auth-fixture-password";
  const app = createNativeRecoveryTestApi(databasePath, password).listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;
  const post = (path: string, body: object, cookie = "") => fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  });
  try {
    const admin = await post("/api/auth/login", { password });
    const cookie = admin.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/__test__/auth-fault", { fault: "login-401" }, cookie)).status).toBe(200);
    const loginId = crypto.randomUUID();
    const login = await post("/api/auth/login", { password, requestId: loginId });
    expect(login.status).toBe(401);
    expect(await login.json()).toEqual({ error: "injected_proxy_unauthorized" });
    expect(login.headers.get("set-cookie")).toBeNull();
    expect(await (await post(`/api/auth/receipts/${loginId}/lookup`, { password })).json()).toMatchObject({
      receipt: { requestId: loginId, kind: "login", outcome: "session_created" }, sessionStatus: "active",
    });
    expect((await post("/__test__/auth-fault", { fault: "revoke-401" }, cookie)).status).toBe(200);
    const revokeId = crypto.randomUUID();
    const revoke = await post(`/api/auth/login/${loginId}/revoke`, { password, requestId: revokeId });
    expect(revoke.status).toBe(401);
    expect(await revoke.json()).toEqual({ error: "injected_proxy_unauthorized" });
    expect(await (await post(`/api/auth/receipts/${revokeId}/lookup`, { password })).json()).toMatchObject({
      receipt: { requestId: revokeId, kind: "revoke_login", targetRequestId: loginId, outcome: "login_revoked" },
    });
    const db = new Database(databasePath);
    try {
      expect(db.query("SELECT request_id FROM auth_requests WHERE request_id IN (?, ?)").all(loginId, revokeId)).toHaveLength(2);
      expect(db.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    } finally { db.close(); }
    const diagnostics = await fetch(`${origin}/__test__/auth-diagnostics`, { headers: { cookie } });
    expect(await diagnostics.json()).toMatchObject({ loginPosts: 1, revokePosts: 1, loginRequestId: loginId, revokeRequestId: revokeId });
  } finally {
    await app.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
