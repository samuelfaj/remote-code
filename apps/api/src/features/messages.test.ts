import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup() {
  const directory = mkdtempSync(join(process.env.RC036_TEST_WORK_DIR ?? tmpdir(), "rc036-messages-"));
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

function provision(app: ReturnType<typeof createApi>, workspaceId: string) {
  return request(app, `http://localhost/api/workspaces/${workspaceId}/folder`, {
    method: "POST",
    headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
  });
}

function setupWorkspace(databasePath: string) {
  const database = new Database(databasePath);
  const workspaceId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
    .run(workspaceId, new Date().toISOString());
  database.close();
  return { workspaceId };
}

describe("Messages routes", () => {
  it("POST /api/workspaces/:workspaceId/threads creates a thread", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    // Thread creation does not require workspace provisioning.
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "My thread" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; workspaceId: string; title: string; createdAt: string; updatedAt: string };
    expect(body.title).toBe("My thread");
    expect(body.workspaceId).toBe(workspaceId);
    expect(canonicalUuid.test(body.id)).toBe(true);
  });

  it("GET /api/workspaces/:workspaceId/threads lists threads newest first", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    // Create threads via API
    const t1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "First" }),
    });
    expect(t1.status).toBe(201);
    const t2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Second" }),
    });
    expect(t2.status).toBe(201);
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { threads: Array<{ id: string; title: string }> };
    expect(body.threads.length).toBe(2);
    expect(body.threads[0].title).toBe("Second");
    expect(body.threads[1].title).toBe("First");
  });

  it.skipIf(process.platform !== "linux")("POST /api/threads/:threadId/messages with attachment returns path, sha256, and size", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(join(folderPath, "note.txt"), "hello world");
    const threadResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { id: string }).id;
    const response = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Check this", attachments: ["note.txt"] }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      id: string; threadId: string; kind: string; body: string;
      attachments: Array<{ path: string; sha256: string; size: number }>;
      createdAt: string;
    };
    expect(body.kind).toBe("user");
    expect(body.body).toBe("Check this");
    expect(body.attachments.length).toBe(1);
    expect(body.attachments[0].path).toBe("note.txt");
    expect(body.attachments[0].sha256).toBe(createHash("sha256").update("hello world").digest("hex"));
    expect(body.attachments[0].size).toBe(11);
    // GET returns the same attachment values
    const getResponse = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as { threadId: string; messages: Array<{ attachments: Array<{ path: string; sha256: string; size: number }> }> };
    expect(getBody.messages.length).toBe(1);
    expect(getBody.messages[0].attachments.length).toBe(1);
    expect(getBody.messages[0].attachments[0].path).toBe("note.txt");
    expect(getBody.messages[0].attachments[0].sha256).toBe(body.attachments[0].sha256);
    expect(getBody.messages[0].attachments[0].size).toBe(body.attachments[0].size);
  });

  it.skipIf(process.platform !== "linux")("attachment does not switch thread: second thread does not see first thread's attachment", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(join(folderPath, "note.txt"), "hello world");
    // Create two threads
    const t1Resp = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread 1" }),
    });
    expect(t1Resp.status).toBe(201);
    const thread1Id = (await t1Resp.json() as { id: string }).id;
    const t2Resp = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread 2" }),
    });
    expect(t2Resp.status).toBe(201);
    const thread2Id = (await t2Resp.json() as { id: string }).id;
    // Post message with attachment to thread 1
    const m1 = await request(app, `http://localhost/api/threads/${thread1Id}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Msg1", attachments: ["note.txt"] }),
    });
    expect(m1.status).toBe(201);
    // Post message without attachment to thread 2
    const m2 = await request(app, `http://localhost/api/threads/${thread2Id}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Msg2" }),
    });
    expect(m2.status).toBe(201);
    // Thread 2 should not have any attachments
    const t2Messages = await request(app, `http://localhost/api/threads/${thread2Id}/messages`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(t2Messages.status).toBe(200);
    const t2Body = await t2Messages.json() as { threadId: string; messages: Array<{ attachments: unknown[] }> };
    expect(t2Body.messages[0].attachments).toEqual([]);
    // Thread 1 should have the attachment
    const t1Messages = await request(app, `http://localhost/api/threads/${thread1Id}/messages`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(t1Messages.status).toBe(200);
    const t1Body = await t1Messages.json() as { threadId: string; messages: Array<{ attachments: unknown[] }> };
    expect(t1Body.messages[0].attachments.length).toBe(1);
  });

  it.skipIf(process.platform !== "linux")("path outside workspace (../something) is refused 400 and writes no message", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    const threadResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { id: string }).id;
    const response = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Bad", attachments: ["../something"] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_attachment_path");
    // No message was written
    const getResponse = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    const getBody = await getResponse.json() as { threadId: string; messages: unknown[] };
    expect(getBody.messages.length).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("missing file is 404 attachment_not_found", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    const threadResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { id: string }).id;
    const response = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Msg", attachments: ["missing.txt"] }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("attachment_not_found");
  });

  it.skipIf(process.platform !== "linux")("same thread and its attachments are still returned after the feature is re-constructed over the same database", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(join(folderPath, "note.txt"), "hello world");
    const threadResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { id: string }).id;
    const msgResponse = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Msg", attachments: ["note.txt"] }),
    });
    expect(msgResponse.status).toBe(201);
    // Re-construct the feature over the same database (simulates restart)
    const app2 = createApi(databasePath);
    const getResponse = await request(app2, `http://localhost/api/threads/${threadId}/messages`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as { threadId: string; messages: Array<{ attachments: Array<{ path: string; sha256: string; size: number }> }> };
    expect(getBody.messages.length).toBe(1);
    expect(getBody.messages[0].attachments.length).toBe(1);
    expect(getBody.messages[0].attachments[0].path).toBe("note.txt");
  });

  it("run_changes is returned on the result message and through GET /api/runs/:id/changes", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    // Set up a git repo with a change
    const gitProc = Bun.spawnSync(["git", "init", "-b", "main"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
    expect(gitProc.exitCode).toBe(0);
    writeFileSync(join(folderPath, "file.txt"), "original");
    const addProc = Bun.spawnSync(["git", "add", "file.txt"], { cwd: folderPath, stdout: "pipe" });
    expect(addProc.exitCode).toBe(0);
    const commitProc = Bun.spawnSync(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "init"], { cwd: folderPath, stdout: "pipe" });
    expect(commitProc.exitCode).toBe(0);
    writeFileSync(join(folderPath, "file.txt"), "modified");
    // Create a run directly in the database
    const db = new Database(databasePath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query("INSERT INTO runs (id, user_id, workspace_id, bot_id, prompt, state, created_at, updated_at, heartbeat_at, stop_requested_at, stop_reason, error, session_id, handoff_reason, retry_after_seconds) VALUES (?, 'alice', ?, NULL, 'test', 'completed', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)")
      .run(runId, workspaceId, now, now);
    // Manually insert run_changes
    const diffProc = Bun.spawnSync(["git", "diff", "--no-color", "--no-ext-diff", "--"], { cwd: folderPath, stdout: "pipe" });
    const diffOutput = diffProc.stdout.toString();
    const payload = JSON.stringify({
      files: [{ path: "file.txt", changeKind: " M" }],
      diff: diffOutput,
      truncated: false,
    });
    db.query("INSERT INTO run_changes (run_id, workspace_id, captured_at, payload) VALUES (?, ?, ?, ?)")
      .run(runId, workspaceId, now, payload);
    db.close();
    // Create a thread and result message
    const threadResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { id: string }).id;
    const msgResponse = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Result", runId }),
    });
    expect(msgResponse.status).toBe(201);
    // Check the result message has changes
    const messagesResponse = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as { threadId: string; messages: Array<{ changes: unknown }> };
    expect(messagesBody.messages[0].changes).not.toBeNull();
    expect((messagesBody.messages[0].changes as { files: unknown[] }).files).toEqual([{ path: "file.txt", changeKind: " M" }]);
    // Check GET /api/runs/:id/changes
    const changesResponse = await request(app, `http://localhost/api/runs/${runId}/changes`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(changesResponse.status).toBe(200);
    const changesBody = await changesResponse.json() as { runId: string; workspaceId: string; files: unknown[]; diff: string };
    expect(changesBody.runId).toBe(runId);
    expect(changesBody.workspaceId).toBe(workspaceId);
    expect(changesBody.files).toEqual([{ path: "file.txt", changeKind: " M" }]);
  });

  it("GET /api/runs/:id/changes returns 404 for a run belonging to another user", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    // Create a run for alice
    const db = new Database(databasePath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query("INSERT INTO runs (id, user_id, workspace_id, bot_id, prompt, state, created_at, updated_at, heartbeat_at, stop_requested_at, stop_reason, error, session_id, handoff_reason, retry_after_seconds) VALUES (?, 'alice', ?, NULL, 'test', 'completed', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)")
      .run(runId, workspaceId, now, now);
    db.close();
    // Bob tries to access alice's run changes
    const response = await request(app, `http://localhost/api/runs/${runId}/changes`, {
      headers: { cookie: `remotecode_session=${otherToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("POST /api/threads/:threadId/messages with runId belonging to another user's workspace returns 404 run_not_found", async () => {
    const { app, databasePath, directory } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(directory), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    // Create a thread
    const threadResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { id: string }).id;
    // Create a run for a different workspace (simulated by using a different workspaceId)
    const otherWorkspaceId = crypto.randomUUID();
    const db = new Database(databasePath);
    db.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'other', ?)")
      .run(otherWorkspaceId, new Date().toISOString());
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query("INSERT INTO runs (id, user_id, workspace_id, bot_id, prompt, state, created_at, updated_at, heartbeat_at, stop_requested_at, stop_reason, error, session_id, handoff_reason, retry_after_seconds) VALUES (?, 'alice', ?, NULL, 'test', 'completed', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)")
      .run(runId, otherWorkspaceId, now, now);
    db.close();
    // Try to reference that run in a message for the original workspace
    const response = await request(app, `http://localhost/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "Msg", runId }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("run_not_found");
  });

  it("anonymous request is rejected with 401", async () => {
    const { app, databasePath } = setup();
    const { workspaceId } = setupWorkspace(databasePath);
    await provision(app, workspaceId);
    const folderPath = join(dirname(databasePath), "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(join(folderPath, "note.txt"), "hello");
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread" }),
    });
    expect(response.status).toBe(401);
  });
});