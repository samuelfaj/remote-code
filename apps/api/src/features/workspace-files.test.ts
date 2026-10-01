import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApi } from "../app";
import { createApiClient } from "../../../../packages/client/src";

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

function request(app: ReturnType<typeof createApi>, route: string, token?: string) {
  return app.handle(new Request(`http://localhost/api/workspaces${route}`, {
    headers: token ? { cookie: `remotecode_session=${token}` } : {},
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

it.skipIf(process.platform === "linux")("reports Linux-only folder boundary as unsupported on other platforms", async () => {
  const { app, workspaceId } = setup();
  expect((await request(app, `/${workspaceId}/files`, ownerToken)).status).toBe(501);
});
