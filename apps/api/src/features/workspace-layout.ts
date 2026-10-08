import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.String({ minLength: 36, maxLength: 36 });
// ponytail: layout stores tabs plus optional one-level split panes;
// deeper nesting comes as a later slice.
const tabSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  kind: t.Union([t.Literal("file"), t.Literal("terminal"), t.Literal("thread")]),
  targetId: t.String({ minLength: 1, maxLength: 128 }),
});
const paneSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  tabId: t.String({ minLength: 1, maxLength: 64 }),
  order: t.Integer({ minimum: 0, maximum: 31 }),
});
const layoutSchema = t.Object({
  tabs: t.Array(tabSchema, { maxItems: 32 }),
  activeTabId: t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()]),
  panes: t.Optional(t.Array(paneSchema, { maxItems: 32 })),
  activePaneId: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()])),
});

export type WorkspaceLayout = { tabs: { id: string; kind: "file" | "terminal" | "thread"; targetId: string }[]; activeTabId: string | null; panes?: { id: string; tabId: string; order: number }[]; activePaneId?: string | null };

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
  const panes = (row as { panes?: unknown }).panes;
  const activePaneId = (row as { activePaneId?: unknown }).activePaneId;
  if (panes !== undefined) {
    if (!Array.isArray(panes) || panes.length > 32) return false;
    const paneIds = new Set<string>();
    for (const pane of panes) {
      if (!pane || typeof pane !== "object" || Array.isArray(pane)) return false;
      const p = pane as Record<string, unknown>;
      if (typeof p.id !== "string" || p.id.length < 1 || p.id.length > 64 || paneIds.has(p.id)) return false;
      if (typeof p.tabId !== "string" || !ids.has(p.tabId)) return false;
      if (!Number.isInteger(p.order) || (p.order as number) < 0 || (p.order as number) > 31) return false;
      paneIds.add(p.id);
    }
    // One client's pane selection is stored, not broadcast: the active
    // pane must belong to this layout. Per-device focus separation is a
    // client concern; the server only guarantees cross-workspace isolation.
    if (activePaneId !== undefined && activePaneId !== null &&
      (typeof activePaneId !== "string" || !paneIds.has(activePaneId))) return false;
    // Panes render side by side in order; orders must be dense from zero.
    const orders = (panes as { order: number }[]).map((p) => p.order).sort((a, b) => a - b);
    if (orders.some((order, index) => order !== index)) return false;
  } else if (activePaneId !== undefined) return false;
  return true;
}

// Owner-scoped per-workspace layout: opening another workspace never changes
// this one. Note: active tab/pane is shared server state per workspace, not
// per device — clients must not treat a selection change as another device's
// focus move; device focus separation is a client concern built on this API.
export function workspaceLayoutFeature(databasePath: string) {
  // Like the terminal routes, bind every call to the live session triple
  // (user, token, expiry): logout, expiry or revocation must stop access
  // even when the caller still presents a workspace id. userId alone is not
  // enough — a stale cookie must not keep working.
  function identity(request: Request): { userId: string; tokenHash: string; expiresAt: number } | null {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return null;
    return { userId, tokenHash, expiresAt };
  }

  function assertSession(owner: { userId: string; tokenHash: string; expiresAt: number }) {
    const db = new Database(databasePath, { readonly: true, create: false });
    try {
      const live = db.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(owner.userId, owner.tokenHash);
      if (!live || live.expires_at !== owner.expiresAt || live.expires_at <= Date.now()) throw new Error("unauthorized");
    } finally { db.close(); }
  }

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
      const owner = identity(request);
      if (!owner || !uuid.test(params.workspaceId)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      const userId = owner.userId;
      // Re-check the live session before distinguishing missing workspace
      // from empty layout, so a revoked session cannot probe existence.
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" }; }
      const result = database((db) => {
        const workspace = db.query<{ archived: number }, [string, string]>(
          "SELECT archived FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, userId);
        if (!workspace) return null;
        return db.query<{ layout: string }, [string, string]>(
          "SELECT layout FROM workspace_layouts WHERE workspace_id = ? AND user_id = ?",
        ).get(params.workspaceId, userId)?.layout ?? null;
      });
      if (result === null) {
        const missing = database((db) => !db.query("SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?").get(params.workspaceId, userId));
        // Final session word: revocation between the first check and now
        // must read as unauthorized, never as existence signal.
        try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" }; }
        if (missing) { set.status = 404; return { error: "not_found" }; }
        return { workspaceId: params.workspaceId, layout: null };
      }
      // Saved layout branch keeps the same final word: re-check before
      // returning stored contents.
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" }; }
      const layout = JSON.parse(result);
      if (!validLayout(layout)) { set.status = 503; return { error: "layout_unavailable" }; }
      return { workspaceId: params.workspaceId, layout };
    }, { params: t.Object({ workspaceId: uuidSchema }) })
    .put("/api/workspaces/:workspaceId/layout", ({ body, params, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.workspaceId)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      const userId = owner.userId;
      if (!validLayout(body)) { set.status = 422; return { error: "invalid_layout" }; }
      try {
        database((db) => db.transaction(() => {
          // Session re-check and write share one immediate transaction: the
          // write lock is held from the re-check to the read-back, so an
          // external revocation between them waits rather than slipping in.
          const live = db.query<{ expires_at: number }, [string, string]>(
            "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
          ).get(owner.userId, owner.tokenHash);
          if (!live || live.expires_at !== owner.expiresAt || live.expires_at <= Date.now()) throw new Error("unauthorized");
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
        }).immediate());
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "unauthorized") { set.status = 401; return { error: "unauthorized" }; }
        set.status = message === "not_found" ? 404 : message === "workspace_archived" ? 409 : 503;
        return { error: message === "not_found" ? "not_found" : message === "workspace_archived" ? "workspace_archived" : "layout_unavailable" };
      }
      return { workspaceId: params.workspaceId, layout: body };
    }, { params: t.Object({ workspaceId: uuidSchema }), body: layoutSchema });

  return { routes };
}
