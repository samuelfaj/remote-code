import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc062-update-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");

  const fakeDockerPath = join(directory, "docker");
  const logPath = join(directory, "docker-log.txt");
  const modePath = join(directory, "docker-mode.txt");
  const volumesDir = join(directory, "volumes");
  const containersDir = join(directory, "containers");

  writeFileSync(
    fakeDockerPath,
    `#!/bin/bash
LOG_FILE="\${FAKE_DOCKER_LOG:-${logPath}}"
MODE_FILE="\${FAKE_DOCKER_MODE:-${modePath}}"
VOLUMES_DIR="\${FAKE_DOCKER_VOLUMES:-${volumesDir}}"
CONTAINERS_DIR="\${FAKE_DOCKER_CONTAINERS:-${containersDir}}"
echo "\$@" >> "\$LOG_FILE"
READY="true"
START_FAIL="false"
CREATE_FAIL="false"
COPY_VOLUME_CREATE_FAIL="false"
if [ -f "\$MODE_FILE" ]; then
  READY=\$(grep '^ready=' "\$MODE_FILE" | cut -d= -f2)
  START_FAIL=\$(grep '^startFail=' "\$MODE_FILE" | cut -d= -f2)
  CREATE_FAIL=\$(grep '^createFail=' "\$MODE_FILE" | cut -d= -f2)
  COPY_VOLUME_CREATE_FAIL=\$(grep '^copyVolumeCreateFail=' "\$MODE_FILE" | cut -d= -f2)
fi
if [ "\$1" = "exec" ] && echo "\$*" | grep -q "curl"; then
  if [ "\$READY" = "false" ]; then exit 1; fi
  exit 0
fi
if [ "\$1" = "volume" ] && [ "\$2" = "create" ]; then
  VOLUME_NAME="\$3"
  if [ "\$COPY_VOLUME_CREATE_FAIL" = "true" ] && echo "\$VOLUME_NAME" | grep -q "update-"; then
    exit 1
  fi
  mkdir -p "\$VOLUMES_DIR/\$VOLUME_NAME"
  exit 0
fi
if [ "\$1" = "volume" ] && [ "\$2" = "rm" ]; then
  VOLUME_NAME="\$3"
  rm -rf "\$VOLUMES_DIR/\$VOLUME_NAME"
  exit 0
fi
if [ "\$1" = "volume" ] && [ "\$2" = "inspect" ]; then
  VOLUME_NAME="\$3"
  if [ -d "\$VOLUMES_DIR/\$VOLUME_NAME" ]; then
    echo '{"Name":"'\$VOLUME_NAME'"}'
    exit 0
  else
    exit 1
  fi
fi
if [ "\$1" = "container" ] && [ "\$2" = "create" ]; then
  if [ "\$CREATE_FAIL" = "true" ]; then exit 1; fi
  CONTAINER_NAME=""
  prev=""
  for i in "\$@"; do
    if [ "\$prev" = "--name" ]; then CONTAINER_NAME="\$i"; break; fi
    prev="\$i"
  done
  mkdir -p "\$CONTAINERS_DIR/\$CONTAINER_NAME"
  exit 0
fi
if [ "\$1" = "container" ] && [ "\$2" = "start" ]; then
  if [ "\$START_FAIL" = "true" ]; then exit 1; fi
  exit 0
fi
if [ "\$1" = "container" ] && [ "\$2" = "wait" ]; then
  COPY_EXIT="0"
  if [ -f "\$MODE_FILE" ]; then
    COPY_EXIT=\$(grep '^copyExit=' "\$MODE_FILE" | cut -d= -f2)
    if [ -z "\$COPY_EXIT" ]; then COPY_EXIT="0"; fi
  fi
  echo "\$COPY_EXIT"
  exit 0
fi
if [ "\$1" = "container" ] && [ "\$2" = "stop" ]; then
  exit 0
fi
if [ "\$1" = "container" ] && [ "\$2" = "rm" ]; then
  exit 0
fi
if [ "\$1" = "container" ] && [ "\$2" = "inspect" ]; then
  CONTAINER_NAME="\$3"
  if [ -d "\$CONTAINERS_DIR/\$CONTAINER_NAME" ]; then
    echo '{"State":{"Status":"running"}}'
    exit 0
  else
    exit 1
  fi
fi
if [ "\$1" = "inspect" ] && [ "\$2" = "-f" ]; then
  FORMAT="\$3"
  CONTAINER_NAME="\$4"
  if [ -d "\$CONTAINERS_DIR/\$CONTAINER_NAME" ]; then
    if echo "\$FORMAT" | grep -q 'Config.Env'; then
      echo '["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","HOSTNAME=abc123","HOME=/root","REMOTECODE_AUTH_PASSWORD=testsecret","REMOTECODE_HOSTED_ACCOUNT=testid"]'
    elif echo "\$FORMAT" | grep -q 'HostConfig.NetworkMode'; then
      echo '"bridge"'
    elif echo "\$FORMAT" | grep -q 'HostConfig.PortBindings'; then
      echo '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"33000"}]}'
    else
      echo '{}'
    fi
    exit 0
  else
    exit 1
  fi
fi
exit 0
`,
  );
  chmodSync(fakeDockerPath, 0o755);

  process.env.RC060_DOCKER = fakeDockerPath;
  process.env.FAKE_DOCKER_LOG = logPath;
  process.env.FAKE_DOCKER_MODE = modePath;
  process.env.FAKE_DOCKER_VOLUMES = volumesDir;
  process.env.FAKE_DOCKER_CONTAINERS = containersDir;
  process.env.RC060_READY_TIMEOUT_MS = "1000";

  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(otherToken).digest("hex"), "bob", Date.now() + 60_000);
  database.close();

  return { app, databasePath, directory, fakeDockerPath, logPath, modePath, volumesDir, containersDir };
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

async function createHostedAccount(app: ReturnType<typeof createApi>, databasePath: string) {
  const createResponse = await request(app, "http://localhost/api/hosted/accounts", {
    method: "POST",
    headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "updateaccount" }),
  });
  expect(createResponse.status).toBe(201);
  const createBody = await createResponse.json() as { id: string; volumeId: string };

  // Set up the database schema and test data
  const db = new Database(databasePath);
  db.exec("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, context TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, skills TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, workspace_id TEXT, bot_id TEXT, prompt TEXT NOT NULL, local_time TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const now = new Date().toISOString();
  db.exec("INSERT INTO workspaces (id, user_id, name, created_at) VALUES ('ws1', 'alice', 'test-workspace', ?)", [now]);
  db.exec("INSERT INTO bots (id, user_id, name, instructions, context, created_at, updated_at) VALUES ('bot1', 'alice', 'test-bot', '', '', ?, ?)", [now, now]);
  db.exec("INSERT INTO schedules (id, user_id, kind, prompt, local_time, timezone, created_at, updated_at) VALUES ('sch1', 'alice', 'cron', 'test', '0 * * * *', 'UTC', ?, ?)", [now, now]);
  db.close();

  return createBody;
}

describe("Update routes", () => {
  it("POST /api/hosted/accounts/:id/update rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "new-image:latest" }),
    });
    expect(response.status).toBe(401);
  });

  it("GET /api/hosted/accounts/:id/update rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000/update");
    expect(response.status).toBe(401);
  });

  it("GET /api/hosted/accounts/:id/update returns none when no update exists", async () => {
    const { app } = setup();
    const response = await request(app,
      "http://localhost/api/hosted/accounts/00000000-0000-4000-8000-000000000000/update", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string };
    expect(body.state).toBe("none");
  });

  it("successful update ends ready and preserves workspaces, bots, and schedules", async () => {
    const { app, databasePath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);

    const response = await request(app,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { updateId: string; state: string; fromImage: string; toImage: string };
    expect(body.state).toBe("ready");
    expect(body.toImage).toBe("remotecode/host:v2");

    // Verify workspaces, bots, and schedules are still listed
    const db = new Database(databasePath);
    const workspaces = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workspaces").get()?.count ?? 0;
    const bots = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM bots").get()?.count ?? 0;
    const schedules = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schedules").get()?.count ?? 0;
    db.close();
    expect(workspaces).toBe(1);
    expect(bots).toBe(1);
    expect(schedules).toBe(1);
  });

  it("failure before migration (copy volume create fails) leaves state failed, step none, live container running", async () => {
    const { app, databasePath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);

    // Fail copy volume creation
    setMode(modePath, { ready: "true", copyVolumeCreateFail: "true" });

    const response = await request(app,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; step: string };
    expect(body.error).toBe("update_failed");
    expect(body.step).toBe("none");

    // Row must be failed with step none
    const db = new Database(databasePath);
    const row = db.query<{ state: string; step: string; error: string | null }, [string]>(
      "SELECT state, step, error FROM hosted_updates WHERE workspace_or_account_id = ?",
    ).get(account.id);
    db.close();
    expect(row?.state).toBe("failed");
    expect(row?.step).toBe("none");
  });

  it("a data copy that exits non-zero fails the update instead of swapping on a partial copy", async () => {
    const { app, databasePath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);
    setMode(modePath, { ready: "true", copyExit: "1" });

    const response = await request(app,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; step: string };
    expect(body.error).toBe("update_failed");
    expect(body.step).toBe("none");

    const db = new Database(databasePath);
    const row = db.query<{ state: string; step: string; error: string | null }, [string]>(
      "SELECT state, step, error FROM hosted_updates WHERE workspace_or_account_id = ?",
    ).get(account.id);
    db.close();
    expect(row?.state).toBe("failed");
    expect(row?.error).toContain("copy_container_exited_1");
  });

  it("failure after migration (readiness probe fails during swap) leaves state rolled_back with old image running", async () => {
    const { app, databasePath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);

    // Fail readiness probe during swap (simulates new container starting but not becoming ready)
    setMode(modePath, { ready: "false" });

    const response = await request(app,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; step: string };
    expect(body.error).toBe("update_failed");
    expect(body.step).toBe("swap");

    // Row must be rolled_back
    const db = new Database(databasePath);
    const row = db.query<{ state: string; step: string; error: string | null }, [string]>(
      "SELECT state, step, error FROM hosted_updates WHERE workspace_or_account_id = ?",
    ).get(account.id);
    db.close();
    expect(row?.state).toBe("rolled_back");
    expect(row?.step).toBe("swap");
  });

  it("crash during swap (row left in swapping) becomes failed with host_restart on fresh feature construction", async () => {
    const { app, databasePath, directory, fakeDockerPath, logPath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);

    // Manually insert a row in swapping state to simulate a crash
    const db = new Database(databasePath);
    db.exec(`CREATE TABLE IF NOT EXISTS hosted_updates (
      id TEXT PRIMARY KEY,
      workspace_or_account_id TEXT NOT NULL,
      from_image TEXT NOT NULL,
      to_image TEXT NOT NULL,
      state TEXT NOT NULL,
      step TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const updateId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO hosted_updates (id, workspace_or_account_id, from_image, to_image, state, step, error, started_at, updated_at) VALUES (?, ?, ?, ?, 'swapping', 'swap', NULL, ?, ?)",
    ).run(updateId, account.id, "remotecode/host:v1", "remotecode/host:v2", now, now);
    db.close();

    // Construct a fresh feature over the same database (simulates host restart)
    const newApp = createApi(databasePath);

    // The row should now be failed with host_restart
    const db2 = new Database(databasePath);
    const row = db2.query<{ state: string; error: string | null }, [string]>(
      "SELECT state, error FROM hosted_updates WHERE id = ?",
    ).get(updateId);
    db2.close();
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("host_restart");

    // The update should not be reported as ready
    const getResponse = await request(newApp,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as { state: string };
    expect(getBody.state).toBe("failed");
  });

  it("update for a foreign account returns 404 and produces no update row", async () => {
    const { app, databasePath, modePath } = setup();
    setMode(modePath, { ready: "true" });

    // Create an account as alice
    const createResponse = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "private" }),
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json() as { id: string };

    // Bob tries to update alice's account
    const response = await request(app,
      `http://localhost/api/hosted/accounts/${createBody.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(404);

    // No update row should be created for alice's account
    const db = new Database(databasePath);
    const row = db.query<{ id: string } | null, [string]>(
      "SELECT id FROM hosted_updates WHERE workspace_or_account_id = ?",
    ).get(createBody.id);
    db.close();
    expect(row).toBeNull();
  });

  it("successful update preserves network, port, and env from the old container", async () => {
    const { app, databasePath, modePath, logPath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);

    const response = await request(app,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(200);

    const log = getLog(logPath);
    const swapCreates = log.filter((l) => l.includes("container create") && l.includes("remotecode/host:v2"));
    expect(swapCreates.length).toBe(1);
    const swapLine = swapCreates[0];
    expect(swapLine).toContain("--network bridge");
    expect(swapLine).toContain("-p 127.0.0.1:33000:3000");
    expect(swapLine).toContain("-e REMOTECODE_AUTH_PASSWORD=testsecret");
    expect(swapLine).toContain("-e REMOTECODE_HOSTED_ACCOUNT=testid");
    expect(swapLine).not.toContain("-e PATH=");
    expect(swapLine).not.toContain("-e HOSTNAME=");
    expect(swapLine).not.toContain("-e HOME=");
  });

  it("rollback preserves network, port, and env from the old container", async () => {
    const { app, databasePath, modePath, logPath } = setup();
    setMode(modePath, { ready: "true" });

    const account = await createHostedAccount(app, databasePath);

    // Fail readiness probe during swap
    setMode(modePath, { ready: "false" });

    const response = await request(app,
      `http://localhost/api/hosted/accounts/${account.id}/update`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ image: "remotecode/host:v2" }),
    });
    expect(response.status).toBe(503);

    const log = getLog(logPath);
    const localCreateLines = log.filter((l) => l.includes("container create") && l.includes("remotecode/host:local"));
    expect(localCreateLines.length).toBe(2);
    const rollbackLine = localCreateLines[1];
    expect(rollbackLine).toContain("--network bridge");
    expect(rollbackLine).toContain("-p 127.0.0.1:33000:3000");
    expect(rollbackLine).toContain("-e REMOTECODE_AUTH_PASSWORD=testsecret");
    expect(rollbackLine).toContain("-e REMOTECODE_HOSTED_ACCOUNT=testid");
    expect(rollbackLine).not.toContain("-e PATH=");
    expect(rollbackLine).not.toContain("-e HOSTNAME=");
    expect(rollbackLine).not.toContain("-e HOME=");
  });
});
