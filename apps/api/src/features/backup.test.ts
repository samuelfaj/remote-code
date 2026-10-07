import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createApi } from "../app";
import { backupFeature } from "./backup";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const foreignToken = "b".repeat(64);

function setup(dataRoot?: string) {
  const directory = dataRoot ?? join(tmpdir(), `rc-backup-test-${crypto.randomUUID()}`);
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath, () => Promise.resolve(true), {
    password: process.env.REMOTECODE_AUTH_PASSWORD,
    sessionTtlMs: process.env.REMOTECODE_AUTH_SESSION_TTL_MS
      ? Number(process.env.REMOTECODE_AUTH_SESSION_TTL_MS)
      : undefined,
    webOrigin: process.env.REMOTECODE_WEB_ORIGIN ?? "http://localhost:5173",
  });
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(foreignToken).digest("hex"), "bob", Date.now() + 60_000);
  database.close();
  return { app, directory, databasePath };
}

afterEach(() => { for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function request(app: { handle: (request: Request) => Promise<Response> }, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

function cookie(token: string) {
  return `remotecode_session=${token}`;
}

function setupWorkspace(app: ReturnType<typeof createApi>, directory: string, token = ownerToken) {
  const workspaceId = crypto.randomUUID();
  const db = new Database(join(directory, "host.sqlite"));
  try {
    db.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'test-ws', ?)")
      .run(workspaceId, new Date().toISOString());
  } finally { db.close(); }
  mkdirSync(join(directory, "workspaces", workspaceId), { recursive: true });
  return workspaceId;
}

function setupBot(app: ReturnType<typeof createApi>, directory: string, token = ownerToken) {
  const botId = crypto.randomUUID();
  const db = new Database(join(directory, "host.sqlite"));
  try {
    db.query("INSERT INTO bots (id, user_id, name, instructions, context, hidden, skills, created_at, updated_at) VALUES (?, 'alice', 'test-bot', 'instructions', 'context', 0, '[]', ?, ?)")
      .run(botId, new Date().toISOString(), new Date().toISOString());
  } finally { db.close(); }
  return botId;
}

describe("Backup feature", () => {
  it("creates a backup archive with a manifest whose member hashes match the archive's contents", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);
    const botId = setupBot(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create a bot profile directory
    const botsDir = join(directory, "bots");
    mkdirSync(join(botsDir, botId, "profile"), { recursive: true });
    writeFileSync(join(botsDir, botId, "profile", "config.json"), '{"theme":"dark"}');

    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const response = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; path: string; bytes: number; sha256: string; manifest: unknown };
    expect(body.id).toBeTruthy();
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.sha256).toBeTruthy();
    expect(body.manifest).toBeTruthy();

    const manifest = body.manifest as {
      schemaVersion: number;
      createdAt: string;
      databaseSha256: string;
      counts: { workspaces: number; bots: number; runs: number; schedules: number; history: number };
      members: { path: string; sha256: string }[];
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.members).toBeInstanceOf(Array);

    // Verify each member's sha256 matches the archive's contents
    const archiveBytes = readFileSync(body.path);
    const extractedDir = join(tmpdir(), `rc-verify-${crypto.randomUUID()}`);
    mkdirSync(extractedDir, { recursive: true });
    try {
      const tarResult = Bun.spawnSync(["tar", "-xzf", body.path], { cwd: extractedDir });
      expect(tarResult.exitCode).toBe(0);

      for (const member of manifest.members) {
        const memberPath = join(extractedDir, member.path);
        expect(existsSync(memberPath)).toBe(true);
        const actualSha256 = createHash("sha256").update(readFileSync(memberPath)).digest("hex");
        expect(actualSha256).toBe(member.sha256);
      }

      // Verify archive's own sha256
      const actualArchiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
      expect(actualArchiveSha256).toBe(body.sha256);
    } finally {
      rmSync(extractedDir, { recursive: true, force: true });
    }
  });

  it("restores a backup archive into a second empty dataRoot/database yielding the same workspace and Bot ids, same file bytes, same run and schedule counts, and requiresNewLogin with no session rows", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);
    const botId = setupBot(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create a bot profile directory
    const botsDir = join(directory, "bots");
    mkdirSync(join(botsDir, botId, "profile"), { recursive: true });
    writeFileSync(join(botsDir, botId, "profile", "config.json"), '{"theme":"dark"}');

    // Insert a run and a schedule
    const db = new Database(join(directory, "host.sqlite"));
    try {
      db.query("INSERT INTO runs (id, user_id, workspace_id, bot_id, prompt, state, created_at, updated_at) VALUES (?, 'alice', ?, ?, 'test prompt', 'completed', ?, ?)")
        .run(crypto.randomUUID(), workspaceId, botId, new Date().toISOString(), new Date().toISOString());
      db.query("INSERT INTO schedules (id, user_id, kind, workspace_id, bot_id, prompt, local_time, timezone, enabled, created_at, updated_at) VALUES (?, 'alice', 'once', ?, ?, 'sched prompt', '2026-01-01T00:00:00Z', 'UTC', 1, ?, ?)")
        .run(crypto.randomUUID(), workspaceId, botId, new Date().toISOString(), new Date().toISOString());
    } finally { db.close(); }

    // Create a session row (should be invalidated on restore)
    const sessionDb = new Database(join(directory, "host.sqlite"));
    try {
      sessionDb.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)")
        .run(createHash("sha256").update("old-session").digest("hex"), Date.now() + 60_000);
    } finally { sessionDb.close(); }

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);
    const backupBody = await backupResponse.json() as { path: string };

    // Set up second data root
    const secondDirectory = join(tmpdir(), `rc-restore-target-${crypto.randomUUID()}`);
    workDirectories.push(secondDirectory);
    const secondDatabasePath = join(secondDirectory, "host.sqlite");
    const secondApp = createApi(secondDatabasePath);
    // Insert owner session into second database so resolveOwner succeeds
    const secondDb = new Database(secondDatabasePath);
    try {
      secondDb.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
    } finally { secondDb.close(); }

    // Copy backup archive to second data root's backup directory so the path is valid there
    const secondBackupRoot = join(secondDirectory, "backups");
    mkdirSync(secondBackupRoot, { recursive: true });
    const secondArchivePath = join(secondBackupRoot, `${crypto.randomUUID()}.tar.gz`);
    writeFileSync(secondArchivePath, readFileSync(backupBody.path));

    // Restore into second data root
    const restoreBackup = backupFeature(secondDatabasePath, { dataRoot: secondDirectory, root: secondBackupRoot });
    const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ archivePath: secondArchivePath }),
    });

    expect(restoreResponse.status).toBe(200);
    const restoreBody = await restoreResponse.json() as {
      restored: { database: boolean; files: number; profiles: number; sessionsInvalidated: boolean };
      counts: { workspaces: number; bots: number; runs: number; schedules: number; history: number };
      requiresNewLogin: boolean;
    };
    expect(restoreBody.restored.database).toBe(true);
    expect(restoreBody.restored.sessionsInvalidated).toBe(true);
    expect(restoreBody.requiresNewLogin).toBe(true);
    expect(restoreBody.counts.workspaces).toBe(1);
    expect(restoreBody.counts.bots).toBe(1);
    expect(restoreBody.counts.runs).toBe(1);
    expect(restoreBody.counts.schedules).toBe(1);

    // Verify workspace and bot IDs match
    const restoredDb = new Database(secondDatabasePath);
    try {
      const wsRow = restoredDb.query("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
      expect(wsRow).toBeTruthy();
      const botRow = restoredDb.query("SELECT id FROM bots WHERE id = ?").get(botId);
      expect(botRow).toBeTruthy();

      // Verify file bytes match
      const restoredFile = join(secondDirectory, "workspaces", workspaceId, "hello.txt");
      expect(existsSync(restoredFile)).toBe(true);
      expect(readFileSync(restoredFile).toString()).toBe("hello world");

      // Verify bot profile directory exists
      const restoredProfile = join(secondDirectory, "bots", botId, "profile", "config.json");
      expect(existsSync(restoredProfile)).toBe(true);
      expect(readFileSync(restoredProfile).toString()).toBe('{"theme":"dark"}');

      // Verify no session rows remain
      const sessionRows = restoredDb.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
      expect(sessionRows.count).toBe(0);
    } finally {
      restoredDb.close();
    }
  });

  it("flipping one byte of a member makes restore answer 400 backup_corrupt and leaves the live database byte-identical", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);
    const backupBody = await backupResponse.json() as { path: string };

    // Extract the archive, flip one byte in a member file, and re-archive
    const extractDir = join(tmpdir(), `rc-corrupt-${crypto.randomUUID()}`);
    mkdirSync(extractDir, { recursive: true });
    try {
      const tarResult = Bun.spawnSync(["tar", "-xzf", backupBody.path], { cwd: extractDir });
      expect(tarResult.exitCode).toBe(0);
      // Flip one byte in the workspace file
      const helloFile = join(extractDir, "workspaces", workspaceId, "hello.txt");
      const originalContent = readFileSync(helloFile);
      const corruptedContent = Buffer.from(originalContent);
      corruptedContent[0] ^= 0xff;
      writeFileSync(helloFile, corruptedContent);
      const corruptedPath = join(backupRoot, "corrupted.tar.gz");
      Bun.spawnSync(["tar", "-czf", corruptedPath, "manifest.json", "remotecode.sqlite", "workspaces", "bots"], { cwd: extractDir });

      // Record live database sha256 before restore attempt
      const dbShaBefore = createHash("sha256").update(readFileSync(join(directory, "host.sqlite"))).digest("hex");

      // Attempt restore with corrupted archive
      const restoreBackup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
      const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
        method: "POST",
        headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({ archivePath: corruptedPath }),
      });

      expect(restoreResponse.status).toBe(400);
      const restoreBody = await restoreResponse.json() as { error: string };
      expect(restoreBody.error).toBe("backup_corrupt");

      // Verify live database is byte-identical
      const dbShaAfter = createHash("sha256").update(readFileSync(join(directory, "host.sqlite"))).digest("hex");
      expect(dbShaAfter).toBe(dbShaBefore);
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it("a truncated archive returns 400 invalid_backup", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);
    const backupBody = await backupResponse.json() as { path: string };

    // Truncate the archive
    const archiveBytes = readFileSync(backupBody.path);
    const truncatedPath = join(backupRoot, "truncated.tar.gz");
    writeFileSync(truncatedPath, archiveBytes.slice(0, Math.floor(archiveBytes.length / 2)));

    const restoreBackup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ archivePath: truncatedPath }),
    });

    expect(restoreResponse.status).toBe(400);
    const restoreBody = await restoreResponse.json() as { error: string };
    expect(restoreBody.error).toBe("invalid_backup");
  });

  it("an archive missing manifest.json returns 400 invalid_backup", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);
    const backupBody = await backupResponse.json() as { path: string };

    // Extract and remove manifest.json, then re-archive
    const extractDir = join(tmpdir(), `rc-no-manifest-${crypto.randomUUID()}`);
    mkdirSync(extractDir, { recursive: true });
    try {
      const tarResult = Bun.spawnSync(["tar", "-xzf", backupBody.path], { cwd: extractDir });
      expect(tarResult.exitCode).toBe(0);
      rmSync(join(extractDir, "manifest.json"));
      const noManifestPath = join(backupRoot, "no-manifest.tar.gz");
      Bun.spawnSync(["tar", "-czf", noManifestPath, "remotecode.sqlite", "workspaces", "bots"], { cwd: extractDir });

      const restoreBackup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
      const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
        method: "POST",
        headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({ archivePath: noManifestPath }),
      });

      expect(restoreResponse.status).toBe(400);
      const restoreBody = await restoreResponse.json() as { error: string };
      expect(restoreBody.error).toBe("invalid_backup");
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it("an archive whose manifest lists a member that is absent returns 400 backup_corrupt", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);
    const backupBody = await backupResponse.json() as { path: string };

    // Extract, remove a file, and re-archive
    const extractDir = join(tmpdir(), `rc-missing-member-${crypto.randomUUID()}`);
    mkdirSync(extractDir, { recursive: true });
    try {
      const tarResult = Bun.spawnSync(["tar", "-xzf", backupBody.path], { cwd: extractDir });
      expect(tarResult.exitCode).toBe(0);
      rmSync(join(extractDir, "workspaces"), { recursive: true, force: true });
      const missingMemberPath = join(backupRoot, "missing-member.tar.gz");
      Bun.spawnSync(["tar", "-czf", missingMemberPath, "manifest.json", "remotecode.sqlite", "bots"], { cwd: extractDir });

      const restoreBackup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
      const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
        method: "POST",
        headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({ archivePath: missingMemberPath }),
      });

      expect(restoreResponse.status).toBe(400);
      const restoreBody = await restoreResponse.json() as { error: string };
      expect(restoreBody.error).toBe("backup_corrupt");
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it("an archivePath outside root returns 400 invalid_backup_path", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);

    const restoreBackup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ archivePath: "/tmp/some-other-backup.tar.gz" }),
    });

    expect(restoreResponse.status).toBe(400);
    const restoreBody = await restoreResponse.json() as { error: string };
    expect(restoreBody.error).toBe("invalid_backup_path");
  });

  it("a relative archivePath returns 400 invalid_backup_path", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    // Create backup
    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const backupResponse = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(backupResponse.status).toBe(201);

    const restoreBackup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const restoreResponse = await request(restoreBackup, "http://localhost/api/restore", {
      method: "POST",
      headers: { cookie: cookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ archivePath: "relative/path.tar.gz" }),
    });

    expect(restoreResponse.status).toBe(400);
    const restoreBody = await restoreResponse.json() as { error: string };
    expect(restoreBody.error).toBe("invalid_backup_path");
  });

  it("anonymous request to backup returns 401", async () => {
    const { app, directory } = setup();
    const workspaceId = setupWorkspace(app, directory);

    // Write a file into the workspace
    const wsDir = join(directory, "workspaces", workspaceId);
    writeFileSync(join(wsDir, "hello.txt"), "hello world");

    const backupRoot = join(directory, "backups");
    const backup = backupFeature(join(directory, "host.sqlite"), { dataRoot: directory, root: backupRoot });
    const response = await request(backup, "http://localhost/api/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });
});
