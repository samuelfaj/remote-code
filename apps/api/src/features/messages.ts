import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, fstatSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";
import { hasGitDir, parsePorcelain, runGit } from "./workspace-git";
import { relativeComponents } from "./workspace-files";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxDiffBytes = 64 * 1024;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

export function messagesFeature(databasePath: string) {
  function resolveOwner(request: Request): Owner {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return { kind: "anonymous" };
    const db = new Database(databasePath, { readonly: true, create: false });
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

  function initializeSchema(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS run_changes (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id)");
    db.exec("CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id)");
    db.exec("CREATE INDEX IF NOT EXISTS attachments_message ON message_attachments(message_id)");
    db.exec("CREATE INDEX IF NOT EXISTS run_changes_workspace ON run_changes(workspace_id)");
  }

  function database<T>(callback: (db: Database) => T): T {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 250");
      db.exec("PRAGMA synchronous = FULL");
      initializeSchema(db);
      return callback(db);
    } finally {
      db.close();
    }
  }

  return new Elysia()
    .post("/api/workspaces/:workspaceId/threads", ({ params, body, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > 500) { set.status = 400; return { error: "invalid_title" as const }; }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      database((db) => {
        const workspace = db.query<{ id: string }, [string, string]>(
          "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, owner.userId);
        if (!workspace) return { kind: "not_found" as const };
        db.query("INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, params.workspaceId, owner.userId, title, now, now);
        return { kind: "ok" as const, id };
      });
      set.status = 201;
      return { id, workspaceId: params.workspaceId, title, createdAt: now, updatedAt: now };
    }, {
      params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
      body: t.Object({ title: t.String({ minLength: 1, maxLength: 500 }) }),
    })
    .get("/api/workspaces/:workspaceId/threads", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const threads = database((db) => {
        const workspace = db.query<{ id: string }, [string, string]>(
          "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, owner.userId);
        if (!workspace) return null;
        return db.query<{ id: string; title: string; created_at: string; updated_at: string }, [string]>(
          "SELECT id, title, created_at, updated_at FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC",
        ).all(params.workspaceId);
      });
      if (threads === null) { set.status = 404; return { error: "not_found" as const }; }
      return { threads: threads.map((row) => ({ id: row.id, workspaceId: params.workspaceId, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at })) };
    }, {
      params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    })
    .post("/api/threads/:threadId/messages", ({ params, body, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const bodyText = typeof body.body === "string" ? body.body : "";
      const attachmentPaths: string[] = Array.isArray(body.attachments) ? body.attachments.filter((p): p is string => typeof p === "string") : [];
      const runId = typeof body.runId === "string" ? body.runId.toLowerCase() : null;
      if (!canonicalUuid.test(params.threadId)) { set.status = 400; return { error: "invalid_thread_id" as const }; }
      if (runId !== null && !canonicalUuid.test(runId)) { set.status = 400; return { error: "invalid_run_id" as const }; }
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      let db: Database | undefined;
      try {
        db = new Database(databasePath);
        db.exec("PRAGMA busy_timeout = 250");
        db.exec("PRAGMA synchronous = FULL");
        const thread = db.query<{ workspace_id: string; user_id: string }, [string]>(
          "SELECT workspace_id, user_id FROM threads WHERE id = ?",
        ).get(params.threadId);
        if (!thread) { set.status = 404; return { error: "thread_not_found" as const }; }
        if (thread.user_id !== owner.userId) { set.status = 404; return { error: "not_found" as const }; }
        const workspace = db.query<{ id: string }, [string, string]>(
          "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(thread.workspace_id, owner.userId);
        if (!workspace) { set.status = 404; return { error: "not_found" as const }; }
        if (runId !== null) {
          const run = db.query<{ workspace_id: string; user_id: string }, [string]>(
            "SELECT workspace_id, user_id FROM runs WHERE id = ?",
          ).get(runId);
          if (!run || run.workspace_id !== thread.workspace_id || run.user_id !== owner.userId) {
            set.status = 404; return { error: "run_not_found" as const };
          }
        }
        const attachmentRecords: Array<{ id: string; path: string; sha256: string; size: number }> = [];
        for (const attachPath of attachmentPaths) {
          const components = relativeComponents(attachPath, true);
          if (!components) { set.status = 400; return { error: "invalid_attachment_path" as const }; }
          const result = withProvisionedWorkspaceFolder(databasePath, owner.userId, thread.workspace_id, (folderFd, openAt, close) => {
            const fullPath = components.join("/");
            const fileFd = openAt(folderFd, fullPath, 0);
            if (fileFd < 0) return { status: 404 as const, error: "attachment_not_found" as const };
            try {
              const info = fstatSync(fileFd);
              if (!info.isFile()) return { status: 400 as const, error: "invalid_attachment_path" as const };
              const bytes = readFileSync(`/proc/self/fd/${fileFd}`);
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              return { status: 200 as const, attachment: { path: fullPath, sha256, size: info.size } };
            } finally {
              close(fileFd);
            }
          });
          if (result.kind !== "opened") {
            set.status = result.kind === "not_found" ? 404 : 503;
            return { error: result.kind === "not_found" ? "workspace_folder_unavailable" : "storage_unavailable" };
          }
          if (result.value.status !== 200) {
            set.status = result.value.status;
            return { error: result.value.error };
          }
          const attId = crypto.randomUUID();
          attachmentRecords.push({ id: attId, ...result.value.attachment });
        }
        const kind = runId !== null ? "result" : "user";
        db.query("INSERT INTO messages (id, thread_id, user_id, kind, body, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, params.threadId, owner.userId, kind, bodyText, runId ?? null, now);
        for (const att of attachmentRecords) {
          db.query("INSERT INTO message_attachments (id, message_id, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(att.id, id, att.path, att.sha256, att.size, now);
        }
        set.status = 201;
        return {
          id, threadId: params.threadId, kind, body: bodyText, runId,
          attachments: attachmentRecords.map((att) => ({ path: att.path, sha256: att.sha256, size: att.size })),
          createdAt: now,
        };
      } catch (error) {
        if (set.status === 201) set.status = 500;
        return { error: "storage_unavailable" as const };
      } finally {
        db?.close();
      }
    }, {
      params: t.Object({ threadId: t.String({ minLength: 1 }) }),
      body: t.Object({
        body: t.String(),
        attachments: t.Optional(t.Array(t.String())),
        runId: t.Optional(t.String({ minLength: 36, maxLength: 36 })),
      }),
    })
    .get("/api/threads/:threadId/messages", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const thread = database((db) => {
        return db.query<{ workspace_id: string; user_id: string }, [string]>(
          "SELECT workspace_id, user_id FROM threads WHERE id = ?",
        ).get(params.threadId);
      });
      if (!thread || thread.user_id !== owner.userId) { set.status = 404; return { error: "not_found" as const }; }
      const messages = database((db) => {
        return db.query<{ id: string; kind: string; body: string; run_id: string | null; created_at: string }, [string]>(
          "SELECT id, kind, body, run_id, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
        ).all(params.threadId);
      });
      const resultMessages = messages.map((msg) => {
        let changes: { files: Array<{ path: string; changeKind: string }>; diff: string; truncated: boolean } | null = null;
        if (msg.run_id) {
          const runId = msg.run_id;
          const runChange = database((db) => {
            return db.query<{ payload: string }, [string]>(
              "SELECT payload FROM run_changes WHERE run_id = ?",
            ).get(runId);
          });
          if (runChange) {
            try { changes = JSON.parse(runChange.payload); } catch { changes = null; }
          }
        }
        const attachments = database((db) => {
          return db.query<{ path: string; sha256: string; size: number }, [string]>(
            "SELECT path, sha256, size FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC",
          ).all(msg.id);
        });
        return {
          id: msg.id, kind: msg.kind, body: msg.body, runId: msg.run_id,
          attachments: attachments.map((att) => ({ path: att.path, sha256: att.sha256, size: att.size })),
          changes,
          createdAt: msg.created_at,
        };
      });
      return { threadId: params.threadId, messages: resultMessages };
    }, {
      params: t.Object({ threadId: t.String({ minLength: 1 }) }),
    })
    .get("/api/runs/:id/changes", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }
      const row = database((db) => {
        return db.query<{ workspace_id: string; user_id: string }, [string]>(
          "SELECT r.workspace_id, r.user_id FROM runs r WHERE r.id = ?",
        ).get(params.id);
      });
      if (!row || row.user_id !== owner.userId) { set.status = 404; return { error: "not_found" as const }; }
      const change = database((db) => {
        return db.query<{ captured_at: string; payload: string }, [string]>(
          "SELECT captured_at, payload FROM run_changes WHERE run_id = ?",
        ).get(params.id);
      });
      if (!change) { set.status = 404; return { error: "not_found" as const }; }
      let payload: { files: Array<{ path: string; changeKind: string }>; diff: string; truncated: boolean };
      try { payload = JSON.parse(change.payload); } catch { set.status = 404; return { error: "not_found" as const }; }
      set.status = 200;
      return { runId: params.id, workspaceId: row.workspace_id, capturedAt: change.captured_at, ...payload };
    }, {
      params: t.Object({ id: t.String({ minLength: 36, maxLength: 36 }) }),
    });
}