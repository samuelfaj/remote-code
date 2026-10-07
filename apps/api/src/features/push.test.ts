import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { createApi } from "../app";
import { recordInboxItem } from "./inbox";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC047_TEST_WORK_DIR ?? tmpdir(), "rc047-push-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(otherToken).digest("hex"), "bob", Date.now() + 60_000);
  database.close();
  return { app, databasePath, directory };
}

afterEach(() => {
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

async function registerDevice(
  app: ReturnType<typeof createApi>,
  databasePath: string,
  deviceId: string,
  platform: string,
  token: string,
  permission?: string,
) {
  const response = await request(app, "http://localhost/api/push/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `remotecode_session=${ownerToken}` },
    body: JSON.stringify({ deviceId, platform, token, permission }),
  });
  return response;
}

async function waitForPush() {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

describe("Push", () => {
  it("two registered devices -> automatic dispatch sends exactly one request per device", async () => {
    const { app, databasePath } = setup();
    const receivedRequests: Array<unknown> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        receivedRequests.push(body);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      const r1 = await registerDevice(app, databasePath, "device-1", "ios", "token-1");
      expect(r1.status).toBe(201);
      const r2 = await registerDevice(app, databasePath, "device-2", "android", "token-2");
      expect(r2.status).toBe(201);

      // Verify both devices are in the DB
      const dbCheck = new Database(databasePath);
      const deviceRows = dbCheck.query<{ device_id: string }, [string]>(
        "SELECT device_id FROM push_devices WHERE user_id = ?",
      ).all("alice");
      dbCheck.close();
      expect(deviceRows.length).toBe(2);

      recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
        dedupeKey: "run:abc:needs_you",
      });

      await waitForPush();

      expect(receivedRequests.length).toBe(2);
      const platforms = receivedRequests.map((r: any) => r.platform);
      expect(platforms).toContain("ios");
      expect(platforms).toContain("android");
    } finally {
      server.stop();
    }
  });

  it("calling notify again for the same item sends no additional request and creates no second delivery row", async () => {
    const { app, databasePath } = setup();
    const requestCount = { count: 0 };
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount.count++;
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      await registerDevice(app, databasePath, "device-1", "ios", "token-1");

      const itemId = recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
        dedupeKey: "run:abc:needs_you",
      });

      // Wait for automatic dispatch from recordInboxItem
      await waitForPush();

      const countAfterAutoDispatch = requestCount.count;
      expect(countAfterAutoDispatch).toBe(1);

      // Notify again for the same item should be a no-op (dedup)
      const notifyResponse = await request(app, `http://localhost/api/inbox/${itemId}/notify`, {
        method: "POST",
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(notifyResponse.status).toBe(200);
      await waitForPush();

      expect(requestCount.count).toBe(countAfterAutoDispatch);

      // Verify only one delivery row exists
      const db = new Database(databasePath);
      const deliveries = db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM push_deliveries WHERE inbox_item_id = ?",
      ).get(itemId);
      db.close();
      expect(deliveries?.count).toBe(1);
    } finally {
      server.stop();
    }
  });

  it("a device that answers 410 becomes enabled:false / permission:denied and its delivery is denied, while the other device still gets its one request", async () => {
    const { app, databasePath } = setup();
    const requestCount = { count: 0 };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount.count++;
        const body = await request.json() as { token?: string };
        if (body.token === "token-1") {
          return new Response(null, { status: 410 });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      // Register devices via API, then verify
      const r1 = await registerDevice(app, databasePath, "device-1", "ios", "token-1");
      expect(r1.status).toBe(201);
      const r2 = await registerDevice(app, databasePath, "device-2", "android", "token-2");
      expect(r2.status).toBe(201);

      const itemId = recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
        dedupeKey: "run:abc:needs_you",
      });

      await waitForPush();

      // Both devices should have been attempted
      expect(requestCount.count).toBe(2);

      const db = new Database(databasePath);
      const device1 = db.query<{ enabled: number; permission: string; last_error: string | null }, [string]>(
        "SELECT enabled, permission, last_error FROM push_devices WHERE device_id = ?",
      ).get("device-1");
      expect(device1?.enabled).toBe(0);
      expect(device1?.permission).toBe("denied");

      const delivery1 = db.query<{ state: string }, [string, string]>(
        "SELECT state FROM push_deliveries WHERE inbox_item_id = ? AND device_id = ?",
      ).get(itemId, "device-1");
      expect(delivery1?.state).toBe("denied");

      const device2 = db.query<{ enabled: number; permission: string }, [string]>(
        "SELECT enabled, permission FROM push_devices WHERE device_id = ?",
      ).get("device-2");
      expect(device2?.enabled).toBe(1);
      expect(device2?.permission).toBe("granted");

      const delivery2 = db.query<{ state: string }, [string, string]>(
        "SELECT state FROM push_deliveries WHERE inbox_item_id = ? AND device_id = ?",
      ).get(itemId, "device-2");
      expect(delivery2?.state).toBe("sent");

      const item = db.query<{ state: string }, [string]>(
        "SELECT state FROM inbox_items WHERE id = ?",
      ).get(itemId);
      expect(item?.state).toBe("open");
      db.close();
    } finally {
      server.stop();
    }
  });

  it("with the user preference off, automatic dispatch attempts no request at all, and the Inbox item still exists and is openable", async () => {
    const { app, databasePath } = setup();
    const requestCount = { count: 0 };
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount.count++;
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      await registerDevice(app, databasePath, "device-1", "ios", "token-1");

      // Turn off push preference
      await request(app, "http://localhost/api/push/preference", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: `remotecode_session=${ownerToken}` },
        body: JSON.stringify({ enabled: false }),
      });

      const itemId = recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
        dedupeKey: "run:abc:needs_you",
      });

      await waitForPush();

      // No requests should have been sent (preference is off)
      expect(requestCount.count).toBe(0);

      // Inbox item should still exist
      const db = new Database(databasePath);
      const item = db.query<{ id: string; state: string }, [string]>(
        "SELECT id, state FROM inbox_items WHERE id = ?",
      ).get(itemId);
      expect(item?.id).toBe(itemId);
      expect(item?.state).toBe("open");

      // Item should be openable via GET /api/inbox/:id
      const getResponse = await request(app, `http://localhost/api/inbox/${itemId}`, {
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(getResponse.status).toBe(200);
      const body = await getResponse.json() as { id: string; state: string; read: boolean };
      expect(body.id).toBe(itemId);
      expect(body.state).toBe("open");
      expect(body.read).toBe(false);
      db.close();
    } finally {
      server.stop();
    }
  });

  it("after a failed delivery the Inbox item is still listed by GET /api/inbox and GET /api/inbox/:id returns it unresolved and unread", async () => {
    const { app, databasePath } = setup();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { status: 500 });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      await registerDevice(app, databasePath, "device-1", "ios", "token-1");

      const itemId = recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
        dedupeKey: "run:abc:needs_you",
      });

      await waitForPush();

      // GET /api/inbox should list the item
      const listResponse = await request(app, "http://localhost/api/inbox", {
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { items: Array<{ id: string; state: string; read: boolean }> };
      expect(listBody.items.length).toBe(1);
      expect(listBody.items[0].id).toBe(itemId);
      expect(listBody.items[0].state).toBe("open");
      expect(listBody.items[0].read).toBe(false);

      // GET /api/inbox/:id should return it unresolved and unread
      const getResponse = await request(app, `http://localhost/api/inbox/${itemId}`, {
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as { id: string; state: string; read: boolean };
      expect(getBody.id).toBe(itemId);
      expect(getBody.state).toBe("open");
      expect(getBody.read).toBe(false);
    } finally {
      server.stop();
    }
  });

  it("the payload sent to the endpoint carries deepLink equal to the item's own destination", async () => {
    const { app, databasePath } = setup();
    let receivedDeepLink: unknown = null;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        receivedDeepLink = body.deepLink;
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      await registerDevice(app, databasePath, "device-1", "ios", "token-1");

      const destination = { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" };
      recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination,
        dedupeKey: "run:abc:needs_you",
      });

      await waitForPush();

      expect(receivedDeepLink).toEqual(destination);
    } finally {
      server.stop();
    }
  });

  it("another user cannot notify or read this user's item", async () => {
    const { app, databasePath } = setup();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    process.env.REMOTECODE_PUSH_ENDPOINT = `http://localhost:${server.port}`;
    try {
      await registerDevice(app, databasePath, "device-1", "ios", "token-1");

      const itemId = recordInboxItem(databasePath, {
        userId: "alice",
        kind: "needs_you",
        title: "Needs you",
        destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
        dedupeKey: "run:abc:needs_you",
      });

      // Other user cannot notify
      const notifyResponse = await request(app, `http://localhost/api/inbox/${itemId}/notify`, {
        method: "POST",
        headers: { cookie: `remotecode_session=${otherToken}` },
      });
      expect(notifyResponse.status).toBe(404);

      // Other user cannot read
      const getResponse = await request(app, `http://localhost/api/inbox/${itemId}`, {
        headers: { cookie: `remotecode_session=${otherToken}` },
      });
      expect(getResponse.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("POST /api/push/devices upserts a device and returns it without the token", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/push/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ deviceId: "device-1", platform: "ios", token: "secret-token", permission: "granted" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { deviceId: string; platform: string; permission: string; enabled: boolean; updatedAt: string };
    expect(body.deviceId).toBe("device-1");
    expect(body.platform).toBe("ios");
    expect(body.permission).toBe("granted");
    expect(body.enabled).toBe(true);
    expect(body.updatedAt).toBeTruthy();
  });

  it("GET /api/push/devices never returns the token", async () => {
    const { app, databasePath } = setup();
    await registerDevice(app, databasePath, "device-1", "ios", "secret-token");

    const response = await request(app, "http://localhost/api/push/devices", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { devices: Array<{ deviceId: string; platform: string; permission: string; enabled: boolean; updatedAt: string }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).not.toHaveProperty("token");
  });

  it("DELETE /api/push/devices/:deviceId removes the device", async () => {
    const { app, databasePath } = setup();
    await registerDevice(app, databasePath, "device-1", "ios", "token-1");

    const response = await request(app, "http://localhost/api/push/devices/device-1", {
      method: "DELETE",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);

    const getResponse = await request(app, "http://localhost/api/push/devices", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    const getBody = await getResponse.json() as { devices: unknown[] };
    expect(getBody.devices).toHaveLength(0);
  });

  it("POST /api/push/preference stores per-user enabled flag", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/push/preference", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("POST /api/push/devices rejects anonymous requests with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/push/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-1", platform: "ios", token: "token" }),
    });
    expect(response.status).toBe(401);
  });

  it("DELETE /api/push/devices/:deviceId rejects another user's device with 404", async () => {
    const { app, databasePath } = setup();
    await registerDevice(app, databasePath, "device-1", "ios", "token-1");

    const response = await request(app, "http://localhost/api/push/devices/device-1", {
      method: "DELETE",
      headers: { cookie: `remotecode_session=${otherToken}` },
    });
    expect(response.status).toBe(404);
  });
});