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
