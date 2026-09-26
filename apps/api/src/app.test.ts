import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { createApi } from "./app";

const databasePath = (label: string) => `/tmp/rc006-${label}-${crypto.randomUUID()}.sqlite`;
const testPassword = "local-test-password";

async function authenticatedApi(path: string) {
  const app = createApi(path, undefined, { password: testPassword });
  const response = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: testPassword }),
  }));
  if (response.status !== 200) throw new Error("Test auth login failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test auth cookie missing");
  return { app, cookie };
}

async function healthStatus(app: ReturnType<typeof createApi>, route: string) {
  return app.handle(new Request(`http://localhost/api/health/${route}`));
}

function openSocket(url: string, cookie?: string, origin = "http://localhost:5173") {
  // Bun supports request headers here; the DOM WebSocket overload exposes only protocols.
  const BunWebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new BunWebSocketWithHeaders(url, { headers: { ...(cookie ? { cookie } : {}), origin } });
}

async function receivesSnapshot(url: string, cookie?: string, origin = "http://localhost:5173") {
  const socket = openSocket(url, cookie, origin);
  let received = false;
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    socket.onmessage = (event) => {
      if ((JSON.parse(String(event.data)) as { type?: string }).type === "snapshot") received = true;
      finish();
    };
    socket.onopen = () => setTimeout(finish, 100);
    socket.onerror = finish;
    socket.onclose = finish;
    setTimeout(finish, 500);
  });
  await closeSocket(socket);
  return received;
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.close();
  });
}

// Bun closes the listener but may leave its stop promise pending after a server-initiated WebSocket close.
async function stopTestServer(stopServer: (force?: boolean) => Promise<unknown>, port: number) {
  let stopped = false;
  const stop = stopServer(true).then(() => { stopped = true; });
  await Promise.race([stop, new Promise((resolve) => setTimeout(resolve, 500))]);
  if (stopped) return;
  let reachable = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(500) });
    reachable = true;
  } catch {
    // The listener is expected to refuse requests after forced shutdown.
  }
  if (reachable) throw new Error("Elysia listener remained open after forced shutdown");
}

function waitForEvent(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 3000);
    const listener = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (event.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(event);
    };
    socket.addEventListener("message", listener);
  });
}

describe("Elysia host authentication", () => {
  const authConfig = { password: "local-test-password", sessionTtlMs: 60_000 };

  it("rejects anonymous requests and validates a persisted session until logout", async () => {
    const path = databasePath("auth-session");
    const app = createApi(path, undefined, authConfig);
    const anonymous = await app.handle(new Request("http://localhost/api/auth/session"));
    expect(anonymous.status).toBe(401);
    const anonymousActions = await app.handle(new Request("http://localhost/api/actions"));
    expect(anonymousActions.status).toBe(401);
    const anonymousWrite = await app.handle(new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "anonymous write" }),
    }));
    expect(anonymousWrite.status).toBe(401);

    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("remotecode_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const secureApi = createApi(databasePath("auth-secure-cookie"), undefined, authConfig);
    const secureLogin = await secureApi.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    expect(secureLogin.headers.get("set-cookie")).toContain("Secure");

    const authenticated = await app.handle(new Request("http://localhost/api/auth/session", {
      headers: { cookie: cookie!.split(";")[0]! },
    }));
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ userId: "local" });

    const restartedApi = createApi(path, undefined, authConfig);
    const restoredSession = await restartedApi.handle(new Request("http://localhost/api/auth/session", {
      headers: { cookie: cookie!.split(";")[0]! },
    }));
    expect(restoredSession.status).toBe(200);
    expect(await restoredSession.json()).toEqual({ userId: "local" });

    const logout = await restartedApi.handle(new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: cookie!.split(";")[0]! },
    }));
    expect(logout.status).toBe(204);
    const afterLogout = await app.handle(new Request("http://localhost/api/auth/session", {
      headers: { cookie: cookie!.split(";")[0]! },
    }));
    expect(afterLogout.status).toBe(401);
    const actionAfterLogout = await app.handle(new Request("http://localhost/api/actions", {
      headers: { cookie: cookie!.split(";")[0]! },
    }));
    expect(actionAfterLogout.status).toBe(401);
  });

  it("rejects a sub-second session lifetime instead of issuing an immediately expired cookie", async () => {
    const app = createApi(databasePath("auth-subsecond-ttl"), undefined, {
      password: testPassword,
      sessionTtlMs: 500,
    });
    const response = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: testPassword }),
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("restricts authenticated WebSocket snapshots to the configured web origin", async () => {
    const { app, cookie } = await authenticatedApi(databasePath("websocket-origin"));
    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral WebSocket test port");
    const url = `ws://127.0.0.1:${port}/api/events`;
    try {
      expect(await receivesSnapshot(url, cookie, "http://localhost:5173")).toBe(true);
      expect(await receivesSnapshot(url, cookie, "http://attacker.localhost:5173")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it("revokes an idle authenticated WebSocket as soon as its session expires", async () => {
    const app = createApi(databasePath("websocket-expiry"), undefined, {
      password: testPassword,
      sessionTtlMs: 1250,
    });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: testPassword }),
    }));
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(login.status).toBe(200);
    expect(cookie).toBeTruthy();

    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral WebSocket test port");
    const socket = openSocket(`ws://127.0.0.1:${port}/api/events`, cookie);
    const snapshot = waitForEvent(socket, "snapshot");
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Expired WebSocket stayed open")), 3000);
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve(event.code);
      }, { once: true });
    });
    try {
      await snapshot;
      expect(await closed).toBe(4401);
      const privateRead = await app.handle(new Request("http://localhost/api/actions", {
        headers: { cookie: cookie! },
      }));
      expect(privateRead.status).toBe(401);
    } finally {
      await closeSocket(socket);
      await stopTestServer(server.stop.bind(server), port);
    }
  });

  it("keeps liveness available and fails login without a durable auth store", async () => {
    const unavailablePath = `/tmp/rc010-unavailable-${crypto.randomUUID()}.sqlite`;
    mkdirSync(unavailablePath);
    const unavailableApi = createApi(unavailablePath, undefined, authConfig);
    const [unavailableLive, unavailableReady] = await Promise.all([
      healthStatus(unavailableApi, "live"),
      healthStatus(unavailableApi, "ready"),
    ]);
    expect(unavailableLive.status).toBe(200);
    expect(unavailableReady.status).toBe(503);
    const unavailableLogin = await unavailableApi.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    expect(unavailableLogin.status).not.toBe(200);
    expect(unavailableLogin.headers.get("set-cookie")).toBeNull();

    const lockedPath = databasePath("auth-locked");
    const owner = new Database(lockedPath);
    owner.exec("CREATE TABLE actions (id TEXT PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL)");
    owner.exec("BEGIN EXCLUSIVE");
    try {
      const lockedApi = createApi(lockedPath, undefined, authConfig);
      const [lockedLive, lockedReady] = await Promise.all([
        healthStatus(lockedApi, "live"),
        healthStatus(lockedApi, "ready"),
      ]);
      expect(lockedLive.status).toBe(200);
      expect(lockedReady.status).toBe(503);
      const lockedLogin = await lockedApi.handle(new Request("https://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: authConfig.password }),
      }));
      expect(lockedLogin.status).not.toBe(200);
      expect(lockedLogin.headers.get("set-cookie")).toBeNull();
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
    }
  });

  it("rejects invalid or weak credentials and expired session cookies", async () => {
    const unconfigured = createApi(databasePath("auth-unconfigured"), undefined, {});
    const unconfiguredLogin = await unconfigured.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "any-password" }),
    }));
    expect(unconfiguredLogin.status).toBe(503);
    expect(unconfiguredLogin.headers.get("set-cookie")).toBeNull();

    const weakCredential = createApi(databasePath("auth-weak"), undefined, { password: "weak" });
    const weakLogin = await weakCredential.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "weak" }),
    }));
    expect(weakLogin.status).toBe(503);
    expect(weakLogin.headers.get("set-cookie")).toBeNull();
    const insecureRemoteLogin = await weakCredential.handle(new Request("http://remote.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a-strong-enough-test-password" }),
    }));
    expect(insecureRemoteLogin.status).toBe(403);
    expect(insecureRemoteLogin.headers.get("set-cookie")).toBeNull();
    const remoteApi = createApi(databasePath("auth-remote"), undefined, authConfig);
    const forgedProxy = await remoteApi.handle(new Request("http://remote.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    expect(forgedProxy.status).toBe(403);
    expect(forgedProxy.headers.get("set-cookie")).toBeNull();
    const forgedAuthority = await remoteApi.handle(new Request("http://remote.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    expect(forgedAuthority.status).toBe(403);
    expect(forgedAuthority.headers.get("set-cookie")).toBeNull();

    const httpsApi = createApi(databasePath("direct-https"), undefined, authConfig);
    const httpsLogin = await httpsApi.handle(new Request("https://remote.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    expect(httpsLogin.status).toBe(200);
    expect(httpsLogin.headers.get("set-cookie")).toContain("Secure");

    const app = createApi(databasePath("auth-expired"), undefined, { ...authConfig, sessionTtlMs: 1000 });
    const invalid = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    }));
    expect(invalid.status).toBe(401);

    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: authConfig.password }),
    }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await new Promise((resolve) => setTimeout(resolve, 1010));
    const expired = await app.handle(new Request("http://localhost/api/auth/session", { headers: { cookie } }));
    expect(expired.status).toBe(401);
    const expiredActions = await app.handle(new Request("http://localhost/api/actions", { headers: { cookie } }));
    expect(expiredActions.status).toBe(401);
    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral auth test port");
    try {
      expect(await receivesSnapshot(`ws://127.0.0.1:${port}/api/events`, cookie)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});

describe("Elysia health checks", () => {
  it("reports ready only when the configured SQLite database responds", async () => {
    const app = createApi(databasePath("available"));
    const response = await healthStatus(app, "ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("reports not ready when a persistent domain table is unavailable", async () => {
    const path = databasePath("missing-workspaces");
    const app = createApi(path);
    const database = new Database(path);
    database.exec("DROP TABLE workspaces");
    database.close();

    const ready = await healthStatus(app, "ready");
    expect(ready.status).toBe(503);
  });

  it("reports not ready when the auth session table is unavailable", async () => {
    const path = databasePath("missing-sessions");
    const app = createApi(path, undefined, { password: testPassword });
    const database = new Database(path);
    database.exec("DROP TABLE sessions");
    database.close();

    const [live, ready, login] = await Promise.all([
      healthStatus(app, "live"),
      healthStatus(app, "ready"),
      app.handle(new Request("https://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: testPassword }),
      })),
    ]);
    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(login.status).not.toBe(200);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("reports not ready when the action store schema is unavailable", async () => {
    const path = databasePath("missing-actions");
    const app = createApi(path);
    const database = new Database(path);
    database.exec("DROP TABLE actions");
    database.close();

    const [ready, actions] = await Promise.all([
      healthStatus(app, "ready"),
      app.handle(new Request("http://localhost/api/actions")),
    ]);

    expect(ready.status).toBe(503);
    expect(actions.status).not.toBe(200);
  });

  it("keeps liveness available when the configured database cannot be opened", async () => {
    const unavailableDatabase = `/tmp/rc006-unavailable-${crypto.randomUUID()}.sqlite`;
    mkdirSync(unavailableDatabase);
    const app = createApi(unavailableDatabase);

    const [ready, live] = await Promise.all([
      healthStatus(app, "ready"),
      healthStatus(app, "live"),
    ]);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready" });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "alive" });
  });

  it("reports not ready while SQLite is exclusively locked and recovers after unlock", async () => {
    const path = databasePath("locked");
    const owner = new Database(path);
    owner.exec("CREATE TABLE actions (id TEXT PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL)");
    const app = createApi(path);
    owner.exec("BEGIN EXCLUSIVE");

    try {
      const startedAt = performance.now();
      const [readyWhileLocked, liveWhileLocked] = await Promise.all([
        healthStatus(app, "ready"),
        healthStatus(app, "live"),
      ]);
      const elapsedMs = performance.now() - startedAt;
      expect(readyWhileLocked.status).toBe(503);
      expect(elapsedMs).toBeLessThan(500);
      expect(liveWhileLocked.status).toBe(200);

      const blockingProbe = new Database(path, { readonly: true, create: false });
      blockingProbe.exec("PRAGMA busy_timeout = 550");
      const blockedAt = performance.now();
      expect(() => blockingProbe.query("SELECT 1").get()).toThrow();
      expect(performance.now() - blockedAt).toBeGreaterThanOrEqual(500);
      blockingProbe.close();

      owner.exec("ROLLBACK");
      const readyAfterUnlock = await healthStatus(app, "ready");
      expect(readyAfterUnlock.status).toBe(200);
    } finally {
      owner.close();
    }
  });

  it("bounds a stalled dependency check and leaves liveness independent", async () => {
    const app = createApi(databasePath("stalled"), () => new Promise<boolean>(() => {}));
    const startedAt = performance.now();
    const ready = await healthStatus(app, "ready");
    const elapsedMs = performance.now() - startedAt;
    const live = await healthStatus(app, "live");

    expect(ready.status).toBe(503);
    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(elapsedMs).toBeLessThan(1000);
    expect(live.status).toBe(200);
  });
});

describe("Elysia persistent workspace data", () => {
  it("restores workspace, history, and profile IDs and content from the configured database", async () => {
    const path = databasePath("workspace-profile-history");
    const { app, cookie } = await authenticatedApi(path);
    const headers = { "content-type": "application/json", cookie };
    const workspaceResponse = await app.handle(new Request("http://localhost/api/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Persistent project" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json();
    const historyResponse = await app.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/history`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "note", content: "confirmed history content" }),
    }));
    expect(historyResponse.status).toBe(201);
    const history = await historyResponse.json();
    const profileResponse = await app.handle(new Request("http://localhost/api/profile", {
      method: "PUT",
      headers,
      body: JSON.stringify({ displayName: "Workspace owner" }),
    }));
    expect(profileResponse.status).toBe(200);
    const profile = await profileResponse.json();

    const restartedApi = createApi(path, undefined, { password: testPassword });
    const [restoredWorkspaces, restoredHistory, restoredProfile] = await Promise.all([
      restartedApi.handle(new Request("http://localhost/api/workspaces", { headers: { cookie } })),
      restartedApi.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/history`, { headers: { cookie } })),
      restartedApi.handle(new Request("http://localhost/api/profile", { headers: { cookie } })),
    ]);

    expect((await restoredWorkspaces.json()).workspaces).toEqual([workspace]);
    expect((await restoredHistory.json()).history).toEqual([history]);
    expect((await restoredProfile.json()).profile).toEqual(profile);
  });

  it("does not report workspace or history writes as successful while SQLite is locked", async () => {
    const path = databasePath("workspace-locked");
    const { app, cookie } = await authenticatedApi(path);
    const workspaceResponse = await app.handle(new Request("http://localhost/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Durable parent" }),
    }));
    const workspace = await workspaceResponse.json();
    const owner = new Database(path);
    owner.exec("BEGIN EXCLUSIVE");
    try {
      const [workspaceWrite, profileWrite, historyWrite] = await Promise.all([
        app.handle(new Request("http://localhost/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "must not be confirmed" }),
        })),
        app.handle(new Request("http://localhost/api/profile", {
          method: "PUT",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ displayName: "must not be confirmed" }),
        })),
        app.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/history`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ type: "note", content: "must not be confirmed" }),
        })),
      ]);
      expect(workspaceWrite.status).not.toBe(201);
      expect(profileWrite.status).not.toBe(200);
      expect(historyWrite.status).not.toBe(201);
      expect(owner.query("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
      expect(owner.query("SELECT COUNT(*) AS count FROM profiles").get()).toEqual({ count: 0 });
      expect(owner.query("SELECT COUNT(*) AS count FROM history").get()).toEqual({ count: 0 });
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
    }
  });
});

describe("Elysia action receipt", () => {
  it("records a UI action once and returns that same receipt from the backend", async () => {
    const { app, cookie } = await authenticatedApi(databasePath("action-write"));
    const created = await app.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "browser proof" }),
      }),
    );

    expect(created.status).toBe(201);
    const receipt = await created.json();
    const readBack = await app.handle(new Request("http://localhost/api/actions", { headers: { cookie } }));
    const state = await readBack.json();

    expect(state.actions).toContainEqual(receipt);
  });

  it("restores the same confirmed receipt after the API is recreated with the same database", async () => {
    const path = databasePath("restored-action");
    const { app: firstApi, cookie } = await authenticatedApi(path);
    const created = await firstApi.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "survive restart" }),
      }),
    );
    const receipt = await created.json();

    const restartedApi = createApi(path, undefined, { password: testPassword });
    const restored = await restartedApi.handle(new Request("http://localhost/api/actions", { headers: { cookie } }));

    expect(created.status).toBe(201);
    expect((await restored.json()).actions).toEqual([receipt]);
  });

  it("does not confirm a receipt while SQLite is locked against writes", async () => {
    const path = databasePath("write-locked");
    const { app, cookie } = await authenticatedApi(path);
    const owner = new Database(path);
    owner.exec("BEGIN EXCLUSIVE");

    try {
      const response = await app.handle(
        new Request("http://localhost/api/actions", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ action: "must not be falsely confirmed" }),
        }),
      );

      expect(response.status).not.toBe(201);
      expect(owner.query("SELECT COUNT(*) AS count FROM actions").get()).toEqual({ count: 0 });
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
    }
  });

  it("broadcasts each confirmed receipt to connected browser clients", async () => {
    const { app, cookie } = await authenticatedApi(databasePath("events"));
    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral port");
    const socketUrl = `ws://127.0.0.1:${port}/api/events`;
    expect(await receivesSnapshot(socketUrl)).toBe(false);
    const socket = openSocket(socketUrl, cookie);
    const snapshotPromise = waitForEvent(socket, "snapshot");

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WebSocket did not open")), 3000);
        socket.onopen = () => { clearTimeout(timeout); resolve(); };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); };
      });
      const snapshot = await snapshotPromise;
      const actionEventPromise = waitForEvent(socket, "action.created");

      const response = await fetch(`http://127.0.0.1:${port}/api/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "broadcast proof" }),
      });
      const receipt = await response.json();
      const actionEvent = await actionEventPromise;

      expect(response.status).toBe(201);
      expect(snapshot).toEqual({ type: "snapshot", actions: [] });
      expect(actionEvent).toEqual({ type: "action.created", receipt });
      const messagesAfterRevocation: string[] = [];
      socket.addEventListener("message", (message) => messagesAfterRevocation.push(String(message.data)));
      const secondLogin = await app.handle(new Request("https://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: testPassword }),
      }));
      const secondCookie = secondLogin.headers.get("set-cookie")!.split(";")[0]!;
      const revokedSocket = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Logout did not revoke the connected socket")), 1000);
        socket.addEventListener("close", (event) => {
          clearTimeout(timeout);
          resolve(event.code);
        }, { once: true });
      });
      const logout = await app.handle(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie },
      }));
      expect(logout.status).toBe(204);
      expect(await revokedSocket).toBe(4401);
      expect(await receivesSnapshot(socketUrl, cookie)).toBe(false);
      const afterLogoutWrite = await app.handle(new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: secondCookie },
        body: JSON.stringify({ action: "event after prior session logout" }),
      }));
      expect(afterLogoutWrite.status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messagesAfterRevocation).toHaveLength(0);
    } finally {
      await closeSocket(socket);
      await stopTestServer(server.stop.bind(server), port);
    }
  });

  it("rejects an empty action before recording a receipt", async () => {
    const { app, cookie } = await authenticatedApi(databasePath("invalid-action"));
    const rejected = await app.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "" }),
      }),
    );

    expect(rejected.status).toBe(422);
    const readBack = await app.handle(new Request("http://localhost/api/actions", { headers: { cookie } }));
    expect((await readBack.json()).actions).toHaveLength(0);
  });
});
