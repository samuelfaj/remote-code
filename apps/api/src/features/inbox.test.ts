import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { createApi } from "../app";
import { recordInboxItem } from "./inbox";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC046_TEST_WORK_DIR ?? tmpdir(), "rc046-inbox-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(otherToken).digest("hex"), "bob", Date.now() + 60_000);
  database.close();
  return { app, databasePath, directory };
}

afterEach(() => {
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

function setupWorkspace(databasePath: string) {
  const database = new Database(databasePath);
  const workspaceId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
    .run(workspaceId, new Date().toISOString());
  database.close();
  return { workspaceId };
}

function setupBot(databasePath: string, botId: string = crypto.randomUUID()) {
  const database = new Database(databasePath);
  database.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, created_at, updated_at) VALUES (?, 'alice', 'Test Bot', '', '', 0, ?, ?)")
    .run(botId, new Date().toISOString(), new Date().toISOString());
  database.close();
  return { botId };
}

function setupRun(databasePath: string, runId: string = crypto.randomUUID(), overrides: {
  workspaceId?: string; botId?: string | null; prompt?: string; state?: string;
  heartbeatAt?: string | null; stopRequestedAt?: string | null; stopReason?: string | null;
  error?: string | null; sessionId?: string | null; handoffReason?: string | null;
  retryAfterSeconds?: number | null;
} = {}) {
  const database = new Database(databasePath);
  const now = new Date().toISOString();
  database.query(`INSERT INTO runs (id, user_id, workspace_id, bot_id, prompt, state, created_at, updated_at, heartbeat_at, stop_requested_at, stop_reason, error, session_id, handoff_reason, retry_after_seconds)
    VALUES (?, 'alice', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      runId,
      overrides.workspaceId ?? crypto.randomUUID(),
      overrides.botId ?? null,
      overrides.prompt ?? "test prompt",
      overrides.state ?? "needs_user",
      now, now,
      overrides.heartbeatAt ?? null,
      overrides.stopRequestedAt ?? null,
      overrides.stopReason ?? null,
      overrides.error ?? null,
      overrides.sessionId ?? null,
      overrides.handoffReason ?? null,
      overrides.retryAfterSeconds ?? null,
    );
  database.close();
  return { runId };
}

describe("Inbox", () => {
  it("recordInboxItem twice with the same dedupeKey creates one row", () => {
    const { databasePath } = setup();
    const id1 = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
      dedupeKey: "run:abc:needs_you",
    });
    const id2 = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId: "abc", workspaceId: "ws", botId: "bot" },
      dedupeKey: "run:abc:needs_you",
    });
    expect(id1).toBe(id2);
    const db = new Database(databasePath);
    const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM inbox_items").get();
    db.close();
    expect(count?.count).toBe(1);
  });

  it("item inserted for one user is invisible to another", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath);
    recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:needs_you`,
    });
    const response = await request(app, `http://localhost/api/inbox/${runId}`, {
      headers: { cookie: `remotecode_session=${otherToken}` },
    });
    expect(response.status).toBe(404);
  });

  it("read is idempotent and does not set resolvedAt", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath);
    const itemId = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:needs_you`,
    });
    const first = await request(app, `http://localhost/api/inbox/${itemId}/read`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { state: string; read: boolean; resolvedAt: string | null };
    expect(firstBody.state).toBe("read");
    expect(firstBody.read).toBe(true);
    expect(firstBody.resolvedAt).toBeNull();
    const second = await request(app, `http://localhost/api/inbox/${itemId}/read`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { state: string; read: boolean; resolvedAt: string | null };
    expect(secondBody.state).toBe("read");
    expect(secondBody.resolvedAt).toBeNull();
  });

  it("resolve on an item whose run is still needs_user answers 409 action_required", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath, crypto.randomUUID(), { state: "needs_user" });
    const itemId = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      runId,
      title: "Needs you",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:needs_you`,
    });
    const response = await request(app, `http://localhost/api/inbox/${itemId}/resolve`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; runId: string };
    expect(body.error).toBe("action_required");
    expect(body.runId).toBe(runId);
    const db = new Database(databasePath);
    const item = db.query<{ state: string; resolved_at: string | null }, [string]>(
      "SELECT state, resolved_at FROM inbox_items WHERE id = ?",
    ).get(itemId);
    db.close();
    expect(item?.state).toBe("open");
    expect(item?.resolved_at).toBeNull();
  });

  it("resolve on an item whose run is completed answers 200 and sets resolvedAt", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath, crypto.randomUUID(), { state: "completed" });
    const itemId = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "result",
      title: "Run finished",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:result`,
    });
    const first = await request(app, `http://localhost/api/inbox/${itemId}/resolve`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { state: string; resolvedAt: string | null };
    expect(firstBody.state).toBe("resolved");
    expect(firstBody.resolvedAt).not.toBeNull();
    const second = await request(app, `http://localhost/api/inbox/${itemId}/resolve`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { state: string; resolvedAt: string | null };
    expect(secondBody.state).toBe("resolved");
  });

  it("resolve on an item with no run answers 200 and sets resolvedAt", async () => {
    const { app, databasePath } = setup();
    const itemId = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "intervention",
      title: "Run failed",
      destination: { screen: "run", runId: "nonexistent", workspaceId: "ws", botId: "bot" },
      dedupeKey: "run:nonexistent:intervention",
    });
    const response = await request(app, `http://localhost/api/inbox/${itemId}/resolve`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string; resolvedAt: string | null };
    expect(body.state).toBe("resolved");
    expect(body.resolvedAt).not.toBeNull();
  });

  it("item survives a fresh createApi over the same database", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath);
    const itemId = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:needs_you`,
    });
    const app2 = createApi(databasePath);
    const response = await request(app2, `http://localhost/api/inbox/${itemId}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; title: string };
    expect(body.id).toBe(itemId);
    expect(body.title).toBe("Needs you");
    rmSync(directory, { recursive: true, force: true });
  });

  it("destination JSON carries the Bot id the item was created for", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath);
    const itemId = recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:needs_you`,
    });
    const response = await request(app, `http://localhost/api/inbox/${itemId}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { destination: { botId: string } };
    expect(body.destination.botId).toBe(botId);
  });

  it("GET /api/inbox lists items newest first", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId: runId1 } = setupRun(databasePath);
    const { runId: runId2 } = setupRun(databasePath);
    recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you 1",
      destination: { screen: "run", runId: runId1, workspaceId, botId },
      dedupeKey: `run:${runId1}:needs_you`,
    });
    recordInboxItem(databasePath, {
      userId: "alice",
      kind: "result",
      title: "Run finished 2",
      destination: { screen: "run", runId: runId2, workspaceId, botId },
      dedupeKey: `run:${runId2}:result`,
    });
    const response = await request(app, "http://localhost/api/inbox", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ title: string }> };
    expect(body.items.length).toBe(2);
    expect(body.items[0].title).toBe("Run finished 2");
  });

  it("anonymous request is rejected with 401", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    const { botId } = setupBot(databasePath);
    const { runId } = setupRun(databasePath);
    recordInboxItem(databasePath, {
      userId: "alice",
      kind: "needs_you",
      title: "Needs you",
      destination: { screen: "run", runId, workspaceId, botId },
      dedupeKey: `run:${runId}:needs_you`,
    });
    const response = await request(app, `http://localhost/api/inbox`, {
      method: "GET",
    });
    expect(response.status).toBe(401);
  });
});
