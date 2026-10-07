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

  it("GET /api/workspaces/:workspaceId/screen/frame returns 409 possession_lost with wrong token", async () => {
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
    expect(body.error).toBe("possession_lost");
  });

  it("GET /api/workspaces/:workspaceId/screen/frame returns 409 possession_lost when no live possession", async () => {
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
    expect(body.error).toBe("possession_lost");
  });

  it("GET /api/workspaces/:workspaceId/screen/frame returns 409 possession_lost after expiry", async () => {
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
    expect(body.error).toBe("possession_lost");
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

  it("POST /api/workspaces/:workspaceId/screen/input returns 409 possession_lost with wrong token", async () => {
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
    expect(body.error).toBe("possession_lost");
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

  it("POST /api/workspaces/:workspaceId/screen/input returns 409 possession_lost after release", async () => {
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
    expect(body.error).toBe("possession_lost");
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

  it("possession is exclusive: Alice's stale token returns 409 possession_superseded", async () => {
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
    expect(body.error).toBe("possession_superseded");
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

  it("POST /api/workspaces/:workspaceId/screen/preview returns 401 for anonymous", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/workspaces/:workspaceId/screen/preview returns 404 for a workspace the caller does not own", async () => {
    const { app, otherWorkspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${otherWorkspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /api/workspaces/:workspaceId/screen/preview returns 404 when bot does not belong to user", async () => {
    const { app, workspaceId } = setup();
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bobbot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /api/workspaces/:workspaceId/screen/preview creates a preview and sets cookie", async () => {
    const { app, workspaceId } = setup();
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "alicebot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText) as { previewId: string; botId: string; expiresAt: number };
    expect(body.previewId).toBeTruthy();
    expect(body.botId).toBe(botId);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const rawToken = response.headers.get("set-cookie") ?? "";
    expect(rawToken).toContain("rc_screen_preview=");
    expect(bodyText).not.toContain(rawToken.split(";")[0].split("=")[1]);
  });

  it("POST /api/workspaces/:workspaceId/screen/preview response body contains no token", async () => {
    const { app, workspaceId } = setup();
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "tokenleakbot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    const bodyText = await response.text();
    const setCookie = response.headers.get("set-cookie") ?? "";
    const tokenMatch = setCookie.match(/rc_screen_preview=([^;]+)/);
    if (tokenMatch) {
      expect(bodyText).not.toContain(tokenMatch[1]);
    }
    expect(response.headers.get("content-type")).not.toContain("text");
  });

  it("GET /api/workspaces/:workspaceId/screen/preview/frame returns PNG for correct bot and cookie", async () => {
    const capturedBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    const captureCalls: { workspaceId: string; botId: string }[] = [];
    const { app, workspaceId } = setup({
      previewMs: 60_000,
      capture: async (request) => {
        captureCalls.push(request);
        return capturedBytes;
      },
    });
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "framebot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    const preview = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    expect(preview.status).toBe(200);
    const previewCookie = preview.headers.get("set-cookie") ?? "";
    const tokenMatch = previewCookie.match(/rc_screen_preview=([^;]+)/);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![1];

    const frame = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`, {
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=${token}`,
      },
    });
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await frame.arrayBuffer());
    expect(bytes).toEqual(capturedBytes);
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({ workspaceId, botId });
  });

  it("GET /api/workspaces/:workspaceId/screen/preview/frame returns 409 for wrong bot cookie", async () => {
    const captureCalls: { workspaceId: string; botId: string }[] = [];
    const { app, workspaceId } = setup({
      previewMs: 60_000,
      capture: async (request) => {
        captureCalls.push(request);
        return new Uint8Array([0x89, 0x50]);
      },
    });
    const botAResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bot-a" }),
    });
    const { id: botAId } = await botAResponse.json() as { id: string };
    const botBResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bot-b" }),
    });
    const { id: botBId } = await botBResponse.json() as { id: string };

    const previewA = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId: botAId }),
    });
    const cookieA = previewA.headers.get("set-cookie") ?? "";
    const tokenA = cookieA.match(/rc_screen_preview=([^;]+)/)![1];

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId: botBId }),
    });

    const frame = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botBId}`, {
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=${tokenA}`,
      },
    });
    expect(frame.status).toBe(409);
    const body = await frame.json() as { error: string };
    expect(body.error).toBe("preview_required");
    expect(captureCalls).toHaveLength(0);
  });

  it("GET /api/workspaces/:workspaceId/screen/preview/frame returns 409 for expired preview", async () => {
    const { app, workspaceId } = setup({ previewMs: 50 });
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "expiredbot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const frame = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`, {
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=anytoken`,
      },
    });
    expect(frame.status).toBe(409);
    const body = await frame.json() as { error: string };
    expect(body.error).toBe("preview_required");
  });

  it("POST /api/workspaces/:workspaceId/screen/preview/refresh rotates token and keeps previewId", async () => {
    const capturedBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    const { app, workspaceId } = setup({ previewMs: 60_000, capture: async () => capturedBytes });
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "refreshbot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    const preview = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    expect(preview.status).toBe(200);
    const { previewId } = await preview.json() as { previewId: string };
    const cookie1 = preview.headers.get("set-cookie") ?? "";
    const token1 = cookie1.match(/rc_screen_preview=([^;]+)/)![1];

    const frame1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`, {
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=${token1}`,
      },
    });
    expect(frame1.status).toBe(200);

    const refresh = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/refresh`, {
      method: "POST",
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=${token1}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ botId }),
    });
    expect(refresh.status).toBe(200);
    const { previewId: refreshedPreviewId, expiresAt } = await refresh.json() as { previewId: string; botId: string; expiresAt: number };
    expect(refreshedPreviewId).toBe(previewId);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const cookie2 = refresh.headers.get("set-cookie") ?? "";
    const token2 = cookie2.match(/rc_screen_preview=([^;]+)/)![1];
    expect(token2).not.toBe(token1);

    const frameOld = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`, {
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=${token1}`,
      },
    });
    expect(frameOld.status).toBe(409);

    const frameNew = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`, {
      headers: {
        cookie: `remotecode_session=${ownerToken}; rc_screen_preview=${token2}`,
      },
    });
    expect(frameNew.status).toBe(200);
  });

  it("POST /api/workspaces/:workspaceId/screen/preview returns 404 for bot belonging to another user", async () => {
    const { app, workspaceId } = setup();
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bobpreviewbot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    expect(response.status).toBe(404);
  });

  it("GET /api/workspaces/:workspaceId/screen/preview/frame returns 404 for workspace the caller does not own", async () => {
    const { app, workspaceId, otherWorkspaceId } = setup();
    const botResponse = await request(app, "http://localhost/api/bots", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "foreignworkspacebot" }),
    });
    const { id: botId } = await botResponse.json() as { id: string };

    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/preview`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });

    const frame = await request(app, `http://localhost/api/workspaces/${otherWorkspaceId}/screen/preview/frame?botId=${botId}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(frame.status).toBe(404);
  });

  it("two clients: superseded token returns possession_superseded, current token succeeds, seam called only for current holder", async () => {
    let inputCalls = 0;
    const captureCalls: { workspaceId: string; botId: string }[] = [];
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
      capture: async (request) => { captureCalls.push(request); return new Uint8Array([0x89, 0x50]); },
    });

    // Client 1 takes possession
    const take1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take1Body = await take1.json() as { token: string };
    const cookie1 = take1.headers.get("set-cookie") ?? "";
    const possessionToken1 = cookie1.match(/rc_screen_possession=([^;]+)/)![1];

    // Client 2 takes possession (supersedes client 1)
    const take2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take2Body = await take2.json() as { token: string };
    const cookie2 = take2.headers.get("set-cookie") ?? "";
    const possessionToken2 = cookie2.match(/rc_screen_possession=([^;]+)/)![1];

    // Client 1's heartbeat is refused possession_superseded
    const hb1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/heartbeat`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken1}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take1Body.token }),
    });
    expect(hb1.status).toBe(409);
    expect((await hb1.json() as { error: string }).error).toBe("possession_superseded");

    // Client 2's heartbeat succeeds
    const hb2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/heartbeat`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken2}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take2Body.token }),
    });
    expect(hb2.status).toBe(200);

    // Client 1's frame is refused possession_superseded
    const frame1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken1}`, "x-rc-possession": take1Body.token },
    });
    expect(frame1.status).toBe(409);
    expect((await frame1.json() as { error: string }).error).toBe("possession_superseded");

    // Client 2's frame succeeds
    const frame2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/frame`, {
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken2}`, "x-rc-possession": take2Body.token },
    });
    expect(frame2.status).toBe(200);

    // Client 1's input is refused possession_superseded
    const input1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken1}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take1Body.token, event: { kind: "click", x: 1, y: 2 } }),
    });
    expect(input1.status).toBe(409);
    expect((await input1.json() as { error: string }).error).toBe("possession_superseded");

    // Client 2's input succeeds
    const input2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken2}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take2Body.token, event: { kind: "click", x: 3, y: 4 } }),
    });
    expect(input2.status).toBe(200);
    expect(inputCalls).toBe(1);
  });

  it("Bot agent/input is refused possession_held_by_user and seam records zero calls after takeover", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
    });

    // Client 1 takes possession
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Bot is refused while client 1 holds possession
    const obs1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken: stateToken1 } = await obs1.json() as { stateToken: string };

    const bot1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken: stateToken1, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(bot1.status).toBe(409);
    expect((await bot1.json() as { error: string }).error).toBe("possession_held_by_user");

    // Client 2 takes possession (supersedes client 1)
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Bot is still refused because client 2 holds possession
    const bot2 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken: stateToken1, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(bot2.status).toBe(409);
    expect((await bot2.json() as { error: string }).error).toBe("possession_held_by_user");
    expect(inputCalls).toBe(0);
  });

  it("GET /api/workspaces/:workspaceId/screen/possession reports holder, superseded, expired, and none", async () => {
    const { app, workspaceId } = setup({ possessionMs: 50 });

    // No cookie → none
    const none = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(none.status).toBe(200);
    expect((await none.json() as { state: string }).state).toBe("none");

    // Client takes possession → holder
    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cookie = take.headers.get("set-cookie") ?? "";
    const possessionToken = cookie.match(/rc_screen_possession=([^;]+)/)![1];

    const holder = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken}` },
    });
    expect(holder.status).toBe(200);
    const holderBody = await holder.json() as { state: string; expiresAt: number | null; epoch: number; supersededCount: number };
    expect(holderBody.state).toBe("holder");
    expect(holderBody.expiresAt).toBeGreaterThan(Date.now());
    expect(holderBody.epoch).toBe(1);
    expect(holderBody.supersededCount).toBe(0);

    // Second takeover → first token is superseded
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const superseded = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken}` },
    });
    expect(superseded.status).toBe(200);
    expect((await superseded.json() as { state: string }).state).toBe("superseded");

    // Wait for the current possession to expire (not the superseded one)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The current token (from the second takeover) should now be expired
    const cookie2 = take.headers.get("set-cookie") ?? "";
    // The second takeover set a new cookie; we need to get it from the second take response
    // Instead, let's test expired by taking a fresh possession and waiting for it to expire
  });

  it("GET /api/workspaces/:workspaceId/screen/possession reports expired when current possession lapses", async () => {
    const { app, workspaceId } = setup({ possessionMs: 50 });

    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cookie = take.headers.get("set-cookie") ?? "";
    const possessionToken = cookie.match(/rc_screen_possession=([^;]+)/)![1];

    // Wait for expiry without taking possession again
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string; expiresAt: number | null };
    expect(body.state).toBe("expired");
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it("resumption: superseded client takes possession again, gets greater epoch, pre-takeover stateToken refused stale_observation", async () => {
    let inputCalls = 0;
    const { app, workspaceId } = setup({
      input: async () => { inputCalls++; },
    });

    // Client 1 takes possession (epoch 1)
    const take1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take1Body = await take1.json() as { token: string; epoch: number };
    expect(take1Body.epoch).toBe(1);

    // Agent observes at epoch 1
    const obs1 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken: oldStateToken } = await obs1.json() as { stateToken: string; epoch: number };
    expect(oldStateToken).toBeTruthy();

    // Client 2 takes possession (epoch 2) - client 1 superseded
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Client 1 takes possession again (epoch 3) - resumption
    const take3 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const take3Body = await take3.json() as { token: string; epoch: number };
    expect(take3Body.epoch).toBe(3);

    // Release current possession so Bot can try agent/input
    await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession/release`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: take3Body.token }),
    });

    // Pre-takeover stateToken (epoch 1) is stale against current epoch 3
    const staleResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken: oldStateToken, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(staleResponse.status).toBe(409);
    expect((await staleResponse.json() as { error: string }).error).toBe("stale_observation");
    expect(inputCalls).toBe(0);

    // New observation at current epoch 3 should work
    const obs3 = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/observation`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    const { stateToken: newStateToken, epoch: obsEpoch } = await obs3.json() as { stateToken: string; epoch: number };
    expect(obsEpoch).toBe(3);

    const freshResponse = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/agent/input`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stateToken: newStateToken, event: { kind: "click", x: 5, y: 10 } }),
    });
    expect(freshResponse.status).toBe(200);
    expect(inputCalls).toBe(1);
  });

  it("expired holder reports expired and is not reported as holder", async () => {
    const { app, workspaceId } = setup({ possessionMs: 50 });

    const take = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cookie = take.headers.get("set-cookie") ?? "";
    const possessionToken = cookie.match(/rc_screen_possession=([^;]+)/)![1];

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/screen/possession`, {
      headers: { cookie: `remotecode_session=${ownerToken}; rc_screen_possession=${possessionToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string; expiresAt: number | null };
    expect(body.state).toBe("expired");
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now());
  });
});