import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionUserId } from "./auth";

type Workspace = { id: string; name: string; createdAt: string };
type WorkspaceState = Workspace & { archived: boolean };
type Profile = { userId: string; displayName: string; updatedAt: string };
type HistoryEntry = { id: string; type: string; content: string; createdAt: string };

const requestIdSchema = t.Transform(t.String({ format: "uuid", minLength: 36, maxLength: 36 }))
  .Decode((value) => value.toLowerCase())
  .Encode((value) => value.toLowerCase());

function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true });
  database.exec("PRAGMA busy_timeout = 250");
  return database;
}

function readWorkspace(row: unknown): Workspace {
  if (
    typeof row !== "object" || row === null ||
    !("id" in row) || typeof row.id !== "string" ||
    !("name" in row) || typeof row.name !== "string" || row.name.length < 1 || row.name.length > 120 ||
    !("createdAt" in row) || typeof row.createdAt !== "string" || row.createdAt.length < 1
  ) throw new Error("Stored workspace is invalid");
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}

function readWorkspaceState(row: unknown): WorkspaceState {
  const workspace = readWorkspace(row);
  if (typeof row !== "object" || row === null || !("archived" in row) ||
    (row.archived !== 0 && row.archived !== 1)) throw new Error("Stored workspace archive state is invalid");
  return { ...workspace, archived: row.archived === 1 };
}

function readWorkspaceReceipt(row: unknown) {
  const workspace = readWorkspaceState(row);
  if (typeof row !== "object" || row === null || !("kind" in row) ||
    (row.kind !== "create" && row.kind !== "rename" && row.kind !== "archive")) {
    throw new Error("Stored workspace receipt is invalid");
  }
  if (workspace.archived !== (row.kind === "archive")) throw new Error("Stored workspace receipt state is invalid");
  return { kind: row.kind, workspace };
}

function loadWorkspaceReceipt(database: Database, userId: string, requestId: string) {
  const row = database.query<unknown, [string, string]>(`
    WITH input AS (SELECT ? AS user_id, ? AS request_id), accepted AS (
      SELECT r.workspace_id, 'create' AS kind, 'creation' AS acceptanceType
      FROM workspace_requests r JOIN input ON r.user_id = input.user_id AND r.request_id = input.request_id
      UNION ALL
      SELECT r.workspace_id, r.kind, 'change' AS acceptanceType
      FROM workspace_change_requests r JOIN input ON r.user_id = input.user_id AND r.request_id = input.request_id
    )
    SELECT s.workspace_id AS id, s.name, s.created_at AS createdAt, s.archived, s.kind,
      s.request_id AS receiptRequestId, a.workspace_id AS acceptedWorkspaceId, a.kind AS acceptedKind,
      a.acceptanceType, w.user_id AS workspaceOwner, (SELECT COUNT(*) FROM accepted) AS acceptanceCount
    FROM input LEFT JOIN accepted a ON 1
    LEFT JOIN workspace_receipts s ON s.user_id = input.user_id AND s.request_id = input.request_id
    LEFT JOIN workspaces w ON w.id = s.workspace_id
  `).get(userId, requestId);
  if (typeof row !== "object" || row === null || !("acceptanceCount" in row) || !("receiptRequestId" in row)) {
    throw new Error("Stored workspace receipt is unavailable");
  }
  if (row.acceptanceCount === 0 && row.receiptRequestId === null) return null;
  if (row.acceptanceCount !== 1 || !("acceptedWorkspaceId" in row) || !("id" in row) ||
    row.acceptedWorkspaceId !== row.id || !("acceptedKind" in row) || !("kind" in row) || row.acceptedKind !== row.kind ||
    !("workspaceOwner" in row) || row.workspaceOwner !== userId || !("acceptanceType" in row) ||
    (row.acceptanceType === "creation" ? row.kind !== "create" : row.kind !== "rename" && row.kind !== "archive")) {
    throw new Error("Stored workspace receipt is unavailable");
  }
  return readWorkspaceReceipt(row);
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
      database.transaction(() => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS workspaces_user_id ON workspaces(user_id);
        CREATE TABLE IF NOT EXISTS workspace_requests (
          user_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
          PRIMARY KEY (user_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS profiles (
          user_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_requests (
          user_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, request_id)
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
        CREATE TABLE IF NOT EXISTS history_requests (
          user_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          history_id TEXT NOT NULL UNIQUE REFERENCES history(id),
          PRIMARY KEY (user_id, request_id)
        );
        `);
        const columns = database.query<{ name: string }, []>("PRAGMA table_info(workspaces)").all();
        const hasArchiveState = columns.some((column) => column.name === "archived");
        const hasReceipts = Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_receipts'").get());
        if (hasArchiveState !== hasReceipts) throw new Error("Stored workspace migration is incomplete");
        if (!hasArchiveState) {
          database.exec("ALTER TABLE workspaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))");
        }
        // Snapshot legacy creation receipts before workspace metadata can change.
        if (!hasReceipts) {
          if (database.query(`
            SELECT 1 FROM workspace_requests r LEFT JOIN workspaces w ON w.id = r.workspace_id
            WHERE w.id IS NULL OR w.user_id IS NOT r.user_id OR w.archived != 0 LIMIT 1
          `).get()) throw new Error("Stored workspace request is invalid");
          database.exec(`
            CREATE TABLE workspace_receipts (
              user_id TEXT NOT NULL,
              request_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL REFERENCES workspaces(id),
              kind TEXT NOT NULL CHECK (kind IN ('create', 'rename', 'archive')),
              name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
              created_at TEXT NOT NULL,
              archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
              PRIMARY KEY (user_id, request_id)
            );
          `);
          database.query(`
            INSERT INTO workspace_receipts (user_id, request_id, workspace_id, kind, name, created_at, archived)
            SELECT r.user_id, r.request_id, w.id, 'create', w.name, w.created_at, 0
            FROM workspace_requests r JOIN workspaces w ON w.id = r.workspace_id
          `).run();
        }
        if (!database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_change_requests'").get()) {
          database.exec(`
            CREATE TABLE workspace_change_requests (
              user_id TEXT NOT NULL,
              request_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL REFERENCES workspaces(id),
              kind TEXT NOT NULL CHECK (kind IN ('rename', 'archive')),
              PRIMARY KEY (user_id, request_id)
            );
          `);
          // Pre-marker acceptance comes only from immutable, owner-validated outcomes.
          database.query(`
            INSERT INTO workspace_change_requests (user_id, request_id, workspace_id, kind)
            SELECT user_id, request_id, workspace_id, kind FROM workspace_receipts WHERE kind IN ('rename', 'archive')
          `).run();
          const receipts = database.query<{ userId: string; requestId: string }, []>(
            "SELECT user_id AS userId, request_id AS requestId FROM workspace_receipts",
          ).all();
          for (const receipt of receipts) loadWorkspaceReceipt(database, receipt.userId, receipt.requestId);
        }
      }).immediate();
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
          "SELECT id, name, created_at AS createdAt, archived FROM workspaces WHERE user_id = ? ORDER BY created_at, id",
        ).all(userId);
        return { workspaces: rows.map((row) => {
          const workspace = readWorkspaceState(row);
          return { ...readWorkspace(workspace), ...(workspace.archived ? { archived: true } : {}) };
        }) };
      } finally {
        database.close();
      }
    })
    .get("/api/workspaces/receipts/:requestId", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const receipt = loadWorkspaceReceipt(database, userId, params.requestId);
        if (!receipt) {
          set.status = 404;
          return { error: "receipt_not_found" as const };
        }
        if (receipt.kind !== "create") {
          set.status = 409;
          return { error: "request_id_conflict" as const };
        }
        return readWorkspace(receipt.workspace);
      } finally {
        database.close();
      }
    }, { params: t.Object({ requestId: requestIdSchema }) })
    .get("/api/workspaces/receipts/:requestId/outcome", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const receipt = loadWorkspaceReceipt(database, userId, params.requestId);
        if (!receipt) {
          set.status = 404;
          return { error: "receipt_not_found" as const };
        }
        return { requestId: params.requestId, kind: receipt.kind, workspace: receipt.workspace };
      } finally {
        database.close();
      }
    }, { params: t.Object({ requestId: requestIdSchema }) })
    .post("/api/workspaces", ({ body, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const workspace = { id: crypto.randomUUID(), name: body.name, createdAt: new Date().toISOString() };
      const database = openDatabase(databasePath);
      try {
        const result = database.transaction(() => {
          if (body.requestId) {
            const existing = loadWorkspaceReceipt(database, userId, body.requestId);
            if (existing) return existing;
          }
          const inserted = database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(
            workspace.id, userId, workspace.name, workspace.createdAt,
          );
          if (inserted.changes !== 1) throw new Error("Workspace was not persisted");
          if (body.requestId) {
            const mapping = database.query("INSERT INTO workspace_requests (user_id, request_id, workspace_id) VALUES (?, ?, ?)")
              .run(userId, body.requestId, workspace.id);
            if (mapping.changes !== 1) throw new Error("Workspace request was not persisted");
            const receipt = database.query(`
              INSERT INTO workspace_receipts (user_id, request_id, workspace_id, kind, name, created_at, archived)
              VALUES (?, ?, ?, 'create', ?, ?, 0)
            `).run(userId, body.requestId, workspace.id, workspace.name, workspace.createdAt);
            if (receipt.changes !== 1) throw new Error("Workspace receipt was not persisted");
          }
          return null;
        }).immediate();
        if (result) {
          if (result.kind !== "create" || result.workspace.name !== body.name) {
            set.status = 409;
            return { error: "request_id_conflict" as const };
          }
          return readWorkspace(result.workspace);
        }
      } finally {
        database.close();
      }
      set.status = 201;
      return workspace;
    }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }), requestId: t.Optional(requestIdSchema) }) })
    .get("/api/workspaces/:workspaceId", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const row = database.query<unknown, [string, string]>(`
          SELECT id, name, created_at AS createdAt, archived FROM workspaces WHERE id = ? AND user_id = ?
        `).get(params.workspaceId, userId);
        if (!row) {
          set.status = 404;
          return { error: "not_found" as const };
        }
        return readWorkspaceState(row);
      } finally {
        database.close();
      }
    })
    .get("/api/workspaces/:workspaceId/receipts/:requestId", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        if (!database.query("SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?").get(params.workspaceId, userId)) {
          set.status = 404;
          return { error: "not_found" as const };
        }
        const receipt = loadWorkspaceReceipt(database, userId, params.requestId);
        if (!receipt) {
          set.status = 404;
          return { error: "receipt_not_found" as const };
        }
        if (receipt.workspace.id !== params.workspaceId) {
          set.status = 409;
          return { error: "request_id_conflict" as const };
        }
        return { requestId: params.requestId, kind: receipt.kind, workspace: receipt.workspace };
      } finally {
        database.close();
      }
    }, { params: t.Object({ workspaceId: t.String(), requestId: requestIdSchema }) })
    .patch("/api/workspaces/:workspaceId", ({ body, params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const kind = typeof body.name === "string" ? "rename" : "archive";
      const database = openDatabase(databasePath);
      try {
        const result = database.transaction(() => {
          const row = database.query<unknown, [string, string]>(`
            SELECT id, name, created_at AS createdAt, archived FROM workspaces WHERE id = ? AND user_id = ?
          `).get(params.workspaceId, userId);
          if (!row) return { kind: "not_found" as const };
          const workspace = readWorkspaceState(row);
          const existing = loadWorkspaceReceipt(database, userId, body.requestId);
          if (existing) {
            if (existing.kind !== kind || existing.workspace.id !== params.workspaceId ||
              (typeof body.name === "string" && existing.workspace.name !== body.name)) return { kind: "request_id_conflict" as const };
            return { kind: "saved" as const, workspace: existing.workspace };
          }
          if (workspace.archived) return { kind: "workspace_archived" as const };
          const updated = { ...workspace, name: typeof body.name === "string" ? body.name : workspace.name, archived: kind === "archive" };
          const mapping = database.query(`
            INSERT INTO workspace_change_requests (user_id, request_id, workspace_id, kind) VALUES (?, ?, ?, ?)
          `).run(userId, body.requestId, updated.id, kind);
          if (mapping.changes !== 1) throw new Error("Workspace change request was not persisted");
          const changed = database.query("UPDATE workspaces SET name = ?, archived = ? WHERE id = ? AND user_id = ?")
            .run(updated.name, Number(updated.archived), updated.id, userId);
          if (changed.changes !== 1) throw new Error("Workspace change was not persisted");
          const savedReceipt = database.query(`
            INSERT INTO workspace_receipts (user_id, request_id, workspace_id, kind, name, created_at, archived)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(userId, body.requestId, updated.id, kind, updated.name, updated.createdAt, Number(updated.archived));
          if (savedReceipt.changes !== 1) throw new Error("Workspace receipt was not persisted");
          return { kind: "saved" as const, workspace: updated };
        }).immediate();
        if (result.kind !== "saved") {
          set.status = result.kind === "not_found" ? 404 : 409;
          return { error: result.kind };
        }
        return { requestId: body.requestId, kind, workspace: result.workspace };
      } finally {
        database.close();
      }
    }, { body: t.Union([
      t.Object({ name: t.String({ minLength: 1, maxLength: 120 }), archived: t.Optional(t.Never()), requestId: requestIdSchema }),
      t.Object({ archived: t.Literal(true), name: t.Optional(t.Never()), requestId: requestIdSchema }),
    ]) })
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
    .get("/api/profile/receipts/:requestId", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        const row = database.query<unknown, [string, string]>(`
          SELECT user_id AS userId, display_name AS displayName, updated_at AS updatedAt
          FROM profile_requests WHERE user_id = ? AND request_id = ?
        `).get(userId, params.requestId);
        if (!row) {
          set.status = 404;
          return { error: "receipt_not_found" as const };
        }
        return readProfile(row);
      } finally {
        database.close();
      }
    }, { params: t.Object({ requestId: requestIdSchema }) })
    .put("/api/profile", ({ body, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const profile = { userId, displayName: body.displayName, updatedAt: new Date().toISOString() };
      const database = openDatabase(databasePath);
      try {
        const existing = database.transaction(() => {
          if (body.requestId) {
            const row = database.query<unknown, [string, string]>(`
              SELECT user_id AS userId, display_name AS displayName, updated_at AS updatedAt
              FROM profile_requests WHERE user_id = ? AND request_id = ?
            `).get(userId, body.requestId);
            if (row) return readProfile(row);
          }
          database.query(`
            INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
          `).run(profile.userId, profile.displayName, profile.updatedAt);
          if (body.requestId) database.query(`
            INSERT INTO profile_requests (user_id, request_id, display_name, updated_at) VALUES (?, ?, ?, ?)
          `).run(userId, body.requestId, profile.displayName, profile.updatedAt);
          return null;
        }).immediate();
        if (existing) {
          if (existing.displayName !== body.displayName) {
            set.status = 409;
            return { error: "request_id_conflict" as const };
          }
          return existing;
        }
      } finally {
        database.close();
      }
      return profile;
    }, { body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 120 }), requestId: t.Optional(requestIdSchema) }) })
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
    .get("/api/workspaces/:workspaceId/history/receipts/:requestId", ({ params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        if (!database.query("SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?").get(params.workspaceId, userId)) {
          set.status = 404;
          return { error: "not_found" as const };
        }
        const row = database.query<unknown, [string, string, string]>(`
          SELECT history.id, history.type, history.content, history.created_at AS createdAt
          FROM history_requests JOIN history ON history.id = history_requests.history_id
          WHERE history_requests.user_id = ? AND history_requests.request_id = ? AND history_requests.workspace_id = ?
        `).get(userId, params.requestId, params.workspaceId);
        if (!row) {
          const usedElsewhere = database.query("SELECT 1 FROM history_requests WHERE user_id = ? AND request_id = ?")
            .get(userId, params.requestId);
          if (usedElsewhere) {
            set.status = 409;
            return { error: "request_id_conflict" as const };
          }
          set.status = 404;
          return { error: "receipt_not_found" as const };
        }
        return readHistoryEntry(row);
      } finally {
        database.close();
      }
    }, { params: t.Object({ workspaceId: t.String(), requestId: requestIdSchema }) })
    .post("/api/workspaces/:workspaceId/history", ({ body, params, request, set }) => {
      const userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const entry = { id: crypto.randomUUID(), type: body.type, content: body.content, createdAt: new Date().toISOString() };
      const database = openDatabase(databasePath);
      try {
        const result = database.transaction(() => {
          const workspace = database.query<unknown, [string, string]>(
            "SELECT id, name, created_at AS createdAt, archived FROM workspaces WHERE id = ? AND user_id = ?",
          ).get(params.workspaceId, userId);
          if (!workspace) return { kind: "not_found" as const };
          const state = readWorkspaceState(workspace);
          if (body.requestId) {
            const row = database.query<unknown, [string, string]>(`
              SELECT history.id, history.type, history.content, history.created_at AS createdAt,
                history_requests.workspace_id AS workspaceId
              FROM history_requests JOIN history ON history.id = history_requests.history_id
              WHERE history_requests.user_id = ? AND history_requests.request_id = ?
            `).get(userId, body.requestId);
            if (row) {
              const existing = readHistoryEntry(row);
              if (typeof row !== "object" || !("workspaceId" in row) || typeof row.workspaceId !== "string") {
                throw new Error("Stored history request is invalid");
              }
              return { kind: "existing" as const, existing, workspaceId: row.workspaceId };
            }
          }
          if (state.archived) return { kind: "workspace_archived" as const };
          database.query(`
            INSERT INTO history (id, user_id, workspace_id, type, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(entry.id, userId, params.workspaceId, entry.type, entry.content, entry.createdAt);
          if (body.requestId) database.query(`
            INSERT INTO history_requests (user_id, request_id, workspace_id, history_id) VALUES (?, ?, ?, ?)
          `).run(userId, body.requestId, params.workspaceId, entry.id);
          return { kind: "created" as const };
        }).immediate();
        if (result.kind === "not_found") {
          set.status = 404;
          return { error: "not_found" as const };
        }
        if (result.kind === "workspace_archived") {
          set.status = 409;
          return { error: "workspace_archived" as const };
        }
        if (result.kind === "existing") {
          if (result.workspaceId !== params.workspaceId || result.existing.type !== body.type || result.existing.content !== body.content) {
            set.status = 409;
            return { error: "request_id_conflict" as const };
          }
          return result.existing;
        }
      } finally {
        database.close();
      }
      set.status = 201;
      return entry;
    }, { body: t.Object({ type: t.String({ minLength: 1, maxLength: 80 }), content: t.String({ minLength: 1, maxLength: 10000 }), requestId: t.Optional(requestIdSchema) }) });
}
