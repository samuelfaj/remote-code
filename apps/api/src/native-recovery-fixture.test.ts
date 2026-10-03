import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, isUnknownOutcomeError } from "../../../packages/client/src";
import { createNativeRecoveryTestApi } from "../test-support/native-recovery";

it("injects native response loss only after the real action commits and preserves canonical recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rc018-native-fixture-"));
  const password = "native-fixture-password";
  const app = createNativeRecoveryTestApi(join(directory, "host.sqlite"), password);
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing authenticated native test session");
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Native fixture did not listen");
  const origin = `http://127.0.0.1:${port}`;
  const requestId = crypto.randomUUID();
  const client = createApiClient(origin, { timeoutMs: 100, headers: { cookie } });
  try {
    expect((await fetch(`${origin}/__test__/lose-action-response`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${origin}/__test__/lose-action-response`, { method: "POST", headers: { cookie } })).status).toBe(200);
    const write = await client.api.actions.post({ requestId, action: "native response loss proof" });
    expect(isUnknownOutcomeError(write.error)).toBe(true);
    const history = await client.api.actions.get();
    if (!history.data || !("actions" in history.data) || !Array.isArray(history.data.actions)) throw new Error("Missing real history");
    expect(history.data.actions).toHaveLength(1);
    expect((await client.api.actions.receipts({ requestId }).get()).status).toBe(503);
    const recovered = await client.api.actions.receipts({ requestId }).get();
    expect(recovered.error).toBeNull();
    expect(recovered.data).toEqual(history.data.actions[0]!);
    const diagnostics = await fetch(`${origin}/__test__/response-loss`, { headers: { cookie } });
    const values = await diagnostics.json() as {
      lostResponse: boolean;
      failedRead: boolean;
      receiptReads: number;
      receiptReadAtMs: number[];
      actionPosts: number;
      requestId: string;
    };
    expect(values).toMatchObject({ lostResponse: true, failedRead: true, receiptReads: 2, actionPosts: 1, requestId });
    expect(values.receiptReadAtMs).toHaveLength(2);
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects unauthenticated AsyncStorage permission control without an API effect", async () => {
  const directory = mkdtempSync(join(process.env.RC_NATIVE_TEST_WORK_DIR ?? tmpdir(), "rc018-native-storage-control-"));
  const previousDeviceId = process.env.RC_NATIVE_TEST_STORAGE_DEVICE_ID;
  const previousDeviceName = process.env.RC_NATIVE_TEST_STORAGE_DEVICE_NAME;
  delete process.env.RC_NATIVE_TEST_STORAGE_DEVICE_ID;
  delete process.env.RC_NATIVE_TEST_STORAGE_DEVICE_NAME;
  try {
    const app = createNativeRecoveryTestApi(join(directory, "host.sqlite"), "native-storage-control-password");
    for (const operation of ["deny-write", "restore"]) {
      const response = await app.handle(new Request("https://localhost/__test__/storage-manifest-permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation }),
      }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    const database = new Database(join(directory, "host.sqlite"), { readonly: true, create: false });
    try {
      expect(database.query("SELECT COUNT(*) AS count FROM actions").get()).toEqual({ count: 0 });
      expect(database.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
      expect(database.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally { database.close(); }
  } finally {
    if (previousDeviceId === undefined) delete process.env.RC_NATIVE_TEST_STORAGE_DEVICE_ID;
    else process.env.RC_NATIVE_TEST_STORAGE_DEVICE_ID = previousDeviceId;
    if (previousDeviceName === undefined) delete process.env.RC_NATIVE_TEST_STORAGE_DEVICE_NAME;
    else process.env.RC_NATIVE_TEST_STORAGE_DEVICE_NAME = previousDeviceName;
    rmSync(directory, { recursive: true, force: true });
  }
});

it("revokes the actual receipt session before a held lookup returns unauthorized", async () => {
  const directory = mkdtempSync(join(process.env.RC_NATIVE_TEST_WORK_DIR ?? tmpdir(), "privacy-receipt-fixture-"));
  const databasePath = join(directory, "host.sqlite");
  const password = "native-fixture-password";
  const app = createNativeRecoveryTestApi(databasePath, password);
  const login = async () => {
    const response = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    }));
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing authenticated native fixture session");
    return cookie;
  };
  const controllerCookie = await login();
  const mobileCookie = await login();
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Native fixture did not listen");
  const origin = `http://127.0.0.1:${port}`;
  const requestId = crypto.randomUUID();
  const action = "native privacy receipt revocation proof";
  const control = (path: string, method = "GET", body?: object) => fetch(`${origin}${path}`, {
    method,
    headers: { cookie: controllerCookie, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const armed = await control("/__test__/lose-action-response", "POST", { privacyUnauthorizedReceipt: true });
    expect(armed.status).toBe(200);
    const post = await fetch(`${origin}/api/actions`, {
      method: "POST", headers: { cookie: mobileCookie, "content-type": "application/json" },
      body: JSON.stringify({ requestId, action }),
    });
    expect(post.status).toBe(201);
    await post.body?.cancel();

    const receiptRead = fetch(`${origin}/api/actions/receipts/${requestId}`, { headers: { cookie: mobileCookie } });
    const started = await control("/__test__/wait-privacy-receipt");
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ privacyReceiptReads: 1, privacySessionRevocations: 1, privacyReceiptRequestId: requestId });
    const released = await control("/__test__/release-privacy-receipt", "POST");
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
    const unauthorized = await receiptRead;
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    expect((await fetch(`${origin}/api/auth/session`, { headers: { cookie: mobileCookie } })).status).toBe(401);
    expect((await fetch(`${origin}/api/auth/session`, { headers: { cookie: controllerCookie } })).status).toBe(200);
    const diagnostics = await control("/__test__/response-loss");
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({
      lostResponse: true, actionPosts: 1, requestId, privacyReceiptReads: 1,
      privacySessionRevocations: 1, privacyReceiptRequestId: requestId, privacyReceiptResponseStatus: 401,
    });
    const database = new Database(databasePath, { readonly: true, create: false });
    try {
      expect(database.query("SELECT id, action FROM actions").all()).toHaveLength(1);
      expect(database.query("SELECT request_id, action_id FROM action_requests").all()).toHaveLength(1);
      expect(database.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
      expect(database.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally { database.close(); }

    expect((await control("/api/auth/logout", "POST", {})).status).toBe(204);
    const afterLogout = new Database(databasePath, { readonly: true, create: false });
    try { expect(afterLogout.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 }); }
    finally { afterLogout.close(); }
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("returns the canonical action receipt when the real handler accepts after a delay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rc018-native-post-delay-"));
  const password = "native-post-delay-password";
  const app = createNativeRecoveryTestApi(join(directory, "host.sqlite"), password);
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing authenticated native test session");
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Native fixture did not listen");
  const origin = `http://127.0.0.1:${port}`;
  const client = createApiClient(origin, { timeoutMs: 8_000, headers: { cookie } });
  let releasePending = false;
  try {
    const armed = await fetch(`${origin}/__test__/lose-action-response`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ actionDeadlinePostDelay: true }),
    });
    expect(armed.status).toBe(200);
    releasePending = true;

    const requestId = crypto.randomUUID();
    const action = "native delayed acceptance response proof";
    const submission = client.api.actions.post({ requestId, action });
    type ActionPostDelayDiagnostics = {
      actionPosts: number;
      actionPostDelayCompleted: boolean;
      lostResponse: boolean;
      receiptReads: number;
      requestId: string;
    };
    const started = await fetch(`${origin}/__test__/wait-action-post`, { headers: { cookie } });
    expect(started.status).toBe(200);
    let diagnostics = await started.json() as ActionPostDelayDiagnostics;
    expect(diagnostics).toMatchObject({ actionPosts: 1, actionPostDelayCompleted: false, receiptReads: 0 });
    const historyBeforeAcceptance = await client.api.actions.get();
    if (!historyBeforeAcceptance.data || !("actions" in historyBeforeAcceptance.data) || !Array.isArray(historyBeforeAcceptance.data.actions)) throw new Error("Missing real action history");
    expect(historyBeforeAcceptance.data.actions).toEqual([]);

    const released = await fetch(`${origin}/__test__/release-action-post`, { method: "POST", headers: { cookie } });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
    releasePending = false;

    const submitted = await submission;
    if (submitted.error || !submitted.data || !("id" in submitted.data)) throw new Error("Missing canonical POST receipt");
    expect(submitted.data.action).toBe(action);

    const canonical = await client.api.actions.receipts({ requestId }).get();
    if (canonical.error || !canonical.data || !("id" in canonical.data)) throw new Error("Missing canonical receipt lookup");
    expect(canonical.data).toEqual(submitted.data);
    const history = await client.api.actions.get();
    if (!history.data || !("actions" in history.data) || !Array.isArray(history.data.actions)) throw new Error("Missing real action history");
    expect(history.data.actions).toEqual([canonical.data]);

    diagnostics = await (await fetch(`${origin}/__test__/response-loss`, { headers: { cookie } })).json() as ActionPostDelayDiagnostics;
    expect(diagnostics).toMatchObject({
      lostResponse: false,
      actionPostDelayCompleted: true,
      actionPosts: 1,
      requestId,
    });
  } finally {
    if (releasePending) {
      await fetch(`${origin}/__test__/release-action-post`, { method: "POST", headers: { cookie } }).catch(() => null);
    }
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 8_000);

it("holds a real keyed login before acceptance until its caller deadline is observed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rc018-native-login-deadline-"));
  const databasePath = join(directory, "host.sqlite");
  const password = crypto.randomUUID();
  const app = createNativeRecoveryTestApi(databasePath, password);
  const adminLogin = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  }));
  const cookie = adminLogin.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing authenticated native test session");
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Native fixture did not listen");
  const origin = `http://127.0.0.1:${port}`;
  let loginPost: Promise<Response> | null = null;
  let releasePending = false;
  try {
    const armed = await fetch(`${origin}/__test__/auth-fault`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ fault: "login-before", loginDeadline: true }),
    });
    expect(armed.status).toBe(200);

    const requestId = crypto.randomUUID();
    loginPost = fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, requestId }),
    });
    releasePending = true;
    type LoginPostDiagnostics = {
      loginPosts: number;
      loginPostDelayCompleted: boolean;
      loginReceiptReads: number;
      loginReceiptExists: boolean;
      loginRequestId: string | null;
    };
    const started = await fetch(`${origin}/__test__/wait-login-post`, { headers: { cookie } });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ loginPosts: 1, loginRequestId: requestId, loginPostDelayCompleted: false });
    const diagnostics = await (await fetch(`${origin}/__test__/auth-diagnostics`, { headers: { cookie } })).json() as LoginPostDiagnostics;
    expect(diagnostics).toMatchObject({ loginReceiptReads: 0, loginReceiptExists: false });

    const beforeRelease = new Database(databasePath, { readonly: true, create: false });
    let authRowsBefore = -1;
    let sessionsBefore = -1;
    try {
      authRowsBefore = beforeRelease.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM auth_requests WHERE request_id = ?").get(requestId)!.count;
      sessionsBefore = beforeRelease.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()!.count;
    } finally { beforeRelease.close(); }
    expect(authRowsBefore).toBe(0);
    expect(sessionsBefore).toBe(1);

    const released = await fetch(`${origin}/__test__/release-login-post`, { method: "POST", headers: { cookie } });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
    releasePending = false;

    const rejected = await loginPost;
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: "injected_before_login" });
    const afterReleaseDiagnostics = await (await fetch(`${origin}/__test__/auth-diagnostics`, { headers: { cookie } })).json() as LoginPostDiagnostics;
    expect(afterReleaseDiagnostics).toMatchObject({ loginPosts: 1, loginPostDelayCompleted: true, loginReceiptExists: false });

    const database = new Database(databasePath, { readonly: true, create: false });
    try {
      expect(database.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM auth_requests WHERE request_id = ?").get(requestId)!.count).toBe(0);
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()!.count).toBe(1);
      expect(database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()!.quick_check).toBe("ok");
    } finally { database.close(); }

    const loggedOut = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(loggedOut.status).toBe(204);
  } finally {
    if (releasePending) {
      await fetch(`${origin}/__test__/release-login-post`, { method: "POST", headers: { cookie } }).catch(() => null);
      await loginPost?.catch(() => null);
    }
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 8_000);

it("holds capability negotiation before any keyed login mutation until explicitly released", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rc018-native-preflight-deadline-"));
  const databasePath = join(directory, "host.sqlite");
  const password = crypto.randomUUID();
  const app = createNativeRecoveryTestApi(databasePath, password);
  const adminLogin = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  }));
  const cookie = adminLogin.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing authenticated native test session");
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Native fixture did not listen");
  const origin = `http://127.0.0.1:${port}`;
  let versionRequest: Promise<Response> | null = null;
  let releasePending = false;
  try {
    const armed = await fetch(`${origin}/__test__/auth-fault`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ fault: "login-before", loginPreflightDeadline: true }),
    });
    expect(armed.status).toBe(200);

    versionRequest = fetch(`${origin}/api/version`);
    releasePending = true;
    const started = await fetch(`${origin}/__test__/wait-login-version`, { headers: { cookie } });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ loginVersionRequests: 1 });
    const diagnosticsBeforeRelease = await (await fetch(`${origin}/__test__/auth-diagnostics`, { headers: { cookie } })).json() as {
      loginPosts: number;
      loginReceiptReads: number;
      loginRequestId: string | null;
      loginReceiptExists: boolean;
      loginVersionRequests: number;
    };
    expect(diagnosticsBeforeRelease).toMatchObject({
      loginPosts: 0,
      loginReceiptReads: 0,
      loginRequestId: null,
      loginReceiptExists: false,
      loginVersionRequests: 1,
    });

    const beforeRelease = new Database(databasePath, { readonly: true, create: false });
    try {
      expect(beforeRelease.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM auth_requests WHERE kind = 'login'").get()!.count).toBe(0);
      expect(beforeRelease.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()!.count).toBe(1);
      expect(beforeRelease.query<{ quick_check: string }, []>("PRAGMA quick_check").get()!.quick_check).toBe("ok");
    } finally { beforeRelease.close(); }

    const released = await fetch(`${origin}/__test__/release-login-version`, { method: "POST", headers: { cookie } });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
    releasePending = false;

    const capabilityResponse = await versionRequest;
    expect(capabilityResponse.status).toBe(200);
    const finished = await fetch(`${origin}/__test__/wait-login-version-finished`, { headers: { cookie } });
    expect(finished.status).toBe(200);
    expect(await finished.json()).toEqual({ loginVersionRequests: 1, loginVersionRequestFinished: true });
    const diagnosticsAfterRelease = await (await fetch(`${origin}/__test__/auth-diagnostics`, { headers: { cookie } })).json() as typeof diagnosticsBeforeRelease;
    expect(diagnosticsAfterRelease).toMatchObject({ loginPosts: 0, loginReceiptReads: 0, loginRequestId: null, loginReceiptExists: false });

    const database = new Database(databasePath, { readonly: true, create: false });
    try {
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM auth_requests WHERE kind = 'login'").get()!.count).toBe(0);
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()!.count).toBe(1);
      expect(database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()!.quick_check).toBe("ok");
    } finally { database.close(); }

    const loggedOut = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(loggedOut.status).toBe(204);
  } finally {
    if (releasePending) {
      await fetch(`${origin}/__test__/release-login-version`, { method: "POST", headers: { cookie } }).catch(() => null);
      await versionRequest?.catch(() => null);
    }
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 8_000);
