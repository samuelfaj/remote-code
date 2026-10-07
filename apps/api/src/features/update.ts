import { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

function openDatabase(path: string, isReadonly = false) {
  if (!isReadonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !isReadonly, readonly: isReadonly });
}

export function recoverUpdates(databasePath: string): void {
  try {
    const db = openDatabase(databasePath);
    try {
      db.exec("PRAGMA busy_timeout = 250");
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
      const rows = db.query<
        { id: string; workspace_or_account_id: string },
        []
      >(
        "SELECT id, workspace_or_account_id FROM hosted_updates WHERE state IN ('copying', 'migrating', 'swapping')",
      ).all();
      const now = new Date().toISOString();
      for (const row of rows) {
        db.query(
          "UPDATE hosted_updates SET state = 'failed', error = 'host_restart', step = 'none', updated_at = ? WHERE id = ?",
        ).run(now, row.id);
        // The account was mid-swap when the host died, so its image was never
        // confirmed to serve. Reporting it "ready" would advertise a working
        // host that nobody verified, so it is marked failed until re-probed.
        db.query(
          "UPDATE hosted_accounts SET state = 'failed', error = 'update_interrupted_host_restart', updated_at = ? WHERE id = ? AND state = 'ready'",
        ).run(now, row.workspace_or_account_id);
      }
    } finally {
      db.close();
    }
  } catch {
    // Storage unavailable; readiness reports it and every route fails closed.
  }
}

export function updateFeature(
  databasePath: string,
  options?: {
    image?: string;
    docker?: string;
    readyTimeoutMs?: number;
    migrate?: (db: Database) => void;
  },
) {
  const defaultImage = options?.image ?? process.env.REMOTECODE_HOSTED_IMAGE ?? "remotecode/host:local";
  const docker = options?.docker ?? process.env.RC060_DOCKER ?? "docker";
  const readyTimeoutMs = options?.readyTimeoutMs ?? Number(process.env.RC060_READY_TIMEOUT_MS ?? 60000);
  const migrate = options?.migrate ?? (() => {});

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

  // Run recovery on construction so in-progress updates from a prior host
  // crash are marked failed and never resumed automatically.
  recoverUpdates(databasePath);

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_update_request" as const };
      }
    })
    .post("/api/hosted/accounts/:id/update", async ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "account_not_found" as const }; }

      const toImage = (body as { image?: string })?.image ?? "";
      if (!toImage) { set.status = 400; return { error: "invalid_update_request" as const }; }

      // Verify the account belongs to this user
      let accountRow: { id: string; volume_id: string | null; state: string } | null;
      try {
        accountRow = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; volume_id: string | null; state: string },
            [string, string]
          >("SELECT id, volume_id, state FROM hosted_accounts WHERE id = ? AND user_id = ?").get(params.id, userId);
        });
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
      if (!accountRow) { set.status = 404; return { error: "account_not_found" as const }; }

      const updateId = crypto.randomUUID();
      const startedAt = new Date().toISOString();

      // Determine from_image from the most recent successful update, or the default image
      let fromImage = defaultImage;
      try {
        const prevUpdate = db((database) => {
          initializeSchema(database);
          return database.query<
            { to_image: string },
            [string]
          >("SELECT to_image FROM hosted_updates WHERE workspace_or_account_id = ? AND state = 'ready' ORDER BY started_at DESC LIMIT 1").get(params.id);
        });
        if (prevUpdate) fromImage = prevUpdate.to_image;
      } catch {
        // Use defaultImage if we can't look up the previous image
      }

      // Record the intent row
      db((database) => {
        initializeSchema(database);
        database.query(
          "INSERT INTO hosted_updates (id, workspace_or_account_id, from_image, to_image, state, step, error, started_at, updated_at) VALUES (?, ?, ?, ?, 'copying', 'none', ?, ?, ?)",
        ).run(updateId, params.id, fromImage, toImage, null, startedAt, startedAt);
      });

      const copyVolumeId = `${params.id}-update-${updateId}`;

      // --- COPY step ---
      try {
        const volumeProc = Bun.spawnSync([docker, "volume", "create", copyVolumeId, "--label", `remotecode.update=${updateId}`], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (volumeProc.exitCode !== 0) {
          throw new Error(volumeProc.stderr.toString().trim() || "copy_volume_create_failed");
        }

        // Create a throwaway container that copies the directory
        const copyContainerId = `${copyVolumeId}-copy`;
        const createProc = Bun.spawnSync([docker, "container", "create", "--name", copyContainerId, "-v", `${accountRow.volume_id}:/source`, "-v", `${copyVolumeId}:/dest`, "alpine", "cp", "-r", "/source/.", "/dest/"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (createProc.exitCode !== 0) {
          throw new Error(createProc.stderr.toString().trim() || "copy_container_create_failed");
        }

        const startProc = Bun.spawnSync([docker, "container", "start", copyContainerId], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (startProc.exitCode !== 0) {
          throw new Error(startProc.stderr.toString().trim() || "copy_container_start_failed");
        }

        // `docker container start` returns as soon as the copy container is
        // running, so without `wait` the `rm -f` below kills the copy partway
        // and the "copy" is silently incomplete.
        const waitProc = Bun.spawnSync([docker, "container", "wait", copyContainerId], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 300_000,
        });
        if (waitProc.exitCode !== 0) {
          throw new Error(waitProc.stderr.toString().trim() || "copy_container_wait_failed");
        }
        const copyExit = waitProc.stdout.toString().trim();
        if (copyExit !== "0") {
          throw new Error(`copy_container_exited_${copyExit}`);
        }

        // Remove the throwaway container
        Bun.spawnSync([docker, "container", "rm", "-f", copyContainerId], {
          stdout: "pipe", stderr: "pipe", timeout: 10_000,
        });

        // Verify the copy exists by inspecting the volume
        const volumeInspectProc = Bun.spawnSync([docker, "volume", "inspect", copyVolumeId], {
          stdout: "pipe", stderr: "pipe", timeout: 10_000,
        });
        if (volumeInspectProc.exitCode !== 0) {
          throw new Error("copy_volume_verify_failed");
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        db((database) => {
          database.query(
            "UPDATE hosted_updates SET state = 'failed', step = 'none', error = ?, updated_at = ? WHERE id = ?",
          ).run(errorMessage, new Date().toISOString(), updateId);
        });
        set.status = 503;
        return { error: "update_failed" as const, step: "none" };
      }

      // --- MIGRATE step ---
      try {
        db((database) => {
          database.query(
            "UPDATE hosted_updates SET state = 'migrating', step = 'migrate', updated_at = ? WHERE id = ?",
          ).run(new Date().toISOString(), updateId);
        });

        // Copy the live database to a temporary copy and run migration on it
        const copyDbPath = join(dirname(databasePath), `update-${updateId}-copy.sqlite`);
        let migrationFailed = false;
        let migrationError = "";

        try {
          const liveData = readFileSync(databasePath);
          writeFileSync(copyDbPath, liveData);

          const copyDb = new Database(copyDbPath);
          try {
            migrate(copyDb);
          } finally {
            copyDb.close();
          }

          // Verify with integrity_check and row counts
          const verifyDb = new Database(copyDbPath);
          try {
            const integrity = verifyDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
            if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
              throw new Error("copy_integrity_check_failed");
            }

            const copyWorkspaces = verifyDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workspaces").get()?.count ?? 0;
            const copyBots = verifyDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM bots").get()?.count ?? 0;
            const copySchedules = verifyDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schedules").get()?.count ?? 0;

            const liveDb = new Database(databasePath);
            try {
              const liveWorkspaces = liveDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workspaces").get()?.count ?? 0;
              const liveBots = liveDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM bots").get()?.count ?? 0;
              const liveSchedules = liveDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schedules").get()?.count ?? 0;

              if (copyWorkspaces !== liveWorkspaces || copyBots !== liveBots || copySchedules !== liveSchedules) {
                throw new Error("copy_row_count_mismatch");
              }
            } finally {
              liveDb.close();
            }
          } finally {
            verifyDb.close();
          }
        } catch (error) {
          migrationFailed = true;
          migrationError = error instanceof Error ? error.message : String(error);
        } finally {
          try { rmSync(copyDbPath, { force: true }); } catch { /* ignore */ }
        }

        if (migrationFailed) {
          // Remove the copy volume
          try {
            Bun.spawnSync([docker, "volume", "rm", "-f", copyVolumeId], {
              stdout: "pipe", stderr: "pipe", timeout: 10_000,
            });
          } catch { /* ignore */ }

          db((database) => {
            database.query(
              "UPDATE hosted_updates SET state = 'failed', step = 'migrate', error = ?, updated_at = ? WHERE id = ?",
            ).run(migrationError, new Date().toISOString(), updateId);
          });
          set.status = 503;
          return { error: "update_failed" as const, step: "migrate" };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          Bun.spawnSync([docker, "volume", "rm", "-f", copyVolumeId], {
            stdout: "pipe", stderr: "pipe", timeout: 10_000,
          });
        } catch { /* ignore */ }

        db((database) => {
          database.query(
            "UPDATE hosted_updates SET state = 'failed', step = 'migrate', error = ?, updated_at = ? WHERE id = ?",
          ).run(errorMessage, new Date().toISOString(), updateId);
        });
        set.status = 503;
        return { error: "update_failed" as const, step: "migrate" };
      }

      // --- SWAP step ---
      let oldNetwork: string | undefined;
      let oldPortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> | undefined;
      let oldEnv: string[] | undefined;

      try {
        // Checkpoint BEFORE removing the old container so a crash is detectable
        db((database) => {
          database.query(
            "UPDATE hosted_updates SET state = 'swapping', step = 'swap', updated_at = ? WHERE id = ?",
          ).run(new Date().toISOString(), updateId);
        });

        // Read the old container's wiring so the replacement keeps its network, port, and secret.
        const inspectEnvProc = Bun.spawnSync([docker, "inspect", "-f", "{{json .Config.Env}}", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (inspectEnvProc.exitCode !== 0) {
          throw new Error("inspect_old_container_env_failed");
        }
        const inspectNetworkProc = Bun.spawnSync([docker, "inspect", "-f", "{{json .HostConfig.NetworkMode}}", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (inspectNetworkProc.exitCode !== 0) {
          throw new Error("inspect_old_container_network_failed");
        }
        const inspectPortsProc = Bun.spawnSync([docker, "inspect", "-f", "{{json .HostConfig.PortBindings}}", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (inspectPortsProc.exitCode !== 0) {
          throw new Error("inspect_old_container_ports_failed");
        }

        oldNetwork = JSON.parse(inspectNetworkProc.stdout.toString()) as string;
        oldPortBindings = JSON.parse(inspectPortsProc.stdout.toString()) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
        oldEnv = JSON.parse(inspectEnvProc.stdout.toString()) as string[];

        // Stop and remove the old container
        Bun.spawnSync([docker, "container", "stop", "-t", "1", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        Bun.spawnSync([docker, "container", "rm", "-f", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });

        // Create a new container on the new image bound to the same live volume
        const createArgs = [
          "container", "create",
          "--name", params.id,
          "--network", oldNetwork,
          "-v", `${accountRow.volume_id}:/var/lib/remotecode`,
        ];
        // Flags must precede the image: anything after it is the container's
        // command, so a trailing `-p`/`-e` silently becomes an argument list.
        for (const [containerPort, bindings] of Object.entries(oldPortBindings)) {
          for (const binding of bindings) {
            createArgs.push("-p", `${binding.HostIp}:${binding.HostPort}:${containerPort.split("/")[0]}`);
          }
        }
        {
          const dockerInjected = new Set(["PATH", "HOSTNAME", "HOME"]);
          for (const envEntry of oldEnv) {
            const key = envEntry.split("=", 1)[0];
            if (!dockerInjected.has(key)) {
              createArgs.push("-e", envEntry);
            }
          }
        }
        createArgs.push(toImage);
        const createProc = Bun.spawnSync([docker, ...createArgs], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (createProc.exitCode !== 0) {
          throw new Error(`new_container_create_failed args=${JSON.stringify(createArgs)} stderr=${createProc.stderr.toString().trim().slice(0, 400)}`);
        }

        // Start the new container
        const startProc = Bun.spawnSync([docker, "container", "start", params.id], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        if (startProc.exitCode !== 0) {
          throw new Error(`new_container_start_failed args=${JSON.stringify(createArgs)} stderr=${startProc.stderr.toString().trim().slice(0, 400)}`);
        }

        // Run readiness probe
        const ready = await waitForReady(params.id);
        if (!ready) {
          // Record why, so an operator does not have to reproduce the swap.
          const state = Bun.spawnSync([docker, "inspect", "-f", "{{.State.Status}}/{{.State.ExitCode}}", params.id], {
            stdout: "pipe", stderr: "pipe", timeout: 10_000,
          });
          const logs = Bun.spawnSync([docker, "logs", "--tail", "5", params.id], {
            stdout: "pipe", stderr: "pipe", timeout: 10_000,
          });
          throw new Error(
            `readiness_probe_timeout container=${state.stdout.toString().trim()} args=${JSON.stringify(createArgs)} logs=${logs.stdout.toString().trim().slice(-400)}`,
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Roll back: create a container on fromImage bound to the same volume.
        // The failed container still holds the account's name, so it is removed
        // first — a create with a name already in use is rejected and the
        // account would be left running the version that cannot serve.
        try {
          Bun.spawnSync([docker, "container", "rm", "-f", params.id], {
            stdout: "pipe", stderr: "pipe", timeout: 15_000,
          });
          const rollbackArgs = [
            "container", "create",
            "--name", params.id,
            "-v", `${accountRow.volume_id}:/var/lib/remotecode`,
          ];
          if (oldNetwork) {
            rollbackArgs.push("--network", oldNetwork);
          }
          if (oldPortBindings) {
            for (const [containerPort, bindings] of Object.entries(oldPortBindings)) {
              for (const binding of bindings) {
                rollbackArgs.push("-p", `${binding.HostIp}:${binding.HostPort}:${containerPort.split("/")[0]}`);
              }
            }
          }
          if (oldEnv) {
            const dockerInjected = new Set(["PATH", "HOSTNAME", "HOME"]);
            for (const envEntry of oldEnv) {
              const key = envEntry.split("=", 1)[0];
              if (!dockerInjected.has(key)) {
                rollbackArgs.push("-e", envEntry);
              }
            }
          }
          rollbackArgs.push(fromImage);
          Bun.spawnSync([docker, ...rollbackArgs], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          });
          Bun.spawnSync([docker, "container", "start", params.id], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          });
          // Try readiness probe on the rolled-back container
          try { await waitForReady(params.id); } catch { /* ignore */ }
        } catch {
          // Rollback container creation/start failed; best effort
        }

        db((database) => {
          database.query(
            "UPDATE hosted_updates SET state = 'rolled_back', step = 'swap', error = ?, updated_at = ? WHERE id = ?",
          ).run(errorMessage, new Date().toISOString(), updateId);
        });
        set.status = 503;
        return { error: "update_failed" as const, step: "swap" };
      }

      // Success: remove the copy volume
      try {
        Bun.spawnSync([docker, "volume", "rm", "-f", copyVolumeId], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
      } catch { /* ignore cleanup errors */ }

      db((database) => {
        database.query(
          "UPDATE hosted_updates SET state = 'ready', step = 'swap', updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), updateId);
      });

      return { updateId, state: "ready" as const, fromImage, toImage };
    })
    .get("/api/hosted/accounts/:id/update", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "account_not_found" as const }; }

      try {
        const row = db((database) => {
          initializeSchema(database);
          return database.query<
            { id: string; workspace_or_account_id: string; from_image: string; to_image: string; state: string; step: string; error: string | null; started_at: string; updated_at: string },
            [string, string]
          >("SELECT * FROM hosted_updates WHERE workspace_or_account_id = ? AND id = (SELECT id FROM hosted_updates WHERE workspace_or_account_id = ? ORDER BY started_at DESC LIMIT 1)").get(params.id, params.id);
        });
        if (!row) { return { state: "none" as const }; }
        return {
          updateId: row.id,
          workspaceOrAccountId: row.workspace_or_account_id,
          fromImage: row.from_image,
          toImage: row.to_image,
          state: row.state,
          step: row.step,
          error: row.error,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    });
}
