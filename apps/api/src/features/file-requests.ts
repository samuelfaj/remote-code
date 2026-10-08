import { Database } from "bun:sqlite";

export const fileRequestSchemaVersion = 2;
const schemaDefinitions = [
  ["table", "file_operation_intents", `CREATE TABLE file_operation_intents (
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'save', 'move')),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    expected_sha256 TEXT,
    input_digest TEXT NOT NULL,
    source_device TEXT,
    source_inode TEXT,
    stage_device TEXT,
    stage_inode TEXT,
    stage_digest TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'prepared', 'completed', 'unknown')),
    PRIMARY KEY (user_id, request_id),
    CHECK (length(request_id) = 36),
    CHECK (length(input_digest) = 64),
    CHECK (expected_sha256 IS NULL OR length(expected_sha256) = 64),
    CHECK (source_device IS NULL OR length(source_device) > 0),
    CHECK (source_inode IS NULL OR length(source_inode) > 0),
    CHECK (stage_device IS NULL OR length(stage_device) > 0),
    CHECK (stage_inode IS NULL OR length(stage_inode) > 0),
    CHECK (stage_digest IS NULL OR length(stage_digest) = 64)
  )`],
  ["index", "file_operation_one_unfinished_workspace", `CREATE UNIQUE INDEX file_operation_one_unfinished_workspace
    ON file_operation_intents(workspace_id) WHERE state IN ('pending', 'prepared', 'unknown')`],
  ["table", "file_operation_outcomes", `CREATE TABLE file_operation_outcomes (
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'save', 'move')),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    result_path TEXT NOT NULL,
    result_sha256 TEXT NOT NULL CHECK (length(result_sha256) = 64),
    completed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, request_id),
    FOREIGN KEY (user_id, request_id) REFERENCES file_operation_intents(user_id, request_id)
  )`],
  ["trigger", "file_operation_outcomes_immutable_update", `CREATE TRIGGER file_operation_outcomes_immutable_update BEFORE UPDATE ON file_operation_outcomes
    BEGIN SELECT RAISE(ABORT, 'file operation outcomes are immutable'); END`],
  ["trigger", "file_operation_outcomes_immutable_delete", `CREATE TRIGGER file_operation_outcomes_immutable_delete BEFORE DELETE ON file_operation_outcomes
    BEGIN SELECT RAISE(ABORT, 'file operation outcomes are immutable'); END`],
] as const;

function canonicalSchemaSql(sql: string) {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

export function fileRequestSchemaMatches(database: Database) {
  if (database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== fileRequestSchemaVersion) return false;
  return schemaDefinitions.every(([type, name, sql]) => {
    const actual = database.query<{ sql: string | null }, [string, string]>(
      "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
    ).get(type, name)?.sql;
    return typeof actual === "string" && canonicalSchemaSql(actual) === canonicalSchemaSql(sql);
  });
}

export function fileRequestSchemaReady(databasePath: string) {
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, create: false });
    return fileRequestSchemaMatches(database);
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export function createFileRequestTables(database: Database) {
  for (const [, , sql] of schemaDefinitions) database.exec(sql);
}
