import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApi } from "../app";
import { workspaceFoldersFeature } from "./workspace-folders";

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(process.env.RC029_TEST_WORK_DIR ?? tmpdir(), "rc029-folder-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const app = createApi(path);
  const database = new Database(path);
  for (const [token, user] of [["a".repeat(64), "alice"], ["b".repeat(64), "bob"]]) {
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), user, Date.now() + 60_000);
  }
  database.close();
  return { app, path };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function request(method: string, route: string, body?: unknown, token = "a") {
  return new Request(`http://localhost/api/workspaces${route}`, {
    method,
    headers: { "content-type": "application/json", cookie: `remotecode_session=${token.repeat(64)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function insertWorkspace(path: string, id: string, userId = "alice", archived = 0) {
  const database = new Database(path);
  try {
    database.query("INSERT INTO workspaces (id, user_id, name, created_at, archived) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, "workspace", new Date().toISOString(), archived);
  } finally { database.close(); }
}

function provisionInNewProcess(path: string, workspaceId: string, requestId: string) {
  const script = `
    import { createApi } from "./apps/api/src/app.ts";
    const app = createApi(process.env.DATABASE_PATH);
    const response = await app.handle(new Request(
      "http://localhost/api/workspaces/" + process.env.RC029_WORKSPACE_ID + "/folder",
      { method: "POST", headers: { cookie: "remotecode_session=" + "a".repeat(64), "content-type": "application/json" },
        body: JSON.stringify({ requestId: process.env.RC029_REQUEST_ID }) },
    ));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    if (response.status !== 200) process.exitCode = 1;
  `;
  const child = Bun.spawnSync(["bun", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: path, RC029_WORKSPACE_ID: workspaceId, RC029_REQUEST_ID: requestId },
  });
  return { exitCode: child.exitCode, output: child.stdout.toString().trim() };
}

it.skipIf(process.platform !== "linux")("syncs real directory ancestors while the SQLite intent remains pending", async () => {
  const { path } = setup();
  const workspaceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  const syncPaths: string[] = [];
  const statesAtSync: unknown[] = [];
  const feature = workspaceFoldersFeature(path, (fd) => {
    fsyncSync(fd);
    syncPaths.push(realpathSync(`/proc/self/fd/${fd}`));
    const database = new Database(path, { readonly: true, create: false });
    statesAtSync.push(database.query("SELECT state FROM workspace_folder_requests WHERE request_id = ?")
      .get(requestId));
    database.close();
  });
  const app = new Elysia().use(feature.routes);
  const response = await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }));
  expect(response.status).toBe(200);
  const root = realpathSync(dirname(path));
  expect(syncPaths).toEqual([
    join(root, "workspaces", workspaceId),
    join(root, "workspaces"),
    root,
  ]);
  expect(statesAtSync).toEqual([
    { state: "pending" },
    { state: "pending" },
    { state: "pending" },
  ]);
  const replaySyncCount = syncPaths.length;
  expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }))).status).toBe(200);
  expect(syncPaths).toHaveLength(replaySyncCount);
  const database = new Database(path);
  try {
    expect(database.query("SELECT state FROM workspace_folder_requests WHERE request_id = ?").get(requestId))
      .toEqual({ state: "provisioned" });
  } finally { database.close(); }
});

it.skipIf(process.platform !== "linux")("serializes archive with folder filesystem confirmation across API processes", async () => {
  const { app, path } = setup();
  const created = await app.handle(request("POST", "", { name: "workspace", requestId: crypto.randomUUID() }));
  expect(created.status).toBe(201);
  const workspaceId = (await created.json() as { id: string }).id;
  const archiveId = crypto.randomUUID();
  let attempted = false;
  let archiveStatus: number | undefined;
  const feature = workspaceFoldersFeature(path, (fd) => {
    fsyncSync(fd);
    if (attempted) return;
    attempted = true;
    const child = Bun.spawnSync(["bun", "-e", `
      import { createApi } from "./apps/api/src/app.ts";
      const app = createApi(process.env.DATABASE_PATH);
      const response = await app.handle(new Request(
        "http://localhost/api/workspaces/" + process.env.RC029_WORKSPACE_ID,
        { method: "PATCH", headers: { cookie: "remotecode_session=" + "a".repeat(64), "content-type": "application/json" },
          body: JSON.stringify({ requestId: process.env.RC029_ARCHIVE_ID, archived: true }) },
      ));
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: path, RC029_WORKSPACE_ID: workspaceId, RC029_ARCHIVE_ID: archiveId },
    });
    expect(child.exitCode).toBe(0);
    archiveStatus = JSON.parse(child.stdout.toString()).status;
  });
  const folderApp = new Elysia().use(feature.routes);
  expect((await folderApp.handle(request("POST", `/${workspaceId}/folder`, { requestId: crypto.randomUUID() }))).status).toBe(200);
  expect(attempted).toBe(true);
  expect(archiveStatus).toBe(503);
  const database = new Database(path, { readonly: true, create: false });
  try {
    expect(database.query("SELECT archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ archived: 0 });
    expect(database.query("SELECT state FROM workspace_folder_requests WHERE workspace_id = ?").get(workspaceId))
      .toEqual({ state: "provisioned" });
    expect(database.query("SELECT COUNT(*) AS count FROM workspace_change_requests WHERE request_id = ?").get(archiveId))
      .toEqual({ count: 0 });
  } finally { database.close(); }
  expect((await app.handle(request("PATCH", `/${workspaceId}`, { requestId: archiveId, archived: true }))).status).toBe(200);
  expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId: crypto.randomUUID() }))).status).toBe(409);
});

it.skipIf(process.platform !== "linux")("provisions stable owner-bound folder once and recovers the same keyed outcome after process restart", async () => {
  const { app, path } = setup();
  const workspaceRequestId = crypto.randomUUID();
  const created = await app.handle(request("POST", "", { requestId: workspaceRequestId, name: "workspace" }));
  expect(created.status).toBe(201);
  const workspaceId = (await created.json() as { id: string }).id;
  const requestId = crypto.randomUUID();
  const first = provisionInNewProcess(path, workspaceId, requestId);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.output)).toEqual({ status: 200, body: { workspaceId, state: "provisioned" } });

  const folderPath = join(dirname(path), "workspaces", workspaceId);
  expect(lstatSync(folderPath).isDirectory()).toBe(true);
  expect(realpathSync(folderPath)).toBe(folderPath);
  expect(lstatSync(folderPath).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(dirname(path), "workspaces")).isDirectory()).toBe(true);
  expect(readFileSync(join(folderPath, ".remotecode-workspace"), "utf8")).toBe(`${requestId}\n`);

  const retry = provisionInNewProcess(path, workspaceId, requestId);
  expect(retry.exitCode).toBe(0);
  expect(JSON.parse(retry.output)).toEqual({ status: 200, body: { workspaceId, state: "provisioned" } });
  const database = new Database(path);
  try {
    expect(database.query("SELECT state FROM workspace_folder_requests WHERE user_id = 'alice' AND request_id = ?")
      .get(requestId)).toEqual({ state: "provisioned" });
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE user_id = 'alice'").get()).toEqual({ count: 1 });
  } finally { database.close(); }
  expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId: crypto.randomUUID() }))).status).toBe(409);
});

it.skipIf(process.platform !== "linux")("never recreates an accepted folder whose filesystem outcome was lost", async () => {
  const { app, path } = setup();
  const workspaceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }))).status).toBe(200);
  const folderPath = join(dirname(path), "workspaces", workspaceId);
  const database = new Database(path);
  const accepted = database.query("SELECT state, folder_device AS device, folder_inode AS inode FROM workspace_folder_requests WHERE request_id = ?")
    .get(requestId);
  database.close();
  rmSync(folderPath, { recursive: true });

  const restarted = createApi(path);
  const response = await restarted.handle(request("POST", `/${workspaceId}/folder`, { requestId }));
  expect(response.status).toBe(503);
  expect((await import("node:fs")).existsSync(folderPath)).toBe(false);
  const after = new Database(path);
  try {
    expect(after.query("SELECT state, folder_device AS device, folder_inode AS inode FROM workspace_folder_requests WHERE request_id = ?")
      .get(requestId)).toEqual(accepted);
  } finally { after.close(); }
});

it.skipIf(process.platform !== "linux")("does not allocate a folder when the durable intent insert fails", async () => {
  const { app, path } = setup();
  const workspaceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  const database = new Database(path);
  database.exec(`
    CREATE TRIGGER reject_folder_intent BEFORE INSERT ON workspace_folder_requests
    BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END
  `);
  database.close();

  expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }))).status).toBe(503);
  expect(existsSync(join(dirname(path), "workspaces"))).toBe(false);
  const after = new Database(path);
  expect(after.query("SELECT count(*) AS count FROM workspace_folder_requests WHERE request_id = ?").get(requestId))
    .toEqual({ count: 0 });
  after.exec("DROP TRIGGER reject_folder_intent");
  after.close();

  expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }))).status).toBe(200);
});

it.skipIf(process.platform !== "linux")("recovers a durable folder marker after outcome finalization fails", async () => {
  const { app, path } = setup();
  const workspaceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  const database = new Database(path);
  database.exec(`
    CREATE TRIGGER reject_folder_finalization BEFORE UPDATE OF state ON workspace_folder_requests
    BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END
  `);
  database.close();

  const first = await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }));
  expect(first.status).toBe(503);
  const folderPath = join(dirname(path), "workspaces", workspaceId);
  expect(readFileSync(join(folderPath, ".remotecode-workspace"), "utf8")).toBe(`${requestId}\n`);
  const pending = new Database(path);
  expect(pending.query("SELECT state, folder_device AS device FROM workspace_folder_requests WHERE request_id = ?")
    .get(requestId)).toEqual({ state: "pending", device: null });
  pending.exec("DROP TRIGGER reject_folder_finalization");
  pending.close();

  const retry = await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }));
  expect(retry.status).toBe(200);
  const finalized = new Database(path);
  try {
    expect(finalized.query("SELECT state, folder_device AS device FROM workspace_folder_requests WHERE request_id = ?")
      .get(requestId)).toEqual({ state: "provisioned", device: String(lstatSync(folderPath).dev) });
  } finally { finalized.close(); }
});

it.skipIf(process.platform !== "linux")("refuses a workspace symlink without touching its target", async () => {
  const { app, path } = setup();
  const workspaceId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  const workspaces = join(dirname(path), "workspaces");
  const target = join(dirname(path), "outside");
  mkdirSync(workspaces, { mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(workspaces, workspaceId));

  const response = await app.handle(request("POST", `/${workspaceId}/folder`, { requestId: crypto.randomUUID() }));
  expect(response.status).toBe(503);
  expect(lstatSync(join(workspaces, workspaceId)).isSymbolicLink()).toBe(true);
  expect((await import("node:fs")).readdirSync(target)).toEqual([]);
});

it("does not allocate folders from workspace reads and denies foreign or archived workspaces", async () => {
  const { app, path } = setup();
  const foreignId = crypto.randomUUID();
  const archivedId = crypto.randomUUID();
  insertWorkspace(path, foreignId, "bob");
  insertWorkspace(path, archivedId, "alice", 1);

  expect((await app.handle(request("GET", `/${foreignId}`))).status).toBe(404);
  expect((await app.handle(request("POST", `/${foreignId}/folder`, { requestId: crypto.randomUUID() }))).status).toBe(404);
  expect((await app.handle(request("POST", `/${archivedId}/folder`, { requestId: crypto.randomUUID() }))).status).toBe(409);
  expect((await app.handle(request("GET", `/${archivedId}`))).status).toBe(200);
  expect(existsSync(join(dirname(path), "workspaces"))).toBe(false);
});

it.skipIf(process.platform !== "linux")("rejects a borrowed workspace parent with unsafe mode without changing it", async () => {
  const { app, path } = setup();
  const workspaceId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  const workspaces = join(dirname(path), "workspaces");
  mkdirSync(workspaces, { mode: 0o700 });
  chmodSync(workspaces, 0o777);

  const requestId = crypto.randomUUID();
  const response = await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }));
  expect(response.status).toBe(503);
  expect(lstatSync(workspaces).mode & 0o777).toBe(0o777);
  expect(existsSync(join(workspaces, workspaceId))).toBe(false);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    chownSync(workspaces, 65534, 65534);
    chmodSync(workspaces, 0o700);
    expect((await app.handle(request("POST", `/${workspaceId}/folder`, { requestId }))).status).toBe(503);
    expect(lstatSync(workspaces).uid).toBe(65534);
    expect(existsSync(join(workspaces, workspaceId))).toBe(false);
  }
});

it("keeps liveness available and does not repair a missing folder schema", async () => {
  const { app, path } = setup();
  const workspaceId = crypto.randomUUID();
  insertWorkspace(path, workspaceId);
  const database = new Database(path);
  database.exec("DROP TABLE workspace_folder_requests");
  database.close();

  expect((await app.handle(new Request("http://localhost/api/health/live"))).status).toBe(200);
  expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
  const restarted = createApi(path);
  expect((await restarted.handle(new Request("http://localhost/api/health/live"))).status).toBe(200);
  expect((await restarted.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
  expect((await restarted.handle(request("POST", `/${workspaceId}/folder`, { requestId: crypto.randomUUID() }))).status).toBe(503);
  expect(existsSync(join(dirname(path), "workspaces"))).toBe(false);
});
