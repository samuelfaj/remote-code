import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc060-hosted-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");

  const fakeDockerPath = join(directory, "docker");
  const logPath = join(directory, "docker-log.txt");
  const modePath = join(directory, "docker-mode.txt");

  writeFileSync(
    fakeDockerPath,
    `#!/bin/bash
LOG_FILE="\${FAKE_DOCKER_LOG:-${logPath}}"
MODE_FILE="\${FAKE_DOCKER_MODE:-${modePath}}"
echo "\$@" >> "\$LOG_FILE"
READY="true"
START_FAIL="false"
CREATE_FAIL="false"
if [ -f "\$MODE_FILE" ]; then
  READY=\$(grep '^ready=' "\$MODE_FILE" | cut -d= -f2)
  START_FAIL=\$(grep '^startFail=' "\$MODE_FILE" | cut -d= -f2)
  CREATE_FAIL=\$(grep '^createFail=' "\$MODE_FILE" | cut -d= -f2)
fi
if [ "\$1" = "exec" ] && echo "\$*" | grep -q "curl"; then
  if [ "\$READY" = "false" ]; then exit 1; fi
  exit 0
fi
if [ "\$1" = "container" ] && [ "\$2" = "create" ] && [ "\$CREATE_FAIL" = "true" ]; then exit 1; fi
if [ "\$1" = "container" ] && [ "\$2" = "start" ] && [ "\$START_FAIL" = "true" ]; then exit 1; fi
if [ "\$1" = "inspect" ]; then
  RUNNING=\$(grep '^running=' "\$MODE_FILE" 2>/dev/null | cut -d= -f2)
  [ -z "\$RUNNING" ] && RUNNING=true
  echo "\$RUNNING"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fakeDockerPath, 0o755);

  process.env.RC060_DOCKER = fakeDockerPath;
  process.env.FAKE_DOCKER_LOG = logPath;
  process.env.FAKE_DOCKER_MODE = modePath;

  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(otherToken).digest("hex"), "bob", Date.now() + 60_000);
  database.close();

  return { app, databasePath, directory, fakeDockerPath, logPath, modePath };
}

afterEach(() => {
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

function setMode(modePath: string, updates: Record<string, string>) {
  const lines = Object.entries(updates).map(([k, v]) => `${k}=${v}`);
  writeFileSync(modePath, lines.join("\n"));
}

function getLog(logPath: string): string[] {
  try {
    const content = readFileSync(logPath, "utf-8");
    return content.split("\n").filter((l: string) => l.length > 0);
  } catch {
    return [];
  }
}

describe("Hosted routes", () => {
  it("POST /api/hosted/accounts rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(response.status).toBe(401);
  });

  it("GET /api/hosted/accounts rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts");
    expect(response.status).toBe(401);
  });

  it("GET /api/hosted/accounts/:id rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(401);
  });

  it("POST /api/hosted/accounts/:id/suspend rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000/suspend", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/hosted/accounts/:id/resume rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000/resume", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/hosted/accounts rejects an invalid account name with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "invalid\nname" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_account_name");
  });

  it("POST /api/hosted/accounts rejects an empty name with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_account_name");
  });

  it("POST /api/hosted/accounts provisions successfully and reaches ready", async () => {
    const { app, logPath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "myaccount" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      id: string; name: string; state: string; containerId: string;
      volumeId: string; hostPort: number; gatewayToken: string;
      gatewayRoute: { token: string; target: string };
      supervisor: { container: string };
    };
    expect(body.name).toBe("myaccount");
    expect(body.state).toBe("ready");
    expect(body.containerId).toBeTruthy();
    expect(body.volumeId).toBeTruthy();
    expect(body.hostPort).toBeGreaterThanOrEqual(33000);
    expect(body.gatewayToken).toBeTruthy();
    expect(body.gatewayRoute.token).toBe(body.gatewayToken);
    expect(body.gatewayRoute.target).toBe(`http://${body.containerId}:3000`);
    expect(body.supervisor.container).toBe(body.containerId);

    // Verify the fake docker recorded the expected argv
    const log = getLog(logPath);
    const containerCreateLine = log.find((l) => l.includes("container create"));
    expect(containerCreateLine).toBeTruthy();
    expect(containerCreateLine).toContain(body.id);
    expect(containerCreateLine).toContain(`${body.id}-data`);
    expect(containerCreateLine).toContain(`remotecode.hosted=${body.id}`);

    // Gateway token must not appear in container create argv
    expect(containerCreateLine).not.toContain(body.gatewayToken);
  });

  it("an account whose container died stops reading as ready", async () => {
    const { app, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const created = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "crash" }),
    });
    expect(created.status).toBe(201);
    const account = await created.json() as { id: string; state: string };
    expect(account.state).toBe("ready");

    // The container dies outside the control plane's knowledge.
    setMode(modePath, { ready: "true", running: "false" });

    const read = await request(app, `http://localhost/api/hosted/accounts/${account.id}`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(read.status).toBe(200);
    const record = await read.json() as { state: string; error: string | null };
    expect(record.state).toBe("failed");
    expect(record.error).toBe("container_not_running");

    const listed = await request(app, "http://localhost/api/hosted/accounts", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    const list = await listed.json() as { accounts: Array<{ id: string; state: string }> };
    expect(list.accounts.find((entry) => entry.id === account.id)?.state).toBe("failed");
  });

  it("provisioning failure leaves row as failed, never ready", async () => {
    const { app, databasePath, logPath, modePath } = setup();
    // Fail at container start
    setMode(modePath, { ready: "true", startFail: "true" });

    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "failaccount" }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; accountId: string };
    expect(body.error).toBe("provisioning_failed");
    expect(body.accountId).toBeTruthy();

    // Row must be failed, never ready
    const db = new Database(databasePath);
    const row = db.query<{ state: string }, [string]>(
      "SELECT state FROM hosted_accounts WHERE id = ?",
    ).get(body.accountId);
    db.close();
    expect(row?.state).toBe("failed");
  });

  it("resume with working fake reaches ready from failed state", async () => {
    const { app, databasePath, logPath, modePath } = setup();

    // First, create a failed account by failing at container start
    setMode(modePath, { ready: "true", startFail: "true" });
    const createResponse = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "recoverable" }),
    });
    expect(createResponse.status).toBe(503);
    const createBody = await createResponse.json() as { accountId: string };

    // Now resume with a working fake
    setMode(modePath, { ready: "true", startFail: "false" });
    const resumeResponse = await request(app,
      `http://localhost/api/hosted/accounts/${createBody.accountId}/resume`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(resumeResponse.status).toBe(200);
    const resumeBody = await resumeResponse.json() as { state: string };
    expect(resumeBody.state).toBe("ready");

    // Verify row is ready in database
    const db = new Database(databasePath);
    const row = db.query<{ state: string }, [string]>(
      "SELECT state FROM hosted_accounts WHERE id = ?",
    ).get(createBody.accountId);
    db.close();
    expect(row?.state).toBe("ready");
  });

  it("gateway token never appears in container create argv", async () => {
    const { app, logPath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "secrettest" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { gatewayToken: string; id: string };

    const log = getLog(logPath);
    const containerCreateLine = log.find((l) => l.includes("container create"));
    expect(containerCreateLine).toBeTruthy();
    expect(containerCreateLine).not.toContain(body.gatewayToken);
  });

  it("two accounts by the same user get different container ids, volume ids and host ports", async () => {
    const { app, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const resp1 = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "account1" }),
    });
    expect(resp1.status).toBe(201);
    const body1 = await resp1.json() as { id: string; hostPort: number };

    const resp2 = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "account2" }),
    });
    expect(resp2.status).toBe(201);
    const body2 = await resp2.json() as { id: string; hostPort: number };

    expect(body1.id).not.toBe(body2.id);
    expect(body1.hostPort).not.toBe(body2.hostPort);
  });

  it("GET /api/hosted/accounts lists only the caller's accounts", async () => {
    const { app, modePath } = setup();
    setMode(modePath, { ready: "true" });

    // Create account as alice
    await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "aliceaccount" }),
    });

    // Create account as bob
    await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bobaccount" }),
    });

    // Alice should only see her account
    const aliceResponse = await request(app, "http://localhost/api/hosted/accounts", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(aliceResponse.status).toBe(200);
    const aliceBody = await aliceResponse.json() as { accounts: unknown[] };
    expect(aliceBody.accounts).toHaveLength(1);
    expect((aliceBody.accounts[0] as { name: string }).name).toBe("aliceaccount");

    // Bob should only see his account
    const bobResponse = await request(app, "http://localhost/api/hosted/accounts", {
      headers: { cookie: `remotecode_session=${otherToken}` },
    });
    expect(bobResponse.status).toBe(200);
    const bobBody = await bobResponse.json() as { accounts: unknown[] };
    expect(bobBody.accounts).toHaveLength(1);
    expect((bobBody.accounts[0] as { name: string }).name).toBe("bobaccount");
  });

  it("suspend stops exactly one container and does not change the other account's row", async () => {
    const { app, databasePath, logPath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    // Create two accounts as alice
    const resp1 = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "suspend1" }),
    });
    expect(resp1.status).toBe(201);
    const body1 = await resp1.json() as { id: string };

    const resp2 = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "suspend2" }),
    });
    expect(resp2.status).toBe(201);
    const body2 = await resp2.json() as { id: string };

    // Suspend the first account
    const suspendResponse = await request(app,
      `http://localhost/api/hosted/accounts/${body1.id}/suspend`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(suspendResponse.status).toBe(200);

    // Verify the fake docker recorded a container stop for exactly the first account
    const log = getLog(logPath);
    const stopLines = log.filter((l) => l.includes("container stop"));
    expect(stopLines).toHaveLength(1);
    expect(stopLines[0]).toContain(body1.id);
    expect(stopLines[0]).not.toContain(body2.id);

    // Verify the second account's row is unchanged (still ready)
    const db = new Database(databasePath);
    const row2 = db.query<{ state: string }, [string]>(
      "SELECT state FROM hosted_accounts WHERE id = ?",
    ).get(body2.id);
    db.close();
    expect(row2?.state).toBe("ready");
  });

  it("suspend an account that is not ready returns 409", async () => {
    const { app, modePath } = setup();
    setMode(modePath, { ready: "true" });

    // Create an account
    const createResponse = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "notready" }),
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json() as { id: string };

    // Suspend it (should work since it's ready)
    const suspendResponse = await request(app,
      `http://localhost/api/hosted/accounts/${createBody.id}/suspend`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(suspendResponse.status).toBe(200);

    // Try to suspend again (now it's suspended, not ready)
    const suspendAgainResponse = await request(app,
      `http://localhost/api/hosted/accounts/${createBody.id}/suspend`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(suspendAgainResponse.status).toBe(409);
    const body = await suspendAgainResponse.json() as { error: string };
    expect(body.error).toBe("account_not_running");
  });

  it("GET /api/hosted/accounts/:id returns 404 for a foreign account", async () => {
    const { app, modePath } = setup();
    setMode(modePath, { ready: "true" });

    // Create account as alice
    const createResponse = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "private" }),
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json() as { id: string };

    // Bob tries to access alice's account
    const response = await request(app,
      `http://localhost/api/hosted/accounts/${createBody.id}`, {
      headers: { cookie: `remotecode_session=${otherToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("account_not_found");
  });

  it("GET /api/hosted/accounts/:id returns 404 for an unknown account", async () => {
    const { app } = setup();
    const response = await request(app,
      "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("account_not_found");
  });

  it("POST /api/hosted/accounts/:id/resume on a non-existent account returns 404", async () => {
    const { app } = setup();
    const response = await request(app,
      "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000/resume", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("account_not_found");
  });
});