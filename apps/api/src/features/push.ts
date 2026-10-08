import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

type PushOptions = {
  endpoint?: string;
  timeoutMs?: number;
};

function openDatabase(path: string, readonly: boolean) {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !readonly, readonly });
}

function initializeSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS push_devices (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    token TEXT NOT NULL,
    permission TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, device_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS push_deliveries (
    inbox_item_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(inbox_item_id, device_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS push_preferences (
    user_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function resolveOwner(request: Request, databasePath: string): Owner {
  const userId = sessionUserId(databasePath, request);
  const tokenHash = sessionTokenHash(request);
  const expiresAt = sessionExpiresAt(databasePath, request);
  if (!userId || !tokenHash || !expiresAt) return { kind: "anonymous" };
  const db = openDatabase(databasePath, true);
  try {
    const live = db.query<{ expires_at: number }, [string, string]>(
      "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
    ).get(userId, tokenHash);
    if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return { kind: "anonymous" };
    return { kind: "ok", userId };
  } catch {
    return { kind: "unavailable" };
  } finally {
    db.close();
  }
}

export async function dispatchInboxItem(
  databasePath: string,
  options: { userId: string; itemId: string; title: string; body: string; deepLink: Record<string, unknown> },
  pushOptions?: PushOptions,
): Promise<void> {
  const endpoint = pushOptions?.endpoint ?? process.env.REMOTECODE_PUSH_ENDPOINT ?? "";
  const timeoutMs = pushOptions?.timeoutMs ?? Number(process.env.REMOTECODE_PUSH_TIMEOUT_MS ?? 10_000);
  if (!endpoint) return;

  const db = openDatabase(databasePath, false);
  try {
    db.exec("PRAGMA busy_timeout = 250");
    initializeSchema(db);

    const prefRow = db.query<{ enabled: number }, [string]>(
      "SELECT enabled FROM push_preferences WHERE user_id = ?",
    ).get(options.userId);
    if (prefRow && prefRow.enabled === 0) return;

    const devices = db.query<
      { device_id: string; platform: string; token: string },
      [string]
    >(
      "SELECT device_id, platform, token FROM push_devices WHERE user_id = ? AND enabled = 1",
    ).all(options.userId);

    const now = new Date().toISOString();
    for (const device of devices) {
      const existing = db.query<{ inbox_item_id: string }, [string, string]>(
        "SELECT inbox_item_id FROM push_deliveries WHERE inbox_item_id = ? AND device_id = ?",
      ).get(options.itemId, device.device_id);
      if (existing) continue;

      try {
        db.query(
          "INSERT INTO push_deliveries (inbox_item_id, user_id, device_id, state, attempts, detail, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
        ).run(options.itemId, options.userId, device.device_id, "pending", "", now);
      } catch {
        // Unique constraint violation: another dispatch already inserted this row; skip
        continue;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: device.platform,
            token: device.token,
            title: options.title,
            body: options.body,
            deepLink: options.deepLink,
            itemId: options.itemId,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 401 || response.status === 410) {
          const detail = `HTTP ${response.status}`;
          db.query(
            "UPDATE push_deliveries SET state = ?, attempts = attempts + 1, detail = ?, updated_at = ? WHERE inbox_item_id = ? AND device_id = ?",
          ).run("denied", detail, now, options.itemId, device.device_id);
          db.query(
            "UPDATE push_devices SET enabled = 0, permission = 'denied', last_error = ?, updated_at = ? WHERE user_id = ? AND device_id = ?",
          ).run(detail, now, options.userId, device.device_id);
        } else if (!response.ok) {
          const detail = `HTTP ${response.status}`;
          db.query(
            "UPDATE push_deliveries SET state = ?, attempts = attempts + 1, detail = ?, updated_at = ? WHERE inbox_item_id = ? AND device_id = ?",
          ).run("failed", detail, now, options.itemId, device.device_id);
        } else {
          db.query(
            "UPDATE push_deliveries SET state = ?, attempts = attempts + 1, updated_at = ? WHERE inbox_item_id = ? AND device_id = ?",
          ).run("sent", now, options.itemId, device.device_id);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        db.query(
          "UPDATE push_deliveries SET state = ?, attempts = attempts + 1, detail = ?, updated_at = ? WHERE inbox_item_id = ? AND device_id = ?",
        ).run("failed", detail, now, options.itemId, device.device_id);
      }
    }
  } finally {
    db.close();
  }
}

export function pushFeature(databasePath: string, options?: PushOptions) {
  return new Elysia()
    .post("/api/push/devices", ({ body, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const { deviceId, platform, token, permission } = body as {
        deviceId: string;
        platform: string;
        token: string;
        permission?: string;
      };
      if (!deviceId || !platform || !token) { set.status = 400; return { error: "missing_fields" as const }; }
      if (platform !== "ios" && platform !== "android" && platform !== "web") {
        set.status = 400;
        return { error: "invalid_platform" as const };
      }
      if (permission !== undefined && permission !== "granted" && permission !== "denied") {
        set.status = 400;
        return { error: "invalid_permission" as const };
      }
      const now = new Date().toISOString();
      const db = openDatabase(databasePath, false);
      try {
        db.exec("PRAGMA busy_timeout = 250");
        initializeSchema(db);
        db.query(
          "INSERT OR REPLACE INTO push_devices (user_id, device_id, platform, token, permission, enabled, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
        ).run(owner.userId, deviceId, platform, token, permission ?? "granted", null, now, now);
        const row = db.query<
          { device_id: string; platform: string; permission: string; enabled: number; updated_at: string },
          [string, string]
        >(
          "SELECT device_id, platform, permission, enabled, updated_at FROM push_devices WHERE user_id = ? AND device_id = ?",
        ).get(owner.userId, deviceId);
        set.status = 201;
        return {
          deviceId: row!.device_id,
          platform: row!.platform,
          permission: row!.permission,
          enabled: row!.enabled === 1,
          updatedAt: row!.updated_at,
        };
      } finally {
        db.close();
      }
    }, {
      body: t.Object({
        deviceId: t.String({ minLength: 1 }),
        platform: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
        permission: t.Optional(t.String()),
      }),
    })
    .get("/api/push/devices", ({ request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const db = openDatabase(databasePath, true);
      try {
        db.exec("PRAGMA busy_timeout = 250");
        initializeSchema(db);
        const devices = db.query<
          { device_id: string; platform: string; permission: string; enabled: number; updated_at: string },
          [string]
        >(
          "SELECT device_id, platform, permission, enabled, updated_at FROM push_devices WHERE user_id = ? ORDER BY updated_at DESC",
        ).all(owner.userId);
        return {
          devices: devices.map((row) => ({
            deviceId: row.device_id,
            platform: row.platform,
            permission: row.permission,
            enabled: row.enabled === 1,
            updatedAt: row.updated_at,
          })),
        };
      } finally {
        db.close();
      }
    })
    .delete("/api/push/devices/:deviceId", ({ params, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const db = openDatabase(databasePath, false);
      try {
        db.exec("PRAGMA busy_timeout = 250");
        initializeSchema(db);
        const existing = db.query<{ device_id: string }, [string, string]>(
          "SELECT device_id FROM push_devices WHERE user_id = ? AND device_id = ?",
        ).get(owner.userId, params.deviceId);
        if (!existing) { set.status = 404; return { error: "not_found" as const }; }
        db.query("DELETE FROM push_devices WHERE user_id = ? AND device_id = ?").run(owner.userId, params.deviceId);
        set.status = 200;
        return { deleted: true };
      } finally {
        db.close();
      }
    })
    .post("/api/push/preference", ({ body, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const enabled = (body as { enabled?: unknown }).enabled;
      if (typeof enabled !== "boolean") { set.status = 400; return { error: "invalid_enabled" as const }; }
      const now = new Date().toISOString();
      const db = openDatabase(databasePath, false);
      try {
        db.exec("PRAGMA busy_timeout = 250");
        initializeSchema(db);
        db.query(
          "INSERT OR REPLACE INTO push_preferences (user_id, enabled, updated_at) VALUES (?, ?, ?)",
        ).run(owner.userId, enabled ? 1 : 0, now);
        set.status = 200;
        return { enabled };
      } finally {
        db.close();
      }
    }, {
      body: t.Object({ enabled: t.Boolean() }),
    })
    .post("/api/inbox/:id/notify", ({ params, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }
      const db = openDatabase(databasePath, true);
      let item: { id: string; user_id: string; title: string; destination: string } | null = null;
      try {
        db.exec("PRAGMA busy_timeout = 250");
        initializeSchema(db);
        item = db.query<
          { id: string; user_id: string; title: string; destination: string },
          [string, string]
        >(
          "SELECT id, user_id, title, destination FROM inbox_items WHERE id = ? AND user_id = ?",
        ).get(params.id, owner.userId);
        if (!item) { set.status = 404; return { error: "not_found" as const }; }
      } finally {
        db.close();
      }
      const destination = JSON.parse(item.destination) as Record<string, unknown>;
      void dispatchInboxItem(databasePath, {
        userId: owner.userId,
        itemId: item.id,
        title: item.title,
        body: item.title,
        deepLink: destination,
      }, options);
      set.status = 200;
      return { notified: true };
    });
}
