import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../../../apps/api/src/app";
import { createApiClient } from "./index";
import { createThread, listThreads, postThreadMessage, listThreadMessages } from "./messages";
import type { Thread } from "./messages";

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rc048-messages-client-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function login(app: ReturnType<typeof createApi>) {
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "messages-client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test login cookie missing");
  return cookie;
}

it("createThread creates a thread and returns the result", async () => {
  const app = createApi(databasePath(), undefined, { password: "messages-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "messages-test", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    const result = await createThread(workspaceId, "My thread", origin, options);
    expect(result.title).toBe("My thread");
    expect(result.workspaceId).toBe(workspaceId);
    expect(result.id).toBeTruthy();
  } finally { await app.stop(true); }
});

it("createThread rejects an empty title with 400", async () => {
  const app = createApi(databasePath(), undefined, { password: "messages-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "messages-test2", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    let thrown = false;
    try {
      await createThread(workspaceId, "", origin, options);
    } catch (error) {
      thrown = true;
      expect((error as { status?: number }).status).toBe(422);
    }
    expect(thrown).toBe(true);
  } finally { await app.stop(true); }
});

it("listThreads returns threads newest first", async () => {
  const app = createApi(databasePath(), undefined, { password: "messages-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "messages-test3", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    await createThread(workspaceId, "First", origin, options);
    await createThread(workspaceId, "Second", origin, options);
    const threads = await listThreads(workspaceId, origin, options);
    expect(threads.length).toBeGreaterThanOrEqual(2);
    expect(threads[0].title).toBe("Second");
  } finally { await app.stop(true); }
});

it("postThreadMessage posts a message and listThreadMessages returns it", async () => {
  const app = createApi(databasePath(), undefined, { password: "messages-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "messages-test4", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    const thread = await createThread(workspaceId, "Message test", origin, options);
    const posted = await postThreadMessage(workspaceId, thread.id, "Hello", undefined, undefined, origin, options);
    expect(posted.body).toBe("Hello");
    expect(posted.kind).toBe("user");

    const messages = await listThreadMessages(workspaceId, thread.id, origin, options);
    expect(messages.threadId).toBe(thread.id);
    expect(messages.messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.messages[0].body).toBe("Hello");
  } finally { await app.stop(true); }
});

it("postThreadMessage rejects a message to a foreign thread with 404", async () => {
  const app = createApi(databasePath(), undefined, { password: "messages-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "messages-test5", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    await createThread(workspaceId, "Foreign thread", origin, options);
    const foreignThreadId = crypto.randomUUID();
    let thrown = false;
    try {
      await postThreadMessage(workspaceId, foreignThreadId, "Hello", undefined, undefined, origin, options);
    } catch (error) {
      thrown = true;
      expect((error as { status?: number }).status).toBe(404);
    }
    expect(thrown).toBe(true);
  } finally { await app.stop(true); }
});
