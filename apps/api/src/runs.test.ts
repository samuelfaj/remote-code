import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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

async function api(path: string, cwd = mkdtempSync(join(tmpdir(), "rc009-cwd-")), env?: NodeJS.ProcessEnv, stallMs?: number) {
  const app = createApi(path, undefined, { password: testPassword }, undefined, {
    command: process.execPath,
    args: [stubAgent],
    cwd,
    stallMs,
    ...(env ? { env } : {}),
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

  it("does not pass backend secrets to the agent process", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rc015-cwd-"));
    process.env.REMOTECODE_GATEWAY_TOKEN = "backend-only-secret";
    try {
      const { app, cookie } = await api(tempDb("isolation"), cwd);
      const workspace = await createWorkspace(app, cookie, "runs");
      const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "ENVCHECK now" });
      const run = (await created.json()) as { id: string };
      await waitForState(app, cookie, run.id, ["completed", "failed"]);
      const seen = readFileSync(join(cwd, "envcheck.txt"), "utf8");
      expect(seen).toBe("absent");
    } finally {
      delete process.env.REMOTECODE_GATEWAY_TOKEN;
    }
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

  it("fails a run honestly when the agent cannot be spawned", async () => {
    const path = tempDb("spawn-fail");
    const app = createApi(path, undefined, { password: testPassword }, undefined, {
      command: join(tmpdir(), "no-such-remotecode-agent"),
      args: ["agent", "stdio"],
      cwd: mkdtempSync(join(tmpdir(), "rc009-cwd-")),
      stallMs: 0,
    });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: testPassword }),
    }));
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("cookie missing");
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick task" });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };

    // The API must stay up and record a failed run, not die with the spawn error.
    const failed = await waitForState(app, cookie, run.id, ["failed"], 5_000);
    expect(failed.state).toBe("failed");
    expect(failed.stopReason).toBe("spawn_failed");
    expect((await request(app, cookie, "/api/health/ready")).status).toBe(200);
  });

  it("ends a run whose agent goes silent as interrupted with stopReason stalled", async () => {
    const { app, cookie } = await api(tempDb("stall"), undefined, undefined, 300);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "SLOW silent task" });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };

    await waitForState(app, cookie, run.id, ["running"]);
    const stalled = await waitForState(app, cookie, run.id, ["interrupted"], 5_000);
    expect(stalled.state).toBe("interrupted");
    expect(stalled.stopReason).toBe("stalled");

    // The killed agent settling later must not replace the honest ending.
    await Bun.sleep(300);
    const after = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as RunSummary;
    expect(after.state).toBe("interrupted");
    expect(after.stopReason).toBe("stalled");
  });

  it("does not stall a quick run when stallMs is comfortably larger", async () => {
    const { app, cookie } = await api(tempDb("no-stall"), undefined, undefined, 5_000);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick task" });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };
    const finished = await waitForState(app, cookie, run.id, ["completed", "failed"], 5_000);
    expect(finished.state).toBe("completed");
    expect(finished.stopReason).toBe("end_turn");
  });

  it("does not disturb a handoff run that is in needs_user", async () => {
    const { app, cookie } = await api(tempDb("stall-handoff"), undefined, undefined, 300);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "SLOW handoff task" });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };

    await waitForState(app, cookie, run.id, ["running"]);
    const handoff = await request(app, cookie, `/api/runs/${run.id}/handoff`, "POST", { reason: "user must review" });
    expect(handoff.status).toBe(200);
    expect(((await handoff.json()) as RunSummary).state).toBe("needs_user");

    // Wait longer than stallMs; the watchdog must not touch needs_user runs.
    await Bun.sleep(1_000);
    const after = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as RunSummary;
    expect(after.state).toBe("needs_user");
  });
});
describe("needs_user handoff", () => {
  type HandoffView = RunSummary & { sessionId?: string | null; handoffReason?: string | null };

  it("records the ACP session id and keeps a handoff run in needs_user when the agent finishes", async () => {
    const path = tempDb("handoff");
    const { app, cookie } = await api(path);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick task" });
    const run = (await created.json()) as { id: string };

    const running = (await waitForState(app, cookie, run.id, ["running"])) as HandoffView;
    expect(running.sessionId).toBe("stub-session");

    const handoff = await request(app, cookie, `/api/runs/${run.id}/handoff`, "POST", { reason: "user must sign in" });
    expect(handoff.status).toBe(200);
    const handed = (await handoff.json()) as HandoffView;
    expect(handed.state).toBe("needs_user");
    expect(handed.handoffReason).toBe("user must sign in");
    expect(handed.sessionId).toBe("stub-session");

    // The stub agent answers the prompt 60ms in; the handoff must not be
    // overwritten by that completion.
    await Bun.sleep(300);
    const after = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as HandoffView;
    expect(after.state).toBe("needs_user");
    expect(after.handoffReason).toBe("user must sign in");

    const db = new Database(path, { create: true });
    try {
      const row = db.query("SELECT state, session_id, handoff_reason FROM runs WHERE id = ?").get(run.id);
      expect(row).toEqual({ state: "needs_user", session_id: "stub-session", handoff_reason: "user must sign in" });
    } finally {
      db.close();
    }
  });

  it("keeps a handoff made before the agent creates its session", async () => {
    const path = tempDb("handoff-starting");
    const { app, cookie } = await api(path, mkdtempSync(join(tmpdir(), "rc009-cwd-")), {
      ...process.env,
      STUB_SESSION_NEW_DELAY_MS: "2000",
    });
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick task" });
    const run = (await created.json()) as { id: string };

    // Hand off long before the stub answers session/new, so this is the race
    // window where the session id arrives after the state was set.
    const handoff = await request(app, cookie, `/api/runs/${run.id}/handoff`, "POST", { reason: "needs the user early" });
    expect(handoff.status).toBe(200);
    expect(((await handoff.json()) as HandoffView).state).toBe("needs_user");

    // Session creation and the agent's completion must both leave it waiting.
    await Bun.sleep(3_000);
    const after = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as HandoffView;
    expect(after.state).toBe("needs_user");
    expect(after.sessionId).toBe("stub-session");
    expect(after.handoffReason).toBe("needs the user early");
  });

  it("refuses a handoff on a finished run and changes nothing", async () => {
    const path = tempDb("handoff-terminal");
    const { app, cookie } = await api(path);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "quick task" });
    const run = (await created.json()) as { id: string };
    const finished = (await waitForState(app, cookie, run.id, ["completed", "failed"])) as HandoffView;

    const handoff = await request(app, cookie, `/api/runs/${run.id}/handoff`, "POST", { reason: "too late" });
    expect(handoff.status).toBe(409);
    expect((await handoff.json()) as { error: string }).toEqual({ error: "run_finished" });

    const after = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as HandoffView;
    expect(after.state).toBe(finished.state);
    expect(after.handoffReason ?? null).toBeNull();
  });

  it("does not let another login or an unknown id hand off a run", async () => {
    const path = tempDb("handoff-foreign");
    const { app, cookie } = await api(path);
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "SLOW task" });
    const run = (await created.json()) as { id: string };
    const before = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as HandoffView;

    const db = new Database(path, { create: true });
    let otherCookie: string;
    try {
      const otherToken = randomBytes(32).toString("hex");
      db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(createHash("sha256").update(otherToken).digest("hex"), "other-user", Date.now() + 60_000);
      otherCookie = `remotecode_session=${otherToken}`;
    } finally {
      db.close();
    }

    expect((await request(app, otherCookie, `/api/runs/${run.id}/handoff`, "POST", { reason: "foreign" })).status).toBe(404);
    expect((await request(app, cookie, "/api/runs/00000000-0000-0000-0000-000000000000/handoff", "POST", { reason: "ghost" })).status).toBe(404);

    const after = (await (await request(app, cookie, `/api/runs/${run.id}`)).json()) as HandoffView;
    expect(after.state).toBe(before.state);
    expect(after.handoffReason ?? null).toBeNull();
  });
});
