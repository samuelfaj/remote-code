import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { getHealth } from "../../../packages/client/src/index";
import { createApi } from "./app";

const root = process.env.RC020_TEST_WORK_DIR ?? tmpdir();

function removeDatabase(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

it("refuses a corrupt SQLite copy after restart without damaging the prior durable database", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `healthy-${crypto.randomUUID()}.sqlite`);
  const corruptPath = join(root, `corrupt-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const database = new Database(path);
    database.exec("CREATE TABLE proof (value TEXT NOT NULL)");
    database.query("INSERT INTO proof (value) VALUES (?)").run("previous durable value");
    database.close();
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    copyFileSync(path, corruptPath);
    const fd = openSync(corruptPath, "r+");
    try {
      writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, 4096);
    } finally {
      closeSync(fd);
    }
    const corruptedBytes = readFileSync(corruptPath);
    const restarted = createApi(corruptPath, undefined, { password: "test-storage-password" });
    const ready = await restarted.handle(new Request("http://localhost/api/health/ready"));
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready" });
    expect((await restarted.handle(new Request("http://localhost/api/health/live"))).status).toBe(200);
    const write = await restarted.handle(new Request("http://localhost/api/workspaces", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name: "not accepted" }),
    }));
    expect(write.status).toBe(503);
    expect(readFileSync(corruptPath)).toEqual(corruptedBytes);
    const original = new Database(path, { readonly: true, create: false });
    expect(original.query<{ value: string }, []>("SELECT value FROM proof").get()?.value).toBe("previous durable value");
    original.close();
  } finally {
    removeDatabase(path);
    removeDatabase(corruptPath);
  }
});

it("rejects a write under an exclusive SQLite lock and recovers after release and restart", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `locked-${crypto.randomUUID()}.sqlite`);
  let owner: Database | undefined;
  let listener: ReturnType<typeof createApi> | undefined;
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const request = (name: string) => new Request("http://localhost/api/workspaces", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name }),
    });
    expect((await app.handle(request("previous durable workspace"))).status).toBe(201);
    owner = new Database(path);
    owner.exec("BEGIN EXCLUSIVE");
    const restarted = createApi(path, undefined, { password: "test-storage-password" });
    listener = restarted.listen({ hostname: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${listener.server!.port}`;
    expect((await restarted.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
    expect(await getHealth(origin)).toBe("not_ready");
    expect((await restarted.handle(request("not accepted"))).status).not.toBe(201);
    owner.exec("ROLLBACK");
    owner.close();
    owner = undefined;
    expect((await restarted.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    expect(await getHealth(origin)).toBe("ready");
    const recovered = await restarted.handle(new Request("http://localhost/api/workspaces", {
      headers: { cookie: cookie! },
    }));
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as { workspaces: { name: string }[] }).workspaces.map((row) => row.name))
      .toEqual(["previous durable workspace"]);
    expect((await restarted.handle(request("safe after lock"))).status).toBe(201);
  } finally {
    if (owner) {
      owner.exec("ROLLBACK");
      owner.close();
    }
    await listener?.stop(true);
    removeDatabase(path);
  }
});
