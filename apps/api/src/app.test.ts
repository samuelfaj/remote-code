import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { createApi } from "./app";

const databasePath = (label: string) => `/tmp/rc006-${label}-${crypto.randomUUID()}.sqlite`;

async function healthStatus(app: ReturnType<typeof createApi>, route: string) {
  return app.handle(new Request(`http://localhost/api/health/${route}`));
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

describe("Elysia health checks", () => {
  it("reports ready only when the configured SQLite database responds", async () => {
    const app = createApi(databasePath("available"));
    const response = await healthStatus(app, "ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
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
    owner.exec("BEGIN EXCLUSIVE");
    const app = createApi(path);

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

describe("Elysia action receipt", () => {
  it("records a UI action once and returns that same receipt from the backend", async () => {
    const app = createApi(databasePath("action-write"));
    const created = await app.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "browser proof" }),
      }),
    );

    expect(created.status).toBe(201);
    const receipt = await created.json();
    const readBack = await app.handle(new Request("http://localhost/api/actions"));
    const state = await readBack.json();

    expect(state.actions).toContainEqual(receipt);
  });

  it("restores the same confirmed receipt after the API is recreated with the same database", async () => {
    const path = databasePath("restored-action");
    const firstApi = createApi(path);
    const created = await firstApi.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "survive restart" }),
      }),
    );
    const receipt = await created.json();

    const restartedApi = createApi(path);
    const restored = await restartedApi.handle(new Request("http://localhost/api/actions"));

    expect(created.status).toBe(201);
    expect((await restored.json()).actions).toEqual([receipt]);
  });

  it("does not confirm a receipt while SQLite is locked against writes", async () => {
    const path = databasePath("write-locked");
    const app = createApi(path);
    const owner = new Database(path);
    owner.exec("BEGIN EXCLUSIVE");

    try {
      const response = await app.handle(
        new Request("http://localhost/api/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
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
    const server = createApi(databasePath("events")).listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral port");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "broadcast proof" }),
      });
      const receipt = await response.json();
      const actionEvent = await actionEventPromise;

      expect(response.status).toBe(201);
      expect(snapshot).toEqual({ type: "snapshot", actions: [] });
      expect(actionEvent).toEqual({ type: "action.created", receipt });
    } finally {
      socket.close();
      await server.stop(true);
    }
  });

  it("rejects an empty action before recording a receipt", async () => {
    const app = createApi(databasePath("invalid-action"));
    const rejected = await app.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "" }),
      }),
    );

    expect(rejected.status).toBe(422);
    const readBack = await app.handle(new Request("http://localhost/api/actions"));
    expect((await readBack.json()).actions).toHaveLength(0);
  });
});
