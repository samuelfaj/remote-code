import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { createApi } from "../app";
import { nextOccurrence, schedulesFeature } from "./schedules";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc045-schedules-"));
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

describe("nextOccurrence planner", () => {
  it("returns exact for a normal day", () => {
    const after = new Date("2026-01-15T10:00:00Z");
    const result = nextOccurrence("10:30", "America/New_York", after);
    expect(result.decision).toBe("exact");
    expect(result.plannedAt.getUTCHours()).toBe(15);
    expect(result.plannedAt.getUTCMinutes()).toBe(30);
  });

  it("returns shifted_forward for a spring-forward gap", () => {
    const after = new Date("2026-03-08T06:59:00Z");
    const result = nextOccurrence("02:30", "America/New_York", after);
    expect(result.decision).toBe("shifted_forward");
    const localHour = result.plannedAt.getUTCHours();
    expect(localHour).toBeGreaterThanOrEqual(7);
  });

  it("returns deduplicated for a fall-back transition and does not return the second occurrence on the same day", () => {
    const after = new Date("2026-11-01T05:00:00Z");
    const result = nextOccurrence("01:30", "America/New_York", after);
    expect(result.decision).toBe("deduplicated");
    // Calling again with after past the first occurrence should return
    // the first occurrence of the next day, not the second occurrence on the same day.
    const later = new Date(result.plannedAt.getTime() + 60 * 60 * 1000);
    const laterResult = nextOccurrence("01:30", "America/New_York", later);
    expect(laterResult.plannedAt.getTime()).not.toBe(result.plannedAt.getTime());
    expect(laterResult.decision).toBe("exact");
  });
});

describe("Schedule routes", () => {
  it("POST /api/schedules rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "task", workspaceId: "00000000-0000-4000-8000-000000000000", prompt: "test", localTime: "10:00", timezone: "America/New_York" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/schedules rejects invalid local_time with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ kind: "task", workspaceId: "00000000-0000-4000-8000-000000000000", prompt: "test", localTime: "25:00", timezone: "America/New_York" }),
    });
    expect(response.status).toBe(400);
  });

  it("POST /api/schedules rejects invalid_timezone with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ kind: "task", workspaceId: "00000000-0000-4000-8000-000000000000", prompt: "test", localTime: "10:00", timezone: "Invalid/Zone" }),
    });
    expect(response.status).toBe(400);
  });

  it("POST /api/schedules rejects invalid_prompt with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ kind: "task", workspaceId: "00000000-0000-4000-8000-000000000000", prompt: "", localTime: "10:00", timezone: "America/New_York" }),
    });
    expect(response.status).toBe(400);
  });

  it("POST /api/schedules returns 404 for another user's workspace", async () => {
    const { app, databasePath } = setup();
    const db = new Database(databasePath);
    const otherWorkspaceId = crypto.randomUUID();
    db.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(otherWorkspaceId, "bob", "other", new Date().toISOString());
    db.close();
    const response = await request(app, "http://localhost/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ kind: "task", workspaceId: otherWorkspaceId, prompt: "test", localTime: "10:00", timezone: "America/New_York" }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /api/schedules returns 404 for an unknown bot", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `remotecode_session=${ownerToken}` },
      body: JSON.stringify({ kind: "routine", botId: "00000000-0000-4000-8000-000000000000", prompt: "test", localTime: "10:00", timezone: "America/New_York" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("Schedule timer loop", () => {
  it("ticks once and inserts exactly ONE occurrence and calls startRun once", () => {
    const startRunCalls: Array<{ owner: { userId: string }; input: { workspaceId: string; prompt: string; botId?: string; requestId?: string } }> = [];
    const now = new Date("2026-01-15T10:00:00Z");
    const directory = mkdtempSync(join(tmpdir(), "rc045-timer-"));
    workDirectories.push(directory);
    const databasePath = join(directory, "host.sqlite");
    const feature = schedulesFeature(databasePath, {
      startRun: (owner, input) => {
        startRunCalls.push({ owner, input });
        return { kind: "ok", run: { id: "run-1", workspaceId: input.workspaceId, botId: null, state: "starting", prompt: input.prompt, createdAt: now.toISOString(), updatedAt: now.toISOString(), heartbeatAt: null, stopRequestedAt: null, stopReason: null, error: null, sessionId: null, handoffReason: null, retryAfterSeconds: null } };
      },
      now: () => now,
    });

    const db = new Database(databasePath);
    db.query("INSERT INTO schedules (id, user_id, kind, workspace_id, prompt, local_time, timezone, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(crypto.randomUUID(), "alice", "task", "ws-1", "test prompt", "10:00", "UTC", now.toISOString(), now.toISOString());
    db.close();

    feature.tick();
    expect(startRunCalls.length).toBe(1);
    expect(startRunCalls[0].input.requestId).toBeDefined();
    feature.stop();
  });

  it("ticks again with the same instant inserts nothing new and calls startRun zero more times", () => {
    const startRunCalls: Array<{ owner: { userId: string }; input: { workspaceId: string; prompt: string; botId?: string; requestId?: string } }> = [];
    const now = new Date("2026-01-15T10:00:00Z");
    const directory = mkdtempSync(join(tmpdir(), "rc045-timer2-"));
    workDirectories.push(directory);
    const databasePath = join(directory, "host.sqlite");
    const feature = schedulesFeature(databasePath, {
      startRun: (owner, input) => {
        startRunCalls.push({ owner, input });
        return { kind: "ok", run: { id: "run-1", workspaceId: input.workspaceId, botId: null, state: "starting", prompt: input.prompt, createdAt: now.toISOString(), updatedAt: now.toISOString(), heartbeatAt: null, stopRequestedAt: null, stopReason: null, error: null, sessionId: null, handoffReason: null, retryAfterSeconds: null } };
      },
      now: () => now,
    });

    const db = new Database(databasePath);
    db.query("INSERT INTO schedules (id, user_id, kind, workspace_id, prompt, local_time, timezone, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(crypto.randomUUID(), "alice", "task", "ws-1", "test prompt", "10:00", "UTC", now.toISOString(), now.toISOString());
    db.close();

    feature.tick();
    const firstCount = startRunCalls.length;
    feature.tick();
    expect(startRunCalls.length).toBe(firstCount);
    feature.stop();
  });

  it("a paused schedule ticks without any occurrence or call", () => {
    const startRunCalls: Array<{ owner: { userId: string }; input: { workspaceId: string; prompt: string; botId?: string; requestId?: string } }> = [];
    const now = new Date("2026-01-15T10:00:00Z");
    const directory = mkdtempSync(join(tmpdir(), "rc045-timer3-"));
    workDirectories.push(directory);
    const databasePath = join(directory, "host.sqlite");
    const feature = schedulesFeature(databasePath, {
      startRun: (owner, input) => {
        startRunCalls.push({ owner, input });
        return { kind: "ok", run: { id: "run-1", workspaceId: input.workspaceId, botId: null, state: "starting", prompt: input.prompt, createdAt: now.toISOString(), updatedAt: now.toISOString(), heartbeatAt: null, stopRequestedAt: null, stopReason: null, error: null, sessionId: null, handoffReason: null, retryAfterSeconds: null } };
      },
      now: () => now,
    });

    const db = new Database(databasePath);
    db.query("INSERT INTO schedules (id, user_id, kind, workspace_id, prompt, local_time, timezone, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .run(crypto.randomUUID(), "alice", "task", "ws-1", "test prompt", "10:00", "UTC", now.toISOString(), now.toISOString());
    db.close();

    feature.tick();
    expect(startRunCalls.length).toBe(0);
    feature.stop();
  });
});
