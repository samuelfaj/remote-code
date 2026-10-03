import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../app";

const volumeName = process.env.RC031_PROOF_VOLUME;
const image = process.env.RC031_PROOF_IMAGE;
const root = process.env.RC031_PROOF_DATA_ROOT;
const supported = process.platform === "linux" && process.getuid?.() === 0 && !!volumeName && !!image && !!root;

for (const transition of ["logout", "expiry", "archive"] as const) {
  it.skipIf(!supported)(`stops the real protected terminal after ${transition} and fences further input`, async () => {
    const name = `rc031-${randomUUID()}`;
    const path = join(root!, `${name}.sqlite`);
    const password = randomBytes(32).toString("base64url");
    const app = createApi(path, undefined, { password, sessionTtlMs: transition === "expiry" ? 4000 : 120_000 }, { volumeName: volumeName!, image: image! }).listen({ hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.server!.port}`;
    let cookie = "";
    async function request(route: string, method = "GET", body?: unknown) {
      const response = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    }
    const database = new Database(path, { readwrite: true, create: false });
    try {
      const login = await request("/api/auth/login", "POST", { password, requestId: randomUUID() });
      expect(login.status).toBe(200); cookie = login.cookie!;
      expect((await request("/api/workspaces", "POST", { name, requestId: randomUUID() })).status).toBe(201);
      const workspace = (await request("/api/workspaces")).body.workspaces.find((row: any) => row.name === name);
      expect((await request(`/api/workspaces/${workspace.id}/folder`, "POST", { requestId: randomUUID() })).status).toBe(200);
      const started = await request(`/api/workspaces/${workspace.id}/terminals`, "POST", { requestId: randomUUID(), cols: 80, rows: 24 });
      if (started.status !== 201) throw new Error(`terminal_start_${started.status}_${started.body.error}`);
      const id = started.body.terminalId;
      const leaf = join(root!, "workspaces", workspace.id);
      const ready = join(leaf, "ready.txt");
      expect((await request(`/api/terminals/${id}/input`, "POST", { sequence: 1, text: "stty -echo; printf ready > ready.txt\n" })).status).toBe(200);
      const readyDeadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < readyDeadline) await delay(25);
      expect(readFileSync(ready, "utf8")).toBe("ready");
      if (transition === "logout") expect((await request("/api/auth/logout", "POST", { requestId: randomUUID() })).status).toBe(200);
      if (transition === "expiry") {
        const expiry = database.query<{ expiresAt: number }, []>("SELECT expires_at AS expiresAt FROM sessions LIMIT 1").get()!;
        await delay(Math.max(0, expiry.expiresAt - Date.now()) + 100);
        expect((await request("/api/auth/session")).status).toBe(401);
      }
      if (transition === "archive") {
        expect((await request(`/api/workspaces/${workspace.id}`, "PATCH", { archived: true, requestId: randomUUID() })).status).toBe(200);
      }
      const denied = await request(`/api/terminals/${id}/input`, "POST", { sequence: 2, text: "printf forbidden > after-revocation.txt\n" });
      expect(denied.status).toBe(transition === "archive" ? 409 : 401);
      let row: any;
      const deadline = Date.now() + 12_000;
      do {
        row = database.query("SELECT state,cleanup,input_sequence,exit_code FROM terminal_sessions WHERE terminal_id = ?").get(id);
        await delay(50);
      } while (row?.cleanup !== "removed" && Date.now() < deadline);
      expect(row).toMatchObject({ state: "exited", cleanup: "removed", input_sequence: 1 });
      expect(Number.isInteger(row.exit_code)).toBe(true);
      expect(existsSync(join(leaf, "after-revocation.txt"))).toBe(false);
      expect(database.query("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      if (transition === "archive") expect((await request("/api/auth/logout", "POST", { requestId: randomUUID() })).status).toBe(200);
    } finally {
      await app.stop(); database.close();
    }
  }, 35_000);
}
