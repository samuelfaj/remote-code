import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);

function setup(screenOptions?: Parameters<typeof createApi>[5]) {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc024-screen-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "screen.sqlite");

  const app = createApi(databasePath, undefined, undefined, undefined, undefined, screenOptions);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(otherToken).digest("hex"), "bob", Date.now() + 60_000);
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
    .run(workspaceId, new Date().toISOString());
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'bob', 'other', ?)")
    .run(otherWorkspaceId, new Date().toISOString());
  database.close();

  return { app, databasePath, directory, workspaceId, otherWorkspaceId };
}

afterEach(() => {
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

describe("Screen routes", () => {
  it("POST /api/workspaces/:workspaceId/screen/possession rejects an anonymous request with 401", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/workspaces/:workspaceId/screen/possession returns 404 for a workspace the caller does not own", async () => {
    const { app, otherWorkspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${otherWorkspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });

  it("POST /api/workspaces/:workspaceId/screen/possession takes exclusive possession and returns token", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { possessionId: string; token: string; epoch: number; expiresAt: number };
    expect(body.possessionId).toBeTruthy();
    expect(body.token).toBeTruthy();
    expect(body.epoch).toBe(1);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("POST /api/workspaces/:workspaceId/screen/possession increments epoch on second take", async () => {
    const { app, workspaceId } = setup();
    const first = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const firstBody = await first.json() as { token: string; epoch: number };
    expect(firstBody.epoch).toBe(1);

    const second = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const secondBody = await second.json() as { token: string; epoch: number };
    expect(secondBody.epoch).toBe(2);
    expect(secondBody.token).not.toBe(firstBody.token);
  });

  it("POST /api/workspaces/:workspaceId/screen/possession/heartbeat extends expiresAt with valid token", async () => {
    const { app, workspaceId } = setup();
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/heartbeat`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
  });

  it("POST /api/workspaces/:workspaceId/screen/possession/heartbeat returns 409 possession_lost with wrong token", async () => {
    const { app, workspaceId } = setup();
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/heartbeat`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_lost");
  });

  it("POST /api/workspaces/:workspaceId/screen/possession/heartbeat returns 404 for a workspace the caller does not own", async () => {
    const { app, otherWorkspaceId } = setup();
    await request(app, `http://localhost/api/workspaces/${otherWorkspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await request(app, `http://localhost/api/workspaces/${otherWorkspaceId}/screen/possession/heartbeat`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "any" }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /api/workspaces/:workspaceId/screen/possession/release clears possession", async () => {
    const { app, workspaceId } = setup();
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
  });

  it("POST /api/workspaces/:workspaceId/screen/possession/release returns 409 possession_lost with wrong token", async () => {
    const { app, workspaceId } = setup();
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_lost");
  });

  it("GET /api/workspaces/:workspaceId/screen/frame returns PNG with valid token", async () => {
    const capturedBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    const { app, workspaceId } = setup({
      capture: async () => capturedBytes,
    });
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}`, "x-rc-possession": token },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(capturedBytes);
  });

  it("GET /api/workspaces/:workspaceId/screen/frame returns 409 possession_required with wrong token", async () => {
    const { app, workspaceId } = setup({
      capture: async () => new Uint8Array([0x89, 0x50]),
    });
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}`, "x-rc-possession": "wrongtoken" },
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_required");
  });

  it("GET /api/workspaces/:workspaceId/screen/frame returns 409 possession_required when no live possession", async () => {
    const { app, workspaceId } = setup({
      capture: async () => new Uint8Array([0x89, 0x50]),
    });
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}`, "x-rc-possession": token },
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_required");
  });

  it("GET /api/workspaces/:workspaceId/screen/frame returns 409 possession_required after expiry", async () => {
    const { app, workspaceId } = setup({ possessionMs: 50 });
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}`, "x-rc-possession": token },
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_required");
  });

  it("POST /api/workspaces/:workspaceId/screen/input succeeds with valid token", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
    });
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, event: { kind: "click", x: 10, y: 20 } }),
    });
    expect(response.status).toBe(200);
    expect(inputCalls).toBe(1);
  });

  it("POST /api/workspaces/:workspaceId/screen/input returns 409 possession_required with wrong token", async () => {
    const { app, workspaceId } = setup({
      input: async () => {},
    });
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "wrongtoken", event: { kind: "click", x: 10, y: 20 } }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_required");
  });

  it("POST /api/workspaces/:workspaceId/screen/input returns 422 for invalid event", async () => {
    const { app, workspaceId } = setup({
      input: async () => {},
    });
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, event: { kind: "invalid" } }),
    });
    expect(response.status).toBe(422);
  });

  it("POST /api/workspaces/:workspaceId/screen/input returns 409 possession_required after release", async () => {
    const { app, workspaceId } = setup({
      input: async () => {},
    });
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = await take.json() as { token: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, event: { kind: "click", x: 10, y: 20 } }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_required");
  });

  it("POST /api/workspaces/:workspaceId/screen/agent/observation returns stateToken and epoch", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { stateToken: string; epoch: number; observedAt: string };
    expect(body.stateToken).toBeTruthy();
    expect(body.epoch).toBe(1);
    expect(body.observedAt).toBeTruthy();
  });

  it("POST /api/workspaces/:workspaceId/screen/agent/input succeeds with fresh observation and no live possession", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
    });
    const obs = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken } = await obs.json() as { stateToken: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { applied: boolean; epoch: number };
    expect(body.applied).toBe(true);
    expect(body.epoch).toBe(1);
    expect(inputCalls).toBe(1);
  });

  it("POST /api/workspaces/:workspaceId/screen/agent/input returns 409 possession_held_by_user when live human possession exists", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
    });
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const obs = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken } = await obs.json() as { stateToken: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("possession_held_by_user");
    expect(inputCalls).toBe(0);
  });

  it("POST /api/workspaces/:workspaceId/screen/agent/input returns 409 stale_observation when epoch advanced", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
    });
    const take1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take1Body = await take1.json() as { token: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take1Body.token }),
    });

    const obs = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken } = await obs.json() as { stateToken: string; epoch: number };

    const take2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take2Body = await take2.json() as { token: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take2Body.token }),
    });

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("stale_observation");
    expect(inputCalls).toBe(0);
  });

  it("POST /api/workspaces/:workspaceId/screen/agent/input returns 409 stale_observation when stateToken is unknown", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken: "unknown", event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("stale_observation");
  });

  it("POST /api/workspaces/:workspaceId/screen/agent/input returns 422 for invalid event", async () => {
    const { app, workspaceId } = setup();
    const obs = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken } = await obs.json() as { stateToken: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken, event: { kind: "invalid" } }),
    });
    expect(response.status).toBe(422);
  });

  it("possession is exclusive: Bob cannot access Alice's workspace (404)", async () => {
    const { app, workspaceId } = setup();
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const heartbeat = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/heartbeat`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "any" }),
    });
    expect(heartbeat.status).toBe(404);

    const frame = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${otherToken}`, "x-rc-possession": "any" },
    });
    expect(frame.status).toBe(404);

    const input = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "any", event: { kind: "click", x: 1, y: 2 } }),
    });
    expect(input.status).toBe(404);
  });

  it("possession is exclusive: Alice's stale token returns 409 possession_required", async () => {
    const { app, workspaceId } = setup();
    const take1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token: oldToken } = await take1.json() as { token: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const frame = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}`, "x-rc-possession": oldToken },
    });
    expect(frame.status).toBe(409);
    const body = await frame.json() as { error: string };
    expect(body.error).toBe("possession_required");
  });

  it("release returns control: agent path accepted with new observation, pre-takeover stateToken refused", async () => {
    const { app, workspaceId } = setup();

    // Alice takes possession (epoch 1)
    const take1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take1Body = await take1.json() as { token: string };

    // Agent observes at epoch 1
    const obs1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken: oldStateToken } = await obs1.json() as { stateToken: string };

    // Alice takes possession again (epoch 2)
    const take2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take2Body = await take2.json() as { token: string };

    // Alice releases possession with current token
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take2Body.token }),
    });

    // Old observation token should be stale (epoch 1 < current epoch 2)
    const staleResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken: oldStateToken, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(staleResponse.status).toBe(409);
    const staleBody = await staleResponse.json() as { error: string };
    expect(staleBody.error).toBe("stale_observation");

    // New observation at current epoch should work
    const obs2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken: newStateToken } = await obs2.json() as { stateToken: string; epoch: number };
    expect(newStateToken).toBeTruthy();
    expect(newStateToken).not.toBe(oldStateToken);
  });

  it("a wrong token never reads a frame or moves the mouse", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      capture: async () => new Uint8Array([0x89, 0x50]),
      input: async () => { inputCalls++; },
    });
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const frame = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}`, "x-rc-possession": "wrongtoken" },
    });
    expect(frame.status).toBe(409);

    const input = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "wrongtoken", event: { kind: "click", x: 1, y: 2 } }),
    });
    expect(input.status).toBe(409);
    expect(inputCalls).toBe(0);
  });
});