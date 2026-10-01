import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../app";
import { fileRequestSchemaReady } from "./file-requests";

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(process.env.RC029_TEST_WORK_DIR ?? tmpdir(), "rc029-file-schema-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  createApi(path);
  return { path, directory };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("migrates v1 atomically while preserving existing workspace, folder, and receipt rows", () => {
  const { path } = setup();
  const workspaceId = crypto.randomUUID();
  const folderRequestId = crypto.randomUUID();
  const database = new Database(path);
  database.query("INSERT INTO workspaces (id, user_id, name, created_at, archived) VALUES (?, 'alice', 'kept', 'now', 0)").run(workspaceId);
  database.query("INSERT INTO workspace_requests (user_id, request_id, workspace_id) VALUES ('alice', ?, ?)").run(folderRequestId, workspaceId);
  database.query("INSERT INTO workspace_receipts (user_id, request_id, workspace_id, kind, name, created_at, archived) VALUES ('alice', ?, ?, 'create', 'kept', 'now', 0)").run(folderRequestId, workspaceId);
  database.query("INSERT INTO workspace_folder_requests (user_id, request_id, workspace_id, state) VALUES ('alice', ?, ?, 'pending')").run(crypto.randomUUID(), workspaceId);
  database.exec("DROP TABLE file_operation_outcomes; DROP TABLE file_operation_intents; PRAGMA user_version = 1");
  database.close();

  createApi(path);
  const migrated = new Database(path, { readonly: true, create: false });
  try {
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(migrated.query("SELECT id, name FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ id: workspaceId, name: "kept" });
    expect(migrated.query("SELECT workspace_id FROM workspace_requests WHERE request_id = ?").get(folderRequestId)).toEqual({ workspace_id: workspaceId });
    expect(migrated.query("SELECT kind, name FROM workspace_receipts WHERE request_id = ?").get(folderRequestId)).toEqual({ kind: "create", name: "kept" });
    expect(migrated.query("SELECT state FROM workspace_folder_requests WHERE workspace_id = ?").get(workspaceId)).toEqual({ state: "pending" });
    expect(migrated.query("SELECT count(*) AS count FROM file_operation_intents").get()).toEqual({ count: 0 });
    expect(migrated.query("SELECT count(*) AS count FROM file_operation_outcomes").get()).toEqual({ count: 0 });
  } finally { migrated.close(); }
  expect(fileRequestSchemaReady(path)).toBe(true);
});

it("rolls back a failed v1-to-v2 migration without advancing the schema version", () => {
  const { path } = setup();
  const database = new Database(path);
  database.exec("DROP TABLE file_operation_outcomes; DROP TABLE file_operation_intents; CREATE TABLE file_operation_intents (broken TEXT); PRAGMA user_version = 1");
  database.close();

  createApi(path);
  const after = new Database(path, { readonly: true, create: false });
  try {
    expect(after.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(after.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_operation_outcomes'").get()).toBeNull();
    expect(after.query("SELECT name FROM pragma_table_info('file_operation_intents')").all()).toEqual([{ name: "broken" }]);
  } finally { after.close(); }
  expect(fileRequestSchemaReady(path)).toBe(false);
});

it.each(["drop", "incomplete"] as const)("does not repair a %s v2 table after restart and keeps liveness available", async (damage) => {
  const { path } = setup();
  const database = new Database(path);
  if (damage === "drop") database.exec("DROP TABLE file_operation_outcomes");
  else database.exec("ALTER TABLE file_operation_outcomes RENAME TO damaged_file_operation_outcomes; CREATE TABLE file_operation_outcomes (user_id TEXT)");
  database.close();

  const restarted = createApi(path);
  expect((await awaitResponse(restarted, "/api/health/live")).status).toBe(200);
  expect((await awaitResponse(restarted, "/api/health/ready")).status).toBe(503);
  expect(fileRequestSchemaReady(path)).toBe(false);
  const after = new Database(path, { readonly: true, create: false });
  try {
    const table = after.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_operation_outcomes'").get();
    if (damage === "drop") expect(table).toBeNull();
    else expect(after.query("SELECT name FROM pragma_table_info('file_operation_outcomes')").all()).toEqual([{ name: "user_id" }]);
    expect(existsSync(path)).toBe(true);
  } finally { after.close(); }
});

it("enforces one unfinished workspace intent and keeps terminal outcomes immutable", () => {
  const { path } = setup();
  const database = new Database(path);
  const workspaceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  try {
    database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
      .run(workspaceId, new Date().toISOString());
    const insert = database.query(`INSERT INTO file_operation_intents
      (user_id, request_id, kind, workspace_id, source_path, destination_path, input_digest, state)
      VALUES ('alice', ?, 'create', ?, '', 'file.txt', ?, 'pending')`);
    insert.run(requestId, workspaceId, "a".repeat(64));
    expect(() => insert.run(crypto.randomUUID(), workspaceId, "b".repeat(64))).toThrow();
    database.query("UPDATE file_operation_intents SET state = 'completed' WHERE request_id = ?").run(requestId);
    database.query(`INSERT INTO file_operation_outcomes
      (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
      VALUES ('alice', ?, 'create', ?, '', 'file.txt', 'file.txt', ?, ?)`)
      .run(requestId, workspaceId, "a".repeat(64), new Date().toISOString());
    expect(() => database.query("UPDATE file_operation_outcomes SET result_sha256 = ? WHERE request_id = ?")
      .run("b".repeat(64), requestId)).toThrow("file operation outcomes are immutable");
    expect(() => database.query("DELETE FROM file_operation_outcomes WHERE request_id = ?").run(requestId))
      .toThrow("file operation outcomes are immutable");
    expect(database.query("SELECT result_sha256 FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
      .toEqual({ result_sha256: "a".repeat(64) });
  } finally { database.close(); }
});

it.each(["index", "update", "delete"] as const)("rejects a named %s schema object whose safety constraint was replaced", async (damage) => {
  const { path } = setup();
  const database = new Database(path);
  if (damage === "index") database.exec(`
    DROP INDEX file_operation_one_unfinished_workspace;
    CREATE INDEX file_operation_one_unfinished_workspace ON file_operation_intents(workspace_id)
  `);
  else database.exec(`
    DROP TRIGGER file_operation_outcomes_immutable_${damage};
    CREATE TRIGGER file_operation_outcomes_immutable_${damage} BEFORE ${damage.toUpperCase()} ON file_operation_outcomes
    BEGIN SELECT 1; END
  `);
  database.close();
  expect(fileRequestSchemaReady(path)).toBe(false);
  const restarted = createApi(path);
  expect((await awaitResponse(restarted, "/api/health/live")).status).toBe(200);
  expect((await awaitResponse(restarted, "/api/health/ready")).status).toBe(503);
});

function awaitResponse(app: ReturnType<typeof createApi>, route: string) {
  return app.handle(new Request(`http://localhost${route}`));
}
