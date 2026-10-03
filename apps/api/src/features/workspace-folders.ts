import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { closeSync, constants, fchownSync, fstatSync, fsyncSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionUserId } from "./auth";
import { createFileRequestTables, fileRequestSchemaMatches } from "./file-requests";

const requestIdSchema = t.Transform(t.String({ format: "uuid", minLength: 36, maxLength: 36 }))
  .Decode((value) => value.toLowerCase())
  .Encode((value) => value.toLowerCase());
const folderSchemaVersion = 2;
const folderMarker = ".remotecode-workspace";
type WorkspaceIdentity = { uid: number; gid: number };
const uidColumn = "folder_uid INTEGER CHECK (folder_uid IS NULL OR (typeof(folder_uid) = 'integer' AND folder_uid BETWEEN 0 AND 4294967295))";
const gidColumn = "folder_gid INTEGER CHECK ((folder_uid IS NULL) = (folder_gid IS NULL) AND (folder_gid IS NULL OR (typeof(folder_gid) = 'integer' AND folder_gid BETWEEN 0 AND 4294967295)))";
const requiredFolderColumns = ["user_id", "request_id", "workspace_id", "state", "folder_device", "folder_inode"];
const nativeSymbols = {
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;
type NativeLibrary = ReturnType<typeof dlopen<typeof nativeSymbols>>;

function openNativeLibrary() {
  return dlopen("libc.so.6", nativeSymbols);
}

function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA busy_timeout = 250");
  return database;
}

function ffiBuffer(name: string) {
  return Buffer.from(`${name}\0`);
}

function ffiOpenAt(libc: NativeLibrary, parent: number, name: string, flags: number, mode = 0) {
  const buffer = ffiBuffer(name);
  return libc.symbols.openat(parent, buffer, flags, mode);
}

function ffiMkdirAt(libc: NativeLibrary, parent: number, name: string, mode: number) {
  const buffer = ffiBuffer(name);
  return libc.symbols.mkdirat(parent, buffer, mode);
}

const workspaceRootFds = new Map<string, number>();

function openWorkspaceRoot(databasePath: string) {
  if (process.platform !== "linux") return -1;
  const root = realpathSync(dirname(databasePath));
  const cached = workspaceRootFds.get(root);
  if (cached !== undefined) return cached;
  const libc = openNativeLibrary();
  const directoryFlags = constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000;
  let current = ffiOpenAt(libc, -100, "/", directoryFlags);
  try {
    if (current < 0) return -1;
    for (const segment of root.split("/").filter(Boolean)) {
      const next = ffiOpenAt(libc, current, segment, directoryFlags);
      libc.symbols.close(current);
      if (next < 0) return -1;
      current = next;
    }
    workspaceRootFds.set(root, current);
    return current;
  } finally {
    libc.close();
  }
}

function workspaceRootCurrent(databasePath: string, rootFd: number) {
  if (process.platform !== "linux") return true;
  if (rootFd < 0) return false;
  try {
    const configuredRoot = statSync(realpathSync(dirname(databasePath)));
    const anchoredRoot = statSync(`/proc/self/fd/${rootFd}`);
    return configuredRoot.dev === anchoredRoot.dev && configuredRoot.ino === anchoredRoot.ino;
  } catch {
    return false;
  }
}

function validIdentity(identity: WorkspaceIdentity) {
  // fchown reserves UINT32_MAX for unchanged ownership.
  return identity !== null && typeof identity === "object" &&
    Number.isInteger(identity.uid) && identity.uid >= 0 && identity.uid < 0xffffffff &&
    Number.isInteger(identity.gid) && identity.gid >= 0 && identity.gid < 0xffffffff;
}

function storedIdentity(uid: number | null, gid: number | null): WorkspaceIdentity {
  if (uid === null && gid === null) return processIdentity();
  const identity = { uid: uid!, gid: gid! };
  if (!validIdentity(identity)) throw new Error("workspace_folder_owner_invalid");
  return identity;
}

function identitySchemaMatches(database: Database) {
  const columns = database.query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
    "PRAGMA table_info(workspace_folder_requests)",
  ).all();
  const sql = database.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_folder_requests'",
  ).get()?.sql.replace(/\s+/g, " ");
  if (![uidColumn, gidColumn].every((definition) => sql?.includes(definition))) return false;
  if (!["folder_uid", "folder_gid"].every((name) => columns.some((column) =>
    column.name === name && column.type === "INTEGER" && column.notnull === 0 && column.dflt_value === null))) return false;
  return !database.query(`SELECT 1 FROM workspace_folder_requests WHERE
    (folder_uid IS NULL) != (folder_gid IS NULL) OR
    (folder_uid IS NOT NULL AND (typeof(folder_uid) != 'integer' OR folder_uid NOT BETWEEN 0 AND 4294967294)) OR
    (folder_gid IS NOT NULL AND (typeof(folder_gid) != 'integer' OR folder_gid NOT BETWEEN 0 AND 4294967294)) LIMIT 1`).get();
}

function folderSchemaMatches(database: Database) {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  if (version !== folderSchemaVersion || !fileRequestSchemaMatches(database) || !identitySchemaMatches(database)) return false;
  const columns = database.query<{ name: string }, []>("PRAGMA table_info(workspace_folder_requests)").all();
  if (requiredFolderColumns.some((name) => !columns.some((column) => column.name === name))) return false;
  database.query(`SELECT ${requiredFolderColumns.join(", ")} FROM workspace_folder_requests LIMIT 0`).get();
  return true;
}

export function workspaceFolderSchemaReady(databasePath: string) {
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, create: false });
    return folderSchemaMatches(database);
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function initializeFolderSchema(databasePath: string) {
  let database: Database | undefined;
  try {
    database = openDatabase(databasePath);
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      database.transaction(() => {
        const existing = database!.query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_folder_requests'",
        ).get();
        if (!existing) {
          database!.exec(`
            CREATE TABLE workspace_folder_requests (
              user_id TEXT NOT NULL,
              request_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
              state TEXT NOT NULL CHECK (state IN ('pending', 'provisioned')),
              folder_device TEXT,
              folder_inode TEXT,
              PRIMARY KEY (user_id, request_id)
            )
          `);
        } else {
          const columns = database!.query<{ name: string }, []>("PRAGMA table_info(workspace_folder_requests)").all();
          const names = columns.map((column) => column.name);
          if (["user_id", "request_id", "workspace_id", "state"].some((name) => !names.includes(name))) {
            throw new Error("Workspace folder schema is invalid");
          }
          for (const name of ["folder_device", "folder_inode"]) {
            if (!names.includes(name)) database!.exec(`ALTER TABLE workspace_folder_requests ADD COLUMN ${name} TEXT`);
          }
        }
        createFileRequestTables(database!);
        database!.exec(`PRAGMA user_version = ${folderSchemaVersion}`);
      }).immediate();
    } else if (version === 1) {
      database.transaction(() => {
        const columns = database!.query<{ name: string }, []>("PRAGMA table_info(workspace_folder_requests)").all();
        if (requiredFolderColumns.some((name) => !columns.some((column) => column.name === name))) {
          throw new Error("Workspace folder schema is invalid");
        }
        createFileRequestTables(database!);
        database!.exec(`PRAGMA user_version = ${folderSchemaVersion}`);
      }).immediate();
    }
    if (database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version === folderSchemaVersion &&
      fileRequestSchemaMatches(database)) {
      database.transaction(() => {
        const columns = database!.query<{ name: string }, []>("PRAGMA table_info(workspace_folder_requests)").all();
        if (requiredFolderColumns.some((name) => !columns.some((column) => column.name === name))) {
          throw new Error("Workspace folder schema is invalid");
        }
        if (!columns.some((column) => column.name === "folder_uid" || column.name === "folder_gid")) {
          database!.exec(`ALTER TABLE workspace_folder_requests ADD COLUMN ${uidColumn}`);
          database!.exec(`ALTER TABLE workspace_folder_requests ADD COLUMN ${gidColumn}`);
        }
        if (!identitySchemaMatches(database!)) throw new Error("Workspace folder identity schema is invalid");
      }).immediate();
    }
    return folderSchemaMatches(database);
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function processIdentity() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("workspace_folder_owner_unavailable");
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

function validateDirectory(fd: number, mode: number, owner = processIdentity()) {
  const info = fstatSync(fd);
  if (!info.isDirectory() || info.uid !== owner.uid || info.gid !== owner.gid || (info.mode & 0o777) !== mode) {
    throw new Error("workspace_folder_directory_invalid");
  }
  return info;
}

function validateMarker(libc: NativeLibrary, workspaceFd: number, requestId: string, owner: WorkspaceIdentity) {
  const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000;
  const markerFd = ffiOpenAt(libc, workspaceFd, folderMarker, flags);
  if (markerFd < 0) throw new Error("workspace_folder_marker_unavailable");
  try {
    const markerStat = fstatSync(markerFd);
    if (!markerStat.isFile() || markerStat.dev !== fstatSync(workspaceFd).dev || markerStat.nlink !== 1 || markerStat.size !== 37 || markerStat.uid !== owner.uid || markerStat.gid !== owner.gid ||
      (markerStat.mode & 0o777) !== 0o600 || readFileSync(`/proc/self/fd/${markerFd}`, "utf8") !== `${requestId}\n`) {
      throw new Error("workspace_folder_marker_invalid");
    }
  } finally {
    libc.symbols.close(markerFd);
  }
}

type SyncDirectory = (fd: number) => void;

function createMarker(libc: NativeLibrary, workspaceFd: number, requestId: string, owner: WorkspaceIdentity) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | 0x80000;
  const markerFd = ffiOpenAt(libc, workspaceFd, folderMarker, flags, 0o600);
  if (markerFd < 0) throw new Error("workspace_folder_marker_create_failed");
  try {
    const info = fstatSync(markerFd);
    const current = processIdentity();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== fstatSync(workspaceFd).dev ||
      info.uid !== current.uid || info.gid !== current.gid || (info.mode & 0o777) !== 0o600) {
      throw new Error("workspace_folder_marker_invalid");
    }
    if (owner.uid !== current.uid || owner.gid !== current.gid) fchownSync(markerFd, owner.uid, owner.gid);
    const owned = fstatSync(markerFd);
    if (owned.uid !== owner.uid || owned.gid !== owner.gid) throw new Error("workspace_folder_marker_invalid");
    const content = Buffer.from(`${requestId}\n`);
    writeSync(markerFd, content, 0, content.length, 0);
    fsyncSync(markerFd);
  } finally {
    closeSync(markerFd);
  }
}

function provisionFolder(
  rootFd: number,
  workspaceId: string,
  requestId: string,
  state: "pending" | "provisioned",
  expectedDevice: string | null,
  expectedInode: string | null,
  syncDirectory: SyncDirectory,
  owner: WorkspaceIdentity,
) {
  if (process.platform !== "linux" || rootFd < 0) throw new Error("linux_folder_boundary_required");
  const libc = openNativeLibrary();
  const directoryFlags = constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000;
  let workspacesFd = -1;
  let workspaceFd = -1;
  let created = false;
  try {
    if (state === "pending") ffiMkdirAt(libc, rootFd, "workspaces", 0o700);
    workspacesFd = ffiOpenAt(libc, rootFd, "workspaces", directoryFlags);
    if (workspacesFd < 0) throw new Error("workspace_root_unavailable");
    validateDirectory(workspacesFd, 0o700);

    if (state === "pending") created = ffiMkdirAt(libc, workspacesFd, workspaceId, 0o700) === 0;
    workspaceFd = ffiOpenAt(libc, workspacesFd, workspaceId, directoryFlags);
    if (workspaceFd < 0) throw new Error("workspace_folder_unavailable");
    if (created) {
      const current = validateDirectory(workspaceFd, 0o700);
      if (readdirSync(`/proc/self/fd/${workspaceFd}`).length !== 0) throw new Error("workspace_folder_state_conflict");
      if (owner.uid !== current.uid || owner.gid !== current.gid) fchownSync(workspaceFd, owner.uid, owner.gid);
    }
    const info = validateDirectory(workspaceFd, 0o700, owner);

    if (state === "provisioned") {
      if (expectedDevice === null || expectedInode === null || String(info.dev) !== expectedDevice || String(info.ino) !== expectedInode) {
        throw new Error("workspace_folder_identity_unavailable");
      }
      validateMarker(libc, workspaceFd, requestId, owner);
    } else if (created) {
      createMarker(libc, workspaceFd, requestId, owner);
      validateMarker(libc, workspaceFd, requestId, owner);
    } else {
      validateMarker(libc, workspaceFd, requestId, owner);
      if (readdirSync(`/proc/self/fd/${workspaceFd}`).some((name) => name !== folderMarker)) {
        throw new Error("workspace_folder_state_conflict");
      }
    }
    if (state === "pending") {
      try {
        syncDirectory(workspaceFd);
        syncDirectory(workspacesFd);
        syncDirectory(rootFd);
      } catch {
        throw new Error("workspace_folder_sync_unknown");
      }
    }
    validateDirectory(workspaceFd, 0o700, owner);
    validateMarker(libc, workspaceFd, requestId, owner);
    return { device: String(info.dev), inode: String(info.ino) };
  } finally {
    if (workspaceFd >= 0) libc.symbols.close(workspaceFd);
    if (workspacesFd >= 0) libc.symbols.close(workspacesFd);
    libc.close();
  }
}

export function withProvisionedWorkspaceFolder<T>(
  databasePath: string,
  userId: string,
  workspaceId: string,
  callback: (folderFd: number, openAt: (parentFd: number, name: string, flags: number, mode?: number) => number, close: (fd: number) => void, owner: WorkspaceIdentity) => T,
): { kind: "not_found" } | { kind: "unavailable" } | { kind: "opened"; value: T } {
  if (process.platform !== "linux") return { kind: "unavailable" };
  let database: Database | undefined;
  let libc: NativeLibrary | undefined;
  let workspacesFd = -1;
  let workspaceFd = -1;
  try {
    const rootFd = openWorkspaceRoot(databasePath);
    if (!workspaceRootCurrent(databasePath, rootFd) || !workspaceFolderSchemaReady(databasePath)) return { kind: "unavailable" };
    database = new Database(databasePath, { readonly: true, create: false });
    const accepted = database.query<{
      requestId: string; state: string; device: string | null; inode: string | null; uid: number | null; gid: number | null;
    }, [string, string]>(`
      SELECT f.request_id AS requestId, f.state, f.folder_device AS device, f.folder_inode AS inode, f.folder_uid AS uid, f.folder_gid AS gid
      FROM workspaces w JOIN workspace_folder_requests f ON f.workspace_id = w.id
      WHERE w.id = ? AND w.user_id = ?
    `).get(workspaceId, userId);
    if (!accepted) return { kind: "not_found" };
    if (accepted.state !== "provisioned" || accepted.device === null || accepted.inode === null) return { kind: "unavailable" };

    libc = openNativeLibrary();
    const directoryFlags = constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000;
    workspacesFd = ffiOpenAt(libc, rootFd, "workspaces", directoryFlags);
    if (workspacesFd < 0) return { kind: "unavailable" };
    validateDirectory(workspacesFd, 0o700);
    workspaceFd = ffiOpenAt(libc, workspacesFd, workspaceId, directoryFlags);
    if (workspaceFd < 0) return { kind: "unavailable" };
    const owner = storedIdentity(accepted.uid, accepted.gid);
    const info = validateDirectory(workspaceFd, 0o700, owner);
    if (String(info.dev) !== accepted.device || String(info.ino) !== accepted.inode) return { kind: "unavailable" };
    validateMarker(libc, workspaceFd, accepted.requestId, owner);
    const value = callback(workspaceFd, (parentFd, name, flags, mode = 0) => ffiOpenAt(libc!, parentFd, name, flags, mode),
      (fd) => { libc!.symbols.close(fd); }, owner);
    return { kind: "opened", value };
  } catch {
    return { kind: "unavailable" };
  } finally {
    if (workspaceFd >= 0) libc?.symbols.close(workspaceFd);
    if (workspacesFd >= 0) libc?.symbols.close(workspacesFd);
    libc?.close();
    database?.close();
  }
}

export function workspaceFoldersFeature(databasePath: string, syncDirectory: SyncDirectory = fsyncSync, identity?: WorkspaceIdentity) {
  const identityReady = identity === undefined || validIdentity(identity);
  const plannedIdentity = identityReady && identity !== undefined ? { uid: identity.uid, gid: identity.gid } : undefined;
  const schemaReady = identityReady && initializeFolderSchema(databasePath);
  let workspaceRootFd = -1;
  try {
    workspaceRootFd = openWorkspaceRoot(databasePath);
  } catch {
    workspaceRootFd = -1;
  }
  const isReady = () => identityReady && (schemaReady || workspaceFolderSchemaReady(databasePath)) &&
    workspaceRootCurrent(databasePath, workspaceRootFd);

  const routes = new Elysia().get("/api/workspaces/:workspaceId/folder", ({ params, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    let database: Database | undefined;
    try {
      database = new Database(databasePath, { readonly: true, create: false });
      const result = database.transaction(() => {
        const workspace = database!.query<{ id: string; archived: number }, [string, string]>(
          "SELECT id, archived FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, userId);
        if (!workspace) return { error: "not_found" as const };
        if (process.platform !== "linux") return { error: "workspace_folders_require_linux" as const };
        if (!isReady() || !workspaceFolderSchemaReady(databasePath)) throw new Error("storage_unavailable");
        const current = database!.query<{
          userId: string; requestId: string; state: string; device: string | null; inode: string | null; uid: number | null; gid: number | null;
        }, [string]>(`
          SELECT user_id AS userId, request_id AS requestId, state, folder_device AS device, folder_inode AS inode, folder_uid AS uid, folder_gid AS gid
          FROM workspace_folder_requests WHERE workspace_id = ?
        `).get(params.workspaceId);
        if (current) {
          if (current.userId !== userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(current.requestId)) {
            throw new Error("workspace_folder_identity_unavailable");
          }
          storedIdentity(current.uid, current.gid);
          if (current.state === "pending") return { workspaceId: params.workspaceId, state: "unknown" as const, requestId: current.requestId };
          if (current.state !== "provisioned") throw new Error("workspace_folder_state_unavailable");
          provisionFolder(workspaceRootFd, params.workspaceId, current.requestId, "provisioned", current.device, current.inode, syncDirectory, storedIdentity(current.uid, current.gid));
          return { workspaceId: params.workspaceId, state: "provisioned" as const, requestId: current.requestId };
        }
        if (workspace.archived) return { error: "workspace_archived" as const };
        if (readdirSync(`/proc/self/fd/${workspaceRootFd}`).includes("workspaces")) {
          const libc = openNativeLibrary();
          let parentFd = -1;
          try {
            parentFd = ffiOpenAt(libc, workspaceRootFd, "workspaces", constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
            if (parentFd < 0) throw new Error("workspace_root_unavailable");
            validateDirectory(parentFd, 0o700);
            if (readdirSync(`/proc/self/fd/${parentFd}`).includes(params.workspaceId)) throw new Error("workspace_folder_identity_unavailable");
          } finally {
            if (parentFd >= 0) libc.symbols.close(parentFd);
            libc.close();
          }
        }
        return { workspaceId: params.workspaceId, state: "not_provisioned" as const };
      }).deferred();
      if ("error" in result) set.status = result.error === "not_found" ? 404 : result.error === "workspace_archived" ? 409 : 501;
      return result;
    } catch {
      set.status = 503;
      return { error: "workspace_folder_unavailable" as const };
    } finally { database?.close(); }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
  }).post("/api/workspaces/:workspaceId/folder", ({ body, params, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) {
      set.status = 401;
      return { error: "unauthorized" as const };
    }
    if (!isReady() || !workspaceFolderSchemaReady(databasePath)) {
      set.status = 503;
      return { error: "storage_unavailable" as const };
    }

    let connection: Database | undefined;
    try {
      const database = openDatabase(databasePath);
      connection = database;
      const result = database.transaction(() => {
        const workspace = database.query<{ archived: number }, [string, string]>(
          "SELECT archived FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, userId);
        if (!workspace) return { kind: "not_found" as const };
        if (workspace.archived) return { kind: "workspace_archived" as const };
        const existing = database.query<{
          requestId: string; state: "pending" | "provisioned"; device: string | null; inode: string | null; uid: number | null; gid: number | null;
        }, [string]>(`
          SELECT request_id AS requestId, state, folder_device AS device, folder_inode AS inode, folder_uid AS uid, folder_gid AS gid
          FROM workspace_folder_requests WHERE workspace_id = ?
        `).get(params.workspaceId);
        if (existing) {
          if (existing.requestId !== body.requestId) return { kind: "request_id_conflict" as const };
          if (process.platform !== "linux") return { kind: "unsupported" as const };
          return { kind: "existing" as const, state: existing.state, device: existing.device, inode: existing.inode };
        }
        const duplicateRequest = database.query(
          "SELECT 1 FROM workspace_folder_requests WHERE user_id = ? AND request_id = ?",
        ).get(userId, body.requestId);
        if (duplicateRequest) return { kind: "request_id_conflict" as const };
        if (process.platform !== "linux") return { kind: "unsupported" as const };
        const libc = openNativeLibrary();
        let parentFd = -1;
        try {
          if (readdirSync(`/proc/self/fd/${workspaceRootFd}`).includes("workspaces")) {
            parentFd = ffiOpenAt(libc, workspaceRootFd, "workspaces", constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
            if (parentFd < 0) throw new Error("workspace_root_unavailable");
            validateDirectory(parentFd, 0o700);
            if (readdirSync(`/proc/self/fd/${parentFd}`).includes(params.workspaceId)) throw new Error("workspace_folder_identity_unavailable");
          }
        } finally {
          if (parentFd >= 0) libc.symbols.close(parentFd);
          libc.close();
        }
        const owner = plannedIdentity ?? processIdentity();
        database.query(`
          INSERT INTO workspace_folder_requests (user_id, request_id, workspace_id, state, folder_uid, folder_gid)
          VALUES (?, ?, ?, 'pending', ?, ?)
        `).run(userId, body.requestId, params.workspaceId, owner.uid, owner.gid);
        return { kind: "created" as const, state: "pending" as const, device: null, inode: null };
      }).immediate();
      if (result.kind === "not_found") {
        set.status = 404;
        return { error: "not_found" as const };
      }
      if (result.kind === "workspace_archived") {
        set.status = 409;
        return { error: "workspace_archived" as const };
      }
      if (result.kind === "request_id_conflict") {
        set.status = 409;
        return { error: "request_id_conflict" as const };
      }
      if (result.kind === "unsupported") {
        set.status = 501;
        return { error: "workspace_folders_require_linux" as const };
      }
    } catch {
      set.status = 503;
      return { error: "storage_unavailable" as const };
    } finally {
      connection?.close();
    }

    let finalized: Database | undefined;
    try {
      const database = openDatabase(databasePath);
      finalized = database;
      const result = database.transaction(() => {
        const workspace = database.query<{ archived: number }, [string, string]>(
          "SELECT archived FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, userId);
        if (!workspace) return { error: "not_found" as const };
        if (workspace.archived) return { error: "workspace_archived" as const };
        const intent = database.query<{
          state: "pending" | "provisioned"; device: string | null; inode: string | null; uid: number | null; gid: number | null;
        }, [string, string, string]>(`
          SELECT state, folder_device AS device, folder_inode AS inode, folder_uid AS uid, folder_gid AS gid FROM workspace_folder_requests
          WHERE user_id = ? AND request_id = ? AND workspace_id = ?
        `).get(userId, body.requestId, params.workspaceId);
        if (!intent) throw new Error("workspace_folder_outcome_unavailable");
        const folder = provisionFolder(workspaceRootFd, params.workspaceId, body.requestId,
          intent.state, intent.device, intent.inode, syncDirectory, storedIdentity(intent.uid, intent.gid));
        if (intent.state === "pending") {
          const update = database.query(`
            UPDATE workspace_folder_requests SET state = 'provisioned', folder_device = ?, folder_inode = ?
            WHERE user_id = ? AND request_id = ? AND workspace_id = ? AND state = 'pending'
          `).run(folder.device, folder.inode, userId, body.requestId, params.workspaceId);
          if (update.changes !== 1) throw new Error("workspace_folder_outcome_unavailable");
        }
        return { workspaceId: params.workspaceId, state: "provisioned" as const };
      }).immediate();
      if ("error" in result) set.status = result.error === "not_found" ? 404 : 409;
      return result;
    } catch (error) {
      const reason = error instanceof Error && error.message.startsWith("workspace_") ? error.message : "storage_unavailable";
      set.status = reason === "workspace_folder_state_conflict" ? 409 : 503;
      return { error: reason };
    } finally {
      finalized?.close();
    }
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ requestId: requestIdSchema }),
  });
  return { routes, isReady };
}
