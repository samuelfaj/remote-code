import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../../../apps/api/src/app";
import { createApiClient } from "./index";
import { listBots, createBot, readBot } from "./bots";
import type { Bot } from "./bots";

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rc048-bots-client-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function login(app: ReturnType<typeof createApi>) {
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bots-client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test login cookie missing");
  return cookie;
}

it("createBot creates a bot and returns the result", async () => {
  const app = createApi(databasePath(), undefined, { password: "bots-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  try {
    const result = await createBot("mybot", "do things", "be helpful", origin, options);
    expect(result.name).toBe("mybot");
    expect(result.instructions).toBe("do things");
    expect(result.context).toBe("be helpful");
    expect(result.hidden).toBe(false);
    expect(result.skills).toEqual([]);
    expect(result.id).toBeTruthy();
  } finally { await app.stop(true); }
});

it("createBot rejects a name with a newline with 400", async () => {
  const app = createApi(databasePath(), undefined, { password: "bots-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  try {
    let thrown = false;
    try {
      await createBot("invalid\nname", "do things", "be helpful", origin, options);
    } catch (error) {
      thrown = true;
      expect((error as { status?: number }).status).toBe(400);
    }
    expect(thrown).toBe(true);
  } finally { await app.stop(true); }
});

it("listBots returns bots for the owner", async () => {
  const app = createApi(databasePath(), undefined, { password: "bots-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  try {
    const result = await createBot("listedbot", "instr", "ctx", origin, options);
    const bots = await listBots(origin, options);
    expect(bots.length).toBeGreaterThanOrEqual(1);
    expect(bots.some((b) => b.id === result.id)).toBe(true);
  } finally { await app.stop(true); }
});

it("readBot returns the owner's bot", async () => {
  const app = createApi(databasePath(), undefined, { password: "bots-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  try {
    const bot = await createBot("readablebot", "instr", "ctx", origin, options);
    const result = await readBot(bot.id, origin, options);
    expect(result.name).toBe("readablebot");
    expect(result.instructions).toBe("instr");
    expect(result.context).toBe("ctx");
  } finally { await app.stop(true); }
});

it("readBot rejects a foreign id with 404", async () => {
  const app = createApi(databasePath(), undefined, { password: "bots-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  try {
    await createBot("ownerbot", "instr", "ctx", origin, options);
    let thrown = false;
    try {
      await readBot("00000000-0000-4000-8000-000000000000", origin, options);
    } catch (error) {
      thrown = true;
      expect((error as { status?: number }).status).toBe(404);
    }
    expect(thrown).toBe(true);
  } finally { await app.stop(true); }
});
