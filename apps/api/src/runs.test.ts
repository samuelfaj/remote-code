import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createApi } from "./app";

const stubAgent = join(import.meta.dir, "features/runs-stub-agent.mjs");
const testPassword = "local-test-password";

function tempDb(label: string) {
  return join(mkdtempSync(join(tmpdir(), `rc009-${label}-`)), "remotecode.sqlite");
}

function openSocket(url: string, cookie: string) {
  const BunWebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new BunWebSocketWithHeaders(url, { headers: { cookie, origin: "http://localhost:5173" } });
}

function waitForEvent(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5_000);
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String((message as MessageEvent).data)) as Record<string, unknown>;
      if (event.type !== type) return;
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

async function api(path: string, password = testPassword) {
  const app = createApi(path, undefined, { password }, undefined, {
    command: process.execPath,
    args: [stubAgent],
    cwd: tmpdir(),
  });
  const response = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
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

type RunSummary = { state: string; heartbeatAt?: string | null; stopReason?: string | null };

async function waitForState(app: ReturnType<typeof createApi>, cookie: string, id: string, states: string[], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last: RunSummary | null = null;
  while (Date.now() < deadline) {
    const response = await request(app, cookie, `/api/runs/${id}`);
    last = (await response.json()) as RunSummary;
    if (states.includes(last.state)) return last;
    await Bun.sleep(25);
  }
  throw new Error(`run ${id} never reached ${states.join("/")}; last=${JSON.stringify(last)}`);
}

describe("RC-009 run supervision", () => {
  it("starts, observes progress, and stops a run to interrupted", async () => {
    const { app, cookie } = await api(tempDb("stop"));
    const workspace = await createWorkspace(app, cookie, "runs");

    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "SLOW task" });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string; state: string };
    expect(["starting", "running"]).toContain(run.state);

    const running = await waitForState(app, cookie, run.id, ["running"]);
    expect(running.heartbeatAt ?? null).not.toBeNull();

    const stopped = await request(app, cookie, `/api/runs/${run.id}/stop`, "POST");
    expect(stopped.status).toBe(200);
    const finished = await waitForState(app, cookie, run.id, ["interrupted", "failed"]);
    expect(finished.state).toBe("interrupted");
    expect(finished.stopReason).toBe("cancelled");
  });

  it("completes a short run and records end_turn", async () => {
    const { app, cookie } = await api(tempDb("complete"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick task" });
    const run = (await created.json()) as { id: string };
    const finished = await waitForState(app, cookie, run.id, ["completed", "failed"]);
    expect(finished.state).toBe("completed");
    expect(finished.stopReason).toBe("end_turn");
  });

  it("is idempotent for a repeated requestId and hides other owners' runs", async () => {
    const path = tempDb("idem");
    const { app, cookie } = await api(path);
    const workspace = await createWorkspace(app, cookie, "runs");
    const requestId = crypto.randomUUID();

    const first = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick", requestId });
    const second = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick", requestId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await first.json()) as { id: string }).id).toBe(requestId);
    expect(((await second.json()) as { id: string }).id).toBe(requestId);

    const db = new Database(path, { create: true });
    try {
      const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE id = ?").get(requestId);
      expect(count?.n).toBe(1);
      // A run owned by another user must be invisible to this session.
      const foreignId = crypto.randomUUID();
      db.query(`INSERT INTO runs (id, user_id, workspace_id, prompt, state, created_at, updated_at)
        VALUES (?, 'other-user', ?, 'x', 'interrupted', ?, ?)`).run(foreignId, workspace.id, new Date().toISOString(), new Date().toISOString());
      expect((await request(app, cookie, `/api/runs/${foreignId}`)).status).toBe(404);
    } finally {
      db.close();
    }

    expect((await app.handle(new Request("https://localhost/api/runs/" + requestId))).status).toBe(401);
  });

  it("broadcasts run progress to a connected client", async () => {
    const { app, cookie } = await api(tempDb("events"));
    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("no test port");
    const socket = openSocket(`ws://127.0.0.1:${port}/api/events`, cookie);
    try {
      await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
      const workspace = await createWorkspace(app, cookie, "runs");
      const progress = waitForEvent(socket, "run.updated");
      const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "SLOW push" });
      expect(created.status).toBe(201);
      const event = await progress;
      const run = event.run as { state: string; workspaceId: string };
      expect(run.workspaceId).toBe(workspace.id);
      expect(["starting", "running"]).toContain(run.state);
    } finally {
      socket.close();
      await server.stop(true);
    }
  });

  it("reconciles a live run to interrupted when the host process restarts", async () => {
    const path = tempDb("restart");
    const { app, cookie } = await api(path);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "SLOW stuck task" });
    const run = (await created.json()) as { id: string };
    await waitForState(app, cookie, run.id, ["running"]);

    // A fresh API process on the same database must not leave it "running".
    const { app: restarted, cookie: restartedCookie } = await api(path);
    const reconciled = (await (await request(restarted, restartedCookie, `/api/runs/${run.id}`)).json()) as RunSummary;
    expect(reconciled.state).toBe("interrupted");
    expect(reconciled.stopReason).toBe("host_restart");
  });
});