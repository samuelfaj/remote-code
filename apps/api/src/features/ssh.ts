import { readlinkSync, renameSync, chmodSync, statSync, realpathSync } from "node:fs";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credentialNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253})$/;
const userPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function openDatabase(path: string, isReadonly = false) {
  if (!isReadonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !isReadonly, readonly: isReadonly });
}

export function sshFeature(databasePath: string, options: { root?: string } = {}) {
  const root = options.root ?? process.env.REMOTECODE_SSH_ROOT ?? "/var/lib/remotecode/ssh-credentials";

  function liveUserId(request: Request): string | null {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return null;
    const db = openDatabase(databasePath, true);
    try {
      const live = db.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(userId, tokenHash);
      if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return null;
      return userId;
    } catch { return null; }
    finally { db.close(); }
  }

  function credentialRoot(userId: string): string {
    return join(root, userId);
  }

  function keyPath(userId: string, id: string): string {
    return join(credentialRoot(userId), id);
  }

  function knownHostsPath(userId: string): string {
    return join(credentialRoot(userId), "known_hosts");
  }

  function ensureUserDirectory(userId: string): void {
    const dir = credentialRoot(userId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function initializeSchema(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS ssh_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ssh_credentials_user_id ON ssh_credentials(user_id)");
  }

  // Create the table once with a writable connection; the read paths below use
  // a read-only connection, which SQLite refuses to run DDL on.
  try {
    const db = openDatabase(databasePath);
    try { initializeSchema(db); } finally { db.close(); }
  } catch {
    // Storage is unavailable; readiness reports it and every route fails closed.
  }

  return new Elysia()
    .post("/api/ssh/credentials", ({ body, request, set }) => {
      const userId = liveUserId(request);
      if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
      const name = typeof body.name === "string" ? body.name : "";
      if (!credentialNamePattern.test(name)) { set.status = 400; return { error: "invalid_credential_name" as const }; }
      const privateKey = typeof body.privateKey === "string" ? body.privateKey : "";
      if (privateKey.length < 1 || privateKey.length > 16384 || !privateKey.includes("PRIVATE KEY")) {
        set.status = 400; return { error: "invalid_private_key" as const };
      }
      if (process.platform !== "linux") { set.status = 501; return { error: "ssh_require_linux" as const }; }
      const db = openDatabase(databasePath);
      try {
        initializeSchema(db);
        const id = crypto.randomUUID();
        const userDir = credentialRoot(userId);
        mkdirSync(userDir, { recursive: true, mode: 0o700 });
        const tmpPath = join(userDir, `.tmp-${id}`);
        writeFileSync(tmpPath, privateKey, { mode: 0o600 });
        let publicKey = "";
        try {
          const proc = Bun.spawnSync(["ssh-keygen", "-y", "-f", tmpPath], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
          if (proc.exitCode !== 0 || proc.stdout.toString().trim().length === 0) {
            try { unlinkSync(tmpPath); } catch {}
            set.status = 400; return { error: "invalid_private_key" as const };
          }
          publicKey = proc.stdout.toString().trim();
        } catch {
          try { unlinkSync(tmpPath); } catch {}
          set.status = 400; return { error: "invalid_private_key" as const };
        }
        const fingerprint = createHash("sha256").update(publicKey).digest("hex").toLowerCase();
        const createdAt = new Date().toISOString();
        db.query("INSERT INTO ssh_credentials (id, user_id, name, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, userId, name, fingerprint, createdAt);
        const finalPath = keyPath(userId, id);
        renameSync(tmpPath, finalPath);
        try { chmodSync(finalPath, 0o600); } catch {}
        try { mkdirSync(dirname(knownHostsPath(userId)), { recursive: true, mode: 0o700 }); } catch {}
        set.status = 201;
        return { id, name, fingerprint, createdAt };
      } finally { db.close(); }
    }, {
      body: t.Object({ name: t.String(), privateKey: t.String() }),
    })
    .get("/api/ssh/credentials", ({ request, set }) => {
      const userId = liveUserId(request);
      if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
      if (process.platform !== "linux") { set.status = 501; return { error: "ssh_require_linux" as const }; }
      const db = openDatabase(databasePath, true);
      try {
        const rows = db.query<{ id: string; name: string; fingerprint: string; created_at: string }, [string]>(
          "SELECT id, name, fingerprint, created_at FROM ssh_credentials WHERE user_id = ? ORDER BY created_at DESC",
        ).all(userId);
        return { credentials: rows };
      } catch {
        set.status = 503;
        return { error: "ssh_unavailable" as const };
      } finally { db.close(); }
    })
    .delete("/api/ssh/credentials/:id", ({ params, request, set }) => {
      const userId = liveUserId(request);
      if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "credential_not_found" as const }; }
      if (process.platform !== "linux") { set.status = 501; return { error: "ssh_require_linux" as const }; }
      const db = openDatabase(databasePath);
      try {
        initializeSchema(db);
        const row = db.query<{ user_id: string }, [string]>(
          "SELECT user_id FROM ssh_credentials WHERE id = ?",
        ).get(params.id);
        if (!row || row.user_id !== userId) { set.status = 404; return { error: "credential_not_found" as const }; }
        db.query("DELETE FROM ssh_credentials WHERE id = ?").run(params.id);
        try { unlinkSync(keyPath(userId, params.id)); } catch {}
        return { revoked: true };
      } finally { db.close(); }
    })
    .post("/api/workspaces/:workspaceId/ssh/transfer", ({ params, body, request, set }) => {
      const userId = liveUserId(request);
      if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
      const direction = body.direction;
      if (direction !== "upload" && direction !== "download") { set.status = 400; return { error: "invalid_direction" as const }; }
      const host = typeof body.host === "string" ? body.host : "";
      if (!hostPattern.test(host)) { set.status = 400; return { error: "invalid_host" as const }; }
      const port = typeof body.port === "number" ? body.port : 22;
      if (!Number.isInteger(port) || port < 1 || port > 65535) { set.status = 400; return { error: "invalid_port" as const }; }
      const user = typeof body.user === "string" ? body.user : "";
      if (!userPattern.test(user)) { set.status = 400; return { error: "invalid_user" as const }; }
      const remotePath = typeof body.remotePath === "string" ? body.remotePath : "";
      if (!remotePath.startsWith("/") || remotePath.includes("\n") || remotePath.includes("\0") || remotePath.length > 4096) {
        set.status = 400; return { error: "invalid_remote_path" as const };
      }
      const localPath = typeof body.localPath === "string" ? body.localPath : "";
      if (localPath.length > 4096 || localPath.startsWith("/") || localPath.includes("..") || localPath.includes("\n") || localPath.includes("\0")) {
        set.status = 400; return { error: "invalid_local_path" as const };
      }
      const credentialId = typeof body.credentialId === "string" ? body.credentialId : "";
      if (process.platform !== "linux") { set.status = 501; return { error: "ssh_require_linux" as const }; }
      const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
        const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
        const db = openDatabase(databasePath, true);
        try {
          let credential: { id: string; user_id: string; fingerprint: string } | null = null;
          try {
            credential = db.query<{ id: string; user_id: string; fingerprint: string }, [string]>(
              "SELECT id, user_id, fingerprint FROM ssh_credentials WHERE id = ?",
            ).get(credentialId);
          } catch {
            return { status: 503 as const, body: { error: "ssh_unavailable" as const } };
          }
          if (!credential || credential.user_id !== userId) return { status: 404 as const, body: { error: "credential_not_found" as const } };
          const kp = keyPath(userId, credentialId);
          let keyExists = false;
          try { keyExists = statSync(kp).isFile(); } catch {}
          if (!keyExists) return { status: 404 as const, body: { error: "credential_not_found" as const } };
          const localAbs = join(folderPath, localPath);
          const localParent = dirname(localAbs);
          mkdirSync(localParent, { recursive: true });
          const resolvedFolder = realpathSync(folderPath);
          let resolvedLocal: string;
          try {
            resolvedLocal = realpathSync(localAbs);
          } catch {
            resolvedLocal = realpathSync(localParent);
          }
          if (!resolvedLocal.startsWith(resolvedFolder + "/") && resolvedLocal !== resolvedFolder) {
            return { status: 400 as const, body: { error: "invalid_local_path" as const } };
          }
          const knownHosts = knownHostsPath(userId);
          const scpArgs = [
            "scp", "-q", "-P", String(port),
            "-i", kp,
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", `UserKnownHostsFile=${knownHosts}`,
            "-o", "ConnectTimeout=10",
          ];
          let src: string;
          let dst: string;
          if (direction === "upload") {
            src = localAbs;
            dst = `${user}@${host}:${remotePath}`;
          } else {
            src = `${user}@${host}:${remotePath}`;
            dst = localAbs;
          }
          scpArgs.push(src, dst);
          const proc = Bun.spawnSync(scpArgs, { cwd: folderPath, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
          if (proc.exitCode !== 0) {
            const stderr = proc.stderr.toString();
            if (stderr.includes("Permission denied") || stderr.includes("no supported authentication methods")) {
              return { status: 403 as const, body: { error: "ssh_auth_failed" as const } };
            }
            if (stderr.includes("Connection refused") || stderr.includes("Connection timed out") ||
              stderr.includes("Could not resolve") || stderr.includes("No route to host") ||
              stderr.includes("Host key verification failed")) {
              return { status: 502 as const, body: { error: "ssh_unreachable" as const } };
            }
            return { status: 502 as const, body: { error: "ssh_transfer_failed" as const } };
          }
          const localContent = readFileSync(localAbs);
          const sha256 = createHash("sha256").update(localContent).digest("hex").toLowerCase();
          return { status: 200 as const, body: { direction, localPath: localPath, bytes: localContent.length, sha256 } };
        } finally { db.close(); }
      });
      if (result.kind !== "opened") {
        set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
        return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "ssh_require_linux" };
      }
      if (result.value.status !== 200) { set.status = result.value.status; return result.value.body; }
      set.status = 200;
      return result.value.body;
    }, {
      params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
      body: t.Object({
        credentialId: t.String(),
        direction: t.String(),
        host: t.String(),
        port: t.Optional(t.Number()),
        user: t.String(),
        remotePath: t.String(),
        localPath: t.String(),
      }),
    });
}