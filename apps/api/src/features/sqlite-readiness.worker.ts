import { Database } from "bun:sqlite";

self.onmessage = (event: MessageEvent<string>) => {
  let database: Database | undefined;
  try {
    database = new Database(event.data, { readonly: true, create: false });
    database.exec("PRAGMA busy_timeout = 5000");
    database.query("SELECT sequence FROM actions LIMIT 1").get();
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
