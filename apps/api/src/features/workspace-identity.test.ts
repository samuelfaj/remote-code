import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { chownSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApi } from "../app";
import { workspaceFilesFeature } from "./workspace-files";
import { workspaceFolderSchemaReady, workspaceFoldersFeature } from "./workspace-folders";

const directories: string[] = [];
const terminalIdentity = { uid: 65534, gid: 65534 };
const rootLinux = process.platform === "linux" && process.getuid?.() === 0;
const token = "a".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC029_TEST_WORK_DIR ?? tmpdir(), "rc031-identity-"));
  directories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  try {
    for (const [session, user] of [[token, "alice"], ["b".repeat(64), "bob"]]) {
      database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(createHash("sha256").update(session).digest("hex"), user, Date.now() + 60_000);
    }
    const workspaceId = crypto.randomUUID();
    database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
      .run(workspaceId, new Date().toISOString());
    return { app, databasePath, workspaceId, folderPath: join(directory, "workspaces", workspaceId) };
  } finally { database.close(); }
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function request(app: { handle: (request: Request) => Promise<Response> }, workspaceId: string, route: string,
  method = "GET", body?: unknown, session = token) {
  return app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}${route}`, {
    method,
    headers: { cookie: `remotecode_session=${session}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

function protectedApp(databasePath: string) {
  return new Elysia().use(workspaceFoldersFeature(databasePath, fsyncSync, terminalIdentity).routes)
    .use(workspaceFilesFeature(databasePath, (fd) => {
      for (const name of readdirSync(`/proc/self/fd/${fd}`).filter((entry) => entry.startsWith(".remotecode-stage-"))) {
        expectOwner(join(`/proc/self/fd/${fd}`, name), 65534, 65534);
      }
      fsyncSync(fd);
    }));
}

function expectOwner(path: string, uid: number, gid: number, mode?: number) {
  const info = lstatSync(path);
  expect(info.uid).toBe(uid);
  expect(info.gid).toBe(gid);
  if (mode !== undefined) expect(info.mode & 0o777).toBe(mode);
  return info;
}

it("rejects malformed opt-in identities without mutating schema or creating folders", async () => {
  const { databasePath, workspaceId, folderPath } = setup();
  const before = readFileSync(databasePath);
  for (const identity of [null, {}, { uid: 65534 }, { gid: 65534 }, { uid: -1, gid: 0 },
    { uid: 0, gid: 1.5 }, { uid: 0x100000000, gid: 0 }, { uid: 0xffffffff, gid: 0 },
    { uid: 0, gid: 0xffffffff }, { uid: "65534", gid: 65534 }]) {
    const feature = workspaceFoldersFeature(databasePath, fsyncSync, identity as typeof terminalIdentity);
    expect(feature.isReady()).toBe(false);
    expect((await request(new Elysia().use(feature.routes), workspaceId, "/folder", "POST", { requestId: crypto.randomUUID() })).status).toBe(503);
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(folderPath)).toBe(false);
  }
});

it("adds nullable identity columns to legacy rows and rejects partial or malformed identity schema", () => {
  const { databasePath, workspaceId } = setup();
  const database = new Database(databasePath);
  try {
    database.exec("ALTER TABLE workspace_folder_requests DROP COLUMN folder_gid; ALTER TABLE workspace_folder_requests DROP COLUMN folder_uid");
    database.query("INSERT INTO workspace_folder_requests (user_id, request_id, workspace_id, state) VALUES ('alice', ?, ?, 'pending')")
      .run(crypto.randomUUID(), workspaceId);
    workspaceFoldersFeature(databasePath, fsyncSync, terminalIdentity);
    expect(workspaceFolderSchemaReady(databasePath)).toBe(true);
    expect(database.query("SELECT folder_uid, folder_gid FROM workspace_folder_requests").get()).toEqual({ folder_uid: null, folder_gid: null });
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(() => database.exec("UPDATE workspace_folder_requests SET folder_uid = 65534")).toThrow();
    database.exec("PRAGMA ignore_check_constraints = ON; UPDATE workspace_folder_requests SET folder_uid = 65534");
    expect(workspaceFolderSchemaReady(databasePath)).toBe(false);
    database.exec("UPDATE workspace_folder_requests SET folder_uid = NULL; PRAGMA ignore_check_constraints = OFF");
    database.exec("UPDATE workspace_folder_requests SET folder_uid = 4294967295, folder_gid = 4294967295");
    expect(workspaceFolderSchemaReady(databasePath)).toBe(false);
    database.exec("UPDATE workspace_folder_requests SET folder_uid = NULL, folder_gid = NULL");
    database.exec("ALTER TABLE workspace_folder_requests DROP COLUMN folder_gid");
    expect(workspaceFoldersFeature(databasePath).isReady()).toBe(false);
    expect(database.query<{ name: string }, []>("PRAGMA table_info(workspace_folder_requests)").all().some((column) => column.name === "folder_gid")).toBe(false);
    database.exec("ALTER TABLE workspace_folder_requests ADD COLUMN folder_gid TEXT");
    expect(workspaceFoldersFeature(databasePath).isReady()).toBe(false);
  } finally { database.close(); }
});

it.skipIf(!rootLinux)("root API provisions UID/GID 65534 and preserves ownership through CREATE, OPEN, SAVE, MOVE and receipts", async () => {
  const { databasePath, workspaceId, folderPath } = setup();
  const requestId = crypto.randomUUID();
  const feature = workspaceFoldersFeature(databasePath, (fd) => {
    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.query("SELECT state, folder_uid, folder_gid FROM workspace_folder_requests WHERE workspace_id = ?").get(workspaceId))
        .toEqual({ state: "pending", folder_uid: 65534, folder_gid: 65534 });
    } finally { database.close(); }
    fsyncSync(fd);
  }, terminalIdentity);
  expect((await request(new Elysia().use(feature.routes), workspaceId, "/folder", "POST", { requestId })).status).toBe(200);
  const directory = expectOwner(folderPath, 65534, 65534, 0o700);
  const marker = join(folderPath, ".remotecode-workspace");
  expectOwner(marker, 65534, 65534, 0o600);
  expect(readFileSync(marker, "utf8")).toBe(`${requestId}\n`);
  expectOwner(dirname(folderPath), 0, process.getgid!(), 0o700);
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.query("SELECT state, folder_uid, folder_gid, folder_device, folder_inode FROM workspace_folder_requests WHERE workspace_id = ?").get(workspaceId))
      .toEqual({ state: "provisioned", folder_uid: 65534, folder_gid: 65534, folder_device: String(directory.dev), folder_inode: String(directory.ino) });
  } finally { database.close(); }

  const app = protectedApp(databasePath);
  const createId = crypto.randomUUID();
  const created = await request(app, workspaceId, "/files", "POST", { requestId: createId, path: "original.txt", content: "first\n" });
  expect(created.status).toBe(201);
  const createReceipt = await created.json() as { version: string };
  const original = join(folderPath, "original.txt");
  const first = expectOwner(original, 65534, 65534, 0o600);
  expect((await request(app, workspaceId, `/files/receipts/${createId}`)).status).toBe(200);
  expect(await (await request(app, workspaceId, "/files/content?path=original.txt")).json()).toMatchObject({ content: "first\n", version: createReceipt.version });
  const saveId = crypto.randomUUID();
  const saved = await request(app, workspaceId, "/files/content", "PUT", {
    requestId: saveId, path: "original.txt", content: "second\n", expectedVersion: createReceipt.version,
  });
  expect(saved.status).toBe(201);
  const saveReceipt = await saved.json() as { version: string };
  const second = expectOwner(original, 65534, 65534, 0o600);
  expect(second.ino).not.toBe(first.ino);
  const moveId = crypto.randomUUID();
  const moved = await request(app, workspaceId, "/files/move", "POST", {
    requestId: moveId, sourcePath: "original.txt", destinationPath: "moved.txt", expectedVersion: saveReceipt.version,
  });
  expect(moved.status).toBe(201);
  const moveReceipt = await moved.json();
  expect(expectOwner(join(folderPath, "moved.txt"), 65534, 65534, 0o600).ino).toBe(second.ino);
  expect(existsSync(original)).toBe(false);
  expect(readFileSync(join(folderPath, "moved.txt"), "utf8")).toBe("second\n");
  expect(await (await request(app, workspaceId, `/files/receipts/${moveId}`)).json()).toEqual(moveReceipt);
  expect((await request(app, workspaceId, `/files/receipts/${saveId}`)).status).toBe(200);
  const defaultPolicy = new Elysia().use(workspaceFoldersFeature(databasePath).routes).use(workspaceFilesFeature(databasePath));
  expect((await request(defaultPolicy, workspaceId, "/folder")).status).toBe(200);
  expect((await request(defaultPolicy, workspaceId, "/folder", "POST", { requestId })).status).toBe(200);
  expect((await request(defaultPolicy, workspaceId, "/files/content?path=moved.txt")).status).toBe(200);
  expectOwner(marker, 65534, 65534, 0o600);
  expect(lstatSync(folderPath).ino).toBe(directory.ino);
  expect(readdirSync(folderPath).sort()).toEqual([".remotecode-workspace", "moved.txt"]);
});

it.skipIf(!rootLinux)("keeps accepted legacy folders and their files current-process-owned under the opt-in policy", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  const requestId = crypto.randomUUID();
  expect((await request(app, workspaceId, "/folder", "POST", { requestId })).status).toBe(200);
  const original = lstatSync(folderPath);
  const legacy = new Database(databasePath);
  try { legacy.exec("ALTER TABLE workspace_folder_requests DROP COLUMN folder_gid; ALTER TABLE workspace_folder_requests DROP COLUMN folder_uid"); }
  finally { legacy.close(); }
  const protectedRoutes = new Elysia().use(workspaceFoldersFeature(databasePath, fsyncSync, terminalIdentity).routes)
    .use(workspaceFilesFeature(databasePath));
  expect((await request(protectedRoutes, workspaceId, "/folder", "POST", { requestId })).status).toBe(200);
  expect((await request(protectedRoutes, workspaceId, "/files", "POST", { requestId: crypto.randomUUID(), path: "legacy.txt", content: "legacy" })).status).toBe(201);
  expectOwner(folderPath, 0, process.getgid!(), 0o700);
  expectOwner(join(folderPath, ".remotecode-workspace"), 0, process.getgid!(), 0o600);
  expectOwner(join(folderPath, "legacy.txt"), 0, process.getgid!(), 0o600);
  expect(lstatSync(folderPath).ino).toBe(original.ino);
  const database = new Database(databasePath, { readonly: true });
  try { expect(database.query("SELECT folder_uid, folder_gid FROM workspace_folder_requests").get()).toEqual({ folder_uid: null, folder_gid: null }); }
  finally { database.close(); }
});

it.skipIf(!rootLinux)("denies wrong folder, marker and file owners, marker content and orphan leaves without new writes", async () => {
  const { databasePath, workspaceId, folderPath } = setup();
  const app = protectedApp(databasePath);
  const requestId = crypto.randomUUID();
  expect((await request(app, workspaceId, "/folder", "POST", { requestId })).status).toBe(200);
  const marker = join(folderPath, ".remotecode-workspace");
  const content = readFileSync(marker);
  for (const [path, uid, gid] of [[folderPath, 0, 65534], [marker, 65534, 0], [marker, 0, 0]] as const) {
    chownSync(path, uid, gid);
    const before = readFileSync(databasePath);
    expect((await request(app, workspaceId, "/folder")).status).toBe(503);
    expect((await request(app, workspaceId, "/files", "POST", { requestId: crypto.randomUUID(), path: "denied.txt", content: "no" })).status).toBe(503);
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(folderPath, "denied.txt"))).toBe(false);
    expectOwner(path, uid, gid);
    chownSync(path, 65534, 65534);
  }
  writeFileSync(marker, `${crypto.randomUUID()}\n`);
  const beforeMarker = readFileSync(databasePath);
  expect((await request(app, workspaceId, "/folder", "POST", { requestId })).status).toBe(503);
  expect(readFileSync(databasePath)).toEqual(beforeMarker);
  writeFileSync(marker, content);
  const wrongFile = join(folderPath, "wrong.txt");
  writeFileSync(wrongFile, "unchanged", { mode: 0o600 });
  const version = createHash("sha256").update("unchanged").digest("hex");
  const beforeFile = readFileSync(databasePath);
  expect((await request(app, workspaceId, "/files/content?path=wrong.txt")).status).toBe(409);
  expect((await request(app, workspaceId, "/files/content", "PUT", { requestId: crypto.randomUUID(), path: "wrong.txt", content: "no", expectedVersion: version })).status).toBe(409);
  expect((await request(app, workspaceId, "/files/move", "POST", { requestId: crypto.randomUUID(), sourcePath: "wrong.txt", destinationPath: "no.txt", expectedVersion: version })).status).toBe(409);
  expect(readFileSync(databasePath)).toEqual(beforeFile);
  expect(readFileSync(wrongFile, "utf8")).toBe("unchanged");
  expectOwner(wrongFile, 0, process.getgid!(), 0o600);
  expect((await request(app, workspaceId, "/files", "POST", { requestId: crypto.randomUUID(), path: "foreign.txt", content: "no" }, "b".repeat(64))).status).toBe(404);
  expect(readFileSync(databasePath)).toEqual(beforeFile);

  const orphanId = crypto.randomUUID();
  const database = new Database(databasePath);
  try {
    database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'orphan', ?)").run(orphanId, new Date().toISOString());
  } finally { database.close(); }
  const orphan = join(dirname(folderPath), orphanId);
  mkdirSync(orphan, { mode: 0o700 });
  const orphanRequest = crypto.randomUUID();
  writeFileSync(join(orphan, ".remotecode-workspace"), `${orphanRequest}\n`, { mode: 0o600 });
  chownSync(orphan, 65534, 65534);
  chownSync(join(orphan, ".remotecode-workspace"), 65534, 65534);
  const beforeOrphan = readFileSync(databasePath);
  expect((await request(app, orphanId, "/folder", "POST", { requestId: orphanRequest })).status).toBe(503);
  expect(readFileSync(databasePath)).toEqual(beforeOrphan);
  expectOwner(orphan, 65534, 65534, 0o700);
});

it.skipIf(!rootLinux)("recovers only the original folder intent and published file witness with their persisted owner", async () => {
  const { databasePath, workspaceId, folderPath } = setup();
  const app = protectedApp(databasePath);
  const requestId = crypto.randomUUID();
  const database = new Database(databasePath);
  try {
    database.exec("CREATE TRIGGER reject_identity_folder BEFORE UPDATE OF state ON workspace_folder_requests BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END");
    expect((await request(app, workspaceId, "/folder", "POST", { requestId })).status).toBe(503);
    const inode = expectOwner(folderPath, 65534, 65534, 0o700).ino;
    expect(database.query("SELECT state, folder_uid, folder_gid FROM workspace_folder_requests").get()).toEqual({ state: "pending", folder_uid: 65534, folder_gid: 65534 });
    database.exec("DROP TRIGGER reject_identity_folder");
    const defaultPolicy = new Elysia().use(workspaceFoldersFeature(databasePath).routes).use(workspaceFilesFeature(databasePath));
    expect((await request(defaultPolicy, workspaceId, "/folder", "POST", { requestId: crypto.randomUUID() })).status).toBe(409);
    expect((await request(defaultPolicy, workspaceId, "/folder", "POST", { requestId })).status).toBe(200);
    expect(lstatSync(folderPath).ino).toBe(inode);
    database.exec("CREATE TRIGGER reject_identity_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END");
    const createId = crypto.randomUUID();
    expect((await request(app, workspaceId, "/files", "POST", { requestId: createId, path: "recover.txt", content: "once" })).status).toBe(503);
    const file = join(folderPath, "recover.txt");
    const published = expectOwner(file, 65534, 65534, 0o600);
    expect(database.query("SELECT state, stage_inode FROM file_operation_intents WHERE request_id = ?").get(createId))
      .toEqual({ state: "prepared", stage_inode: String(published.ino) });
    database.exec("DROP TRIGGER reject_identity_outcome");
    chownSync(file, 0, 0);
    const before = readFileSync(databasePath);
    expect((await request(defaultPolicy, workspaceId, `/files/receipts/${createId}`)).status).toBe(503);
    expect(readFileSync(databasePath)).toEqual(before);
    chownSync(file, 65534, 65534);
    expect((await request(defaultPolicy, workspaceId, `/files/receipts/${createId}`)).status).toBe(200);
    expect((await request(defaultPolicy, workspaceId, "/files", "POST", { requestId: createId, path: "recover.txt", content: "once" })).status).toBe(200);
    expect(expectOwner(file, 65534, 65534, 0o600).ino).toBe(published.ino);
    expect(database.query("SELECT count(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(createId)).toEqual({ count: 1 });
  } finally { database.close(); }
});

it.skipIf(!rootLinux)("rejects fchown sentinel identities before an intent or partial filesystem ownership change", async () => {
  const { databasePath, workspaceId, folderPath } = setup();
  for (const identity of [{ uid: 0xffffffff, gid: 65534 }, { uid: 65534, gid: 0xffffffff }]) {
    const before = readFileSync(databasePath);
    const requestId = crypto.randomUUID();
    const feature = workspaceFoldersFeature(databasePath, fsyncSync, identity);
    const app = new Elysia().use(feature.routes);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await request(app, workspaceId, "/folder", "POST", { requestId })).status).toBe(503);
      expect(existsSync(folderPath)).toBe(false);
      expect(readFileSync(databasePath)).toEqual(before);
    }
    expect(feature.isReady()).toBe(false);
    const database = new Database(databasePath, { readonly: true });
    try { expect(database.query("SELECT count(*) AS count FROM workspace_folder_requests").get()).toEqual({ count: 0 }); }
    finally { database.close(); }
  }
});
