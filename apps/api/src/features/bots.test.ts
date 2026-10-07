import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc030-bots-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.close();
  return { app, databasePath };
}

afterEach(() => { for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

describe("Bots routes", () => {
  it("POST /api/bots rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(response.status).toBe(401);
  });

  it("GET /api/bots rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots");
    expect(response.status).toBe(401);
  });

  it("GET /api/bots/:id rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(401);
  });

  it("PATCH /api/bots/:id rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "updated" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/bots rejects a name with a newline with 400 invalid_bot_name", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "invalid\nname" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_name");
  });

  it("POST /api/bots rejects a name that is only whitespace with 400 invalid_bot_name", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_name");
  });

  it("POST /api/bots rejects instructions over 8000 chars with 400 invalid_bot_instructions", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "test", instructions: "x".repeat(8001) }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_instructions");
  });

  it("POST /api/bots rejects instructions with NUL with 400 invalid_bot_instructions", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "test", instructions: "bad\x00value" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_instructions");
  });

  it("POST /api/bots rejects context over 8000 chars with 400 invalid_bot_context", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "test", context: "x".repeat(8001) }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_context");
  });

  it("POST /api/bots rejects context with NUL with 400 invalid_bot_context", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "test", context: "bad\x00value" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_context");
  });

  it("POST /api/bots rejects a schema failure with 400 invalid_bot_request and no echoed body", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: 123 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_request");
    expect(Object.keys(body)).toHaveLength(1);
  });

  it("POST /api/bots creates a bot and returns 201 with the view", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "mybot", instructions: "do things", context: "be helpful" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; name: string; instructions: string; context: string; hidden: boolean; skills: string[]; createdAt: string; updatedAt: string };
    expect(body.name).toBe("mybot");
    expect(body.instructions).toBe("do things");
    expect(body.context).toBe("be helpful");
    expect(body.hidden).toBe(false);
    expect(body.skills).toEqual([]);
    expect(body.id).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
  });

  it("GET /api/bots returns bots for the owner, newest first, including hidden", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    const bot1 = crypto.randomUUID();
    const bot2 = crypto.randomUUID();
    const now1 = new Date(Date.now() - 1000).toISOString();
    const now2 = new Date().toISOString();
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', ?, ?, ?, 0, ?, ?)")
      .run(bot1, "first", "instr1", "ctx1", now1, now1);
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', ?, ?, ?, 1, ?, ?)")
      .run(bot2, "second", "instr2", "ctx2", now2, now2);
    database.close();

    const response = await request(app, "http://localhost/api/bots", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { bots: unknown[] };
    expect(body.bots).toBeInstanceOf(Array);
    expect(body.bots).toHaveLength(2);
    expect((body.bots[0] as { name: string }).name).toBe("second");
    expect((body.bots[1] as { name: string }).name).toBe("first");
  });

  it("GET /api/bots/:id returns the owner's bot", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    const botId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', 'testbot', 'instr', 'ctx', 0, ?, ?)")
      .run(botId, now, now);
    database.close();

    const response = await request(app, `http://localhost/api/bots/${botId}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; name: string; instructions: string; context: string; hidden: boolean; skills: string[] };
    expect(body.name).toBe("testbot");
    expect(body.instructions).toBe("instr");
    expect(body.context).toBe("ctx");
    expect(body.hidden).toBe(false);
    expect(body.skills).toEqual([]);
  });

  it("GET /api/bots/:id returns 404 for a foreign id", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();

    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000", {
      headers: { cookie: `remotecode_session=${"b".repeat(64)}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("GET /api/bots/:id returns 404 for an unknown id", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("PATCH /api/bots/:id updates provided fields and leaves other bot unchanged", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    const bot1 = crypto.randomUUID();
    const bot2 = crypto.randomUUID();
    const now = new Date().toISOString();
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', 'bot1', 'instr1', 'ctx1', 0, ?, ?)")
      .run(bot1, now, now);
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', 'bot2', 'instr2', 'ctx2', 0, ?, ?)")
      .run(bot2, now, now);
    database.close();

    const response = await request(app, `http://localhost/api/bots/${bot1}`, {
      method: "PATCH",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ instructions: "updated instructions" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { name: string; instructions: string; context: string; skills: string[] };
    expect(body.name).toBe("bot1");
    expect(body.instructions).toBe("updated instructions");
    expect(body.context).toBe("ctx1");
    expect(body.skills).toEqual([]);

    const bot2Response = await request(app, `http://localhost/api/bots/${bot2}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(bot2Response.status).toBe(200);
    const bot2Body = await bot2Response.json() as { instructions: string; skills: string[] };
    expect(bot2Body.instructions).toBe("instr2");
    expect(bot2Body.skills).toEqual([]);
  });

  it("PATCH /api/bots/:id returns 404 for a foreign id", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();

    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { cookie: `remotecode_session=${"b".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "updated" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("PATCH /api/bots/:id returns 404 for an unknown id", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "updated" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("PATCH /api/bots/:id allows an empty patch and returns the current view", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    const botId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', 'bot', 'instr', 'ctx', 0, ?, ?)")
      .run(botId, now, now);
    database.close();

    const response = await request(app, `http://localhost/api/bots/${botId}`, {
      method: "PATCH",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { name: string; instructions: string; context: string; skills: string[] };
    expect(body.name).toBe("bot");
    expect(body.instructions).toBe("instr");
    expect(body.context).toBe("ctx");
    expect(body.skills).toEqual([]);
  });

  it("GET /api/bots/:id returns the same instructions and context as created", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "persistent", instructions: "keep me", context: "remember this" }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string };

    const getResponse = await request(app, `http://localhost/api/bots/${created.id}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(getResponse.status).toBe(200);
    const body = await getResponse.json() as { instructions: string; context: string; skills: string[] };
    expect(body.instructions).toBe("keep me");
    expect(body.context).toBe("remember this");
    expect(body.skills).toEqual([]);
  });

  it("PUT /api/bots/:id/skills rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: ["search"] }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/bots/:id/memory rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fact" }),
    });
    expect(response.status).toBe(401);
  });

  it("GET /api/bots/:id/memory rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/memory");
    expect(response.status).toBe(401);
  });

  it("PUT /api/bots/:id/skills rejects a foreign caller with 404", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();

    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/skills", {
      method: "PUT",
      headers: { cookie: `remotecode_session=${"b".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["search"] }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("POST /api/bots/:id/memory rejects a foreign caller with 404", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();

    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/memory", {
      method: "POST",
      headers: { cookie: `remotecode_session=${"b".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "fact" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("GET /api/bots/:id/memory rejects a foreign caller with 404", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();

    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/memory", {
      headers: { cookie: `remotecode_session=${"b".repeat(64)}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("PUT /api/bots/:id/skills returns 400 invalid_bot_skills for too many entries", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/skills`, {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: Array.from({ length: 33 }, (_, i) => `skill${i}`) }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_skills");
  });

  it("PUT /api/bots/:id/skills returns 400 invalid_bot_skills for bad characters", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/skills`, {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["Search", "bad!", "a".repeat(64)] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_skills");
  });

  it("PUT /api/bots/:id/skills returns 400 invalid_bot_skills for duplicates", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/skills`, {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["search", "search"] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_skills");
  });

  it("PUT /api/bots/:id/skills replaces skills and returns the updated view", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/skills`, {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["search", "write"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { skills: string[] };
    expect(body.skills).toEqual(["search", "write"]);
  });

  it("POST /api/bots/:id/memory returns 400 invalid_bot_memory for empty text", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/memory`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_memory");
  });

  it("POST /api/bots/:id/memory returns 400 invalid_bot_memory for whitespace-only text", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/memory`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_memory");
  });

  it("POST /api/bots/:id/memory returns 400 invalid_bot_memory for oversized text", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/memory`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(2001) }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_memory");
  });

  it("POST /api/bots/:id/memory returns 400 invalid_bot_memory for text with NUL", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/memory`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "bad\x00value" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_bot_memory");
  });

  it("POST /api/bots/:id/memory appends a fact and returns 201", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/memory`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "likes pizza" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; botId: string; text: string; createdAt: string };
    expect(body.botId).toBe(botId);
    expect(body.text).toBe("likes pizza");
    expect(body.id).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
  });

  it("GET /api/bots/:id/memory returns entries oldest first for the owner", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    await addMemory(app, botId, "first fact");
    await addMemory(app, botId, "second fact");

    const response = await request(app, `http://localhost/api/bots/${botId}/memory`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { botId: string; entries: Array<{ id: string; botId: string; text: string; createdAt: string }> };
    expect(body.botId).toBe(botId);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].text).toBe("first fact");
    expect(body.entries[1].text).toBe("second fact");
  });

  it("GET /api/bots/:id/memory returns 404 for an unknown id", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/memory", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("PUT /api/bots/:id/skills returns 404 for an unknown id", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/skills", {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["search"] }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("POST /api/bots/:id/memory returns 404 for an unknown id", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/memory", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "fact" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("two bots by the same user have isolated skills and memory", async () => {
    const { app } = setup();
    const bot1Id = await createBot(app);
    const bot2Id = await createBot(app);

    await request(app, `http://localhost/api/bots/${bot1Id}/skills`, {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["search", "write"] }),
    });
    await request(app, `http://localhost/api/bots/${bot2Id}/skills`, {
      method: "PUT",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ skills: ["read"] }),
    });

    await addMemory(app, bot1Id, "bot1 fact");
    await addMemory(app, bot1Id, "bot1 second fact");
    await addMemory(app, bot2Id, "bot2 fact");

    const bot1View = await request(app, `http://localhost/api/bots/${bot1Id}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(bot1View.status).toBe(200);
    const bot1Body = await bot1View.json() as { skills: string[] };
    expect(bot1Body.skills).toEqual(["search", "write"]);

    const bot2View = await request(app, `http://localhost/api/bots/${bot2Id}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(bot2View.status).toBe(200);
    const bot2Body = await bot2View.json() as { skills: string[] };
    expect(bot2Body.skills).toEqual(["read"]);

    const bot1Memory = await request(app, `http://localhost/api/bots/${bot1Id}/memory`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(bot1Memory.status).toBe(200);
    const bot1MemBody = await bot1Memory.json() as { botId: string; entries: Array<{ text: string }> };
    expect(bot1MemBody.botId).toBe(bot1Id);
    expect(bot1MemBody.entries).toHaveLength(2);
    expect(bot1MemBody.entries[0].text).toBe("bot1 fact");
    expect(bot1MemBody.entries[1].text).toBe("bot1 second fact");

    const bot2Memory = await request(app, `http://localhost/api/bots/${bot2Id}/memory`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(bot2Memory.status).toBe(200);
    const bot2MemBody = await bot2Memory.json() as { botId: string; entries: Array<{ text: string }> };
    expect(bot2MemBody.botId).toBe(bot2Id);
    expect(bot2MemBody.entries).toHaveLength(1);
    expect(bot2MemBody.entries[0].text).toBe("bot2 fact");
  });

  it("GET /api/bots/:id/memory returns 404 for a foreign bot", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    const foreignBotId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'bob', 'foreign', 'instr', 'ctx', 0, ?, ?)")
      .run(foreignBotId, now, now);
    database.close();

    const response = await request(app, `http://localhost/api/bots/${foreignBotId}/memory`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("POST /api/bots/:id/session rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/bots/:id/session returns 404 bot_not_found for an unknown bot", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/session", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("POST /api/bots/:id/session returns 400 invalid_session_url for a url with no scheme", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/session`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "example.com" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_session_url");
  });

  it("POST /api/bots/:id/session returns 400 invalid_session_url for a url with a newline", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/session`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com\nbad" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_session_url");
  });

  it("POST /api/bots/:id/session returns 400 invalid_session_url for an oversized url", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/session`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" + "x".repeat(2030) }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_session_url");
  });

  it("POST /api/bots/:id/session returns 501 session_require_linux on non-Linux", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/session`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(501);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("session_require_linux");
  });

  it("GET /api/bots/:id/session returns 404 bot_not_found for an unknown bot", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/bots/00000000-0000-4000-8000-000000000000/session", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("bot_not_found");
  });

  it("GET /api/bots/:id/session returns { session: null } for a bot with no session", async () => {
    const { app } = setup();
    const botId = await createBot(app);
    const response = await request(app, `http://localhost/api/bots/${botId}/session`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { session: unknown };
    expect(body.session).toBeNull();
  });
});

async function createBot(app: ReturnType<typeof createApi>) {
  const response = await request(app, "http://localhost/api/bots", {
    method: "POST",
    headers: { cookie: `remotecode_session=${"a".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "test" }),
  });
  return (await response.json() as { id: string }).id;
}

async function addMemory(app: ReturnType<typeof createApi>, botId: string, text: string) {
  await request(app, `http://localhost/api/bots/${botId}/memory`, {
    method: "POST",
    headers: { cookie: `remotecode_session=${"a".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}
