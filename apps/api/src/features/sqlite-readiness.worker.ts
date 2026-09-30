import { Database } from "bun:sqlite";
import { existsSync, statfsSync } from "node:fs";

self.onmessage = (event: MessageEvent<string>) => {
  let database: Database | undefined;
  try {
    if (!existsSync(event.data)) throw new Error("SQLite file unavailable");
    if (statfsSync(event.data).bavail === 0) throw new Error("SQLite volume full");
    database = new Database(event.data);
    database.exec("PRAGMA busy_timeout = 250");
    const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") throw new Error("SQLite integrity check failed");
    database.exec("BEGIN IMMEDIATE");
    database.exec("ROLLBACK");

    database.query("SELECT sequence FROM actions LIMIT 1").get();
    database.query("SELECT user_id, request_id, action_id FROM action_requests LIMIT 1").get();
    database.query("SELECT user_id, request_id, workspace_id FROM workspace_requests LIMIT 1").get();
    database.query("SELECT user_id, request_id, workspace_id, kind FROM workspace_change_requests LIMIT 1").get();
    database.query("SELECT id, user_id, name, created_at, archived FROM workspaces LIMIT 1").get();
    database.query("SELECT user_id, request_id, workspace_id, kind, name, created_at, archived FROM workspace_receipts LIMIT 1").get();
    if (database.query(`
      SELECT 1 FROM workspace_requests r
      LEFT JOIN workspace_receipts s ON s.user_id = r.user_id AND s.request_id = r.request_id
      WHERE s.workspace_id IS NOT r.workspace_id OR s.kind IS NOT 'create' LIMIT 1
    `).get() || database.query(`
      SELECT 1 FROM workspace_receipts s LEFT JOIN workspaces w ON w.id = s.workspace_id
      WHERE w.id IS NULL OR w.user_id IS NOT s.user_id OR
        typeof(s.request_id) != 'text' OR length(s.request_id) != 36 OR
        typeof(s.kind) != 'text' OR s.kind NOT IN ('create', 'rename', 'archive') OR
        (s.archived IS NOT 0 AND s.archived IS NOT 1) OR (s.kind = 'archive') != s.archived OR
        typeof(s.name) != 'text' OR length(s.name) NOT BETWEEN 1 AND 120 OR
        typeof(s.created_at) != 'text' OR length(s.created_at) = 0 LIMIT 1
    `).get() || database.query(`
      SELECT 1 FROM workspace_receipts s
      LEFT JOIN workspace_requests r ON r.user_id = s.user_id AND r.request_id = s.request_id
      WHERE s.kind = 'create' AND r.workspace_id IS NOT s.workspace_id LIMIT 1
    `).get() || database.query(`
      SELECT 1 FROM workspace_change_requests r
      LEFT JOIN workspace_receipts s ON s.user_id = r.user_id AND s.request_id = r.request_id
      WHERE r.kind NOT IN ('rename', 'archive') OR s.workspace_id IS NOT r.workspace_id OR s.kind IS NOT r.kind LIMIT 1
    `).get() || database.query(`
      SELECT 1 FROM workspace_receipts s
      LEFT JOIN workspace_change_requests r ON r.user_id = s.user_id AND r.request_id = s.request_id
      WHERE s.kind != 'create' AND (r.workspace_id IS NOT s.workspace_id OR r.kind IS NOT s.kind) LIMIT 1
    `).get() || database.query(`
      SELECT 1 FROM workspace_requests c JOIN workspace_change_requests r ON r.user_id = c.user_id AND r.request_id = c.request_id LIMIT 1
    `).get() || database.query(`
      SELECT 1 FROM workspaces
      WHERE typeof(id) != 'text' OR length(id) = 0 OR typeof(user_id) != 'text' OR length(user_id) = 0 OR
        typeof(name) != 'text' OR length(name) NOT BETWEEN 1 AND 120 OR
        typeof(created_at) != 'text' OR length(created_at) = 0 OR
        (archived IS NOT 0 AND archived IS NOT 1) LIMIT 1
    `).get()) throw new Error("SQLite workspace receipts are invalid");
    database.query("SELECT user_id, request_id, display_name, updated_at FROM profile_requests LIMIT 1").get();
    database.query("SELECT user_id, request_id, workspace_id, history_id FROM history_requests LIMIT 1").get();
    database.query("SELECT user_id, request_id, kind, outcome, session_token_hash FROM auth_requests LIMIT 1").get();
    for (const table of ["workspaces", "history", "profiles", "sessions"]) {
      database.query(`SELECT 1 FROM ${table} LIMIT 1`).get();
    }
    self.postMessage(true);
  } catch {
    self.postMessage(false);
  } finally {
    database?.close();
  }
};
