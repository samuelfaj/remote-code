import { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const botNamePattern = /^[\x20-\x7E]{1,64}$/;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

type BotView = {
  id: string;
  name: string;
  instructions: string;
  context: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
};

function openDatabase(path: string, isReadonly: boolean) {
  if (!isReadonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !isReadonly, readonly: isReadonly });
}

function database<T>(databasePath: string, callback: (db: Database) => T): T {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 250");
    return callback(db);
  } finally {
    db.close();
  }
}

export function botsFeature(databasePath: string) {
  function resolveOwner(request: Request): Owner {
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

  try {
    database(databasePath, (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        context TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id)");
    });
  } catch {
    // Storage unavailable; readiness reports it and every route fails closed.
  }

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_bot_request" as const };
      }
    })
    .post("/api/bots", ({ body, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      const name = typeof body.name === "string" ? body.name : "";
      const trimmedName = name.trim();
      if (!botNamePattern.test(trimmedName)) { set.status = 400; return { error: "invalid_bot_name" as const }; }

      const instructions = typeof body.instructions === "string" ? body.instructions : "";
      if (instructions.length > 8000 || instructions.includes("\0")) { set.status = 400; return { error: "invalid_bot_instructions" as const }; }

      const context = typeof body.context === "string" ? body.context : "";
      if (context.length > 8000 || context.includes("\0")) { set.status = 400; return { error: "invalid_bot_context" as const }; }

      const now = new Date().toISOString();
      const id = database(databasePath, (db) => {
        const id = crypto.randomUUID();
        db.query(
          "INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        ).run(id, userId, trimmedName, instructions, context, now, now);
        return id;
      });
      set.status = 201;
      return { id, name: trimmedName, instructions, context, hidden: false, createdAt: now, updatedAt: now };
    }, {
      body: t.Object({
        name: t.String(),
        instructions: t.Optional(t.String()),
        context: t.Optional(t.String()),
      }),
    })
    .get("/api/bots", ({ request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      try {
        const bots = database(databasePath, (db) => {
          const rows = db.query<
            { id: string; name: string; instructions: string; context: string; hidden: number; created_at: string; updated_at: string },
            [string]
          >(
            "SELECT id, name, instructions, context, hidden, created_at, updated_at FROM bots WHERE user_id = ? ORDER BY created_at DESC",
          ).all(userId);
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            instructions: row.instructions,
            context: row.context,
            hidden: row.hidden === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }));
        });
        return { bots };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .get("/api/bots/:id", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "bot_not_found" as const }; }

      try {
        const result = database(databasePath, (db) => {
          const row = db.query<
            { id: string; name: string; instructions: string; context: string; hidden: number; created_at: string; updated_at: string },
            [string, string]
          >(
            "SELECT id, name, instructions, context, hidden, created_at, updated_at FROM bots WHERE id = ? AND user_id = ?",
          ).get(params.id, userId);
          if (!row) return null;
          return {
            id: row.id,
            name: row.name,
            instructions: row.instructions,
            context: row.context,
            hidden: row.hidden === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        });
        if (!result) { set.status = 404; return { error: "bot_not_found" as const }; }
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .patch("/api/bots/:id", ({ body, params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "bot_not_found" as const }; }

      if (body.name !== undefined) {
        const trimmed = body.name.trim();
        if (!botNamePattern.test(trimmed)) { set.status = 400; return { error: "invalid_bot_name" as const }; }
      }
      if (body.instructions !== undefined) {
        if (body.instructions.length > 8000 || body.instructions.includes("\0")) { set.status = 400; return { error: "invalid_bot_instructions" as const }; }
      }
      if (body.context !== undefined) {
        if (body.context.length > 8000 || body.context.includes("\0")) { set.status = 400; return { error: "invalid_bot_context" as const }; }
      }

      try {
        const result = database(databasePath, (db) => {
          const existing = db.query<{ user_id: string }, [string]>(
            "SELECT user_id FROM bots WHERE id = ?",
          ).get(params.id);
          if (!existing || existing.user_id !== userId) return null;

          const updates: string[] = [];
          const values: SQLQueryBindings[] = [];
          if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name.trim()); }
          if (body.instructions !== undefined) { updates.push("instructions = ?"); values.push(body.instructions); }
          if (body.context !== undefined) { updates.push("context = ?"); values.push(body.context); }
          if (body.hidden !== undefined) { updates.push("hidden = ?"); values.push(body.hidden ? 1 : 0); }

          if (updates.length === 0) {
            const row = db.query<
              { id: string; name: string; instructions: string; context: string; hidden: number; created_at: string; updated_at: string },
              [string, string]
            >(
              "SELECT id, name, instructions, context, hidden, created_at, updated_at FROM bots WHERE id = ? AND user_id = ?",
            ).get(params.id, userId);
            return row
              ? { id: row.id, name: row.name, instructions: row.instructions, context: row.context, hidden: row.hidden === 1, createdAt: row.created_at, updatedAt: row.updated_at }
              : null;
          }

          updates.push("updated_at = ?");
          values.push(new Date().toISOString());
          values.push(params.id);
          values.push(userId);

          db.query(`UPDATE bots SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);

          const row = db.query<
            { id: string; name: string; instructions: string; context: string; hidden: number; created_at: string; updated_at: string },
            [string, string]
          >(
            "SELECT id, name, instructions, context, hidden, created_at, updated_at FROM bots WHERE id = ? AND user_id = ?",
          ).get(params.id, userId);
          return row
            ? { id: row.id, name: row.name, instructions: row.instructions, context: row.context, hidden: row.hidden === 1, createdAt: row.created_at, updatedAt: row.updated_at }
            : null;
        });

        if (!result) { set.status = 404; return { error: "bot_not_found" as const }; }
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, {
      body: t.Object({
        name: t.Optional(t.String()),
        instructions: t.Optional(t.String()),
        context: t.Optional(t.String()),
        hidden: t.Optional(t.Boolean()),
      }),
    });
}
