import { createHash } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { closeSync, constants, fsyncSync, fstatSync, readFileSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
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
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;
const atSymlinkFollow = 0x400;
const libc = process.platform === "linux" ? dlopen("libc.so.6", nativeSymbols) : undefined;

type Entry = { name: string; type: "file" | "directory"; size: number };
type FileContent = { path: string; content: string; version: string };
type DirectoryListing = { path: string; entries: Entry[] };
type ReadResult<T> = { status: number; body: T | { error: string } };
type FileIntentRow = {
  user_id: string; request_id: string; kind: string; workspace_id: string; source_path: string; destination_path: string;
  expected_sha256: string | null; input_digest: string; source_device: string | null; source_inode: string | null;
  stage_device: string | null; stage_inode: string | null; stage_digest: string | null; state: string;
};
type FileOutcomeRow = {
  user_id: string; request_id: string; kind: string; workspace_id: string; source_path: string; destination_path: string;
  result_path: string; result_sha256: string; completed_at: string;
};
type FileReceipt = { requestId: string; workspaceId: string; kind: "create"; path: string; version: string; createdAt: string };

function relativeComponents(path: string | undefined, required: boolean): string[] | null {
  if (path === undefined) return required ? null : [];
  if (path.length === 0 || path.includes("\0") || path.startsWith("/")) return null;
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
    const inputDigest = createHash("sha256").update(JSON.stringify([params.workspaceId, path.join("/"), digest])).digest("hex");
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
        try { return { kind: "created" as const, result: createOnce(db!, folderFd, path, bytes, digest, id, params.workspaceId, userId, libc!, openAt, close, syncDirectory) }; }
        catch (error) { return { kind: "error" as const, error }; }
      });
      if (created.kind !== "opened") throw new Error(created.kind === "not_found" ? "foreign_workspace" : "workspace_unavailable");
      if (created.value.kind === "error") throw created.value.error;
      set.status = created.value.result.status;
      return created.value.result.body;
    } catch (error) {
      set.status = errorStatus(error);
      return { error: "file_operation_unavailable" as const };
    } finally { db?.close(); }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ requestId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }), path: t.String({ minLength: 1, maxLength: 4096 }), content: t.String() }),
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
      if (intent.kind !== "create" || intent.workspace_id !== params.workspaceId) { set.status = 404; return { error: "receipt_not_found" as const }; }
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

function validatedReceipt(db: Database, userId: string, workspaceId: string, requestId: string, outcome: FileOutcomeRow): FileReceipt | null {
  const intent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
    .get(userId, requestId);
  const path = relativeComponents(outcome.destination_path, true);
  const timestamp = new Date(outcome.completed_at);
  if (!intent || outcome.user_id !== userId || outcome.request_id !== requestId || outcome.kind !== "create" ||
    outcome.workspace_id !== workspaceId || !canonicalUuid.test(outcome.workspace_id) || outcome.source_path !== "" || !path || path.join("/") !== outcome.destination_path ||
    outcome.result_path !== outcome.destination_path || !/^[0-9a-f]{64}$/.test(outcome.result_sha256) ||
    createHash("sha256").update(JSON.stringify([workspaceId, outcome.destination_path, outcome.result_sha256])).digest("hex") !== intent?.input_digest ||
    !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== outcome.completed_at ||
    intent.user_id !== userId || intent.request_id !== requestId || intent.kind !== "create" || intent.workspace_id !== workspaceId ||
    intent.source_path !== "" || intent.destination_path !== outcome.destination_path || intent.state !== "completed" ||
    intent.expected_sha256 !== null || !/^[0-9a-f]{64}$/.test(intent.input_digest) ||
    !intent.stage_device || !/^\d+$/.test(intent.stage_device) || !intent.stage_inode || !/^\d+$/.test(intent.stage_inode) ||
    intent.stage_digest !== outcome.result_sha256 || intent.source_device !== null || intent.source_inode !== null) return null;
  return { requestId, workspaceId, kind: "create", path: outcome.result_path, version: outcome.result_sha256, createdAt: outcome.completed_at };
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

function unlinkStageIfMatching(
  libcHandle: ReturnType<typeof dlopen<typeof nativeSymbols>>, parent: number, stage: string, stageFd: number,
  openAt: (parentFd: number, name: string, flags: number, mode?: number) => number, close: (fd: number) => void,
) {
  const original = fstatSync(stageFd, { bigint: true });
  const named = openAt(parent, stage, inspectFlags);
  if (named < 0) return false;
  let matches = false;
  try {
    const current = fstatSync(named, { bigint: true });
    matches = current.dev === original.dev && current.ino === original.ino;
  } finally { close(named); }
  return matches && libcHandle.symbols.unlinkat(parent, nativeName(stage), 0) === 0;
}

function pathExists(parentFd: number, name: string, openAt: (parentFd: number, name: string, flags: number) => number, close: (fd: number) => void) {
  const fd = openAt(parentFd, name, inspectFlags);
  if (fd < 0) return false;
  close(fd);
  return true;
}

function createOnce(
  db: Database, folderFd: number, components: string[], bytes: Buffer, digest: string, requestId: string, workspaceId: string, userId: string,
  libcHandle: ReturnType<typeof dlopen<typeof nativeSymbols>>,
  openAt: (parentFd: number, name: string, flags: number, mode?: number) => number,
  close: (fd: number) => void,
  syncDirectory: (fd: number) => void,
): ReadResult<FileReceipt> {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
  if (parent < 0) throw new Error("parent_directory_not_found");
  const stage = `${stagePrefix}${requestId}`;
  let stageFd = -1;
  try {
    if (pathExists(parent, components.at(-1)!, openAt, close)) throw new Error("target_exists");
    let stageStat: { dev: bigint; ino: bigint };
    db.transaction(() => {
      const workspace = db.query<{ archived: number }, [string, string]>("SELECT archived FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId);
      if (!workspace) throw new Error("foreign_workspace");
      if (workspace.archived) throw new Error("workspace_archived");
      stageFd = openAt(parent, stage, stageFlags, 0o600);
      if (stageFd < 0) throw new Error("stage_create_failed");
      let written = 0;
      while (written < bytes.length) written += writeSync(stageFd, bytes, written, bytes.length - written);
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
      if (!intent || intent.state !== "prepared" || intent.kind !== "create" || intent.workspace_id !== workspaceId ||
        intent.source_path !== "" || intent.destination_path !== components.join("/") || intent.expected_sha256 !== null ||
        intent.source_device !== null || intent.source_inode !== null ||
        intent.input_digest !== createHash("sha256").update(JSON.stringify([workspaceId, components.join("/"), digest])).digest("hex") ||
        intent.stage_device !== String(stageStat.dev) || intent.stage_inode !== String(stageStat.ino) || intent.stage_digest !== digest) throw new Error("stage_witness_mismatch");
      if (pathExists(parent, components.at(-1)!, openAt, close)) throw new Error("target_exists");
      const current = fstatSync(stageFd, { bigint: true });
      if (!current.isFile() || String(current.dev) !== intent.stage_device || String(current.ino) !== intent.stage_inode ||
        current.uid !== BigInt(process.getuid?.() ?? -1) || current.gid !== BigInt(process.getgid?.() ?? -1) || (current.mode & 0o777n) !== 0o600n ||
        current.size !== BigInt(bytes.length) || createHash("sha256").update(readBounded(stageFd, maxContentBytes)).digest("hex") !== intent.stage_digest) {
        throw new Error("stage_witness_mismatch");
      }
      const targetName = components.at(-1)!;
      if (libcHandle.symbols.linkat(-100, nativeName(`/proc/self/fd/${stageFd}`), parent, nativeName(targetName), atSymlinkFollow) !== 0) {
        throw new Error(pathExists(parent, targetName, openAt, close) ? "target_exists" : "file_publish_failed");
      }
      syncDirectory(parent);
      const now = new Date().toISOString();
      const completed = db.query("UPDATE file_operation_intents SET state = 'completed' WHERE user_id = ? AND request_id = ? AND state = 'prepared'")
        .run(userId, requestId);
      if (completed.changes !== 1) throw new Error("intent_state_unknown");
      db.query(`INSERT INTO file_operation_outcomes (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
        VALUES (?, ?, 'create', ?, '', ?, ?, ?, ?)`)
        .run(userId, requestId, workspaceId, components.join("/"), components.join("/"), digest, now);
      if (unlinkStageIfMatching(libcHandle, parent, stage, stageFd, openAt, close)) syncDirectory(parent);
      return { requestId, workspaceId, kind: "create" as const, path: components.join("/"), version: digest, createdAt: now };
    }).immediate();
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
    if (!workspace || !intent || intent.kind !== "create" || intent.workspace_id !== workspaceId || intent.request_id !== requestId ||
      intent.state !== "prepared" || intent.source_path !== "" || intent.expected_sha256 !== null || intent.source_device !== null ||
      intent.source_inode !== null || !/^[0-9a-f]{64}$/.test(intent.input_digest) || !intent.stage_device || !/^\d+$/.test(intent.stage_device) ||
      !intent.stage_inode || !/^\d+$/.test(intent.stage_inode) || !intent.stage_digest || !/^[0-9a-f]{64}$/.test(intent.stage_digest)) return null;
    const components = relativeComponents(intent.destination_path, true);
    if (!components || components.join("/") !== intent.destination_path ||
      createHash("sha256").update(JSON.stringify([workspaceId, intent.destination_path, intent.stage_digest])).digest("hex") !== intent.input_digest) return null;
    const witnessed = withProvisionedWorkspaceFolder(databasePath, userId, workspaceId, (folderFd, openAt, close) => {
      const folder = db.query<{ request_id: string; device: string; inode: string }, [string, string]>(`SELECT request_id, folder_device AS device, folder_inode AS inode
        FROM workspace_folder_requests WHERE user_id = ? AND workspace_id = ? AND state = 'provisioned'`).get(userId, workspaceId);
      const folderIdentity = statSync(`/proc/self/fd/${folderFd}`, { bigint: true });
      if (!folder || String(folderIdentity.dev) !== folder.device || String(folderIdentity.ino) !== folder.inode) return null;
      const currentIntent = db.query<FileIntentRow, [string, string]>("SELECT * FROM file_operation_intents WHERE user_id = ? AND request_id = ?")
        .get(userId, requestId);
      if (!currentIntent || currentIntent.state !== "prepared" || currentIntent.stage_device !== intent.stage_device ||
        currentIntent.stage_inode !== intent.stage_inode || currentIntent.stage_digest !== intent.stage_digest ||
        currentIntent.destination_path !== intent.destination_path) return null;
      const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
      if (parent < 0) return null;
      const target = openAt(parent, components.at(-1)!, fileFlags);
      try {
        if (target < 0) return null;
        const info = fstatSync(target, { bigint: true });
        if (!info.isFile() || String(info.dev) !== intent.stage_device || String(info.ino) !== intent.stage_inode ||
          info.uid !== BigInt(process.getuid?.() ?? -1) || info.gid !== BigInt(process.getgid?.() ?? -1) ||
          (info.mode & 0o777n) !== 0o600n || info.size > BigInt(maxContentBytes)) return null;
        const bytes = readBounded(target, maxContentBytes);
        const afterRead = fstatSync(target, { bigint: true });
        if (BigInt(bytes.length) !== info.size || afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.size !== info.size ||
          (afterRead.mode & 0o777n) !== 0o600n || createHash("sha256").update(bytes).digest("hex") !== intent.stage_digest) return null;
        fsyncSync(target);
        fsyncSync(parent);
        const now = new Date().toISOString();
        const changed = db.query("UPDATE file_operation_intents SET state = 'completed' WHERE user_id = ? AND request_id = ? AND state = 'prepared'")
          .run(userId, requestId);
        if (changed.changes !== 1) return null;
        db.query(`INSERT INTO file_operation_outcomes (user_id, request_id, kind, workspace_id, source_path, destination_path, result_path, result_sha256, completed_at)
          VALUES (?, ?, 'create', ?, '', ?, ?, ?, ?)`).run(userId, requestId, workspaceId, components.join("/"), components.join("/"), intent.stage_digest, now);
        return { requestId, workspaceId, kind: "create", path: components.join("/"), version: intent.stage_digest, createdAt: now } satisfies FileReceipt;
      } finally {
        if (target >= 0) close(target);
        if (parent !== folderFd) close(parent);
      }
    });
    if (witnessed.kind !== "opened") throw new Error("workspace_folder_unavailable");
    return witnessed.value;
  }).immediate();
}
