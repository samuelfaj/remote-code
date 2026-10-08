import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createApi } from "../app";

const stubAgent = join(import.meta.dir, "runs-stub-agent.mjs");
const testPassword = "local-test-password";

function tempDb(label: string) {
  return join(mkdtempSync(join(tmpdir(), `rc-thread-${label}-`)), "remotecode.sqlite");
}

async function api(path: string, cwd = mkdtempSync(join(tmpdir(), "rc-thread-cwd-"))) {
  const app = createApi(path, undefined, { password: testPassword }, undefined, {
    command: process.execPath,
    args: [stubAgent],
    cwd,
  });
  const response = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: testPassword }),
  }));
  if (response.status !== 200) throw new Error("login failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("cookie missing");
  return { app, cookie };
}

async function request(app: ReturnType<typeof createApi>, cookie: string, path: string, method = "GET", body?: unknown) {
  return app.handle(new Request(`https://localhost${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

async function createWorkspace(app: ReturnType<typeof createApi>, cookie: string, name: string) {
  const response = await request(app, cookie, "/api/workspaces", "POST", { name });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function createBot(app: ReturnType<typeof createApi>, cookie: string, name: string, instructions: string) {
  const response = await request(app, cookie, "/api/bots", "POST", { name, instructions });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

async function waitForState(app: ReturnType<typeof createApi>, cookie: string, id: string, states: string[], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { state: string } | null = null;
  while (Date.now() < deadline) {
    last = (await (await request(app, cookie, `/api/runs/${id}`)).json()) as { state: string };
    if (states.includes(last.state)) return last;
    await Bun.sleep(25);
  }
  throw new Error(`run ${id} never reached ${states.join("/")}; last=${JSON.stringify(last)}`);
}

type RunView = { id: string; threadId: string | null };
type ThreadMessage = { id: string; kind: string; body: string; runId: string | null; createdAt: string };
type ThreadMessages = { threadId: string; messages: ThreadMessage[] };

async function threadMessages(app: ReturnType<typeof createApi>, cookie: string, threadId: string) {
  const response = await request(app, cookie, `/api/threads/${threadId}/messages`);
  expect(response.status).toBe(200);
  return (await response.json()) as ThreadMessages;
}

describe("run transcript", () => {
  it("records the prompt as a user message and the agent reply as an assistant message", async () => {
    const { app, cookie } = await api(tempDb("workspace"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const prompt = "quick task";

    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt });
    expect(created.status).toBe(201);
    const run = (await created.json()) as RunView;
    expect(run.threadId).not.toBeNull();

    const finished = await waitForState(app, cookie, run.id, ["completed", "failed"]);
    expect(finished.state).toBe("completed");

    const thread = await threadMessages(app, cookie, run.threadId as string);
    expect(thread.threadId).toBe(run.threadId as string);

    const userMessage = thread.messages.find((message) => message.kind === "user");
    expect(userMessage?.body).toBe(prompt);
    expect(userMessage?.runId).toBe(run.id);

    const replies = thread.messages.filter((message) => message.kind === "assistant" && message.runId === run.id);
    expect(replies.length).toBe(1);
    expect(replies[0].body.length).toBeGreaterThan(0);
    expect(replies[0].body).toContain(prompt);
  });

  it("records a bot run on the bot's own thread", async () => {
    const { app, cookie } = await api(tempDb("bot"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const instructions = "You are a thread test bot.";
    const prompt = "quick task";
    const bot = await createBot(app, cookie, "threadbot", instructions);

    const created = await request(app, cookie, `/api/bots/${bot.id}/run`, "POST", { workspaceId: workspace.id, prompt });
    expect(created.status).toBe(201);
    const run = (await created.json()) as RunView;
    expect(run.threadId).not.toBeNull();

    const finished = await waitForState(app, cookie, run.id, ["completed", "failed"]);
    expect(finished.state).toBe("completed");

    const thread = await threadMessages(app, cookie, run.threadId as string);
    const userMessage = thread.messages.find((message) => message.kind === "user");
    expect(userMessage?.body).toBe(`${instructions}\n\n${prompt}`);
    expect(userMessage?.runId).toBe(run.id);

    const replies = thread.messages.filter((message) => message.kind === "assistant" && message.runId === run.id);
    expect(replies.length).toBe(1);
    expect(replies[0].body.length).toBeGreaterThan(0);

    // A plain run in the same workspace uses a different thread ("Chat"), so the
    // bot reply lives on the bot's own thread, not the workspace default one.
    const plain = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "plain task" });
    const plainRun = (await plain.json()) as RunView;
    expect(plainRun.threadId).not.toBeNull();
    expect(plainRun.threadId).not.toBe(run.threadId);
  });

  it("records no assistant message when the agent sends no text", async () => {
    const { app, cookie } = await api(tempDb("empty"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const prompt = "EMPTY_REPLY task";

    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt });
    expect(created.status).toBe(201);
    const run = (await created.json()) as RunView;
    expect(run.threadId).not.toBeNull();

    const finished = await waitForState(app, cookie, run.id, ["completed", "failed"]);
    expect(finished.state).toBe("completed");

    const thread = await threadMessages(app, cookie, run.threadId as string);
    const userMessage = thread.messages.find((message) => message.kind === "user");
    expect(userMessage?.body).toBe(prompt);
    expect(userMessage?.runId).toBe(run.id);

    const replies = thread.messages.filter((message) => message.kind === "assistant" && message.runId === run.id);
    expect(replies.length).toBe(0);
  });
});
