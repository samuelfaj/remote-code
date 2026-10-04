import { createHash } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, fstatSync, readFileSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
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
const renameNoReplace = 1;
const renameExchange = 2;
const libc = process.platform === "linux" ? dlopen("libc.so.6", nativeSymbols) : undefined;

type WorkspaceIdentity = { uid: number; gid: number };
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
type FileReceipt = { requestId: string; workspaceId: string; kind: "create" | "save"; path: string; version: string; createdAt: string } |
  { requestId: string; workspaceId: string; kind: "move"; sourcePath: string; path: string; version: string; createdAt: string };
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
  owner: WorkspaceIdentity,
): number {
  let current = folderFd;
  for (const component of components) {
    const next = openAt(current, component, directoryFlags);
    if (next < 0) {
      if (current !== folderFd) close(current);
      return -1;
    }
    const info = fstatSync(next);
    if (info.uid !== owner.uid || info.gid !== owner.gid) {
      close(next);
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
  owner: WorkspaceIdentity,
): ReadResult<FileContent> {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close, owner);
  if (parent < 0) return { status: 404, body: { error: "file_not_found" } };
  const fileFd = openAt(parent, components.at(-1)!, fileFlags);
  if (parent !== folderFd) close(parent);
  if (fileFd < 0) return { status: 404, body: { error: "file_not_found" } };
  try {
    const info = statSync(`/proc/self/fd/${fileFd}`);
    if (!info.isFile()) return { status: 415, body: { error: "unsupported_file_type" } };
    if (info.uid !== owner.uid || info.gid !== owner.gid) return { status: 409, body: { error: "file_unavailable" } };
    if (info.size > maxContentBytes) return { status: 413, body: { error: "file_too_large" } };
    const bytes = Buffer.alloc(maxContentBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fileFd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxContentBytes) return { status: 413, body: { error: "file_too_large" } };
    const afterRead = fstatSync(fileFd);
    if (afterRead.uid !== owner.uid || afterRead.gid !== owner.gid) return { status: 409, body: { error: "file_unavailable" } };
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
  owner: WorkspaceIdentity,
): ReadResult<DirectoryListing> {
  const directoryFd = openDirectoryPath(folderFd, components, openAt, close, owner);
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
        if (info.uid !== owner.uid || info.gid !== owner.gid) continue;
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
  // Session-bound ownership like the layout routes: every file call must
  // present a live session (user + token + expiry). Logout, expiry or
  // revocation stops reads and writes even with a valid workspace id.
  function liveUserId(request: Request): string | null {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return null;
    const db = new Database(databasePath, { readonly: true, create: false });
    try {
      const live = db.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(userId, tokenHash);
      if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return null;
      return userId;
    } catch { return null; }
    finally { db.close(); }
  }
  const routes = new Elysia().get("/api/workspaces/:workspaceId/files", ({ params, query, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const components = relativeComponents(query.path, false);
    if (components === null) { set.status = 400; return { error: "invalid_path" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
      (folderFd, openAt, close, owner) => listDirectory(folderFd, components, openAt, close, owner));
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
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const components = relativeComponents(query.path, true);
    if (!components) { set.status = 400; return { error: "invalid_path" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
      (folderFd, openAt, close, owner) => readContent(folderFd, components, openAt, close, owner));
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
    const userId = liveUserId(request);
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
      const preflight = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close, owner) => {
        const parent = openDirectoryPath(folderFd, path.slice(0, -1), openAt, close, owner);
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
      const created = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close, owner) => {
        try { return { kind: "created" as const, result: writeOnce(db!, folderFd, path, bytes, digest, id, params.workspaceId, userId, libc!, openAt, close, syncDirectory,
          { kind: "create", expectedVersion: null, sourceDevice: null, sourceInode: null, mode: 0o600 }, owner) }; }
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
    const userId = liveUserId(request);
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
        (folderFd, openAt, close, owner) => inspectSaveTarget(folderFd, path, openAt, close, owner));
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
          (folderFd, openAt, close, owner) => inspectSaveTarget(folderFd, path, openAt, close, owner));
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
      const saved = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close, owner) => {
        try { return { kind: "saved" as const, result: writeOnce(db!, folderFd, path, bytes, digest, id, params.workspaceId, userId, libc!, openAt, close, syncDirectory,
          { kind: "save", expectedVersion, sourceDevice: source.device, sourceInode: source.inode, mode: source.mode }, owner) }; }
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
  }).post("/api/workspaces/:workspaceId/files/move", ({ params, body, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const id = body.requestId.toLowerCase();
    const source = relativeComponents(body.sourcePath, true);
    const destination = relativeComponents(body.destinationPath, true);
    const expectedVersion = body.expectedVersion.toLowerCase();
    if (!canonicalUuid.test(id) || !source || !destination || source.join("/") === destination.join("/") ||
      !/^[0-9a-f]{64}$/.test(expectedVersion)) { set.status = 400; return { error: "invalid_file_request" as const }; }
    if (process.platform !== "linux" || !libc) { set.status = 501; return { error: "workspace_files_require_linux" as const }; }
    const sourcePath = source.join("/");
    const destinationPath = destination.join("/");
    const inputDigest = fileInputDigest("move", params.workspaceId, destinationPath, expectedVersion, expectedVersion, sourcePath);
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
        if (outcome.kind !== "move") { set.status = 409; return { error: "request_id_conflict" as const }; }
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
        if (existing.kind !== "move" || existing.workspace_id !== params.workspaceId || existing.source_path !== sourcePath ||
          existing.destination_path !== destinationPath || existing.expected_sha256 !== expectedVersion || existing.input_digest !== inputDigest) {
          set.status = 409; return { error: "request_id_conflict" as const };
        }
        const recovered = recoverOnly(databasePath, db, userId, params.workspaceId, id, libc);
        if (recovered) { set.status = 200; return recovered; }
        set.status = 503; return { error: "outcome_unknown" as const };
      }
      const preflight = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
        (folderFd, openAt, close, owner) => inspectMovePaths(folderFd, source, destination, openAt, close, owner));
      if (preflight.kind !== "opened") {
        set.status = preflight.kind === "not_found" ? 404 : 503;
        return { error: "workspace_folder_unavailable" as const };
      }
      if (preflight.value.status !== 200) { set.status = preflight.value.status; return { error: preflight.value.error } as const; }
      if (preflight.value.value.version !== expectedVersion) {
        set.status = 409; return { error: "version_conflict" as const, currentVersion: preflight.value.value.version };
      }
      const sourceWitness = preflight.value.value;
      const accepted = db.transaction(() => {
        const current = db!.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?")
          .get(params.workspaceId, userId);
        if (!current) return "foreign_workspace";
        if (current.archived) return "workspace_archived";
        const checked = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
          (folderFd, openAt, close, owner) => inspectMovePaths(folderFd, source, destination, openAt, close, owner));
        if (checked.kind !== "opened" || checked.value.status !== 200) return "workspace_folder_unavailable";
        if (checked.value.value.version !== expectedVersion || checked.value.value.device !== sourceWitness.device ||
          checked.value.value.inode !== sourceWitness.inode) return "version_conflict";
        db!.query(`INSERT INTO file_operation_intents
          (user_id, request_id, kind, workspace_id, source_path, destination_path, expected_sha256, input_digest, source_device, source_inode, state)
          VALUES (?, ?, 'move', ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(userId, id, params.workspaceId, sourcePath, destinationPath, expectedVersion, inputDigest, sourceWitness.device, sourceWitness.inode);
        return "accepted";
      }).immediate();
      if (accepted !== "accepted") {
        set.status = accepted === "foreign_workspace" ? 404 : accepted === "workspace_archived" || accepted === "version_conflict" ? 409 : 503;
        return { error: accepted === "version_conflict" ? "version_conflict" : accepted } as const;
      }
      const moved = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close, owner) => {
        try { return { kind: "moved" as const, result: moveOnce(db!, folderFd, source, destination, sourceWitness, expectedVersion, id,
          params.workspaceId, userId, libc!, openAt, close, owner) }; }
        catch (error) { return { kind: "error" as const, error }; }
      });
      if (moved.kind !== "opened") throw new Error(moved.kind === "not_found" ? "foreign_workspace" : "workspace_unavailable");
      if (moved.value.kind === "error") throw moved.value.error;
      set.status = moved.value.result.status;
      return moved.value.result.body;
    } catch (error) {
      set.status = errorStatus(error);
      if (error instanceof Error && error.message === "version_conflict") return { error: "version_conflict" as const };
      return { error: "file_operation_unavailable" as const };
    } finally { db?.close(); }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ requestId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }), sourcePath: t.String({ minLength: 1, maxLength: 4096 }),
      destinationPath: t.String({ minLength: 1, maxLength: 4096 }), expectedVersion: t.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-fA-F]{64}$" }) }),
  }).get("/api/workspaces/:workspaceId/files/receipts/:requestId", ({ params, request, set }) => {
    const userId = liveUserId(request);
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
      if ((intent.kind !== "create" && intent.kind !== "save" && intent.kind !== "move") || intent.workspace_id !== params.workspaceId) { set.status = 404; return { error: "receipt_not_found" as const }; }
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

function fileInputDigest(kind: "create" | "save" | "move", workspaceId: string, path: string, resultDigest: string, expectedVersion: string | null, sourcePath?: string) {
  const input = kind === "create" ? [workspaceId, path, resultDigest] : kind === "save" ?
    [kind, workspaceId, path, expectedVersion, resultDigest] : [kind, workspaceId, sourcePath, path, expectedVersion];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

type SaveTargetResult = { status: 200; value: SaveTarget } | { status: 404 | 409 | 413 | 415; error: string };
function inspectSaveTarget(
  folderFd: number, components: string[], openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void, owner: WorkspaceIdentity,
): SaveTargetResult {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close, owner);
  if (parent < 0) return { status: 404, error: "parent_directory_not_found" };
  try { return readSaveTarget(parent, components.at(-1)!, openAt, close, owner); }
  finally { if (parent !== folderFd) close(parent); }
}

function readOpenFile(fd: number, owner: WorkspaceIdentity): SaveTargetResult {
  const info = fstatSync(fd, { bigint: true });
  if (!info.isFile()) return { status: 415, error: "unsupported_file_type" };
  if (info.uid !== BigInt(owner.uid) || info.gid !== BigInt(owner.gid)) return { status: 409, error: "file_unavailable" };
  if (info.size > BigInt(maxContentBytes)) return { status: 413, error: "file_too_large" };
  const bytes = readBounded(fd, maxContentBytes);
  const afterRead = fstatSync(fd, { bigint: true });
  if (BigInt(bytes.length) !== info.size || afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.size !== info.size || afterRead.mode !== info.mode || afterRead.uid !== info.uid || afterRead.gid !== info.gid) {
    return { status: 409, error: "file_changed" };
  }
  if (bytes.includes(0)) return { status: 415, error: "unsupported_file_type" };
  try { utf8.decode(bytes); } catch { return { status: 415, error: "unsupported_text_encoding" }; }
  return { status: 200, value: { device: String(info.dev), inode: String(info.ino), mode: Number(info.mode & 0o777n), version: createHash("sha256").update(bytes).digest("hex") } };
}

function readSaveTarget(
  parent: number, name: string, openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void, owner: WorkspaceIdentity,
): SaveTargetResult {
  const fd = openAt(parent, name, fileFlags);
  if (fd < 0) return { status: 404, error: "file_not_found" };
  try { return readOpenFile(fd, owner); }
  finally { close(fd); }
}

function inspectMovePaths(
  folderFd: number, source: string[], destination: string[],
  openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void, owner: WorkspaceIdentity,
): SaveTargetResult {
  const sourceParent = openDirectoryPath(folderFd, source.slice(0, -1), openAt, close, owner);
  if (sourceParent < 0) return { status: 404, error: "source_parent_not_found" };
  let destinationParent = -1;
  try {
    const sourceFd = openAt(sourceParent, source.at(-1)!, fileFlags);
    if (sourceFd < 0) return { status: 404, error: "file_not_found" };
    let sourceResult: SaveTargetResult;
    try { sourceResult = readOpenFile(sourceFd, owner); }
    finally { close(sourceFd); }
    if (sourceResult.status !== 200) return sourceResult;
    destinationParent = openDirectoryPath(folderFd, destination.slice(0, -1), openAt, close, owner);
    if (destinationParent < 0) return { status: 404, error: "destination_parent_not_found" };
    if (pathExists(destinationParent, destination.at(-1)!, openAt, close)) return { status: 409, error: "target_exists" };
    return sourceResult;
  } finally {
    if (destinationParent >= 0 && destinationParent !== folderFd) close(destinationParent);
    if (sourceParent !== folderFd) close(sourceParent);
  }
}

function validatedReceipt(db: Database, userId: string, workspaceId: string, requestId: string, outcome: FileOutcomeRow): FileReceipt | null {
  const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
    .get(userId, requestId);
  const path = relativeComponents(outcome.destination_path, true);
  const source = outcome.kind === "move" ? relativeComponents(outcome.source_path, true) : null;
  const timestamp = new Date(outcome.completed_at);
  if (!intent || outcome.user_id !== userId || outcome.request_id !== requestId ||
    (outcome.kind !== "create" && outcome.kind !== "save" && outcome.kind !== "move") ||
    outcome.workspace_id !== workspaceId || !canonicalUuid.test(outcome.workspace_id) ||
    outcome.source_path !== (outcome.kind === "create" ? "" : outcome.kind === "save" ? outcome.destination_path : source?.join("/")) ||
    (outcome.kind === "move" && (!source || source.join("/") !== outcome.source_path || outcome.source_path === outcome.destination_path)) ||
    !path || path.join("/") !== outcome.destination_path || outcome.result_path !== outcome.destination_path || !/^[0-9a-f]{64}$/.test(outcome.result_sha256) ||
    fileInputDigest(outcome.kind, workspaceId, outcome.destination_path, outcome.result_sha256,
      outcome.kind === "create" ? null : intent.expected_sha256, outcome.kind === "move" ? outcome.source_path : undefined) !== intent.input_digest ||
    !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== outcome.completed_at ||
    intent.user_id !== userId || intent.request_id !== requestId || intent.kind !== outcome.kind || intent.workspace_id !== workspaceId ||
    intent.source_path !== outcome.source_path || intent.destination_path !== outcome.destination_path || intent.state !== "completed" ||
    (outcome.kind === "create" && (intent.expected_sha256 !== null || intent.source_device !== null || intent.source_inode !== null)) ||
    ((outcome.kind === "save" || outcome.kind === "move") && (!intent.expected_sha256 || !/^[0-9a-f]{64}$/.test(intent.expected_sha256) ||
      !intent.source_device || !/^\d+$/.test(intent.source_device) || !intent.source_inode || !/^\d+$/.test(intent.source_inode))) ||
    !/^[0-9a-f]{64}$/.test(intent.input_digest)) return null;
  if (outcome.kind === "move") {
    if (outcome.result_sha256 !== intent.expected_sha256 || intent.stage_device !== null || intent.stage_inode !== null || intent.stage_digest !== null) return null;
    return { requestId, workspaceId, kind: "move", sourcePath: outcome.source_path, path: outcome.result_path, version: outcome.result_sha256, createdAt: outcome.completed_at };
  }
  if (!intent.stage_device || !/^\d+$/.test(intent.stage_device) || !intent.stage_inode || !/^\d+$/.test(intent.stage_inode) ||
    intent.stage_digest !== outcome.result_sha256) return null;
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
  owner: WorkspaceIdentity,
): ReadResult<FileReceipt> {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close, owner);
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
        const current = inspectSaveTarget(folderFd, components, openAt, close, owner);
        if (current.status !== 200 || current.value.version !== operation.expectedVersion ||
          current.value.device !== operation.sourceDevice || current.value.inode !== operation.sourceInode || current.value.mode !== operation.mode) throw new Error("version_conflict");
      }
      stageFd = openAt(parent, stage, stageFlags, 0o600);
      if (stageFd < 0) throw new Error("stage_create_failed");
      const initial = fstatSync(stageFd);
      if (!initial.isFile() || initial.nlink !== 1 || initial.uid !== process.getuid?.() || initial.gid !== process.getgid?.()) {
        throw new Error("stage_witness_mismatch");
      }
      if (initial.uid !== owner.uid || initial.gid !== owner.gid) fchownSync(stageFd, owner.uid, owner.gid);
      const owned = fstatSync(stageFd);
      if (owned.uid !== owner.uid || owned.gid !== owner.gid) throw new Error("stage_witness_mismatch");
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
      if (!folderRequest || !folderIdentity.isDirectory() || folderIdentity.uid !== BigInt(owner.uid) || folderIdentity.gid !== BigInt(owner.gid) ||
        (folderIdentity.mode & 0o777n) !== 0o700n || String(folderIdentity.dev) !== folderRequest.device || String(folderIdentity.ino) !== folderRequest.inode) throw new Error("workspace_folder_unavailable");
      const markerFd = openAt(folderFd, markerName, fileFlags);
      if (markerFd < 0) throw new Error("workspace_marker_unavailable");
      try {
        const marker = statSync(`/proc/self/fd/${markerFd}`);
        if (!marker.isFile() || BigInt(marker.dev) !== folderIdentity.dev || marker.nlink !== 1 || marker.size !== 37 || marker.uid !== owner.uid || marker.gid !== owner.gid || (marker.mode & 0o777) !== 0o600 ||
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
        const currentTarget = readSaveTarget(parent, targetName, openAt, close, owner);
        if (currentTarget.status !== 200 || currentTarget.value.version !== operation.expectedVersion ||
          currentTarget.value.device !== operation.sourceDevice || currentTarget.value.inode !== operation.sourceInode || currentTarget.value.mode !== operation.mode) {
          throw new Error("version_conflict");
        }
      }
      const current = fstatSync(stageFd, { bigint: true });
      if (!current.isFile() || String(current.dev) !== intent.stage_device || String(current.ino) !== intent.stage_inode ||
        current.uid !== BigInt(owner.uid) || current.gid !== BigInt(owner.gid) || (current.mode & 0o777n) !== BigInt(operation.mode) ||
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
        const recheckedTarget = readSaveTarget(parent, targetName, openAt, close, owner);
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
        const published = readSaveTarget(parent, targetName, openAt, close, owner);
        const previous = readSaveTarget(parent, publishName, openAt, close, owner);
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

function moveOnce(
  db: Database, folderFd: number, source: string[], destination: string[], witness: SaveTarget, expectedVersion: string,
  requestId: string, workspaceId: string, userId: string, libcHandle: ReturnType<typeof dlopen<typeof nativeSymbols>>,
  openAt: (parentFd: number, name: string, flags: number, mode?: number) => number, close: (fd: number) => void,
  owner: WorkspaceIdentity,
): ReadResult<FileReceipt> {
  const sourceParent = openDirectoryPath(folderFd, source.slice(0, -1), openAt, close, owner);
  if (sourceParent < 0) throw new Error("parent_directory_not_found");
  const destinationParent = openDirectoryPath(folderFd, destination.slice(0, -1), openAt, close, owner);
  if (destinationParent < 0) { if (sourceParent !== folderFd) close(sourceParent); throw new Error("parent_directory_not_found"); }
  const sourceName = source.at(-1)!;
  const destinationName = destination.at(-1)!;
  const sourcePath = source.join("/");
  const destinationPath = destination.join("/");
  const inputDigest = fileInputDigest("move", workspaceId, destinationPath, expectedVersion, expectedVersion, sourcePath);
  let sourceFd = -1;
  try {
    db.transaction(() => {
      const workspace = db.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId);
      if (!workspace) throw new Error("foreign_workspace");
      if (workspace.archived) throw new Error("workspace_archived");
      const current = inspectMovePaths(folderFd, source, destination, openAt, close, owner);
      if (current.status !== 200 || current.value.version !== expectedVersion || current.value.device !== witness.device ||
        current.value.inode !== witness.inode || current.value.mode !== witness.mode) throw new Error("version_conflict");
      const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?").get(userId, requestId);
      if (!intent || intent.kind !== "move" || intent.workspace_id !== workspaceId || intent.state !== "pending" ||
        intent.source_path !== sourcePath || intent.destination_path !== destinationPath || intent.expected_sha256 !== expectedVersion ||
        intent.source_device !== witness.device || intent.source_inode !== witness.inode || intent.input_digest !== inputDigest) throw new Error("intent_state_unknown");
      sourceFd = openAt(sourceParent, sourceName, fileFlags);
      if (sourceFd < 0) throw new Error("version_conflict");
      const opened = readOpenFile(sourceFd, owner);
      if (opened.status !== 200 || opened.value.version !== expectedVersion || opened.value.device !== witness.device ||
        opened.value.inode !== witness.inode || opened.value.mode !== witness.mode) throw new Error("version_conflict");
      const prepared = db.query("UPDATE file_operation_intents SET state = 'prepared' WHERE user_id = ? AND request_id = ? AND state = 'pending'")
        .run(userId, requestId);
      if (prepared.changes !== 1) throw new Error("intent_state_unknown");
    }).immediate();
    const result = db.transaction(() => {
      const workspace = db.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId);
      if (!workspace) throw new Error("foreign_workspace");
      if (workspace.archived) throw new Error("workspace_archived");
      const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?").get(userId, requestId);
      const folderRequest = db.query<{ request_id: string; device: string; inode: string }, [string, string]>(`SELECT request_id, folder_device AS device, folder_inode AS inode
        FROM workspace_folder_requests WHERE user_id = ? AND workspace_id = ? AND state = 'provisioned'`).get(userId, workspaceId);
      const folderIdentity = statSync(`/proc/self/fd/${folderFd}`, { bigint: true });
      if (!folderRequest || !folderIdentity.isDirectory() || folderIdentity.uid !== BigInt(owner.uid) || folderIdentity.gid !== BigInt(owner.gid) ||
        (folderIdentity.mode & 0o777n) !== 0o700n || String(folderIdentity.dev) !== folderRequest.device || String(folderIdentity.ino) !== folderRequest.inode) throw new Error("workspace_folder_unavailable");
      const markerFd = openAt(folderFd, markerName, fileFlags);
      if (markerFd < 0) throw new Error("workspace_marker_unavailable");
      try {
        const marker = statSync(`/proc/self/fd/${markerFd}`);
        if (!marker.isFile() || BigInt(marker.dev) !== folderIdentity.dev || marker.nlink !== 1 || marker.size !== 37 || marker.uid !== owner.uid || marker.gid !== owner.gid || (marker.mode & 0o777) !== 0o600 ||
          readFileSync(`/proc/self/fd/${markerFd}`, "utf8") !== `${folderRequest.request_id}\n`) throw new Error("workspace_marker_invalid");
      } finally { close(markerFd); }
      if (!intent || intent.kind !== "move" || intent.workspace_id !== workspaceId || intent.state !== "prepared" ||
        intent.source_path !== sourcePath || intent.destination_path !== destinationPath || intent.expected_sha256 !== expectedVersion ||
        intent.source_device !== witness.device || intent.source_inode !== witness.inode || intent.input_digest !== inputDigest ||
        intent.stage_device !== null || intent.stage_inode !== null || intent.stage_digest !== null) throw new Error("intent_state_unknown");
      fsyncSync(sourceFd);
      const held = readOpenFile(sourceFd, owner);
      if (held.status !== 200 || held.value.version !== expectedVersion || held.value.device !== witness.device ||
        held.value.inode !== witness.inode || held.value.mode !== witness.mode) throw new Error("version_conflict");
      const namedFd = openAt(sourceParent, sourceName, fileFlags);
      if (namedFd < 0) throw new Error("version_conflict");
      try {
        const named = readOpenFile(namedFd, owner);
        if (named.status !== 200 || named.value.version !== expectedVersion || named.value.device !== witness.device ||
          named.value.inode !== witness.inode || named.value.mode !== witness.mode) throw new Error("version_conflict");
      } finally { close(namedFd); }
      if (pathExists(destinationParent, destinationName, openAt, close)) throw new Error("target_exists");
      if (libcHandle.symbols.renameat2(sourceParent, nativeName(sourceName), destinationParent, nativeName(destinationName), renameNoReplace) !== 0) {
        throw new Error(pathExists(destinationParent, destinationName, openAt, close) ? "target_exists" : "move_failed");
      }
      if (pathExists(sourceParent, sourceName, openAt, close)) throw new Error("move_witness_unknown");
      const destinationFd = openAt(destinationParent, destinationName, fileFlags);
      if (destinationFd < 0) throw new Error("move_witness_unknown");
      try {
        const moved = readOpenFile(destinationFd, owner);
        if (moved.status !== 200 || moved.value.device !== witness.device || moved.value.inode !== witness.inode ||
          moved.value.version !== expectedVersion || moved.value.mode !== witness.mode) throw new Error("move_witness_unknown");
        fsyncSync(destinationFd);
      } finally { close(destinationFd); }
      fsyncSync(sourceParent);
      if (source.slice(0, -1).join("/") !== destination.slice(0, -1).join("/")) fsyncSync(destinationParent);
      const completed = db.query("UPDATE file_operation_intents SET state = 'completed' WHERE user_id = ? AND request_id = ? AND state = 'prepared'")
        .run(userId, requestId);
      if (completed.changes !== 1) throw new Error("intent_state_unknown");
      const now = new Date().toISOString();
      const outcome = db.query(`INSERT INTO file_operation_outcomes (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
        VALUES (?, ?, 'move', ?, ?, ?, ?, ?, ?)`).run(userId, requestId, workspaceId, sourcePath, destinationPath, destinationPath, expectedVersion, now);
      if (outcome.changes !== 1) throw new Error("outcome_write_unknown");
      return { requestId, workspaceId, kind: "move" as const, sourcePath, path: destinationPath, version: expectedVersion, createdAt: now };
    }).immediate();
    return { status: 201, body: result };
  } finally {
    if (sourceFd >= 0) close(sourceFd);
    if (sourceParent !== folderFd) close(sourceParent);
    if (destinationParent !== folderFd) close(destinationParent);
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
    if (!workspace || !intent || (intent.kind !== "create" && intent.kind !== "save" && intent.kind !== "move") || intent.workspace_id !== workspaceId || intent.request_id !== requestId ||
      intent.state !== "prepared" || !/^[0-9a-f]{64}$/.test(intent.input_digest) ||
      (intent.kind !== "move" && (!intent.stage_device || !/^\d+$/.test(intent.stage_device) || !intent.stage_inode || !/^\d+$/.test(intent.stage_inode) ||
        !intent.stage_digest || !/^[0-9a-f]{64}$/.test(intent.stage_digest)))) return null;
    if ((intent.kind === "create" && (intent.source_path !== "" || intent.expected_sha256 !== null || intent.source_device !== null || intent.source_inode !== null)) ||
      (intent.kind === "save" && (intent.source_path !== intent.destination_path || !intent.expected_sha256 || !/^[0-9a-f]{64}$/.test(intent.expected_sha256) ||
        !intent.source_device || !/^\d+$/.test(intent.source_device) || !intent.source_inode || !/^\d+$/.test(intent.source_inode))) ||
      (intent.kind === "move" && (!intent.source_path || intent.source_path === intent.destination_path || !intent.expected_sha256 ||
        !/^[0-9a-f]{64}$/.test(intent.expected_sha256) || !intent.source_device || !/^\d+$/.test(intent.source_device) ||
        !intent.source_inode || !/^\d+$/.test(intent.source_inode) || intent.stage_device !== null || intent.stage_inode !== null || intent.stage_digest !== null))) return null;
    const components = relativeComponents(intent.destination_path, true);
    const sourceComponents = intent.kind === "move" ? relativeComponents(intent.source_path, true) : null;
    if (!components || components.join("/") !== intent.destination_path ||
      (intent.kind === "move" && (!sourceComponents || sourceComponents.join("/") !== intent.source_path)) ||
      fileInputDigest(intent.kind, workspaceId, intent.destination_path, intent.stage_digest ?? intent.expected_sha256 ?? "", intent.expected_sha256,
        intent.kind === "move" ? intent.source_path : undefined) !== intent.input_digest) return null;
    const witnessed = withProvisionedWorkspaceFolder(databasePath, userId, workspaceId, (folderFd, openAt, close, owner) => {
      const folder = db.query<{ request_id: string; device: string; inode: string }, [string, string]>(`SELECT request_id, folder_device AS device, folder_inode AS inode
        FROM workspace_folder_requests WHERE user_id = ? AND workspace_id = ? AND state = 'provisioned'`).get(userId, workspaceId);
      const folderIdentity = statSync(`/proc/self/fd/${folderFd}`, { bigint: true });
      if (!folder || !folderIdentity.isDirectory() || folderIdentity.uid !== BigInt(owner.uid) || folderIdentity.gid !== BigInt(owner.gid) ||
        (folderIdentity.mode & 0o777n) !== 0o700n || String(folderIdentity.dev) !== folder.device || String(folderIdentity.ino) !== folder.inode) return null;
      const currentIntent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
        .get(userId, requestId);
      if (!currentIntent || currentIntent.state !== "prepared" || currentIntent.kind !== intent.kind ||
        currentIntent.stage_device !== intent.stage_device || currentIntent.stage_inode !== intent.stage_inode || currentIntent.stage_digest !== intent.stage_digest ||
        currentIntent.source_path !== intent.source_path || currentIntent.destination_path !== intent.destination_path || currentIntent.expected_sha256 !== intent.expected_sha256 ||
        currentIntent.source_device !== intent.source_device || currentIntent.source_inode !== intent.source_inode) return null;
      const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close, owner);
      if (parent < 0) return null;
      let sourceParent = -1;
      let target = -1;
      try {
        if (intent.kind === "move") {
          sourceParent = openDirectoryPath(folderFd, sourceComponents!.slice(0, -1), openAt, close, owner);
          if (sourceParent < 0 || pathExists(sourceParent, sourceComponents!.at(-1)!, openAt, close)) return null;
        }
        target = openAt(parent, components.at(-1)!, fileFlags);
        if (target < 0) return null;
        const info = fstatSync(target, { bigint: true });
        const witnessDevice = intent.kind === "move" ? intent.source_device : intent.stage_device;
        const witnessInode = intent.kind === "move" ? intent.source_inode : intent.stage_inode;
        const expectedDigest = intent.kind === "move" ? intent.expected_sha256 : intent.stage_digest;
        const expectedMode = intent.kind === "create" ? 0o600n : null;
        if (!witnessDevice || !witnessInode || !expectedDigest || !info.isFile() || String(info.dev) !== witnessDevice ||
          String(info.ino) !== witnessInode || info.uid !== BigInt(owner.uid) || info.gid !== BigInt(owner.gid) ||
          (expectedMode !== null && (info.mode & 0o777n) !== expectedMode) || info.size > BigInt(maxContentBytes)) return null;
        const bytes = readBounded(target, maxContentBytes);
        const afterRead = fstatSync(target, { bigint: true });
        if (BigInt(bytes.length) !== info.size || afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.size !== info.size ||
          afterRead.mode !== info.mode || afterRead.uid !== info.uid || afterRead.gid !== info.gid || createHash("sha256").update(bytes).digest("hex") !== expectedDigest) return null;
        if (intent.kind === "save") {
          const previous = readSaveTarget(parent, `${stagePrefix}${requestId}-publish`, openAt, close, owner);
          if (previous.status !== 200 || previous.value.device !== intent.source_device || previous.value.inode !== intent.source_inode ||
            previous.value.version !== intent.expected_sha256 || BigInt(previous.value.mode) !== (info.mode & 0o777n)) return null;
        }
        if (intent.kind === "move" && pathExists(sourceParent, sourceComponents!.at(-1)!, openAt, close)) return null;
        fsyncSync(target);
        fsyncSync(parent);
        if (intent.kind === "move" && sourceComponents!.slice(0, -1).join("/") !== components.slice(0, -1).join("/")) fsyncSync(sourceParent);
        const now = new Date().toISOString();
        const changed = db.query("UPDATE file_operation_intents SET state = 'completed' WHERE user_id = ? AND request_id = ? AND state = 'prepared'")
          .run(userId, requestId);
        if (changed.changes !== 1) return null;
        const sourcePath = intent.kind === "create" ? "" : intent.kind === "save" ? intent.destination_path : intent.source_path;
        const outcome = db.query(`INSERT INTO file_operation_outcomes (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, requestId, intent.kind, workspaceId, sourcePath, components.join("/"), components.join("/"), expectedDigest, now);
        if (outcome.changes !== 1) throw new Error("outcome_write_unknown");
        if (intent.kind === "move") return { requestId, workspaceId, kind: "move" as const, sourcePath, path: components.join("/"), version: expectedDigest, createdAt: now };
        return { requestId, workspaceId, kind: intent.kind, path: components.join("/"), version: expectedDigest, createdAt: now } satisfies FileReceipt;
      } finally {
        if (target >= 0) close(target);
        if (sourceParent >= 0 && sourceParent !== folderFd) close(sourceParent);
        if (parent !== folderFd) close(parent);
      }
    });
    if (witnessed.kind !== "opened") throw new Error("workspace_folder_unavailable");
    return witnessed.value;
  }).immediate();
}
