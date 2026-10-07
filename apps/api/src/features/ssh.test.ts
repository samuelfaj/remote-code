import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc030-ssh-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  const workspaceId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
    .run(workspaceId, new Date().toISOString());
  database.close();
  return { app, databasePath, workspaceId };
}

afterEach(() => { for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

describe("SSH credentials routes", () => {
  it("POST /api/ssh/credentials rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", privateKey: "-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----\n" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/ssh/credentials rejects an invalid credential name with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "invalid name!", privateKey: "-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----\n" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_credential_name");
  });

  it("POST /api/ssh/credentials rejects a privateKey without PRIVATE KEY with 400", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "test", privateKey: "not a valid key" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_private_key");
  });

  it("POST /api/ssh/credentials reaches the platform guard on this macOS host", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials", {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "validname", privateKey: "-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----\n" }),
    });
    expect(response.status).toBe(process.platform === "linux" ? 201 : 501);
    if (process.platform === "linux") {
      const body = await response.json() as { id: string; name: string; fingerprint: string; createdAt: string };
      expect(body.id).toBeTruthy();
      expect(body.name).toBe("validname");
    } else {
      const body = await response.json() as { error: string };
      expect(body.error).toBe("ssh_require_linux");
    }
  });

  it("GET /api/ssh/credentials rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials");
    expect(response.status).toBe(401);
  });

  it("GET /api/ssh/credentials reaches the platform guard on this macOS host", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(process.platform === "linux" ? 200 : 501);
    if (process.platform === "linux") {
      const body = await response.json() as { credentials: unknown[] };
      expect(body.credentials).toBeInstanceOf(Array);
    } else {
      const body = await response.json() as { error: string };
      expect(body.error).toBe("ssh_require_linux");
    }
  });

  it("DELETE /api/ssh/credentials/:id rejects an anonymous request with 401", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
    });
    expect(response.status).toBe(401);
  });

  it("DELETE /api/ssh/credentials/:id reaches the platform guard on this macOS host", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(process.platform === "linux" ? 404 : 501);
    if (process.platform === "linux") {
      const body = await response.json() as { error: string };
      expect(body.error).toBe("credential_not_found");
    } else {
      const body = await response.json() as { error: string };
      expect(body.error).toBe("ssh_require_linux");
    }
  });

  it("GET /api/ssh/credentials returns an empty list for an authenticated user with no credentials", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/ssh/credentials", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(process.platform === "linux" ? 200 : 501);
    if (process.platform === "linux") {
      const body = await response.json() as { credentials: unknown[] };
      expect(body.credentials).toBeInstanceOf(Array);
      expect(body.credentials).toHaveLength(0);
    }
  });

  it("DELETE /api/ssh/credentials/:id rejects a signed-in non-owner", async () => {
    const { app, databasePath } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();
    const response = await request(app, "http://localhost/api/ssh/credentials/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
      headers: { cookie: `remotecode_session=${"b".repeat(64)}` },
    });
    expect(response.status).toBe(process.platform === "linux" ? 404 : 501);
  });
});

describe("SSH transfer route", () => {
  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects an anonymous request with 401", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", user: "test", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects invalid direction with 400", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "invalid", host: "example.com", user: "test", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_direction");
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects invalid host with 400", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "", user: "test", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_host");
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects invalid port with 400", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", port: 0, user: "test", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_port");
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects invalid user with 400", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", user: "invalid user!", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_user");
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects invalid remotePath with 400", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", user: "test", remotePath: "relative/path", localPath: "file.txt" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_remote_path");
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects invalid localPath with 400", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", user: "test", remotePath: "/tmp/file", localPath: "/absolute/path" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_local_path");
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer reaches the platform guard on this macOS host", async () => {
    const { app, workspaceId } = setup();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", user: "test", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(process.platform === "linux" ? 404 : 501);
    if (process.platform === "linux") {
      const body = await response.json() as { error: string };
      expect(body.error).toBe("not_found");
    } else {
      const body = await response.json() as { error: string };
      expect(body.error).toBe("ssh_require_linux");
    }
  });

  it("POST /api/workspaces/:workspaceId/ssh/transfer rejects a signed-in non-owner", async () => {
    const { app, databasePath, workspaceId } = setup();
    const database = new Database(databasePath);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
    database.close();
    const response = await request(app, `http://localhost/api/workspaces/${workspaceId}/ssh/transfer`, {
      method: "POST",
      headers: { cookie: `remotecode_session=${"b".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "00000000-0000-4000-8000-000000000000", direction: "upload", host: "example.com", user: "test", remotePath: "/tmp/file", localPath: "file.txt" }),
    });
    expect(response.status).toBe(process.platform === "linux" ? 404 : 501);
  });
});