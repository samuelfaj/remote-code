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

describe("RC-034 provider failure classification", () => {
  type FailedView = RunSummary & { stopReason: string; retryAfterSeconds: number | null };

  it("ends a run as failed with provider_auth_expired when the provider refuses with 401", async () => {
    const path = tempDb("auth-expired");
    const { app, cookie } = await api(path, mkdtempSync(join(tmpdir(), "rc034-cwd-")), {
      ...process.env,
      STUB_PROMPT_LOG: join(mkdtempSync(join(tmpdir(), "rc034-prompt-")), "prompt.log"),
    });
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "AUTH_EXPIRED task" });
    const run = (await created.json()) as { id: string };
    const failed = await waitForState(app, cookie, run.id, ["failed"]);
    expect(failed.stopReason).toBe("provider_auth_expired");
    expect((failed as FailedView).retryAfterSeconds).toBeNull();
    expect((await request(app, cookie, "/api/health/ready")).status).toBe(200);
  });

  it("ends a run as failed with provider_rate_limited and retryAfterSeconds when the provider returns 429", async () => {
    const path = tempDb("rate-limited");
    const { app, cookie } = await api(path, mkdtempSync(join(tmpdir(), "rc034-cwd-")), {
      ...process.env,
      STUB_PROMPT_LOG: join(mkdtempSync(join(tmpdir(), "rc034-prompt-")), "prompt.log"),
    });
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "RATE_LIMITED task" });
    const run = (await created.json()) as { id: string };
    const failed = await waitForState(app, cookie, run.id, ["failed"]);
    expect(failed.stopReason).toBe("provider_rate_limited");
    expect((failed as FailedView).retryAfterSeconds).toBe(30);
    expect((await request(app, cookie, "/api/health/ready")).status).toBe(200);
  });

  it("ends a run as failed with provider_unavailable when the provider returns 503", async () => {
    const path = tempDb("unavailable");
    const { app, cookie } = await api(path, mkdtempSync(join(tmpdir(), "rc034-cwd-")), {
      ...process.env,
      STUB_PROMPT_LOG: join(mkdtempSync(join(tmpdir(), "rc034-prompt-")), "prompt.log"),
    });
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "UNAVAILABLE task" });
    const run = (await created.json()) as { id: string };
    const failed = await waitForState(app, cookie, run.id, ["failed"]);
    expect(failed.stopReason).toBe("provider_unavailable");
    expect((failed as FailedView).retryAfterSeconds).toBeNull();
    expect((await request(app, cookie, "/api/health/ready")).status).toBe(200);
  });

  it("logs exactly one prompt attempt per run and the argv contains no model switch", async () => {
    const path = tempDb("prompt-log");
    const logFile = join(mkdtempSync(join(tmpdir(), "rc034-prompt-")), "prompt.log");
    const { app, cookie } = await api(path, mkdtempSync(join(tmpdir(), "rc034-cwd-")), {
      ...process.env,
      STUB_PROMPT_LOG: logFile,
    });
    const workspace = await createWorkspace(app, cookie, "runs");
    const created = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "AUTH_EXPIRED task" });
    const run = (await created.json()) as { id: string };
    await waitForState(app, cookie, run.id, ["failed"]);

    const logContent = readFileSync(logFile, "utf8");
    const lines = logContent.trim().split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("--model");
  });
});

describe("RC-040 bot runs", () => {
  async function createBot(app: ReturnType<typeof createApi>, cookie: string, name: string, instructions: string) {
    const response = await request(app, cookie, "/api/bots", "POST", { name, instructions });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; instructions: string };
  }

  it("two bots in the same workspace get a run each with their own instructions", async () => {
    const { app, cookie } = await api(tempDb("bot-runs"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const bot1 = await createBot(app, cookie, "bot1", "Bot one instructions");
    const bot2 = await createBot(app, cookie, "bot2", "Bot two instructions");

    const run1 = await request(app, cookie, `/api/bots/${bot1.id}/run`, "POST", { workspaceId: workspace.id, prompt: "hello" });
    expect(run1.status).toBe(201);
    const run1Body = (await run1.json()) as { id: string; prompt: string };
    expect(run1Body.prompt).toBe("Bot one instructions\n\nhello");

    const run2 = await request(app, cookie, `/api/bots/${bot2.id}/run`, "POST", { workspaceId: workspace.id, prompt: "hello" });
    expect(run2.status).toBe(201);
    const run2Body = (await run2.json()) as { id: string; prompt: string };
    expect(run2Body.prompt).toBe("Bot two instructions\n\nhello");
  });

  it("each GET /api/bots/:id/runs returns only that bot's run", async () => {
    const { app, cookie } = await api(tempDb("bot-runs-list"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const bot1 = await createBot(app, cookie, "bot1", "instructions 1");
    const bot2 = await createBot(app, cookie, "bot2", "instructions 2");

    await request(app, cookie, `/api/bots/${bot1.id}/run`, "POST", { workspaceId: workspace.id, prompt: "task" });
    await request(app, cookie, `/api/bots/${bot2.id}/run`, "POST", { workspaceId: workspace.id, prompt: "task" });

    const runs1 = (await (await request(app, cookie, `/api/bots/${bot1.id}/runs`)).json()) as { runs: { id: string; botId: string | null }[] };
    const runs2 = (await (await request(app, cookie, `/api/bots/${bot2.id}/runs`)).json()) as { runs: { id: string; botId: string | null }[] };

    expect(runs1.runs.length).toBe(1);
    expect(runs1.runs[0].botId).toBe(bot1.id);
    expect(runs2.runs.length).toBe(1);
    expect(runs2.runs[0].botId).toBe(bot2.id);
  });

  it("repeating POST with the same requestId returns the same run id and creates no second run", async () => {
    const idempotencyPath = tempDb("bot-idem");
    const { app, cookie } = await api(idempotencyPath);
    const workspace = await createWorkspace(app, cookie, "runs");
    const bot = await createBot(app, cookie, "bot", "instructions");
    const requestId = crypto.randomUUID();

    const first = await request(app, cookie, `/api/bots/${bot.id}/run`, "POST", { workspaceId: workspace.id, prompt: "quick", requestId });
    const second = await request(app, cookie, `/api/bots/${bot.id}/run`, "POST", { workspaceId: workspace.id, prompt: "quick", requestId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await first.json()) as { id: string }).id).toBe(requestId);
    expect(((await second.json()) as { id: string }).id).toBe(requestId);

    const db = new Database(idempotencyPath, { create: true });
    try {
      const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE id = ?").get(requestId);
      expect(count?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("unknown or foreign bot id returns 404", async () => {
    const { app, cookie } = await api(tempDb("bot-not-found"));
    const workspace = await createWorkspace(app, cookie, "runs");

    const unknown = await request(app, cookie, "/api/bots/00000000-0000-4000-8000-000000000000/run", "POST", { workspaceId: workspace.id, prompt: "hello" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("bot_not_found");

    const bot = await createBot(app, cookie, "bot", "instructions");
    const foreign = await request(app, cookie, `/api/bots/${bot.id}/run`, "POST", { workspaceId: "00000000-0000-4000-8000-000000000000", prompt: "hello" });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: string }).error).toBe("workspace_not_found");
  });

  it("a run created through /api/runs never appears in any bot's run list", async () => {
    const { app, cookie } = await api(tempDb("bot-no-plain-run"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const bot = await createBot(app, cookie, "bot", "instructions");

    const plainRun = await request(app, cookie, "/api/runs", "POST", { workspaceId: workspace.id, prompt: "plain task" });
    expect(plainRun.status).toBe(201);
    const plainRunResult = (await plainRun.json()) as { id: string };
    const plainRunId = plainRunResult.id;

    const botRuns = (await (await request(app, cookie, `/api/bots/${bot.id}/runs`)).json()) as { runs: { id: string }[] };
    expect(botRuns.runs.map((r) => r.id)).not.toContain(plainRunId);
  });

  it("a bot run can be interrupted through the existing stop route", async () => {
    const { app, cookie } = await api(tempDb("bot-stop"));
    const workspace = await createWorkspace(app, cookie, "runs");
    const bot = await createBot(app, cookie, "bot", "instructions");

    const created = await request(app, cookie, `/api/bots/${bot.id}/run`, "POST", { workspaceId: workspace.id, prompt: "SLOW task" });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string; state: string };
    expect(["starting", "running"]).toContain(run.state);
    await waitForState(app, cookie, run.id, ["running"]);

    const stopped = await request(app, cookie, `/api/runs/${run.id}/stop`, "POST");
    expect(stopped.status).toBe(200);
    const finished = await waitForState(app, cookie, run.id, ["interrupted", "failed"]);
    expect(finished.state).toBe("interrupted");
    expect(finished.stopReason).toBe("cancelled");
  });
});
