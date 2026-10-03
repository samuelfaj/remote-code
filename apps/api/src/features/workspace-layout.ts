import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionUserId } from "./auth";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.String({ minLength: 36, maxLength: 36 });
// ponytail: layout starts with tabs only; panes/split state comes as a later slice.
const tabSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  kind: t.Union([t.Literal("file"), t.Literal("terminal"), t.Literal("thread")]),
  targetId: t.String({ minLength: 1, maxLength: 128 }),
});
const layoutSchema = t.Object({
  tabs: t.Array(tabSchema, { maxItems: 32 }),
  activeTabId: t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()]),
});

export type WorkspaceLayout = { tabs: { id: string; kind: "file" | "terminal" | "thread"; targetId: string }[]; activeTabId: string | null };

function validLayout(value: unknown): value is WorkspaceLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.tabs) || row.tabs.length > 32) return false;
  const ids = new Set<string>();
  for (const tab of row.tabs) {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return false;
    const t = tab as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id.length < 1 || t.id.length > 64 || ids.has(t.id)) return false;
    if (t.kind !== "file" && t.kind !== "terminal" && t.kind !== "thread") return false;
    if (typeof t.targetId !== "string" || t.targetId.length < 1 || t.targetId.length > 128) return false;
    ids.add(t.id);
  }
  if (row.activeTabId !== null && (typeof row.activeTabId !== "string" || !ids.has(row.activeTabId))) return false;
  return true;
}

// Owner-scoped per-workspace layout: opening another workspace never changes
// this one, and one client's tab selection never moves another device.
export function workspaceLayoutFeature(databasePath: string) {
  function database<T>(callback: (db: Database) => T): T {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 250");
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_layouts (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
        user_id TEXT NOT NULL, layout TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      return callback(db);
    } finally { db.close(); }
  }

  const routes = new Elysia()
    .get("/api/workspaces/:workspaceId/layout", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId || !uuid.test(params.workspaceId)) { set.status = userId ? 404 : 401; return { error: userId ? "not_found" : "unauthorized" }; }
      const result = database((db) => {
        const workspace = db.query<{ archived: number }, [string, string]>(
          "SELECT archived FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, userId);
        if (!workspace) return null;
        return db.query<{ layout: string }, [string, string]>(
          "SELECT layout FROM workspace_layouts WHERE workspace_id = ? AND user_id = ?",
        ).get(params.workspaceId, userId)?.layout ?? null;
      });
      if (result === null && database((db) => !db.query("SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?").get(params.workspaceId, userId))) {
        set.status = 404; return { error: "not_found" };
      }
      if (result === null) return { workspaceId: params.workspaceId, layout: null };
      const layout = JSON.parse(result);
      if (!validLayout(layout)) { set.status = 503; return { error: "layout_unavailable" }; }
      return { workspaceId: params.workspaceId, layout };
    }, { params: t.Object({ workspaceId: uuidSchema }) })
    .put("/api/workspaces/:workspaceId/layout", ({ body, params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId || !uuid.test(params.workspaceId)) { set.status = userId ? 404 : 401; return { error: userId ? "not_found" : "unauthorized" }; }
      if (!validLayout(body)) { set.status = 422; return { error: "invalid_layout" }; }
      try {
        database((db) => {
          const workspace = db.query<{ archived: number }, [string, string]>(
            "SELECT archived FROM workspaces WHERE id = ? AND user_id = ?",
          ).get(params.workspaceId, userId);
          if (!workspace) throw new Error("not_found");
          if (workspace.archived !== 0) throw new Error("workspace_archived");
          db.query(`INSERT INTO workspace_layouts (workspace_id, user_id, layout, updated_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at
            WHERE workspace_layouts.user_id = excluded.user_id`).run(
            params.workspaceId, userId, JSON.stringify(body), new Date().toISOString());
          const stored = db.query<{ layout: string }, [string, string]>(
            "SELECT layout FROM workspace_layouts WHERE workspace_id = ? AND user_id = ?",
          ).get(params.workspaceId, userId);
          if (!stored || stored.layout !== JSON.stringify(body)) throw new Error("layout_not_persisted");
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        set.status = message === "not_found" ? 404 : message === "workspace_archived" ? 409 : 503;
        return { error: message === "not_found" ? "not_found" : message === "workspace_archived" ? "workspace_archived" : "layout_unavailable" };
      }
      return { workspaceId: params.workspaceId, layout: body };
    }, { params: t.Object({ workspaceId: uuidSchema }), body: layoutSchema });

  return { routes };
}
