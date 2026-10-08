import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import type { LiveNotifier } from "./live";
import { dispatchInboxItem } from "./push";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// recordInboxItem is called from the runs state machine, which does not own the
// feature instance; the notifier registered by inboxFeature reaches it here.
let inboxChangeNotifier: LiveNotifier | undefined;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

export type InboxKind = "needs_you" | "result" | "approval" | "intervention";

export function recordInboxItem(
  databasePath: string,
  options: {
    userId: string;
    kind: InboxKind;
    botId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    threadId?: string | null;
    title: string;
    destination: Record<string, unknown>;
    dedupeKey: string;
  },
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const destinationJson = JSON.stringify(options.destination);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 250");
    initializeSchema(db);
    const inserted = db.query(
      "INSERT OR IGNORE INTO inbox_items (id, user_id, kind, bot_id, workspace_id, run_id, thread_id, title, destination, state, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, options.userId, options.kind, options.botId ?? null,
      options.workspaceId ?? null, options.runId ?? null, options.threadId ?? null,
      options.title, destinationJson, "open", options.dedupeKey, now,
    );
    const row = db.query<{ id: string }, [string, string]>(
      "SELECT id FROM inbox_items WHERE user_id = ? AND dedupe_key = ?",
    ).get(options.userId, options.dedupeKey);
    if (inserted.changes > 0) {
      inboxChangeNotifier?.({ userId: options.userId, type: "inbox.changed", workspaceId: options.workspaceId ?? undefined });
    }
    void dispatchInboxItem(databasePath, {
      userId: options.userId,
      itemId: row!.id,
      title: options.title,
      body: options.title,
      deepLink: options.destination,
    }).catch(() => {});
    return row!.id;
  } finally {
    db.close();
  }
}

function initializeSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    bot_id TEXT,
    workspace_id TEXT,
    run_id TEXT,
    thread_id TEXT,
    title TEXT NOT NULL,
    destination TEXT NOT NULL,
    state TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    resolved_at TEXT,
    resolution TEXT
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_dedupe ON inbox_items(user_id, dedupe_key)");
}

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

function inboxView(row: {
  id: string; kind: string; bot_id: string | null; workspace_id: string | null;
  run_id: string | null; title: string; destination: string; state: string;
  created_at: string; read_at: string | null; resolved_at: string | null;
}) {
  return {
    id: row.id,
    kind: row.kind as InboxKind,
    botId: row.bot_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    title: row.title,
    destination: JSON.parse(row.destination) as Record<string, unknown>,
    state: row.state,
    read: row.read_at !== null,
    createdAt: row.created_at,
    readAt: row.read_at,
    resolvedAt: row.resolved_at,
  };
}

export function inboxFeature(databasePath: string, options?: { onChange?: LiveNotifier }) {
  inboxChangeNotifier = options?.onChange;
  return new Elysia()
    .get("/api/inbox", ({ request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      try {
        const items = database(databasePath, (db) => {
          initializeSchema(db);
          return db.query<
            { id: string; kind: string; bot_id: string | null; workspace_id: string | null; run_id: string | null; title: string; destination: string; state: string; created_at: string; read_at: string | null; resolved_at: string | null },
            [string]
          >(
            "SELECT id, kind, bot_id, workspace_id, run_id, title, destination, state, created_at, read_at, resolved_at FROM inbox_items WHERE user_id = ? ORDER BY created_at DESC",
          ).all(owner.userId);
        });
        return { items: items.map(inboxView) };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .get("/api/inbox/:id", ({ params, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }
      try {
        const result = database(databasePath, (db) => {
          initializeSchema(db);
          const row = db.query<
            { id: string; kind: string; bot_id: string | null; workspace_id: string | null; run_id: string | null; title: string; destination: string; state: string; created_at: string; read_at: string | null; resolved_at: string | null },
            [string, string]
          >(
            "SELECT id, kind, bot_id, workspace_id, run_id, title, destination, state, created_at, read_at, resolved_at FROM inbox_items WHERE id = ? AND user_id = ?",
          ).get(params.id, owner.userId);
          return row ?? null;
        });
        if (!result) { set.status = 404; return { error: "not_found" as const }; }
        return inboxView(result);
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .post("/api/inbox/:id/read", ({ params, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }
      try {
        const result = database(databasePath, (db) => {
          initializeSchema(db);
          const row = db.query<
            { id: string; state: string; read_at: string | null },
            [string, string]
          >(
            "SELECT id, state, read_at FROM inbox_items WHERE id = ? AND user_id = ?",
          ).get(params.id, owner.userId);
          if (!row) return null;
          if (row.state === "read") return { ...row, alreadyRead: true };
          const now = new Date().toISOString();
          db.query("UPDATE inbox_items SET state = ?, read_at = ? WHERE id = ?").run("read", now, params.id);
          return { ...row, alreadyRead: false, readAt: now };
        });
        if (!result) { set.status = 404; return { error: "not_found" as const }; }
        const item = database(databasePath, (db) => {
          initializeSchema(db);
          return db.query<
            { id: string; kind: string; bot_id: string | null; workspace_id: string | null; run_id: string | null; title: string; destination: string; state: string; created_at: string; read_at: string | null; resolved_at: string | null },
            [string]
          >(
            "SELECT id, kind, bot_id, workspace_id, run_id, title, destination, state, created_at, read_at, resolved_at FROM inbox_items WHERE id = ?",
          ).get(params.id);
        });
        options?.onChange?.({ userId: owner.userId, type: "inbox.changed", workspaceId: item!.workspace_id ?? undefined });
        return inboxView(item!);
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .post("/api/inbox/:id/resolve", ({ params, request, set }) => {
      const owner = resolveOwner(request, databasePath);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }
      try {
        const result = database(databasePath, (db) => {
          initializeSchema(db);
          const row = db.query<
            { id: string; state: string; run_id: string | null },
            [string, string]
          >(
            "SELECT id, state, run_id FROM inbox_items WHERE id = ? AND user_id = ?",
          ).get(params.id, owner.userId);
          if (!row) return { found: false as const };
          if (row.state === "resolved") return { found: true, alreadyResolved: true, row };
          if (row.run_id) {
            const run = db.query<{ state: string }, [string]>(
              "SELECT state FROM runs WHERE id = ?",
            ).get(row.run_id);
            if (run && run.state === "needs_user") {
              return { found: true, actionRequired: true, runId: row.run_id, row };
            }
          }
          const now = new Date().toISOString();
          db.query("UPDATE inbox_items SET state = ?, resolved_at = ? WHERE id = ?").run("resolved", now, params.id);
          return { found: true, resolved: true, row, resolvedAt: now };
        });
        if (!result.found) { set.status = 404; return { error: "not_found" as const }; }
        if (result.actionRequired) {
          set.status = 409;
          return { error: "action_required" as const, runId: result.runId };
        }
        const item = database(databasePath, (db) => {
          initializeSchema(db);
          return db.query<
            { id: string; kind: string; bot_id: string | null; workspace_id: string | null; run_id: string | null; title: string; destination: string; state: string; created_at: string; read_at: string | null; resolved_at: string | null },
            [string]
          >(
            "SELECT id, kind, bot_id, workspace_id, run_id, title, destination, state, created_at, read_at, resolved_at FROM inbox_items WHERE id = ?",
          ).get(params.id);
        });
        options?.onChange?.({ userId: owner.userId, type: "inbox.changed", workspaceId: item!.workspace_id ?? undefined });
        return inboxView(item!);
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    });
}
