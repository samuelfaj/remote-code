import { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { capacityAllows } from "./capacity";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountNamePattern = /^[\x20-\x7e]{1,64}$/;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

function openDatabase(path: string, isReadonly = false) {
  if (!isReadonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !isReadonly, readonly: isReadonly });
}

export function hostedFeature(
  databasePath: string,
  options: {
    image?: string;
    network?: string;
    portBase?: number;
    docker?: string;
    readyTimeoutMs?: number;
  } = {},
) {
  const image = options.image ?? process.env.REMOTECODE_HOSTED_IMAGE ?? "remotecode/host:local";
  const network = options.network ?? process.env.REMOTECODE_HOSTED_NETWORK ?? "bridge";
  const portBase = options.portBase ?? Number(process.env.REMOTECODE_HOSTED_PORT_BASE ?? 33000);
  const docker = options.docker ?? process.env.RC060_DOCKER ?? "docker";
  const readyTimeoutMs = options.readyTimeoutMs ?? Number(process.env.RC060_READY_TIMEOUT_MS ?? 60000);

  function resolveOwner(request: Request): Owner {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return { kind: "anonymous" };
    const db = openDatabase(databasePath, true);
    try {
      const live = db.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(userId, tokenHash);
      if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return { kind: "anonymous" };
      return { kind: "ok", userId };
    } catch {
      return { kind: "unavailable" };
    } finally {
      db.close();
    }
  }

  function initializeSchema(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS hosted_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      container_id TEXT,
      volume_id TEXT,
      gateway_token TEXT NOT NULL,
      host_port INTEGER NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_hosted_accounts_user_id ON hosted_accounts(user_id)");
  }

  try {
    const db = openDatabase(databasePath);
    try { initializeSchema(db); } finally { db.close(); }
  } catch {
    // Storage unavailable; readiness reports it and every route fails closed.
  }

  function db<T>(callback: (db: Database) => T): T {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 250");
      return callback(db);
    } finally {
      db.close();
    }
  }

  function generateGatewayToken(): string {
    return randomBytes(16).toString("hex");
  }

  function generateAuthSecret(): string {
    return randomBytes(32).toString("hex");
  }

  async function waitForReady(containerId: string): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < readyTimeoutMs) {
      try {
        const proc = Bun.spawn([docker, "exec", containerId, "curl", "-fsS", "http://127.0.0.1:3000/api/health/ready"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const exitCode = await new Promise<number>((resolve) => {
          proc.exited.then((code) => resolve(code));
        });
        if (exitCode === 0) return true;
      } catch {
        // ignore and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  function viewAccount(row: {
    id: string; name: string; state: string; container_id: string | null;
    volume_id: string | null; gateway_token: string; host_port: number;
    error: string | null; created_at: string; updated_at: string;
  }) {
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      containerId: row.container_id,
      volumeId: row.volume_id,
      hostPort: row.host_port,
      gatewayToken: row.gateway_token,
      error: row.error,
      supervisor: { container: row.id },
    };
  }

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_hosted_request" as const };
      }
    })
    .post("/api/hosted/accounts", async ({ body, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      const name = typeof body.name === "string" ? body.name : "";
      if (!accountNamePattern.test(name)) { set.status = 400; return { error: "invalid_account_name" as const }; }

      const capacity = db((database) => capacityAllows(database));
      if (!capacity.allowed) { set.status = 503; return { error: "capacity_exhausted" as const, reason: capacity.reason }; }

      const id = crypto.randomUUID();
      const gatewayToken = generateGatewayToken();
      const authPassword = generateAuthSecret();
      const authSecret = generateAuthSecret();
      const hostPort = portBase + db((database) => {
        const count = database.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM hosted_accounts",
        ).get()?.count ?? 0;
        return count;
      });
      const createdAt = new Date().toISOString();

      db((database) => {
        initializeSchema(database);
        database.query(
          "INSERT INTO hosted_accounts (id, user_id, name, gateway_token, host_port, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?)",
        ).run(id, userId, name, gatewayToken, hostPort, null, createdAt, createdAt);
      });

      let containerId: string | null = null;
      let volumeId: string | null = null;
      let failed = false;
      let errorMessage = "";

      try {
        // Create volume
        const volumeProc = Bun.spawnSync([docker, "volume", "create", `${id}-data`, "--label", `remotecode.hosted=${id}`], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (volumeProc.exitCode !== 0) {
          throw new Error(volumeProc.stderr.toString().trim() || "volume_create_failed");
        }
        volumeId = `${id}-data`;

        // Create container
        const createArgs = [
          "container", "create",
          "--name", id,
          "--network", network,
          "-p", `127.0.0.1:${hostPort}:3000`,
          "-v", `${id}-data:/var/lib/remotecode`,
          "-e", `REMOTECODE_AUTH_PASSWORD=${authPassword}`,
          "-e", `REMOTECODE_HOSTED_ACCOUNT=${id}`,
          "--label", `remotecode.hosted=${id}`,
          image,
        ];
        const createProc = Bun.spawnSync([docker, ...createArgs], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (createProc.exitCode !== 0) {
          throw new Error(createProc.stderr.toString().trim() || "container_create_failed");
        }
        containerId = id;

        // Start container
        const startProc = Bun.spawnSync([docker, "container", "start", id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (startProc.exitCode !== 0) {
          throw new Error(startProc.stderr.toString().trim() || "container_start_failed");
        }

        // Wait for readiness
        const ready = await waitForReady(id);
        if (!ready) {
          throw new Error("readiness_probe_timeout");
        }

        // Success
        db((database) => {
          database.query(
            "UPDATE hosted_accounts SET state = 'ready', container_id = ?, volume_id = ?, error = NULL, updated_at = ? WHERE id = ?",
          ).run(id, `${id}-data`, new Date().toISOString(), id);
        });

        set.status = 201;
        return {
          id,
          name,
          state: "ready" as const,
          containerId: id,
          volumeId: `${id}-data`,
          hostPort,
          gatewayToken,
          gatewayRoute: { token: gatewayToken, target: `http://${id}:3000` },
          supervisor: { container: id },
        };
      } catch (error) {
        failed = true;
        errorMessage = error instanceof Error ? error.message : String(error);

        // Set state to failed
        db((database) => {
          database.query(
            "UPDATE hosted_accounts SET state = 'failed', error = ?, updated_at = ? WHERE id = ?",
          ).run(errorMessage, new Date().toISOString(), id);
        });

        // Remove container if it exists
        try {
          Bun.spawnSync([docker, "rm", "-f", id], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          });
        } catch {
          // ignore cleanup errors
        }

        set.status = 503;
        return { error: "provisioning_failed" as const, accountId: id };
      }
    }, {
      body: t.Object({ name: t.String() }),
    })
    .get("/api/hosted/accounts", ({ request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      try {
        const rows = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; name: string; state: string; container_id: string | null; volume_id: string | null; host_port: number; gateway_token: string; error: string | null; created_at: string; updated_at: string },
            [string]
          >("SELECT * FROM hosted_accounts WHERE user_id = ? ORDER BY created_at DESC").all(userId);
        });
        return { accounts: rows.map(viewAccount) };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .get("/api/hosted/accounts/:id", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "account_not_found" as const }; }

      try {
        const row = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; user_id: string; name: string; container_id: string | null; volume_id: string | null; gateway_token: string; host_port: number; state: string; error: string | null; created_at: string; updated_at: string },
            [string, string]
          >("SELECT * FROM hosted_accounts WHERE id = ? AND user_id = ?").get(params.id, userId);
        });
        if (!row) { set.status = 404; return { error: "account_not_found" as const }; }
        return viewAccount(row);
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .post("/api/hosted/accounts/:id/suspend", async ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "account_not_found" as const }; }

      try {
        const row = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; user_id: string; state: string; container_id: string | null },
            [string, string]
          >("SELECT * FROM hosted_accounts WHERE id = ? AND user_id = ?").get(params.id, userId);
        });
        if (!row) { set.status = 404; return { error: "account_not_found" as const }; }
        if (row.state !== "ready") { set.status = 409; return { error: "account_not_running" as const }; }

        // The default 10 s stop grace equals a 10 s spawn timeout, so a host
        // that ignores SIGTERM raced the kill and reported provisioning_failed.
        const stopProc = Bun.spawnSync([docker, "container", "stop", "-t", "1", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        if (stopProc.exitCode !== 0) {
          set.status = 503;
          return { error: "provisioning_failed" as const, accountId: params.id };
        }

        db((database) => {
          database.query(
            "UPDATE hosted_accounts SET state = 'suspended', error = NULL, updated_at = ? WHERE id = ?",
          ).run(new Date().toISOString(), params.id);
        });

        const updatedRow = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; user_id: string; name: string; container_id: string | null; volume_id: string | null; gateway_token: string; host_port: number; state: string; error: string | null; created_at: string; updated_at: string },
            [string, string]
          >("SELECT * FROM hosted_accounts WHERE id = ? AND user_id = ?").get(params.id, userId);
        });
        return viewAccount(updatedRow!);
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .post("/api/hosted/accounts/:id/resume", async ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "account_not_found" as const }; }

      try {
        const row = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; user_id: string; name: string; container_id: string | null; volume_id: string | null; gateway_token: string; host_port: number; state: string; error: string | null; created_at: string; updated_at: string },
            [string, string]
          >("SELECT * FROM hosted_accounts WHERE id = ? AND user_id = ?").get(params.id, userId);
        });
        if (!row) { set.status = 404; return { error: "account_not_found" as const }; }

        const startProc = Bun.spawnSync([docker, "container", "start", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (startProc.exitCode !== 0) {
          const errorText = startProc.stderr.toString().trim() || "container_start_failed";
          db((database) => {
            database.query(
              "UPDATE hosted_accounts SET state = 'failed', error = ?, updated_at = ? WHERE id = ?",
            ).run(errorText, new Date().toISOString(), params.id);
          });
          set.status = 503;
          return { error: "provisioning_failed" as const, accountId: params.id };
        }

        const ready = await waitForReady(params.id);
        if (ready) {
          db((database) => {
            database.query(
              "UPDATE hosted_accounts SET state = 'ready', error = NULL, updated_at = ? WHERE id = ?",
            ).run(new Date().toISOString(), params.id);
          });
          const updatedRow = db((database) => {
            initializeSchema(database);
            return database.query<
              { id: string; user_id: string; name: string; container_id: string | null; volume_id: string | null; gateway_token: string; host_port: number; state: string; error: string | null; created_at: string; updated_at: string },
              [string, string]
            >("SELECT * FROM hosted_accounts WHERE id = ? AND user_id = ?").get(params.id, userId);
          });
          return viewAccount(updatedRow!);
        } else {
          const errorText = "readiness_probe_timeout";
          db((database) => {
            database.query(
              "UPDATE hosted_accounts SET state = 'failed', error = ?, updated_at = ? WHERE id = ?",
            ).run(errorText, new Date().toISOString(), params.id);
          });
          set.status = 503;
          return { error: "provisioning_failed" as const, accountId: params.id };
        }
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    });
}
