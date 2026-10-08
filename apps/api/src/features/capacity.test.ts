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
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc060-capacity-"));
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

describe("Capacity routes", () => {
  it("GET /api/hosted/capacity rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/capacity");
    expect(response.status).toBe(401);
  });

  it("POST /api/hosted/accounts rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/hosted/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(response.status).toBe(401);
  });

  it("with maxAccounts: 1 and one ready account, POST returns 503 capacity_exhausted and creates no volume", async () => {
    const originalMax = process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
    process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = "1";
    try {
      const { app, databasePath, logPath } = setup();

      // Insert one ready account directly into the database
      const db = new Database(databasePath);
      db.query(
        "INSERT INTO hosted_accounts (id, user_id, name, gateway_token, host_port, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)",
      ).run("00000000-0000-4000-8000-000000000001", "alice", "existing", "tok", 33000, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.close();

      const response = await request(app, "http://localhost/api/hosted/accounts", {
        method: "POST",
        headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "newaccount" }),
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string; reason: string };
      expect(body.error).toBe("capacity_exhausted");
      expect(body.reason).toBe("account_limit");

      // No new row should be written
      const db2 = new Database(databasePath);
      const count = db2.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM hosted_accounts").get()?.count ?? 0;
      db2.close();
      expect(count).toBe(1);

      // No volume create in fake docker log
      const log = getLog(logPath);
      const volumeCreateLines = log.filter((l) => l.includes("volume create"));
      expect(volumeCreateLines.length).toBe(0);
    } finally {
      if (originalMax === undefined) delete process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
      else process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = originalMax;
    }
  });

  it("with maxAccounts: 1 and one suspended account, POST returns 503 capacity_exhausted", async () => {
    const originalMax = process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
    process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = "1";
    try {
      const { app, databasePath } = setup();

      const db = new Database(databasePath);
      db.query(
        "INSERT INTO hosted_accounts (id, user_id, name, gateway_token, host_port, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'suspended', ?, ?, ?)",
      ).run("00000000-0000-4000-8000-000000000001", "alice", "suspended", "tok", 33000, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.close();

      const response = await request(app, "http://localhost/api/hosted/accounts", {
        method: "POST",
        headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "newaccount" }),
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string; reason: string };
      expect(body.error).toBe("capacity_exhausted");
      expect(body.reason).toBe("account_limit");
    } finally {
      if (originalMax === undefined) delete process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
      else process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = originalMax;
    }
  });

  it("under the account limit, provisioning works normally", async () => {
    const originalMax = process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
    process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = "2";
    try {
      const { app, logPath, modePath } = setup();
      setMode(modePath, { ready: "true" });

      const response = await request(app, "http://localhost/api/hosted/accounts", {
        method: "POST",
        headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "myaccount" }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { id: string; name: string; state: string };
      expect(body.name).toBe("myaccount");
      expect(body.state).toBe("ready");

      const log = getLog(logPath);
      const containerCreateLine = log.find((l) => l.includes("container create"));
      expect(containerCreateLine).toBeTruthy();
    } finally {
      if (originalMax === undefined) delete process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
      else process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = originalMax;
    }
  });

  it("GET /api/hosted/capacity reports acceptingNewAccounts false with account_limit at the limit", async () => {
    const originalMax = process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
    process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = "1";
    try {
      const { app, databasePath } = setup();

      const db = new Database(databasePath);
      db.query(
        "INSERT INTO hosted_accounts (id, user_id, name, gateway_token, host_port, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)",
      ).run("00000000-0000-4000-8000-000000000001", "alice", "existing", "tok", 33000, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.close();

      const response = await request(app, "http://localhost/api/hosted/capacity", {
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        acceptingNewAccounts: boolean;
        reason: string | null;
        maxAccounts: number;
        accountsProvisioned: number;
      };
      expect(body.acceptingNewAccounts).toBe(false);
      expect(body.reason).toBe("account_limit");
      expect(body.maxAccounts).toBe(1);
      expect(body.accountsProvisioned).toBe(1);
    } finally {
      if (originalMax === undefined) delete process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
      else process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = originalMax;
    }
  });

  it("GET /api/hosted/capacity reports acceptingNewAccounts true below the limit", async () => {
    const originalMax = process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
    process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = "2";
    try {
      const { app, databasePath } = setup();

      const db = new Database(databasePath);
      db.query(
        "INSERT INTO hosted_accounts (id, user_id, name, gateway_token, host_port, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)",
      ).run("00000000-0000-4000-8000-000000000001", "alice", "existing", "tok", 33000, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.close();

      const response = await request(app, "http://localhost/api/hosted/capacity", {
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        acceptingNewAccounts: boolean;
        reason: string | null;
        accountsProvisioned: number;
      };
      expect(body.acceptingNewAccounts).toBe(true);
      expect(body.reason).toBeNull();
      expect(body.accountsProvisioned).toBe(1);
    } finally {
      if (originalMax === undefined) delete process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS;
      else process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS = originalMax;
    }
  });

  it("GET /api/hosted/capacity returns 200 with host.freeDiskBytes null when disk cannot be measured", async () => {
    const originalDataRoot = process.env.REMOTECODE_DATA_ROOT;
    process.env.REMOTECODE_DATA_ROOT = "/nonexistent/path/for/disk/measurement";
    try {
      const { app } = setup();

      const response = await request(app, "http://localhost/api/hosted/capacity", {
        headers: { cookie: `remotecode_session=${ownerToken}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        acceptingNewAccounts: boolean;
        reason: string | null;
        host: { freeDiskBytes: number | null; freeMemoryBytes: number | null };
      };
      expect(body.host.freeDiskBytes).toBeNull();
      expect(body.reason).not.toBe("disk_pressure");
    } finally {
      if (originalDataRoot === undefined) delete process.env.REMOTECODE_DATA_ROOT;
      else process.env.REMOTECODE_DATA_ROOT = originalDataRoot;
    }
  });
});
