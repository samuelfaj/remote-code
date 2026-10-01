import { createHash } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, readFileSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
import { Elysia, t } from "elysia";
import { sessionUserId } from "./auth";
import { fileRequestSchemaMatches } from "./file-requests";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";

// ponytail: UTF-8 reads cap at 1 MiB; add streaming reads for larger or binary files.
const maxContentBytes = 1024 * 1024;
const maxDirectoryEntries = 1000;
const directoryFlags = constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000;
const stageFlags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | 0x80000;
const inspectFlags = 0x200000 | constants.O_NOFOLLOW | 0x80000;
const markerName = ".remotecode-workspace";
const stagePrefix = ".remotecode-stage-";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nativeSymbols = {
  linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;
const atSymlinkFollow = 0x400;
const renameExchange = 2;
const libc = process.platform === "linux" ? dlopen("libc.so.6", nativeSymbols) : undefined;

type Entry = { name: string; type: "file" | "directory"; size: number };
type FileContent = { path: string; content: string; version: string };
type DirectoryListing = { path: string; entries: Entry[] };
type ReadResult<T> = { status: number; body: T | { error: string } };
type FileIntentRow = {
  user_id: string; request_id: string; kind: "create" | "save" | "move"; workspace_id: string; source_path: string; destination_path: string;
  expected_sha256: string | null; input_digest: string; source_device: string | null; source_inode: string | null;
  stage_device: string | null; stage_inode: string | null; stage_digest: string | null; state: string;
};
type FileOutcomeRow = {
  user_id: string; request_id: string; kind: "create" | "save" | "move"; workspace_id: string; source_path: string; destination_path: string;
  result_path: string; result_sha256: string; completed_at: string;
};
type FileReceipt = { requestId: string; workspaceId: string; kind: "create" | "save"; path: string; version: string; createdAt: string };
type SaveTarget = { device: string; inode: string; mode: number; version: string };
type WriteOperation = { kind: "create"; expectedVersion: null; sourceDevice: null; sourceInode: null; mode: 0o600 } |
  { kind: "save"; expectedVersion: string; sourceDevice: string; sourceInode: string; mode: number };

function relativeComponents(path: string | undefined, required: boolean): string[] | null {
  if (path === undefined) return required ? null : [];
  if (path.length === 0 || !validText(path) || path.startsWith("/")) return null;
  const components = path.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === ".." ||
    component === markerName || component.startsWith(stagePrefix))) return null;
  return components;
}

function openDirectoryPath(
  folderFd: number,
  components: string[],
  openAt: (parentFd: number, name: string, flags: number) => number,
  close: (fd: number) => void,
): number {
  let current = folderFd;
  for (const component of components) {
    const next = openAt(current, component, directoryFlags);
    if (next < 0) {
      if (current !== folderFd) close(current);
      return -1;
    }
    if (current !== folderFd) close(current);
    current = next;
  }
  return current;
}

function readContent(
  folderFd: number,
  components: string[],
  openAt: (parentFd: number, name: string, flags: number) => number,
  close: (fd: number) => void,
): ReadResult<FileContent> {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
  if (parent < 0) return { status: 404, body: { error: "file_not_found" } };
  const fileFd = openAt(parent, components.at(-1)!, fileFlags);
  if (parent !== folderFd) close(parent);
  if (fileFd < 0) return { status: 404, body: { error: "file_not_found" } };
  try {
    const info = statSync(`/proc/self/fd/${fileFd}`);
    if (!info.isFile()) return { status: 415, body: { error: "unsupported_file_type" } };
    if (info.size > maxContentBytes) return { status: 413, body: { error: "file_too_large" } };
    const bytes = Buffer.alloc(maxContentBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fileFd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxContentBytes) return { status: 413, body: { error: "file_too_large" } };
    const contentBytes = bytes.subarray(0, length);
    if (contentBytes.includes(0)) return { status: 415, body: { error: "unsupported_file_type" } };
    let content: string;
    try { content = utf8.decode(contentBytes); } catch { return { status: 415, body: { error: "unsupported_text_encoding" } }; }
    return { status: 200, body: { path: components.join("/"), content, version: createHash("sha256").update(contentBytes).digest("hex") } };
  } finally { close(fileFd); }
}

function listDirectory(
  folderFd: number,
  components: string[],
  openAt: (parentFd: number, name: string, flags: number) => number,
  close: (fd: number) => void,
): ReadResult<DirectoryListing> {
  const directoryFd = openDirectoryPath(folderFd, components, openAt, close);
  if (directoryFd < 0) return { status: 404, body: { error: "directory_not_found" } };
  try {
    const names = readdirSync(`/proc/self/fd/${directoryFd}`);
    if (names.length > maxDirectoryEntries) return { status: 413, body: { error: "directory_too_large" } };
    const entries: Entry[] = [];
    for (const name of names) {
      if (name === markerName || name.startsWith(stagePrefix)) continue;
      const fd = openAt(directoryFd, name, fileFlags);
      if (fd < 0) continue;
      try {
        const info = statSync(`/proc/self/fd/${fd}`);
        if (info.isDirectory()) entries.push({ name, type: "directory", size: 0 });
        else if (info.isFile()) entries.push({ name, type: "file", size: info.size });
      } finally { close(fd); }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { status: 200, body: { path: components.join("/"), entries } };
  } finally { if (directoryFd !== folderFd) close(directoryFd); }
}

function errorStatus(error: unknown) {
  if (error instanceof Error && error.message === "version_conflict") return 409;
  if (error instanceof Error && error.message === "target_exists") return 409;
  if (error instanceof Error && error.message === "workspace_archived") return 409;
  if (error instanceof Error && error.message === "foreign_workspace") return 404;
  return 503;
}

export function workspaceFilesFeature(databasePath: string, syncDirectory: (fd: number) => void = fsyncSync) {
  const routes = new Elysia().get("/api/workspaces/:workspaceId/files", ({ params, query, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const components = relativeComponents(query.path, false);
    if (components === null) { set.status = 400; return { error: "invalid_path" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
      (folderFd, openAt, close) => listDirectory(folderFd, components, openAt, close));
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_files_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    query: t.Object({ path: t.Optional(t.String({ maxLength: 4096 })) }),
  }).get("/api/workspaces/:workspaceId/files/content", ({ params, query, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const components = relativeComponents(query.path, true);
    if (!components) { set.status = 400; return { error: "invalid_path" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
      (folderFd, openAt, close) => readContent(folderFd, components, openAt, close));
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_files_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    query: t.Object({ path: t.Optional(t.String({ maxLength: 4096 })) }),
  }).post("/api/workspaces/:workspaceId/files", ({ params, body, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const id = body.requestId.toLowerCase();
    const path = relativeComponents(body.path, true);
    if (!canonicalUuid.test(id) || !path || !validText(body.content)) { set.status = 400; return { error: "invalid_file_request" as const }; }
    if (process.platform !== "linux" || !libc) { set.status = 501; return { error: "workspace_files_require_linux" as const }; }
    const bytes = Buffer.from(body.content, "utf8");
    if (bytes.length > maxContentBytes) { set.status = 413; return { error: "file_too_large" as const }; }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const inputDigest = fileInputDigest("create", params.workspaceId, path.join("/"), digest, null);
    let db: Database | undefined;
    try {
      db = new Database(databasePath);
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA busy_timeout = 250");
      if (!fileRequestSchemaMatches(db)) throw new Error("storage_unavailable");
      const currentWorkspace = db.query<{ id: string }, [string, string]>("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
        .get(params.workspaceId, userId);
      if (!currentWorkspace) { set.status = 404; return { error: "not_found" as const }; }
      const outcome = db.query<FileOutcomeRow, [string, string]>("SELECT * FROM file_operation_outcomes WHERE user_id = ? AND request_id = ?")
        .get(userId, id);
      if (outcome) {
        if (outcome.workspace_id !== params.workspaceId) { set.status = 404; return { error: "receipt_not_found" as const }; }
        if (outcome.kind !== "create") { set.status = 409; return { error: "request_id_conflict" as const }; }
        const receipt = validatedReceipt(db, userId, params.workspaceId, id, outcome);
        if (!receipt) { set.status = 503; return { error: "outcome_unknown" as const }; }
        if (outcome.destination_path !== path.join("/") || outcome.result_sha256 !== digest) {
          set.status = 409; return { error: "request_id_conflict" as const };
        }
        set.status = 200; return receipt;
      }
      const existing = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
        .get(userId, id);
      if (existing) {
        if (existing.input_digest !== inputDigest || existing.kind !== "create" || existing.workspace_id !== params.workspaceId || existing.destination_path !== path.join("/")) {
          set.status = 409; return { error: "request_id_conflict" as const };
        }
        const recovered = recoverOnly(databasePath, db, userId, params.workspaceId, id, libc);
        if (recovered) { set.status = 200; return recovered; }
        set.status = 503; return { error: "outcome_unknown" as const };
      }
      const preflight = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
        const parent = openDirectoryPath(folderFd, path.slice(0, -1), openAt, close);
        if (parent < 0) return "parent_missing";
        try { return pathExists(parent, path.at(-1)!, openAt, close) ? "target_exists" : "clear"; }
        finally { if (parent !== folderFd) close(parent); }
      });
      if (preflight.kind !== "opened") { set.status = preflight.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501; return { error: "workspace_folder_unavailable" as const }; }
      if (preflight.value === "parent_missing") { set.status = 404; return { error: "parent_directory_not_found" as const }; }
      if (preflight.value === "target_exists") { set.status = 409; return { error: "target_exists" as const }; }
      const accepted = db.transaction(() => {
        const workspace = db!.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?").get(params.workspaceId, userId);
        if (!workspace) return "foreign_workspace";
        if (workspace.archived) return "workspace_archived";
        db!.query(`INSERT INTO file_operation_intents (user_id, request_id, kind, workspace_id, source_path, destination_path, input_digest, state)
          VALUES (?, ?, 'create', ?, '', ?, ?, 'pending')`).run(userId, id, params.workspaceId, path.join("/"), inputDigest);
        return "accepted";
      }).immediate();
      if (accepted !== "accepted") { set.status = accepted === "foreign_workspace" ? 404 : 409; return { error: accepted } as const; }
      const created = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
        try { return { kind: "created" as const, result: writeOnce(db!, folderFd, path, bytes, digest, id, params.workspaceId, userId, libc!, openAt, close, syncDirectory,
          { kind: "create", expectedVersion: null, sourceDevice: null, sourceInode: null, mode: 0o600 }) }; }
        catch (error) { return { kind: "error" as const, error }; }
      });
      if (created.kind !== "opened") throw new Error(created.kind === "not_found" ? "foreign_workspace" : "workspace_unavailable");
      if (created.value.kind === "error") throw created.value.error;
      set.status = created.value.result.status;
      return created.value.result.body;
    } catch (error) {
      set.status = errorStatus(error);
      if (error instanceof Error && error.message === "version_conflict") return { error: "version_conflict" as const };
      return { error: "file_operation_unavailable" as const };
    } finally { db?.close(); }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ requestId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }), path: t.String({ minLength: 1, maxLength: 4096 }), content: t.String() }),
  }).put("/api/workspaces/:workspaceId/files/content", ({ params, body, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const id = body.requestId.toLowerCase();
    const path = relativeComponents(body.path, true);
    const expectedVersion = body.expectedVersion.toLowerCase();
    if (!canonicalUuid.test(id) || !path || !/^[0-9a-f]{64}$/.test(expectedVersion) || !validText(body.content)) {
      set.status = 400; return { error: "invalid_file_request" as const };
    }
    if (process.platform !== "linux" || !libc) { set.status = 501; return { error: "workspace_files_require_linux" as const }; }
    const bytes = Buffer.from(body.content, "utf8");
    if (bytes.length > maxContentBytes) { set.status = 413; return { error: "file_too_large" as const }; }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const inputDigest = fileInputDigest("save", params.workspaceId, path.join("/"), digest, expectedVersion);
    let db: Database | undefined;
    try {
      db = new Database(databasePath);
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA busy_timeout = 250");
      if (!fileRequestSchemaMatches(db)) throw new Error("storage_unavailable");
      const workspace = db.query<{ id: string }, [string, string]>("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
        .get(params.workspaceId, userId);
      if (!workspace) { set.status = 404; return { error: "not_found" as const }; }
      const outcome = db.query<FileOutcomeRow, [string, string]>("SELECT * FROM file_operation_outcomes WHERE user_id = ? AND request_id = ?")
        .get(userId, id);
      if (outcome) {
        if (outcome.workspace_id !== params.workspaceId) { set.status = 404; return { error: "receipt_not_found" as const }; }
        if (outcome.kind !== "save") { set.status = 409; return { error: "request_id_conflict" as const }; }
        const receipt = validatedReceipt(db, userId, params.workspaceId, id, outcome);
        const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
          .get(userId, id);
        if (!receipt || !intent) { set.status = 503; return { error: "outcome_unknown" as const }; }
        if (intent.input_digest !== inputDigest) { set.status = 409; return { error: "request_id_conflict" as const }; }
        set.status = 200; return receipt;
      }
      const existing = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
        .get(userId, id);
      if (existing) {
        if (existing.kind !== "save" || existing.workspace_id !== params.workspaceId || existing.destination_path !== path.join("/") ||
          existing.expected_sha256 !== expectedVersion || existing.input_digest !== inputDigest) {
          set.status = 409; return { error: "request_id_conflict" as const };
        }
        const recovered = recoverOnly(databasePath, db, userId, params.workspaceId, id, libc);
        if (recovered) { set.status = 200; return recovered; }
        set.status = 503; return { error: "outcome_unknown" as const };
      }
      const preflight = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
        (folderFd, openAt, close) => inspectSaveTarget(folderFd, path, openAt, close));
      if (preflight.kind !== "opened") {
        set.status = preflight.kind === "not_found" ? 404 : 503;
        return { error: "workspace_folder_unavailable" as const };
      }
      if (preflight.value.status !== 200) { set.status = preflight.value.status; return { error: preflight.value.error } as const; }
      if (preflight.value.value.version !== expectedVersion) {
        set.status = 409; return { error: "version_conflict" as const, currentVersion: preflight.value.value.version };
      }
      const source = preflight.value.value;
      const accepted = db.transaction(() => {
        const current = db!.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?")
          .get(params.workspaceId, userId);
        if (!current) return "foreign_workspace";
        if (current.archived) return "workspace_archived";
        const checked = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
          (folderFd, openAt, close) => inspectSaveTarget(folderFd, path, openAt, close));
        if (checked.kind !== "opened" || checked.value.status !== 200) return "workspace_folder_unavailable";
        const now = checked.value.value;
        if (now.version !== expectedVersion || now.device !== source.device || now.inode !== source.inode) return "version_conflict";
        db!.query(`INSERT INTO file_operation_intents
          (user_id, request_id, kind, workspace_id, source_path, destination_path, expected_sha256, input_digest, source_device, source_inode, state)
          VALUES (?, ?, 'save', ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(userId, id, params.workspaceId, path.join("/"), path.join("/"), expectedVersion, inputDigest, source.device, source.inode);
        return "accepted";
      }).immediate();
      if (accepted !== "accepted") {
        set.status = accepted === "foreign_workspace" ? 404 : accepted === "workspace_archived" ? 409 : accepted === "version_conflict" ? 409 : 503;
        return { error: accepted === "version_conflict" ? "version_conflict" : accepted } as const;
      }
      const saved = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
        try { return { kind: "saved" as const, result: writeOnce(db!, folderFd, path, bytes, digest, id, params.workspaceId, userId, libc!, openAt, close, syncDirectory,
          { kind: "save", expectedVersion, sourceDevice: source.device, sourceInode: source.inode, mode: source.mode }) }; }
        catch (error) { return { kind: "error" as const, error }; }
      });
      if (saved.kind !== "opened") throw new Error(saved.kind === "not_found" ? "foreign_workspace" : "workspace_unavailable");
      if (saved.value.kind === "error") throw saved.value.error;
      set.status = saved.value.result.status;
      return saved.value.result.body;
    } catch (error) {
      set.status = errorStatus(error);
      if (error instanceof Error && error.message === "version_conflict") return { error: "version_conflict" as const };
      return { error: "file_operation_unavailable" as const };
    } finally { db?.close(); }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ requestId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }), path: t.String({ minLength: 1, maxLength: 4096 }),
      content: t.String(), expectedVersion: t.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-fA-F]{64}$" }) }),
  }).get("/api/workspaces/:workspaceId/files/receipts/:requestId", ({ params, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const requestId = params.requestId.toLowerCase();
    if (!canonicalUuid.test(requestId)) { set.status = 400; return { error: "invalid_request_id" as const }; }
    let db: Database | undefined;
    try {
      db = new Database(databasePath);
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA busy_timeout = 250");
      if (!fileRequestSchemaMatches(db)) throw new Error("storage_unavailable");
      const workspace = db.query<{ id: string }, [string, string]>("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
        .get(params.workspaceId, userId);
      if (!workspace) { set.status = 404; return { error: "receipt_not_found" as const }; }
      const outcome = db.query<FileOutcomeRow, [string, string]>("SELECT * FROM file_operation_outcomes WHERE user_id = ? AND request_id = ?")
        .get(userId, requestId);
      if (outcome) {
        if (outcome.workspace_id !== params.workspaceId) { set.status = 404; return { error: "receipt_not_found" as const }; }
        const receipt = validatedReceipt(db, userId, params.workspaceId, requestId, outcome);
        if (!receipt) { set.status = 503; return { error: "outcome_unknown" as const }; }
        set.status = 200; return receipt;
      }
      const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
        .get(userId, requestId);
      if (!intent) { set.status = 404; return { error: "receipt_not_found" as const }; }
      if ((intent.kind !== "create" && intent.kind !== "save") || intent.workspace_id !== params.workspaceId) { set.status = 404; return { error: "receipt_not_found" as const }; }
      const recovered = recoverOnly(databasePath, db, userId, params.workspaceId, requestId, libc);
      if (recovered) { set.status = 200; return recovered; }
      set.status = 503; return { error: "outcome_unknown" as const };
    } catch { set.status = process.platform === "linux" ? 503 : 501; return { error: "receipt_unavailable" as const }; }
    finally { db?.close(); }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }), requestId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
  });
  return routes;
}

function validText(value: string) {
  if (value.includes("\0")) return false;
  try { const bytes = Buffer.from(value, "utf8"); return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) === value; }
  catch { return false; }
}

function fileInputDigest(kind: "create" | "save", workspaceId: string, path: string, resultDigest: string, expectedVersion: string | null) {
  const input = kind === "create" ? [workspaceId, path, resultDigest] : [kind, workspaceId, path, expectedVersion, resultDigest];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

type SaveTargetResult = { status: 200; value: SaveTarget } | { status: 404 | 409 | 413 | 415; error: string };
function inspectSaveTarget(
  folderFd: number, components: string[], openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void,
): SaveTargetResult {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
  if (parent < 0) return { status: 404, error: "parent_directory_not_found" };
  try { return readSaveTarget(parent, components.at(-1)!, openAt, close); }
  finally { if (parent !== folderFd) close(parent); }
}

function readSaveTarget(
  parent: number, name: string, openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void,
): SaveTargetResult {
  const fd = openAt(parent, name, fileFlags);
  if (fd < 0) return { status: 404, error: "file_not_found" };
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile()) return { status: 415, error: "unsupported_file_type" };
    if (info.uid !== BigInt(process.getuid?.() ?? -1) || info.gid !== BigInt(process.getgid?.() ?? -1)) return { status: 409, error: "file_unavailable" };
    if (info.size > BigInt(maxContentBytes)) return { status: 413, error: "file_too_large" };
    const bytes = readBounded(fd, maxContentBytes);
    const afterRead = fstatSync(fd, { bigint: true });
    if (BigInt(bytes.length) !== info.size || afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.size !== info.size || afterRead.mode !== info.mode) {
      return { status: 409, error: "file_changed" };
    }
    if (bytes.includes(0)) return { status: 415, error: "unsupported_file_type" };
    try { utf8.decode(bytes); } catch { return { status: 415, error: "unsupported_text_encoding" }; }
    return { status: 200, value: { device: String(info.dev), inode: String(info.ino), mode: Number(info.mode & 0o777n), version: createHash("sha256").update(bytes).digest("hex") } };
  } finally { close(fd); }
}

function validatedReceipt(db: Database, userId: string, workspaceId: string, requestId: string, outcome: FileOutcomeRow): FileReceipt | null {
  const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
    .get(userId, requestId);
  const path = relativeComponents(outcome.destination_path, true);
  const timestamp = new Date(outcome.completed_at);
  if (!intent || outcome.user_id !== userId || outcome.request_id !== requestId || (outcome.kind !== "create" && outcome.kind !== "save") ||
    outcome.workspace_id !== workspaceId || !canonicalUuid.test(outcome.workspace_id) || outcome.source_path !== (outcome.kind === "create" ? "" : outcome.destination_path) ||
    !path || path.join("/") !== outcome.destination_path || outcome.result_path !== outcome.destination_path || !/^[0-9a-f]{64}$/.test(outcome.result_sha256) ||
    fileInputDigest(outcome.kind, workspaceId, outcome.destination_path, outcome.result_sha256, outcome.kind === "save" ? intent.expected_sha256 : null) !== intent.input_digest ||
    !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== outcome.completed_at ||
    intent.user_id !== userId || intent.request_id !== requestId || intent.kind !== outcome.kind || intent.workspace_id !== workspaceId ||
    intent.source_path !== outcome.source_path || intent.destination_path !== outcome.destination_path || intent.state !== "completed" ||
    (outcome.kind === "create" && (intent.expected_sha256 !== null || intent.source_device !== null || intent.source_inode !== null)) ||
    (outcome.kind === "save" && (!intent.expected_sha256 || !/^[0-9a-f]{64}$/.test(intent.expected_sha256) ||
      !intent.source_device || !/^\d+$/.test(intent.source_device) || !intent.source_inode || !/^\d+$/.test(intent.source_inode))) ||
    !/^[0-9a-f]{64}$/.test(intent.input_digest) || !intent.stage_device || !/^\d+$/.test(intent.stage_device) ||
    !intent.stage_inode || !/^\d+$/.test(intent.stage_inode) || intent.stage_digest !== outcome.result_sha256) return null;
  return { requestId, workspaceId, kind: outcome.kind, path: outcome.result_path, version: outcome.result_sha256, createdAt: outcome.completed_at };
}

function nativeName(name: string) { return Buffer.from(`${name}\0`); }

function readBounded(fd: number, maximum: number) {
  const bytes = Buffer.alloc(maximum + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, length);
    if (count === 0) break;
    length += count;
  }
  if (length > maximum) throw new Error("file_too_large");
  return bytes.subarray(0, length);
}

function unlinkPathIfMatches(
  libcHandle: ReturnType<typeof dlopen<typeof nativeSymbols>>, parent: number, name: string, device: string, inode: string,
  openAt: (parentFd: number, name: string, flags: number, mode?: number) => number, close: (fd: number) => void,
) {
  const named = openAt(parent, name, inspectFlags);
  if (named < 0) return false;
  let matches = false;
  try {
    const current = fstatSync(named, { bigint: true });
    matches = String(current.dev) === device && String(current.ino) === inode;
  } finally { close(named); }
  return matches && libcHandle.symbols.unlinkat(parent, nativeName(name), 0) === 0;
}

function pathExists(parentFd: number, name: string, openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void) {
  const fd = openAt(parentFd, name, inspectFlags);
  if (fd < 0) return false;
  close(fd);
  return true;
}

function writeOnce(
  db: Database, folderFd: number, components: string[], bytes: Buffer, digest: string, requestId: string, workspaceId: string, userId: string,
  libcHandle: ReturnType<typeof dlopen<typeof nativeSymbols>>,
  openAt: (parentFd: number, name: string, flags: number, mode?: number) => number,
  close: (fd: number) => void,
  syncDirectory: (fd: number) => void,
  operation: WriteOperation,
): ReadResult<FileReceipt> {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
  if (parent < 0) throw new Error("parent_directory_not_found");
  const stage = `${stagePrefix}${requestId}`;
  const publishName = `${stage}-publish`;
  let stageFd = -1;
  try {
    if (operation.kind === "create" && pathExists(parent, components.at(-1)!, openAt, close)) throw new Error("target_exists");
    let stageStat: { dev: bigint; ino: bigint } = { dev: 0n, ino: 0n };
    db.transaction(() => {
      const workspace = db.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId);
      if (!workspace) throw new Error("foreign_workspace");
      if (workspace.archived) throw new Error("workspace_archived");
      if (operation.kind === "save") {
        const current = inspectSaveTarget(folderFd, components, openAt, close);
        if (current.status !== 200 || current.value.version !== operation.expectedVersion ||
          current.value.device !== operation.sourceDevice || current.value.inode !== operation.sourceInode || current.value.mode !== operation.mode) throw new Error("version_conflict");
      }
      stageFd = openAt(parent, stage, stageFlags, 0o600);
      if (stageFd < 0) throw new Error("stage_create_failed");
      let written = 0;
      while (written < bytes.length) written += writeSync(stageFd, bytes, written, bytes.length - written);
      fchmodSync(stageFd, operation.mode);
      fsyncSync(stageFd);
      stageStat = fstatSync(stageFd, { bigint: true });
      syncDirectory(parent);
      const prepared = db.query(`UPDATE file_operation_intents SET stage_device = ?, stage_inode = ?, stage_digest = ?, state = 'prepared'
        WHERE user_id = ? AND request_id = ? AND state = 'pending'`).run(String(stageStat.dev), String(stageStat.ino), digest, userId, requestId);
      if (prepared.changes !== 1) throw new Error("intent_state_unknown");
    }).immediate();
    syncDirectory(parent);
    const result = db.transaction(() => {
      const workspace = db.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId);
      if (!workspace) throw new Error("foreign_workspace");
      if (workspace.archived) throw new Error("workspace_archived");
      const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?").get(userId, requestId);
      const folderRequest = db.query<{ request_id: string; device: string; inode: string }, [string, string]>(`SELECT request_id, folder_device AS device, folder_inode AS inode
        FROM workspace_folder_requests WHERE user_id = ? AND workspace_id = ? AND state = 'provisioned'`).get(userId, workspaceId);
      const folderIdentity = statSync(`/proc/self/fd/${folderFd}`, { bigint: true });
      if (!folderRequest || String(folderIdentity.dev) !== folderRequest.device || String(folderIdentity.ino) !== folderRequest.inode) throw new Error("workspace_folder_unavailable");
      const markerFd = openAt(folderFd, markerName, fileFlags);
      if (markerFd < 0) throw new Error("workspace_marker_unavailable");
      try {
        const marker = statSync(`/proc/self/fd/${markerFd}`);
        if (!marker.isFile() || marker.uid !== process.getuid?.() || marker.gid !== process.getgid?.() || (marker.mode & 0o777) !== 0o600 ||
          readFileSync(`/proc/self/fd/${markerFd}`, "utf8") !== `${folderRequest.request_id}\n`) throw new Error("workspace_marker_invalid");
      } finally { close(markerFd); }
      const sourcePath = operation.kind === "create" ? "" : components.join("/");
      if (!intent || intent.state !== "prepared" || intent.kind !== operation.kind || intent.workspace_id !== workspaceId ||
        intent.source_path !== sourcePath || intent.destination_path !== components.join("/") || intent.expected_sha256 !== operation.expectedVersion ||
        intent.source_device !== operation.sourceDevice || intent.source_inode !== operation.sourceInode ||
        intent.input_digest !== fileInputDigest(operation.kind, workspaceId, components.join("/"), digest, operation.expectedVersion) ||
        intent.stage_device !== String(stageStat.dev) || intent.stage_inode !== String(stageStat.ino) || intent.stage_digest !== digest) throw new Error("stage_witness_mismatch");
      const targetName = components.at(-1)!;
      if (operation.kind === "create") {
        if (pathExists(parent, targetName, openAt, close)) throw new Error("target_exists");
      } else {
        const currentTarget = readSaveTarget(parent, targetName, openAt, close);
        if (currentTarget.status !== 200 || currentTarget.value.version !== operation.expectedVersion ||
          currentTarget.value.device !== operation.sourceDevice || currentTarget.value.inode !== operation.sourceInode || currentTarget.value.mode !== operation.mode) {
          throw new Error("version_conflict");
        }
      }
      const current = fstatSync(stageFd, { bigint: true });
      if (!current.isFile() || String(current.dev) !== intent.stage_device || String(current.ino) !== intent.stage_inode ||
        current.uid !== BigInt(process.getuid?.() ?? -1) || current.gid !== BigInt(process.getgid?.() ?? -1) || (current.mode & 0o777n) !== BigInt(operation.mode) ||
        current.size !== BigInt(bytes.length) || createHash("sha256").update(readBounded(stageFd, maxContentBytes)).digest("hex") !== intent.stage_digest) {
        throw new Error("stage_witness_mismatch");
      }
      if (operation.kind === "create") {
        if (libcHandle.symbols.linkat(-100, nativeName(`/proc/self/fd/${stageFd}`), parent, nativeName(targetName), atSymlinkFollow) !== 0) {
          throw new Error(pathExists(parent, targetName, openAt, close) ? "target_exists" : "file_publish_failed");
        }
      } else {
        if (libcHandle.symbols.linkat(-100, nativeName(`/proc/self/fd/${stageFd}`), parent, nativeName(publishName), atSymlinkFollow) !== 0) {
          throw new Error("file_publish_failed");
        }
        syncDirectory(parent);
        const recheckedTarget = readSaveTarget(parent, targetName, openAt, close);
        if (recheckedTarget.status !== 200 || recheckedTarget.value.version !== operation.expectedVersion ||
          recheckedTarget.value.device !== operation.sourceDevice || recheckedTarget.value.inode !== operation.sourceInode ||
          recheckedTarget.value.mode !== operation.mode) {
          if (unlinkPathIfMatches(libcHandle, parent, publishName, intent.stage_device, intent.stage_inode, openAt, close)) syncDirectory(parent);
          throw new Error("version_conflict");
        }
        if (libcHandle.symbols.renameat2(parent, nativeName(publishName), parent, nativeName(targetName), renameExchange) !== 0) {
          unlinkPathIfMatches(libcHandle, parent, publishName, intent.stage_device, intent.stage_inode, openAt, close);
          throw new Error("version_conflict");
        }
        const published = readSaveTarget(parent, targetName, openAt, close);
        const previous = readSaveTarget(parent, publishName, openAt, close);
        if (published.status !== 200 || published.value.device !== intent.stage_device || published.value.inode !== intent.stage_inode ||
          published.value.version !== digest || published.value.mode !== operation.mode || previous.status !== 200 ||
          previous.value.device !== operation.sourceDevice || previous.value.inode !== operation.sourceInode ||
          previous.value.version !== operation.expectedVersion || previous.value.mode !== operation.mode) throw new Error("file_publish_unknown");
      }
      syncDirectory(parent);
      const now = new Date().toISOString();
      const completed = db.query("UPDATE file_operation_intents SET state = 'completed' WHERE user_id = ? AND request_id = ? AND state = 'prepared'")
        .run(userId, requestId);
      if (completed.changes !== 1) throw new Error("intent_state_unknown");
      const outcome = db.query(`INSERT INTO file_operation_outcomes (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, requestId, operation.kind, workspaceId, sourcePath, components.join("/"), components.join("/"), digest, now);
      if (outcome.changes !== 1) throw new Error("outcome_write_unknown");
      return { requestId, workspaceId, kind: operation.kind, path: components.join("/"), version: digest, createdAt: now } satisfies FileReceipt;
    }).immediate();
    if (unlinkPathIfMatches(libcHandle, parent, stage, String(stageStat.dev), String(stageStat.ino), openAt, close)) syncDirectory(parent);
    if (operation.kind === "save" && unlinkPathIfMatches(libcHandle, parent, publishName, operation.sourceDevice, operation.sourceInode, openAt, close)) syncDirectory(parent);
    return { status: 201, body: result };
  } finally {
    if (stageFd >= 0) closeSync(stageFd);
    if (parent !== folderFd) close(parent);
  }
}

function recoverOnly(
  databasePath: string, db: Database, userId: string, workspaceId: string, requestId: string,
  libcHandle: ReturnType<typeof dlopen<typeof nativeSymbols>> | undefined,
): FileReceipt | null {
  if (!libcHandle || process.platform !== "linux") return null;
  return db.transaction(() => {
    const workspace = db.query<{ id: string }, [string, string]>("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
      .get(workspaceId, userId);
    const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
      .get(userId, requestId);
    if (!workspace || !intent || (intent.kind !== "create" && intent.kind !== "save") || intent.workspace_id !== workspaceId || intent.request_id !== requestId ||
      intent.state !== "prepared" || !/^[0-9a-f]{64}$/.test(intent.input_digest) || !intent.stage_device || !/^\d+$/.test(intent.stage_device) ||
      !intent.stage_inode || !/^\d+$/.test(intent.stage_inode) || !intent.stage_digest || !/^[0-9a-f]{64}$/.test(intent.stage_digest)) return null;
    if ((intent.kind === "create" && (intent.source_path !== "" || intent.expected_sha256 !== null || intent.source_device !== null || intent.source_inode !== null)) ||
      (intent.kind === "save" && (intent.source_path !== intent.destination_path || !intent.expected_sha256 || !/^[0-9a-f]{64}$/.test(intent.expected_sha256) ||
        !intent.source_device || !/^\d+$/.test(intent.source_device) || !intent.source_inode || !/^\d+$/.test(intent.source_inode)))) return null;
    const components = relativeComponents(intent.destination_path, true);
    if (!components || components.join("/") !== intent.destination_path ||
      fileInputDigest(intent.kind as "create" | "save", workspaceId, intent.destination_path, intent.stage_digest, intent.expected_sha256) !== intent.input_digest) return null;
    const witnessed = withProvisionedWorkspaceFolder(databasePath, userId, workspaceId, (folderFd, openAt, close) => {
      const folder = db.query<{ request_id: string; device: string; inode: string }, [string, string]>(`SELECT request_id, folder_device AS device, folder_inode AS inode
        FROM workspace_folder_requests WHERE user_id = ? AND workspace_id = ? AND state = 'provisioned'`).get(userId, workspaceId);
      const folderIdentity = statSync(`/proc/self/fd/${folderFd}`, { bigint: true });
      if (!folder || String(folderIdentity.dev) !== folder.device || String(folderIdentity.ino) !== folder.inode) return null;
      const currentIntent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
        .get(userId, requestId);
      if (!currentIntent || currentIntent.state !== "prepared" || currentIntent.kind !== intent.kind ||
        currentIntent.stage_device !== intent.stage_device || currentIntent.stage_inode !== intent.stage_inode || currentIntent.stage_digest !== intent.stage_digest ||
        currentIntent.destination_path !== intent.destination_path || currentIntent.expected_sha256 !== intent.expected_sha256 ||
        currentIntent.source_device !== intent.source_device || currentIntent.source_inode !== intent.source_inode) return null;
      const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
      if (parent < 0) return null;
      const target = openAt(parent, components.at(-1)!, fileFlags);
      try {
        if (target < 0) return null;
        const info = fstatSync(target, { bigint: true });
        const expectedMode = intent.kind === "create" ? 0o600n : null;
        if (!info.isFile() || String(info.dev) !== intent.stage_device || String(info.ino) !== intent.stage_inode ||
          info.uid !== BigInt(process.getuid?.() ?? -1) || info.gid !== BigInt(process.getgid?.() ?? -1) ||
          (expectedMode !== null && (info.mode & 0o777n) !== expectedMode) || info.size > BigInt(maxContentBytes)) return null;
        const bytes = readBounded(target, maxContentBytes);
        const afterRead = fstatSync(target, { bigint: true });
        if (BigInt(bytes.length) !== info.size || afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.size !== info.size ||
          afterRead.mode !== info.mode || createHash("sha256").update(bytes).digest("hex") !== intent.stage_digest) return null;
        if (intent.kind === "save") {
          const previous = readSaveTarget(parent, `${stagePrefix}${requestId}-publish`, openAt, close);
          if (previous.status !== 200 || previous.value.device !== intent.source_device || previous.value.inode !== intent.source_inode ||
            previous.value.version !== intent.expected_sha256 || BigInt(previous.value.mode) !== (info.mode & 0o777n)) return null;
        }
        fsyncSync(target);
        fsyncSync(parent);
        const now = new Date().toISOString();
        const changed = db.query("UPDATE file_operation_intents SET state = 'completed' WHERE user_id = ? AND request_id = ? AND state = 'prepared'")
          .run(userId, requestId);
        if (changed.changes !== 1) return null;
        const sourcePath = intent.kind === "create" ? "" : intent.destination_path;
        const outcome = db.query(`INSERT INTO file_operation_outcomes (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, requestId, intent.kind, workspaceId, sourcePath, components.join("/"), components.join("/"), intent.stage_digest, now);
        if (outcome.changes !== 1) throw new Error("outcome_write_unknown");
        return { requestId, workspaceId, kind: intent.kind as "create" | "save", path: components.join("/"), version: intent.stage_digest, createdAt: now } satisfies FileReceipt;
      } finally {
        if (target >= 0) close(target);
        if (parent !== folderFd) close(parent);
      }
    });
    if (witnessed.kind !== "opened") throw new Error("workspace_folder_unavailable");
    return witnessed.value;
  }).immediate();
}
