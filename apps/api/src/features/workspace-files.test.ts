import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApi } from "../app";
import { createApiClient } from "../../../../packages/client/src";
import { workspaceFilesFeature } from "./workspace-files";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const foreignToken = "b".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC029_TEST_WORK_DIR ?? tmpdir(), "rc029-files-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  for (const [token, userId] of [[ownerToken, "alice"], [foreignToken, "bob"]]) {
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), userId, Date.now() + 60_000);
  }
  const workspaceId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
    .run(workspaceId, new Date().toISOString());
  database.close();
  return { app, databasePath, workspaceId, folderPath: join(dirname(databasePath), "workspaces", workspaceId) };
}

afterEach(() => { for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function request(app: { handle: (request: Request) => Promise<Response> }, route: string, token?: string, method = "GET", body?: unknown) {
  return app.handle(new Request(`http://localhost/api/workspaces${route}`, {
    method,
    headers: { ...(token ? { cookie: `remotecode_session=${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function provision(app: ReturnType<typeof createApi>, workspaceId: string) {
  const response = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/folder`, {
    method: "POST",
    headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
  }));
  expect(response.status).toBe(200);
}

function archiveInChild(databasePath: string, workspaceId: string, requestId: string) {
  const child = Bun.spawnSync(["bun", "-e", `
    import { createApi } from "./apps/api/src/app.ts";
    const app = createApi(process.env.DATABASE_PATH);
    const response = await app.handle(new Request("http://localhost/api/workspaces/" + process.env.RC029_WORKSPACE_ID,
      { method: "PATCH", headers: { cookie: "remotecode_session=" + "a".repeat(64), "content-type": "application/json" },
        body: JSON.stringify({ requestId: process.env.RC029_REQUEST_ID, archived: true }) }));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: databasePath, RC029_WORKSPACE_ID: workspaceId, RC029_REQUEST_ID: requestId } });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as { status: number; body: unknown };
}

it.skipIf(process.platform !== "linux")("lists and opens real nested workspace files, hashes literal bytes, and never creates directories on reads", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  expect(existsSync(join(dirname(databasePath), "workspaces"))).toBe(false);
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(404);
  expect(existsSync(join(dirname(databasePath), "workspaces"))).toBe(false);

  await provision(app, workspaceId);
  const nested = join(folderPath, "src");
  mkdirSync(nested);
  const file = join(nested, "hello.txt");
  const bytes = Buffer.from("hello \u{1f30d}\n");
  writeFileSync(file, bytes);

  const root = await request(app, `/${workspaceId}/files`, ownerToken);
  expect(root.status).toBe(200);
  expect(await root.json()).toEqual({ path: "", entries: [{ name: "src", type: "directory", size: 0 }] });
  const listing = await request(app, `/${workspaceId}/files?path=src`, ownerToken);
  expect(await listing.json()).toEqual({ path: "src", entries: [{ name: "hello.txt", type: "file", size: bytes.length }] });
  const route = `/${workspaceId}/files/content?path=${encodeURIComponent("src/hello.txt")}`;
  const opened = await request(app, route, ownerToken);
  expect(opened.status).toBe(200);
  const openedBody = await opened.json() as { path: string; content: string; version: string };
  expect(openedBody).toEqual({
    path: "src/hello.txt",
    content: "hello \u{1f30d}\n",
    version: createHash("sha256").update(bytes).digest("hex"),
  });
  const changedBytes = Buffer.from("HELLO \u{1f30e}\n");
  expect(changedBytes.length).toBe(bytes.length);
  writeFileSync(file, changedBytes);
  const changed = await (await request(app, route, ownerToken)).json() as { version: string };
  expect(changed.version).toBe(createHash("sha256").update(changedBytes).digest("hex"));
  expect(changed.version).not.toBe(openedBody.version);
  expect(readFileSync(file, "utf8")).toBe("HELLO \u{1f30e}\n");
});

it.skipIf(process.platform !== "linux")("preserves exact UTF-8 BOM bytes and typed versions through the shared Eden client", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const bytes = Buffer.from("\uFEFFhello\n", "utf8");
  writeFileSync(join(folderPath, "bom.txt"), bytes);
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("File API did not bind");
  try {
    const client = createApiClient(`http://127.0.0.1:${port}`, { headers: { cookie: `remotecode_session=${ownerToken}` } });
    const listing = await client.api.workspaces({ workspaceId }).files.get();
    if (listing.error || !listing.data || !("entries" in listing.data)) throw new Error("File list unavailable");
    const entries: { name: string; type: "file" | "directory"; size: number }[] = listing.data.entries;
    expect(entries).toEqual([{ name: "bom.txt", type: "file", size: bytes.length }]);
    const opened = await client.api.workspaces({ workspaceId }).files.content.get({ query: { path: "bom.txt" } });
    if (opened.error || !opened.data || !("content" in opened.data)) throw new Error("File content unavailable");
    const content: string = opened.data.content;
    const version: string = opened.data.version;
    expect(Buffer.from(content, "utf8")).toEqual(bytes);
    expect(version).toBe(createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"));
  } finally { await app.stop(true); }
});

it.skipIf(process.platform !== "linux")("keeps accepted archived files readable and returns identical private-workspace misses", async () => {
  const { app, workspaceId, folderPath } = setup();

  const anonymous = await request(app, `/${workspaceId}/files`);
  expect(anonymous.status).toBe(401);
  await provision(app, workspaceId);
  writeFileSync(join(folderPath, "kept.txt"), "persisted");
  const foreign = await request(app, `/${workspaceId}/files`, foreignToken);
  const missing = await request(app, `/${crypto.randomUUID()}/files`, foreignToken);
  expect(foreign.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(await foreign.json()).toEqual(await missing.json());
  expect((await request(app, `/${workspaceId}/files/content?path=kept.txt`, foreignToken)).status).toBe(404);

  const archived = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ archived: true, requestId: crypto.randomUUID() }),
  }));
  expect(archived.status).toBe(200);
  const opened = await request(app, `/${workspaceId}/files/content?path=kept.txt`, ownerToken);
  expect(opened.status).toBe(200);
  expect(await opened.json()).toMatchObject({ path: "kept.txt", content: "persisted" });
});

it.skipIf(process.platform !== "linux")("rejects unsafe paths, marker access, symlinks, FIFOs, binary text, and oversized files without blocking", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  writeFileSync(join(folderPath, "binary.bin"), Buffer.from([0xff, 0xfe]));
  writeFileSync(join(folderPath, "nul.bin"), Buffer.from([0, 65]));
  writeFileSync(join(folderPath, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
  writeFileSync(join(folderPath, "target.txt"), "secret");
  symlinkSync("target.txt", join(folderPath, "link.txt"));
  const fifo = Bun.spawnSync(["mkfifo", join(folderPath, "pipe")]);
  expect(fifo.exitCode).toBe(0);

  for (const path of ["../target.txt", "/target.txt", "a//b", "a/../b", ".remotecode-workspace", "a\0b"]) {
    const response = await request(app, `/${workspaceId}/files/content?path=${encodeURIComponent(path)}`, ownerToken);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain(folderPath);
  }
  expect((await request(app, `/${workspaceId}/files/content?path=link.txt`, ownerToken)).status).toBe(404);
  expect((await request(app, `/${workspaceId}/files/content?path=pipe`, ownerToken)).status).toBe(415);
  expect((await request(app, `/${workspaceId}/files/content?path=binary.bin`, ownerToken)).status).toBe(415);
  expect((await request(app, `/${workspaceId}/files/content?path=nul.bin`, ownerToken)).status).toBe(415);
  expect((await request(app, `/${workspaceId}/files/content?path=large.txt`, ownerToken)).status).toBe(413);
  const listing = await request(app, `/${workspaceId}/files`, ownerToken);
  const body = JSON.stringify(await listing.json());
  expect(body).not.toContain(".remotecode-workspace");
  expect(body).not.toContain("link.txt");
  expect(body).not.toContain("pipe");
  const opened = await request(app, `/${workspaceId}/files/content?path=target.txt`, ownerToken);
  expect(JSON.stringify(await opened.json())).not.toContain(folderPath);

  const marker = join(folderPath, ".remotecode-workspace");
  unlinkSync(marker);
  symlinkSync("target.txt", marker);
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(503);
  unlinkSync(marker);
  const markerFifo = Bun.spawnSync(["mkfifo", marker]);
  expect(markerFifo.exitCode).toBe(0);
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(503);
});

it.skipIf(process.platform !== "linux")("fails unavailable when a previously accepted folder is missing and does not recreate it", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  rmSync(folderPath, { recursive: true });
  const response = await request(app, `/${workspaceId}/files`, ownerToken);
  expect(response.status).toBe(503);
  expect(existsSync(folderPath)).toBe(false);
});

it.skipIf(process.platform !== "linux")("returns 503 without archiving when PATCH races CREATE under its SQLite writer lock", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const archiveId = crypto.randomUUID();
  let archive: { status: number; body: unknown } | undefined;
  let attempted = false;
  const files = new Elysia().use(workspaceFilesFeature(databasePath, (fd) => {
    fsyncSync(fd);
    if (!attempted) {
      attempted = true;
      archive = archiveInChild(databasePath, workspaceId, archiveId);
    }
  }));
  const response = await request(files, `/${workspaceId}/files`, ownerToken, "POST", {
    requestId, path: "locked.txt", content: "created",
  });
  expect(response.status).toBe(201);
  expect(attempted).toBe(true);
  expect(archive).toMatchObject({ status: 503 });
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.query("SELECT archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ archived: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM workspace_change_requests WHERE request_id = ?").get(archiveId)).toEqual({ count: 0 });
    expect(database.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "completed" });
    expect(database.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 1 });
  } finally { database.close(); }
  expect(readFileSync(join(folderPath, "locked.txt"), "utf8")).toBe("created");
});

it.skipIf(process.platform !== "linux")("returns 409 when archive wins after CREATE is prepared and retains its stage without replay", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const archiveId = crypto.randomUUID();
  let archive: { status: number; body: unknown } | undefined;
  let preparedBoundary = false;
  const files = new Elysia().use(workspaceFilesFeature(databasePath, (fd) => {
    fsyncSync(fd);
    if (preparedBoundary) return;
    const database = new Database(databasePath, { readonly: true });
    let prepared = false;
    try { prepared = database.query<{ state: string }, [string]>("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)?.state === "prepared"; }
    finally { database.close(); }
    if (prepared) {
      preparedBoundary = true;
      archive = archiveInChild(databasePath, workspaceId, archiveId);
    }
  }));
  const body = { requestId, path: "prepared.txt", content: "staged" };
  const response = await request(files, `/${workspaceId}/files`, ownerToken, "POST", body);
  expect(response.status).toBe(409);
  expect(preparedBoundary).toBe(true);
  expect(archive).toMatchObject({ status: 200 });
  const stage = join(folderPath, `.remotecode-stage-${requestId}`);
  expect(existsSync(stage)).toBe(true);
  expect(existsSync(join(folderPath, body.path))).toBe(false);
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.query("SELECT archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ archived: 1 });
    expect(database.query("SELECT state, stage_digest FROM file_operation_intents WHERE request_id = ?").get(requestId))
      .toEqual({ state: "prepared", stage_digest: createHash("sha256").update(body.content).digest("hex") });
    expect(database.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM workspace_change_requests WHERE request_id = ?").get(archiveId)).toEqual({ count: 1 });
  } finally { database.close(); }
  expect((await request(files, `/${workspaceId}/files`, ownerToken, "POST", body)).status).toBe(503);
  expect(existsSync(stage)).toBe(true);
  expect(existsSync(join(folderPath, body.path))).toBe(false);
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("creates exact UTF-8 bytes once and returns the immutable canonical receipt through Elysia and Eden", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("File API did not bind");
  const requestId = crypto.randomUUID();
  const body = { requestId: requestId.toUpperCase(), path: "drafts/note.txt", content: "\uFEFFhello\n" };
  mkdirSync(join(folderPath, "drafts"));
  try {
    const client = createApiClient(`http://127.0.0.1:${port}`, { headers: { cookie: `remotecode_session=${ownerToken}` } });
    const first = await client.api.workspaces({ workspaceId }).files.post(body);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ requestId, workspaceId, kind: "create", path: body.path });
    const bytes = Buffer.from(body.content, "utf8");
    const target = join(folderPath, body.path);
    expect(readFileSync(target)).toEqual(bytes);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    const inode = lstatSync(target).ino;
    const again = await client.api.workspaces({ workspaceId }).files.post(body);
    expect(again.data).toEqual(first.data);
    expect(lstatSync(target).ino).toBe(inode);
    const changed = await request(app, `/${workspaceId}/files`, ownerToken, "POST", { ...body, content: "changed" });
    expect(changed.status).toBe(409);
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { ...body, path: "other.txt" })).status).toBe(409);
    const receipt = await client.api.workspaces({ workspaceId }).files.receipts({ requestId: body.requestId }).get();
    expect(JSON.stringify(receipt.data)).toBe(JSON.stringify(first.data));
    expect((await request(app, `/${crypto.randomUUID()}/files/receipts/${requestId}`, ownerToken)).status).toBe(404);
    const read = await client.api.workspaces({ workspaceId }).files.content.get({ query: { path: body.path } });
    expect(read.data).toMatchObject({ path: body.path, content: body.content, version: createHash("sha256").update(bytes).digest("hex") });
  } finally { await app.stop(true); }
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "completed" });
    expect(database.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 1 });
  } finally { database.close(); }
});

it.skipIf(process.platform !== "linux")("publishes the witnessed stage inode by FD and preserves a replaced stage pathname", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const stage = join(folderPath, `.remotecode-stage-${requestId}`);
  const parked = `${stage}.parked`;
  const target = join(folderPath, "fd-published.txt");
  let swapped = false;
  let stageInode = 0;
  const files = new Elysia().use(workspaceFilesFeature(databasePath, (fd) => {
    fsyncSync(fd);
    if (swapped) return;
    const database = new Database(databasePath, { readonly: true });
    let prepared = false;
    try { prepared = database.query<{ state: string }, [string]>("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)?.state === "prepared"; }
    finally { database.close(); }
    if (prepared) {
      swapped = true;
      stageInode = lstatSync(stage).ino;
      renameSync(stage, parked);
      writeFileSync(stage, "replacement stage path");
    }
  }));
  const response = await request(files, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "fd-published.txt", content: "original staged bytes" });
  expect(response.status).toBe(201);
  expect(swapped).toBe(true);
  expect(lstatSync(target).ino).toBe(stageInode);
  expect(readFileSync(target, "utf8")).toBe("original staged bytes");
  expect(readFileSync(stage, "utf8")).toBe("replacement stage path");
  expect(JSON.parse(await response.text())).toMatchObject({ version: createHash("sha256").update("original staged bytes").digest("hex") });
  unlinkSync(parked);
});

it.skipIf(process.platform !== "linux")("does not recreate a file when an accepted outcome survives a missing intent", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const body = { requestId, path: "accepted-then-missing.txt", content: "accepted" };
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", body)).status).toBe(201);
  const target = join(folderPath, body.path);
  rmSync(target);
  const damage = new Database(databasePath);
  damage.exec("PRAGMA foreign_keys = OFF");
  damage.query("DELETE FROM file_operation_intents WHERE request_id = ?").run(requestId);
  damage.close();
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", body)).status).toBe(503);
  expect(existsSync(target)).toBe(false);
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 1 });
  } finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("validates receipt intent and owner while keeping receipt historical", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const target = join(folderPath, "historical.txt");
  const body = { requestId, path: "historical.txt", content: "original" };
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", body)).status).toBe(201);
  writeFileSync(target, "edited outside the API");
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(200);
  writeFileSync(target, "original");
  const database = new Database(databasePath);
  database.query("UPDATE file_operation_intents SET destination_path = 'mismatched.txt' WHERE request_id = ?").run(requestId);
  database.close();
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
  const restore = new Database(databasePath);
  restore.query("UPDATE file_operation_intents SET destination_path = ? WHERE request_id = ?").run(body.path, requestId);
  restore.query("UPDATE workspaces SET user_id = 'bob' WHERE id = ?").run(workspaceId);
  restore.close();
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(404);
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, foreignToken)).status).toBe(404);
  const ownerAgain = new Database(databasePath);
  ownerAgain.query("UPDATE workspaces SET user_id = 'alice' WHERE id = ?").run(workspaceId);
  ownerAgain.close();
  rmSync(target);
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(200);
});

it.skipIf(process.platform !== "linux")("keeps oversized, changed-mode, and FIFO recovery witnesses unknown without blocking", async () => {
  for (const damage of ["oversized", "mode", "fifo"] as const) {
    const { app, databasePath, workspaceId, folderPath } = setup();
    await provision(app, workspaceId);
    const requestId = crypto.randomUUID();
    const target = join(folderPath, `${damage}-witness.txt`);
    const failOutcome = new Database(databasePath);
    failOutcome.exec("CREATE TRIGGER fail_file_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END");
    failOutcome.close();
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: `${damage}-witness.txt`, content: "witness" })).status).toBe(503);
    if (damage === "oversized") {
      const originalInode = lstatSync(target).ino;
      writeFileSync(target, Buffer.alloc(1024 * 1024 + 1, 65));
      expect(lstatSync(target).ino).toBe(originalInode);
    } else if (damage === "mode") chmodSync(target, 0o644);
    else { rmSync(target); expect(Bun.spawnSync(["mkfifo", target]).exitCode).toBe(0); }
    const removeTrigger = new Database(databasePath);
    removeTrigger.exec("DROP TRIGGER fail_file_outcome");
    removeTrigger.close();
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
    const verify = new Database(databasePath, { readonly: true });
    try {
      expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    } finally { verify.close(); }
  }
});

it.skipIf(process.platform !== "linux")("leaves a preexisting destination untouched and rejects foreign owners and archived workspaces", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const target = join(folderPath, "existing.txt");
  writeFileSync(target, "original");
  symlinkSync("existing.txt", join(folderPath, "link.txt"));
  expect(Bun.spawnSync(["mkfifo", join(folderPath, "pipe")]).exitCode).toBe(0);
  const requestId = crypto.randomUUID();
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "existing.txt", content: "replacement" })).status).toBe(409);
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "link.txt", content: "replacement" })).status).toBe(409);
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "pipe", content: "replacement" })).status).toBe(409);
  expect(readFileSync(target, "utf8")).toBe("original");
  expect((await request(app, `/${workspaceId}/files`, foreignToken, "POST", { requestId: crypto.randomUUID(), path: "other.txt", content: "x" })).status).toBe(404);
  const archived = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}`, {
    method: "PATCH", headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ archived: true, requestId: crypto.randomUUID() }),
  }));
  expect(archived.status).toBe(200);
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "later.txt", content: "x" })).status).toBe(409);
  expect(existsSync(join(folderPath, "later.txt"))).toBe(false);
});

it.skipIf(process.platform !== "linux")("recovers one published inode after SQL outcome failure without repeating publication", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const target = join(folderPath, "after-crash.txt");
  const database = new Database(databasePath);
  database.exec(`CREATE TRIGGER fail_file_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END`);
  database.close();
  const response = await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "after-crash.txt", content: "durable" });
  expect(response.status).toBe(503);
  expect(existsSync(target)).toBe(true);
  expect(existsSync(join(folderPath, `.remotecode-stage-${requestId}`))).toBe(true);
  const inode = lstatSync(target).ino;
  const repair = new Database(databasePath);
  repair.exec("DROP TRIGGER fail_file_outcome");
  repair.close();
  const child = Bun.spawnSync(["bun", "-e", `
    import { createApi } from "./apps/api/src/app.ts";
    const app = createApi(process.env.DATABASE_PATH);
    const response = await app.handle(new Request("http://localhost/api/workspaces/" + process.env.RC029_WORKSPACE_ID + "/files/receipts/" + process.env.RC029_REQUEST_ID,
      { headers: { cookie: "remotecode_session=" + "a".repeat(64) } }));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: databasePath, RC029_WORKSPACE_ID: workspaceId, RC029_REQUEST_ID: requestId } });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).status).toBe(200);
  expect(lstatSync(target).ino).toBe(inode);
  expect(existsSync(join(folderPath, `.remotecode-stage-${requestId}`))).toBe(true);
  const restarted = createApi(databasePath);
  const replay = await request(restarted, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "after-crash.txt", content: "durable" });
  expect(replay.status).toBe(200);
  expect(lstatSync(target).ino).toBe(inode);
});

it.skipIf(process.platform !== "linux")("keeps missing or mismatched publication witnesses unknown and reserved", async () => {
  for (const damaged of ["missing", "mismatched"] as const) {
    const { app, databasePath, workspaceId, folderPath } = setup();
    await provision(app, workspaceId);
    const requestId = crypto.randomUUID();
    const target = join(folderPath, "witness.txt");
    const triggerDb = new Database(databasePath);
    triggerDb.exec(`CREATE TRIGGER fail_file_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END`);
    triggerDb.close();
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "witness.txt", content: "witness" })).status).toBe(503);
    expect(existsSync(target)).toBe(true);
    const inode = lstatSync(target).ino;
    const removeTrigger = new Database(databasePath);
    removeTrigger.exec("DROP TRIGGER fail_file_outcome");
    removeTrigger.close();
    if (damaged === "missing") rmSync(target);
    else { rmSync(target); writeFileSync(target, "witness"); expect(lstatSync(target).ino).not.toBe(inode); }
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "witness.txt", content: "witness" })).status).toBe(503);
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "other.txt", content: "new" })).status).toBe(503);
    const verify = new Database(databasePath, { readonly: true });
    try {
      expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    } finally { verify.close(); }
    expect(damaged === "missing" ? existsSync(target) : readFileSync(target, "utf8") === "witness").toBe(damaged === "mismatched");
  }
});

it.skipIf(process.platform !== "linux")("keeps a failed stage preparation unknown and never retries its stage or publication", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const target = join(folderPath, "failed-stage.txt");
  const stage = join(folderPath, `.remotecode-stage-${requestId}`);
  const triggerDb = new Database(databasePath);
  triggerDb.exec(`CREATE TRIGGER fail_file_stage BEFORE UPDATE OF state ON file_operation_intents WHEN NEW.state = 'prepared' BEGIN SELECT RAISE(ABORT, 'injected stage metadata failure'); END`);
  triggerDb.close();
  const body = { requestId, path: "failed-stage.txt", content: "staged" };
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", body)).status).toBe(503);
  expect(existsSync(stage)).toBe(true);
  expect(existsSync(target)).toBe(false);
  expect(JSON.stringify(await (await request(app, `/${workspaceId}/files`, ownerToken)).json())).not.toContain(`.remotecode-stage-${requestId}`);
  const removeTrigger = new Database(databasePath);
  removeTrigger.exec("DROP TRIGGER fail_file_stage");
  removeTrigger.close();
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", body)).status).toBe(503);
  expect(existsSync(stage)).toBe(true);
  expect(existsSync(target)).toBe(false);
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
});

it.skipIf(process.platform !== "linux")("persists no user-file effect when durable intent insertion fails", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const database = new Database(databasePath);
  database.exec(`CREATE TRIGGER fail_file_intent BEFORE INSERT ON file_operation_intents BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END`);
  database.close();
  const path = join(folderPath, "never-created.txt");
  const response = await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "never-created.txt", content: "x" });
  expect(response.status).toBe(503);
  expect(existsSync(path)).toBe(false);
  const verify = new Database(databasePath, { readonly: true });
  try { expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents").get()).toEqual({ count: 0 }); }
  finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("keeps unmatched receipts private and rejects malformed create inputs without a filesystem effect", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const id = crypto.randomUUID();
  expect((await request(app, `/${workspaceId}/files/receipts/${id}`, ownerToken)).status).toBe(404);
  expect((await request(app, `/${workspaceId}/files/receipts/${id}`, foreignToken)).status).toBe(404);
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: `urn:uuid:${id}`, path: "urn.txt", content: "x" })).status).toBe(422);
  expect((await request(app, `/${workspaceId}/files/receipts/urn%3Auuid%3A${id}`, ownerToken)).status).toBe(422);
  for (const [path, content] of [["../outside", "x"], [".remotecode-workspace", "x"], [".remotecode-stage-secret", "x"], ["n\u0000ul", "x"], ["invalid.txt", "\uD800"]]) {
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path, content })).status).toBe(400);
  }
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "large.txt", content: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
  expect(readdirSync(folderPath).filter((entry) => entry !== ".remotecode-workspace")).toEqual([]);
});

it.skipIf(process.platform !== "linux")("rolls back recovery when the outcome write still fails and later recovers the same inode", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const target = join(folderPath, "recovery-rollback.txt");
  const database = new Database(databasePath);
  database.exec("CREATE TRIGGER fail_recovery_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END");
  database.close();
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "recovery-rollback.txt", content: "durable" })).status).toBe(503);
  const inode = lstatSync(target).ino;
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
  const verify = new Database(databasePath);
  try {
    expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    verify.exec("DROP TRIGGER fail_recovery_outcome");
  } finally { verify.close(); }
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(200);
  expect(lstatSync(target).ino).toBe(inode);
  expect(readFileSync(target, "utf8")).toBe("durable");
});

it.skipIf(process.platform !== "linux")("keeps a corrupt prepared input digest unknown instead of confirming unrelated bytes", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  const database = new Database(databasePath);
  database.exec("CREATE TRIGGER fail_prepared_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END");
  database.close();
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "digest.txt", content: "original" })).status).toBe(503);
  const corrupt = new Database(databasePath);
  corrupt.exec("DROP TRIGGER fail_prepared_outcome");
  corrupt.query("UPDATE file_operation_intents SET input_digest = ? WHERE request_id = ?").run("0".repeat(64), requestId);
  corrupt.close();
  expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { verify.close(); }
  expect(readFileSync(join(folderPath, "digest.txt"), "utf8")).toBe("original");
});

it.skipIf(process.platform !== "linux")("refuses publication when prepared intent no longer binds the requested destination", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const requestId = crypto.randomUUID();
  let changed = false;
  const files = new Elysia().use(workspaceFilesFeature(databasePath, (fd) => {
    fsyncSync(fd);
    if (changed) return;
    const database = new Database(databasePath);
    try {
      if (database.query<{ state: string }, [string]>("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)?.state === "prepared") {
        database.query("UPDATE file_operation_intents SET destination_path = 'different.txt' WHERE request_id = ?").run(requestId);
        changed = true;
      }
    } finally { database.close(); }
  }));
  expect((await request(files, `/${workspaceId}/files`, ownerToken, "POST", { requestId, path: "bound.txt", content: "staged" })).status).toBe(503);
  expect(changed).toBe(true);
  expect(existsSync(join(folderPath, "bound.txt"))).toBe(false);
  expect(existsSync(join(folderPath, "different.txt"))).toBe(false);
  expect(readFileSync(join(folderPath, `.remotecode-stage-${requestId}`), "utf8")).toBe("staged");
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("saves with two real Eden clients, rejects stale versions, and preserves exact bytes and mode", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  mkdirSync(join(folderPath, "src"));
  const path = "src/script.sh";
  const target = join(folderPath, path);
  writeFileSync(target, "#!/bin/sh\nprintf 'before'\n");
  chmodSync(target, 0o751);
  const initialInode = lstatSync(target).ino;
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("File API did not bind");
  try {
    const clientOne = createApiClient(`http://127.0.0.1:${port}`, { headers: { cookie: `remotecode_session=${ownerToken}` } });
    const clientTwo = createApiClient(`http://127.0.0.1:${port}`, { headers: { cookie: `remotecode_session=${ownerToken}` } });
    const openedOne = await clientOne.api.workspaces({ workspaceId }).files.content.get({ query: { path } });
    const openedTwo = await clientTwo.api.workspaces({ workspaceId }).files.content.get({ query: { path } });
    if (openedOne.error || !openedOne.data || !("version" in openedOne.data) || openedTwo.error || !openedTwo.data || !("version" in openedTwo.data)) {
      throw new Error("Both clients must read the current file version");
    }
    expect(openedOne.data.version).toBe(openedTwo.data.version);
    const firstId = crypto.randomUUID();
    const firstBody = { requestId: firstId.toUpperCase(), path, expectedVersion: openedOne.data.version, content: "#!/bin/sh\nprintf 'first save'\n" };
    const firstSave = await clientOne.api.workspaces({ workspaceId }).files.content.put(firstBody);
    expect(firstSave.error).toBeNull();
    expect(firstSave.data).toMatchObject({ requestId: firstId, workspaceId, kind: "save", path });
    const firstBytes = Buffer.from(firstBody.content, "utf8");
    const firstVersion = createHash("sha256").update(firstBytes).digest("hex");
    expect(readFileSync(target)).toEqual(firstBytes);
    expect(lstatSync(target).mode & 0o777).toBe(0o751);
    const firstInode = lstatSync(target).ino;
    expect(firstInode).not.toBe(initialInode);
    const staleId = crypto.randomUUID();
    const stale = await clientTwo.api.workspaces({ workspaceId }).files.content.put({
      requestId: staleId, path, expectedVersion: openedTwo.data.version, content: "stale overwrite",
    });
    expect(stale.error?.status as number).toBe(409);
    expect(readFileSync(target)).toEqual(firstBytes);
    const secondId = crypto.randomUUID();
    const secondBody = { requestId: secondId, path, expectedVersion: firstVersion, content: "#!/bin/sh\nprintf 'second save'\n" };
    const secondSave = await clientTwo.api.workspaces({ workspaceId }).files.content.put(secondBody);
    expect(secondSave.error).toBeNull();
    expect(secondSave.data).toMatchObject({ requestId: secondId, kind: "save", path });
    const secondBytes = Buffer.from(secondBody.content, "utf8");
    expect(readFileSync(target)).toEqual(secondBytes);
    expect(lstatSync(target).mode & 0o777).toBe(0o751);
    const secondInode = lstatSync(target).ino;
    expect(secondInode).not.toBe(firstInode);
    const replay = await clientOne.api.workspaces({ workspaceId }).files.content.put(firstBody);
    expect(replay.data).toEqual(firstSave.data);
    expect(lstatSync(target).ino).toBe(secondInode);
    const changedReplay = await clientOne.api.workspaces({ workspaceId }).files.content.put({ ...firstBody, content: "different" });
    expect(changedReplay.error?.status as number).toBe(409);
    expect(readFileSync(target)).toEqual(secondBytes);
    expect(lstatSync(target).ino).toBe(secondInode);
    expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: firstId, path, content: firstBody.content })).status).toBe(409);
    const receipt = await clientTwo.api.workspaces({ workspaceId }).files.receipts({ requestId: secondId.toUpperCase() }).get();
    expect(receipt.data as unknown).toEqual(secondSave.data as unknown);
    const verify = new Database(databasePath, { readonly: true });
    try {
      expect(verify.query("SELECT kind, state, expected_sha256 FROM file_operation_intents WHERE request_id = ?").get(firstId))
        .toEqual({ kind: "save", state: "completed", expected_sha256: openedOne.data.version });
      expect(verify.query("SELECT kind, result_sha256 FROM file_operation_outcomes WHERE request_id = ?").get(firstId))
        .toEqual({ kind: "save", result_sha256: firstVersion });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents WHERE request_id = ?").get(staleId)).toEqual({ count: 0 });
      expect(verify.query("SELECT kind, state, expected_sha256 FROM file_operation_intents WHERE request_id = ?").get(secondId))
        .toEqual({ kind: "save", state: "completed", expected_sha256: firstVersion });
      expect(verify.query("SELECT kind, result_sha256 FROM file_operation_outcomes WHERE request_id = ?").get(secondId))
        .toEqual({ kind: "save", result_sha256: createHash("sha256").update(secondBytes).digest("hex") });
    } finally { verify.close(); }
  } finally { await app.stop(true); }
});

it.skipIf(process.platform !== "linux")("recovers a published SAVE witness after outcome SQL failure and process restart", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const path = "recover-save.txt";
  const target = join(folderPath, path);
  writeFileSync(target, "before");
  const previousVersion = createHash("sha256").update("before").digest("hex");
  const requestId = crypto.randomUUID();
  const body = { requestId, path, expectedVersion: previousVersion, content: "after restart recovery" };
  const trigger = new Database(databasePath);
  trigger.exec("CREATE TRIGGER fail_save_outcome BEFORE INSERT ON file_operation_outcomes WHEN NEW.kind = 'save' BEGIN SELECT RAISE(ABORT, 'injected SAVE outcome failure'); END");
  trigger.close();
  expect((await request(app, `/${workspaceId}/files/content`, ownerToken, "PUT", body)).status).toBe(503);
  const publishedInode = lstatSync(target).ino;
  expect(readFileSync(target, "utf8")).toBe(body.content);
  const reserved = new Database(databasePath, { readonly: true });
  try {
    expect(reserved.query("SELECT kind, state, expected_sha256 FROM file_operation_intents WHERE request_id = ?").get(requestId))
      .toEqual({ kind: "save", state: "prepared", expected_sha256: previousVersion });
    expect(reserved.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { reserved.close(); }
  const repair = new Database(databasePath);
  repair.exec("DROP TRIGGER fail_save_outcome");
  repair.close();
  const child = Bun.spawnSync(["bun", "-e", `
    import { createApi } from "./apps/api/src/app.ts";
    const app = createApi(process.env.DATABASE_PATH);
    const response = await app.handle(new Request("http://localhost/api/workspaces/" + process.env.RC029_WORKSPACE_ID + "/files/receipts/" + process.env.RC029_REQUEST_ID,
      { headers: { cookie: "remotecode_session=" + "a".repeat(64) } }));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: databasePath, RC029_WORKSPACE_ID: workspaceId, RC029_REQUEST_ID: requestId } });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).status).toBe(200);
  expect(lstatSync(target).ino).toBe(publishedInode);
  expect(readFileSync(target, "utf8")).toBe(body.content);
  const completed = new Database(databasePath, { readonly: true });
  try {
    expect(completed.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "completed" });
    expect(completed.query("SELECT kind, result_sha256 FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
      .toEqual({ kind: "save", result_sha256: createHash("sha256").update(body.content).digest("hex") });
  } finally { completed.close(); }
});

it.skipIf(process.platform !== "linux")("persists SAVE intent before creating a stage and leaves file bytes unchanged on intent failure", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const path = "intent-save.txt";
  const target = join(folderPath, path);
  const original = Buffer.from("original save bytes");
  writeFileSync(target, original);
  const requestId = crypto.randomUUID();
  const database = new Database(databasePath);
  database.exec("CREATE TRIGGER fail_save_intent BEFORE INSERT ON file_operation_intents WHEN NEW.kind = 'save' BEGIN SELECT RAISE(ABORT, 'injected SAVE intent failure'); END");
  database.close();
  const response = await request(app, `/${workspaceId}/files/content`, ownerToken, "PUT", {
    requestId, path, expectedVersion: createHash("sha256").update(original).digest("hex"), content: "should not be staged",
  });
  expect(response.status).toBe(503);
  expect(readFileSync(target)).toEqual(original);
  expect(existsSync(join(folderPath, `.remotecode-stage-${requestId}`))).toBe(false);
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("does not replay a prepared SAVE stage when the publication witness is absent", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const path = "prepared-save.txt";
  const target = join(folderPath, path);
  writeFileSync(target, "before");
  const requestId = crypto.randomUUID();
  const body = { requestId, path, expectedVersion: createHash("sha256").update("before").digest("hex"), content: "staged but not published" };
  let changed = false;
  const files = new Elysia().use(workspaceFilesFeature(databasePath, (fd) => {
    fsyncSync(fd);
    if (changed) return;
    const state = new Database(databasePath, { readonly: true });
    let prepared = false;
    try { prepared = state.query<{ state: string }, [string]>("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)?.state === "prepared"; }
    finally { state.close(); }
    if (prepared) { changed = true; writeFileSync(target, "concurrent external edit"); }
  }));
  expect((await request(files, `/${workspaceId}/files/content`, ownerToken, "PUT", body)).status).toBe(409);
  expect(changed).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("concurrent external edit");
  expect(readFileSync(join(folderPath, `.remotecode-stage-${requestId}`), "utf8")).toBe(body.content);
  expect(existsSync(join(folderPath, `.remotecode-stage-${requestId}-publish`))).toBe(false);
  expect((await request(files, `/${workspaceId}/files/content`, ownerToken, "PUT", body)).status).toBe(503);
  expect(readFileSync(target, "utf8")).toBe("concurrent external edit");
  const verify = new Database(databasePath, { readonly: true });
  try {
    expect(verify.query("SELECT kind, state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ kind: "save", state: "prepared" });
    expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("refuses SAVE for stale, foreign, archived, symlink, and FIFO targets without overwriting", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const stalePath = join(folderPath, "stale-save.txt");
  writeFileSync(stalePath, "current");
  const stale = await request(app, `/${workspaceId}/files/content`, ownerToken, "PUT", {
    requestId: crypto.randomUUID(), path: "stale-save.txt", expectedVersion: "0".repeat(64), content: "must not replace",
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "version_conflict" });
  expect(readFileSync(stalePath, "utf8")).toBe("current");
  expect((await request(app, `/${workspaceId}/files/content`, foreignToken, "PUT", {
    requestId: crypto.randomUUID(), path: "stale-save.txt", expectedVersion: createHash("sha256").update("current").digest("hex"), content: "foreign",
  })).status).toBe(404);
  writeFileSync(join(folderPath, "target.txt"), "target");
  symlinkSync("target.txt", join(folderPath, "link.txt"));
  expect((await request(app, `/${workspaceId}/files/content`, ownerToken, "PUT", {
    requestId: crypto.randomUUID(), path: "link.txt", expectedVersion: createHash("sha256").update("target").digest("hex"), content: "no follow",
  })).status).toBe(404);
  expect(readFileSync(join(folderPath, "target.txt"), "utf8")).toBe("target");
  const fifoPath = join(folderPath, "pipe");
  expect(Bun.spawnSync(["mkfifo", fifoPath]).exitCode).toBe(0);
  expect((await request(app, `/${workspaceId}/files/content`, ownerToken, "PUT", {
    requestId: crypto.randomUUID(), path: "pipe", expectedVersion: "0".repeat(64), content: "no block",
  })).status).toBe(415);
  const archived = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}`, {
    method: "PATCH", headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ archived: true, requestId: crypto.randomUUID() }),
  }));
  expect(archived.status).toBe(200);
  expect((await request(app, `/${workspaceId}/files/content`, ownerToken, "PUT", {
    requestId: crypto.randomUUID(), path: "stale-save.txt", expectedVersion: createHash("sha256").update("current").digest("hex"), content: "after archive",
  })).status).toBe(409);
  expect(readFileSync(stalePath, "utf8")).toBe("current");
  const verify = new Database(databasePath, { readonly: true });
  try { expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents WHERE kind = 'save'").get()).toEqual({ count: 0 }); }
  finally { verify.close(); }
});

it.skipIf(process.platform !== "linux")("moves exact file inode between existing directories over Eden and keeps a historical receipt", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  mkdirSync(join(folderPath, "src"));
  mkdirSync(join(folderPath, "dst"));
  const sourcePath = "src/note.txt";
  const destinationPath = "dst/note.txt";
  const source = join(folderPath, sourcePath);
  const destination = join(folderPath, destinationPath);
  const bytes = Buffer.from("\uFEFFmove this text\n");
  writeFileSync(source, bytes);
  chmodSync(source, 0o751);
  const sourceInfo = lstatSync(source);
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("File API did not bind");
  try {
    const client = createApiClient(`http://127.0.0.1:${port}`, { headers: { cookie: `remotecode_session=${ownerToken}` } });
    const opened = await client.api.workspaces({ workspaceId }).files.content.get({ query: { path: sourcePath } });
    if (opened.error || !opened.data || !("version" in opened.data)) throw new Error("MOVE source must have a confirmed file version");
    const requestId = crypto.randomUUID();
    const body = { requestId: requestId.toUpperCase(), sourcePath, destinationPath, expectedVersion: opened.data.version };
    const moved = await client.api.workspaces({ workspaceId }).files.move.post(body);
    expect(moved.error).toBeNull();
    expect(moved.data).toMatchObject({ requestId, workspaceId, kind: "move", sourcePath, path: destinationPath, version: opened.data.version });
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(lstatSync(destination).ino).toBe(sourceInfo.ino);
    expect(lstatSync(destination).mode & 0o777).toBe(0o751);
    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.query("SELECT kind, state, source_path, destination_path, expected_sha256, source_device, source_inode FROM file_operation_intents WHERE request_id = ?").get(requestId))
        .toEqual({ kind: "move", state: "completed", source_path: sourcePath, destination_path: destinationPath, expected_sha256: opened.data.version,
          source_device: String(sourceInfo.dev), source_inode: String(sourceInfo.ino) });
      expect(database.query("SELECT kind, source_path, destination_path, result_path, result_sha256 FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
        .toEqual({ kind: "move", source_path: sourcePath, destination_path: destinationPath, result_path: destinationPath, result_sha256: opened.data.version });
    } finally { database.close(); }
    const edited = Buffer.from("later destination edit");
    writeFileSync(destination, edited);
    const replay = await client.api.workspaces({ workspaceId }).files.move.post(body);
    expect(replay.data).toEqual(moved.data);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination)).toEqual(edited);
    const changedKey = await client.api.workspaces({ workspaceId }).files.move.post({ ...body, destinationPath: "dst/other.txt" });
    expect(changedKey.error?.status as number).toBe(409);
    const changedVersion = await client.api.workspaces({ workspaceId }).files.move.post({ ...body, expectedVersion: "0".repeat(64) });
    expect(changedVersion.error?.status as number).toBe(409);
    expect(readFileSync(destination)).toEqual(edited);
    const crossKind = await client.api.workspaces({ workspaceId }).files.post({ requestId, path: "dst/created.txt", content: "conflict" });
    expect(crossKind.error?.status as number).toBe(409);
    expect(readFileSync(destination)).toEqual(edited);
  } finally { await app.stop(true); }
});

it.skipIf(process.platform !== "linux")("recovers MOVE receipt from destination inode after outcome SQL failure and process restart", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  mkdirSync(join(folderPath, "src"));
  mkdirSync(join(folderPath, "dst"));
  const sourcePath = "src/recovery.txt";
  const destinationPath = "dst/recovery.txt";
  const source = join(folderPath, sourcePath);
  const destination = join(folderPath, destinationPath);
  const bytes = Buffer.from("move recovery bytes");
  writeFileSync(source, bytes);
  const inode = lstatSync(source).ino;
  const version = createHash("sha256").update(bytes).digest("hex");
  const requestId = crypto.randomUUID();
  const body = { requestId, sourcePath, destinationPath, expectedVersion: version };
  const trigger = new Database(databasePath);
  trigger.exec("CREATE TRIGGER fail_move_outcome BEFORE INSERT ON file_operation_outcomes WHEN NEW.kind = 'move' BEGIN SELECT RAISE(ABORT, 'injected MOVE outcome failure'); END");
  trigger.close();
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", body)).status).toBe(503);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(destination)).toEqual(bytes);
  expect(lstatSync(destination).ino).toBe(inode);
  const prepared = new Database(databasePath, { readonly: true });
  try {
    expect(prepared.query("SELECT kind, state, source_path, destination_path, expected_sha256, stage_device FROM file_operation_intents WHERE request_id = ?").get(requestId))
      .toEqual({ kind: "move", state: "prepared", source_path: sourcePath, destination_path: destinationPath, expected_sha256: version, stage_device: null });
    expect(prepared.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { prepared.close(); }
  const repair = new Database(databasePath);
  repair.exec("DROP TRIGGER fail_move_outcome");
  repair.close();
  const child = Bun.spawnSync(["bun", "-e", `
    import { createApi } from "./apps/api/src/app.ts";
    const app = createApi(process.env.DATABASE_PATH);
    const response = await app.handle(new Request("http://localhost/api/workspaces/" + process.env.RC029_WORKSPACE_ID + "/files/receipts/" + process.env.RC029_REQUEST_ID,
      { headers: { cookie: "remotecode_session=" + "a".repeat(64) } }));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: databasePath, RC029_WORKSPACE_ID: workspaceId, RC029_REQUEST_ID: requestId } });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).status).toBe(200);
  expect(existsSync(source)).toBe(false);
  expect(lstatSync(destination).ino).toBe(inode);
  const completed = new Database(databasePath, { readonly: true });
  try {
    expect(completed.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "completed" });
    expect(completed.query("SELECT kind, result_sha256 FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
      .toEqual({ kind: "move", result_sha256: version });
  } finally { completed.close(); }
});

it.skipIf(process.platform !== "linux")("keeps missing and mismatched MOVE witnesses unknown and never repeats rename", async () => {
  for (const damage of ["missing", "mismatched"] as const) {
    const { app, databasePath, workspaceId, folderPath } = setup();
    await provision(app, workspaceId);
    mkdirSync(join(folderPath, "src"));
    mkdirSync(join(folderPath, "dst"));
    const sourcePath = "src/witness.txt";
    const destinationPath = "dst/witness.txt";
    const source = join(folderPath, sourcePath);
    const destination = join(folderPath, destinationPath);
    writeFileSync(source, "original witness");
    const requestId = crypto.randomUUID();
    const body = { requestId, sourcePath, destinationPath, expectedVersion: createHash("sha256").update("original witness").digest("hex") };
    const trigger = new Database(databasePath);
    trigger.exec("CREATE TRIGGER fail_move_outcome BEFORE INSERT ON file_operation_outcomes WHEN NEW.kind = 'move' BEGIN SELECT RAISE(ABORT, 'injected MOVE outcome failure'); END");
    trigger.close();
    expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", body)).status).toBe(503);
    const publishedInode = lstatSync(destination).ino;
    expect(existsSync(source)).toBe(false);
    const repair = new Database(databasePath);
    repair.exec("DROP TRIGGER fail_move_outcome");
    repair.close();
    if (damage === "missing") rmSync(destination);
    else { rmSync(destination); writeFileSync(destination, "mismatched replacement"); expect(lstatSync(destination).ino).not.toBe(publishedInode); }
    const savedBytes = damage === "missing" ? null : readFileSync(destination);
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
    expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", body)).status).toBe(503);
    expect(existsSync(source)).toBe(false);
    expect(damage === "missing" ? existsSync(destination) : readFileSync(destination).equals(savedBytes!)).toBe(damage === "mismatched");
    const verify = new Database(databasePath, { readonly: true });
    try {
      expect(verify.query("SELECT kind, state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ kind: "move", state: "prepared" });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    } finally { verify.close(); }
  }
});

it.skipIf(process.platform !== "linux")("refuses invalid MOVE versions, same paths, missing targets, foreign owners, symlinks, FIFO, archives, and occupied destinations", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  mkdirSync(join(folderPath, "src"));
  mkdirSync(join(folderPath, "dst"));
  writeFileSync(join(folderPath, "src", "source.txt"), "source bytes");
  writeFileSync(join(folderPath, "dst", "occupied.txt"), "occupied bytes");
  const sourcePath = "src/source.txt";
  const version = createHash("sha256").update("source bytes").digest("hex");
  const before: string[] = readdirSync(join(folderPath, "src")).sort();
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath, destinationPath: sourcePath, expectedVersion: version,
  })).status).toBe(400);
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath, destinationPath: "dst/stale.txt", expectedVersion: "0".repeat(64),
  })).status).toBe(409);
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath, destinationPath: "dst/occupied.txt", expectedVersion: version,
  })).status).toBe(409);
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath: "src/missing.txt", destinationPath: "dst/missing.txt", expectedVersion: version,
  })).status).toBe(404);
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath, destinationPath: "dst/missing/child.txt", expectedVersion: version,
  })).status).toBe(404);
  expect((await request(app, `/${workspaceId}/files/move`, foreignToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath, destinationPath: "dst/foreign.txt", expectedVersion: version,
  })).status).toBe(404);
  writeFileSync(join(folderPath, "dst", "link-target.txt"), "link target bytes");
  symlinkSync("../dst/link-target.txt", join(folderPath, "src", "link.txt"));
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath: "src/link.txt", destinationPath: "dst/link-moved.txt", expectedVersion: createHash("sha256").update("link target bytes").digest("hex"),
  })).status).toBe(404);
  const fifo = join(folderPath, "src", "pipe");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath: "src/pipe", destinationPath: "dst/pipe", expectedVersion: version,
  })).status).toBe(415);
  const archived = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}`, {
    method: "PATCH", headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ archived: true, requestId: crypto.randomUUID() }),
  }));
  expect(archived.status).toBe(200);
  expect((await request(app, `/${workspaceId}/files/move`, ownerToken, "POST", {
    requestId: crypto.randomUUID(), sourcePath, destinationPath: "dst/archived.txt", expectedVersion: version,
  })).status).toBe(409);
  expect(readFileSync(join(folderPath, sourcePath), "utf8")).toBe("source bytes");
  expect(readFileSync(join(folderPath, "dst", "occupied.txt"), "utf8")).toBe("occupied bytes");
  const verify = new Database(databasePath, { readonly: true });
  try { expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents WHERE kind = 'move'").get()).toEqual({ count: 0 }); }
  finally { verify.close(); }
  expect(readdirSync(join(folderPath, "src")).filter((name) => name === "source.txt") as string[]).toEqual(before);
});

for (const kind of ["create", "save", "move"] as const) {
  it.skipIf(process.platform !== "linux")(`keeps ${kind} unknown when SQLite silently ignores its outcome insertion`, async () => {
    const { app, databasePath, workspaceId, folderPath } = setup();
    await provision(app, workspaceId);
    const requestId = crypto.randomUUID();
    const path = `${kind}-ignored.txt`;
    const target = join(folderPath, path);
    const sourcePath = `src/${kind}-ignored.txt`;
    if (kind === "save") writeFileSync(target, "before");
    if (kind === "move") { mkdirSync(join(folderPath, "src")); writeFileSync(join(folderPath, sourcePath), "before"); }
    const database = new Database(databasePath);
    database.exec("CREATE TRIGGER ignore_file_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(IGNORE); END");
    database.close();
    const body = kind === "create" ? { requestId, path, content: "published" } : kind === "save" ?
      { requestId, path, content: "published", expectedVersion: createHash("sha256").update("before").digest("hex") } :
      { requestId, sourcePath, destinationPath: path, expectedVersion: createHash("sha256").update("before").digest("hex") };
    const route = kind === "create" ? `/${workspaceId}/files` : kind === "save" ? `/${workspaceId}/files/content` : `/${workspaceId}/files/move`;
    const method = kind === "create" ? "POST" : kind === "save" ? "PUT" : "POST";
    const response = await request(app, route, ownerToken, method, body);
    expect(response.status).toBe(503);
    expect(readFileSync(target, "utf8")).toBe(kind === "move" ? "before" : "published");
    if (kind === "move") expect(existsSync(join(folderPath, sourcePath))).toBe(false);
    const inode = lstatSync(target).ino;
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
    const verify = new Database(databasePath);
    try {
      expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
      verify.exec("DROP TRIGGER ignore_file_outcome");
    } finally { verify.close(); }
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(200);
    expect(lstatSync(target).ino).toBe(inode);
    expect(readFileSync(target, "utf8")).toBe(kind === "move" ? "before" : "published");
    if (kind === "move") expect(existsSync(join(folderPath, sourcePath))).toBe(false);
  });
}

for (const kind of ["create", "save", "move"] as const) {
  it.skipIf(process.platform !== "linux")(`keeps ${kind} prepared when SQLite silently ignores completion update`, async () => {
    const { app, databasePath, workspaceId, folderPath } = setup();
    await provision(app, workspaceId);
    const requestId = crypto.randomUUID();
    const path = `${kind}-update-ignored.txt`;
    const target = join(folderPath, path);
    const sourcePath = `src/${kind}-update-ignored.txt`;
    if (kind === "save") writeFileSync(target, "before");
    if (kind === "move") { mkdirSync(join(folderPath, "src")); writeFileSync(join(folderPath, sourcePath), "before"); }
    const trigger = new Database(databasePath);
    trigger.exec("CREATE TRIGGER ignore_file_completion BEFORE UPDATE OF state ON file_operation_intents WHEN NEW.state = 'completed' BEGIN SELECT RAISE(IGNORE); END");
    trigger.close();
    const body = kind === "create" ? { requestId, path, content: "published" } : kind === "save" ?
      { requestId, path, content: "published", expectedVersion: createHash("sha256").update("before").digest("hex") } :
      { requestId, sourcePath, destinationPath: path, expectedVersion: createHash("sha256").update("before").digest("hex") };
    const route = kind === "create" ? `/${workspaceId}/files` : kind === "save" ? `/${workspaceId}/files/content` : `/${workspaceId}/files/move`;
    const method = kind === "save" ? "PUT" : "POST";
    expect((await request(app, route, ownerToken, method, body)).status).toBe(503);
    expect(readFileSync(target, "utf8")).toBe(kind === "move" ? "before" : "published");
    if (kind === "move") expect(existsSync(join(folderPath, sourcePath))).toBe(false);
    const inode = lstatSync(target).ino;
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(503);
    const verify = new Database(databasePath);
    try {
      expect(verify.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ state: "prepared" });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
      verify.exec("DROP TRIGGER ignore_file_completion");
    } finally { verify.close(); }
    expect((await request(app, `/${workspaceId}/files/receipts/${requestId}`, ownerToken)).status).toBe(200);
    expect(lstatSync(target).ino).toBe(inode);
    expect(readFileSync(target, "utf8")).toBe(kind === "move" ? "before" : "published");
    if (kind === "move") expect(existsSync(join(folderPath, sourcePath))).toBe(false);
  });
}

it.skipIf(process.platform !== "linux")("rechecks SAVE version after publishing the exchange link and preserves a concurrent file edit", async () => {
  const { app, databasePath, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  const path = "sync-window-save.txt";
  const target = join(folderPath, path);
  writeFileSync(target, "before sync window");
  const oldBytes = readFileSync(target);
  const requestId = crypto.randomUUID();
  const body = { requestId, path, expectedVersion: createHash("sha256").update(oldBytes).digest("hex"), content: "remote SAVE bytes" };
  const publishName = join(folderPath, `.remotecode-stage-${requestId}-publish`);
  let editedAfterLink = false;
  const files = new Elysia().use(workspaceFilesFeature(databasePath, (fd) => {
    fsyncSync(fd);
    if (!editedAfterLink && existsSync(publishName)) {
      editedAfterLink = true;
      writeFileSync(target, "concurrent editor bytes");
    }
  }));
  const response = await request(files, `/${workspaceId}/files/content`, ownerToken, "PUT", body);
  expect(editedAfterLink).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("concurrent editor bytes");
  expect(response.status).toBe(409);
  expect(existsSync(publishName)).toBe(false);
  expect(readFileSync(join(folderPath, `.remotecode-stage-${requestId}`), "utf8")).toBe(body.content);
  const prepared = new Database(databasePath, { readonly: true });
  try {
    expect(prepared.query("SELECT kind, state FROM file_operation_intents WHERE request_id = ?").get(requestId)).toEqual({ kind: "save", state: "prepared" });
    expect(prepared.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
  } finally { prepared.close(); }
  expect((await request(files, `/${workspaceId}/files/content`, ownerToken, "PUT", body)).status).toBe(503);
  expect(readFileSync(target, "utf8")).toBe("concurrent editor bytes");
});

for (const kind of ["create", "save"] as const) {
  it.skipIf(process.platform !== "linux")(`rejects malformed Unicode ${kind} paths before persisting intent or touching files`, async () => {
    const { app, databasePath, workspaceId, folderPath } = setup();
    await provision(app, workspaceId);
    const target = join(folderPath, "\uFFFD.txt");
    if (kind === "save") writeFileSync(target, "original");
    const response = await request(app, `/${workspaceId}/files${kind === "save" ? "/content" : ""}`, ownerToken, kind === "save" ? "PUT" : "POST", {
      requestId: crypto.randomUUID(), path: "\uD800.txt", content: "replacement",
      ...(kind === "save" ? { expectedVersion: createHash("sha256").update("original").digest("hex") } : {}),
    });
    expect(response.status).toBe(400);
    expect(readdirSync(folderPath).filter((name) => name !== ".remotecode-workspace")).toEqual(kind === "save" ? ["\uFFFD.txt"] : []);
    if (kind === "save") expect(readFileSync(target, "utf8")).toBe("original");
    const verify = new Database(databasePath, { readonly: true });
    try {
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_intents").get()).toEqual({ count: 0 });
      expect(verify.query("SELECT COUNT(*) AS count FROM file_operation_outcomes").get()).toEqual({ count: 0 });
    } finally { verify.close(); }
  });
}

it.skipIf(process.platform === "linux")("reports Linux-only folder boundary as unsupported on other platforms", async () => {
  const { app, workspaceId } = setup();
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(501);
});

it.skipIf(process.platform !== "linux")("stops file reads and writes after logout and after session expiry on Linux", async () => {
  const { app, databasePath, workspaceId } = setup();
  await provision(app, workspaceId);
  // Empty folder lists 200 with no entries — the known-good baseline before
  // exercising denials.
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(200);
  // Expired session row: same denial shape as a missing session.
  const stale = "c".repeat(64);
  const staleDb = new Database(databasePath);
  try {
    staleDb.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(stale).digest("hex"), "alice", Date.now() - 1000);
  } finally { staleDb.close(); }
  expect((await request(app, `/${workspaceId}/files`, stale)).status).toBe(401);
  expect((await request(app, `/${workspaceId}/files`, stale, "POST", { requestId: crypto.randomUUID(), path: "x.txt", content: "x" })).status).toBe(401);
  // Logout deletes alice's sessions: the owner cookie is now unauthorized.
  const logout = await app.handle(new Request("https://localhost/api/auth/logout", {
    method: "POST", headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({}),
  }));
  expect([200, 204].includes(logout.status)).toBe(true);
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(401);
  expect((await request(app, `/${workspaceId}/files`, ownerToken, "POST", { requestId: crypto.randomUUID(), path: "y.txt", content: "y" })).status).toBe(401);
});
