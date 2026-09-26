import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionUserId } from "./auth";

type Workspace = { id: string; name: string; createdAt: string };
type Profile = { userId: string; displayName: string; updatedAt: string };
type HistoryEntry = { id: string; type: string; content: string; createdAt: string };

function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  return new Database(databasePath, { create: true });
}

function readWorkspace(row: unknown): Workspace {
  if (
    typeof row !== "object" || row === null ||
    !("id" in row) || typeof row.id !== "string" ||
    !("name" in row) || typeof row.name !== "string" ||
    !("createdAt" in row) || typeof row.createdAt !== "string"
  ) throw new Error("Stored workspace is invalid");
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}

function readProfile(row: unknown): Profile {
  if (
    typeof row !== "object" || row === null ||
    !("userId" in row) || typeof row.userId !== "string" ||
    !("displayName" in row) || typeof row.displayName !== "string" ||
    !("updatedAt" in row) || typeof row.updatedAt !== "string"
  ) throw new Error("Stored profile is invalid");
  return { userId: row.userId, displayName: row.displayName, updatedAt: row.updatedAt };
}

function readHistoryEntry(row: unknown): HistoryEntry {
  if (
    typeof row !== "object" || row === null ||
    !("id" in row) || typeof row.id !== "string" ||
    !("type" in row) || typeof row.type !== "string" ||
    !("content" in row) || typeof row.content !== "string" ||
    !("createdAt" in row) || typeof row.createdAt !== "string"
  ) throw new Error("Stored history entry is invalid");
  return { id: row.id, type: row.type, content: row.content, createdAt: row.createdAt };
}

export function initializeStorage(databasePath: string) {
  try {
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS workspaces_user_id ON workspaces(user_id);
        CREATE TABLE IF NOT EXISTS profiles (
          user_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS history_workspace_id ON history(workspace_id, created_at, id);
      `);
    } finally {
      database.close();
    }
  } catch {
    // Requests fail closed when storage or its schema is unavailable.
  }
}

export function storageFeature(databasePath: string) {
  initializeStorage(databasePath);
  return new Elysia()
    .get("/api/workspaces", ({ request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const rows = database.query<unknown, [string]>(
          "SELECT id, name, created_at AS createdAt FROM workspaces WHERE user_id = ? ORDER BY created_at, id",
        ).all(userId);
        return { workspaces: rows.map(readWorkspace) };
      } finally {
        database.close();
      }
    })
    .post("/api/workspaces", ({ body, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const workspace = { id: crypto.randomUUID(), name: body.name, createdAt: new Date().toISOString() };
      const database = openDatabase(databasePath);
      try {
        database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(
          workspace.id, userId, workspace.name, workspace.createdAt,
        );
      } finally {
        database.close();
      }
      set.status = 201;
      return workspace;
    }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }) })
    .get("/api/profile", ({ request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const row = database.query<unknown, [string]>(
          "SELECT user_id AS userId, display_name AS displayName, updated_at AS updatedAt FROM profiles WHERE user_id = ?",
        ).get(userId);
        return { profile: row ? readProfile(row) : null };
      } finally {
        database.close();
      }
    })
    .put("/api/profile", ({ body, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const profile = { userId, displayName: body.displayName, updatedAt: new Date().toISOString() };
      const database = openDatabase(databasePath);
      try {
        database.query(`
          INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
        `).run(profile.userId, profile.displayName, profile.updatedAt);
      } finally {
        database.close();
      }
      return profile;
    }, { body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 120 }) }) })
    .get("/api/workspaces/:workspaceId/history", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const workspace = database.query("SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?").get(params.workspaceId, userId);
        if (!workspace) {
          set.status = 404;
          return { error: "not_found" as const };
        }
        const rows = database.query<unknown, [string, string]>(`
          SELECT id, type, content, created_at AS createdAt
          FROM history
          WHERE user_id = ? AND workspace_id = ?
          ORDER BY created_at, id
        `).all(userId, params.workspaceId);
        return { history: rows.map(readHistoryEntry) };
      } finally {
        database.close();
      }
    })
    .post("/api/workspaces/:workspaceId/history", ({ body, params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const entry = { id: crypto.randomUUID(), type: body.type, content: body.content, createdAt: new Date().toISOString() };
      const database = openDatabase(databasePath);
      try {
        database.query(`
          INSERT INTO history (id, user_id, workspace_id, type, content, created_at)
          SELECT ?, ?, id, ?, ?, ? FROM workspaces WHERE id = ? AND user_id = ?
        `).run(entry.id, userId, entry.type, entry.content, entry.createdAt, params.workspaceId, userId);
        if ((database.query("SELECT changes() AS count").get() as { count: number } | null)?.count !== 1) {
          set.status = 404;
          return { error: "not_found" as const };
        }
      } finally {
        database.close();
      }
      set.status = 201;
      return entry;
    }, { body: t.Object({ type: t.String({ minLength: 1, maxLength: 80 }), content: t.String({ minLength: 1, maxLength: 10000 }) }) });
}
