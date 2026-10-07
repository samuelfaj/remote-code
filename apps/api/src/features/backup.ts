import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

function openDatabase(path: string, isReadonly: boolean) {
  if (!isReadonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !isReadonly, readonly: isReadonly });
}

export function backupFeature(databasePath: string, options: { dataRoot: string; root?: string }) {
  const dataRoot = options.dataRoot ?? "/var/lib/remotecode";
  const root = options.root ?? join(dataRoot, "backups");

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

  function sha256Bytes(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
  }

  function sha256File(filePath: string): string {
    return sha256Bytes(readFileSync(filePath));
  }

  function countRows(db: Database, table: string): number {
    try {
      const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  function vacuumCopy(sourcePath: string, destPath: string): boolean {
    mkdirSync(dirname(destPath), { recursive: true });
    let sourceDb: Database | undefined;
    try {
      sourceDb = new Database(sourcePath, { readonly: true, create: false });
      sourceDb.exec(`VACUUM INTO '${destPath}'`);
      return true;
    } catch {
      try { rmSync(destPath, { force: true }); } catch { /* ignore */ }
      return false;
    } finally {
      sourceDb?.close();
    }
  }

  function copyFileFallback(sourcePath: string, destPath: string): void {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, readFileSync(sourcePath));
  }

  function copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      if (statSync(srcPath).isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  function collectFiles(dir: string, prefix: string): { path: string; sha256: string }[] {
    const results: { path: string; sha256: string }[] = [];
    if (!existsSync(dir)) return results;
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(fullPath).isDirectory()) {
        results.push(...collectFiles(fullPath, relPath));
      } else {
        results.push({ path: relPath, sha256: sha256File(fullPath) });
      }
    }
    return results;
  }

  function buildManifest(dbSha256: string): { schemaVersion: number; createdAt: string; databaseSha256: string; counts: { workspaces: number; bots: number; runs: number; schedules: number; history: number }; members: { path: string; sha256: string }[] } {
    const db = openDatabase(databasePath, true);
    try {
      const counts = {
        workspaces: countRows(db, "workspaces"),
        bots: countRows(db, "bots"),
        runs: countRows(db, "runs"),
        schedules: countRows(db, "schedules"),
        history: countRows(db, "history"),
      };
      const members: { path: string; sha256: string }[] = [];
      members.push({ path: "remotecode.sqlite", sha256: dbSha256 });
      for (const dir of ["workspaces", "bots"]) {
        const dirPath = join(dataRoot, dir);
        members.push(...collectFiles(dirPath, dir));
      }
      return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        databaseSha256: dbSha256,
        counts,
        members,
      };
    } finally {
      db.close();
    }
  }

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_backup_request" as const };
      }
    })
    .post("/api/backup", async ({ request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }

      const tmpDir = join(tmpdir(), `rc-backup-${crypto.randomUUID()}`);
      const archivePath = join(root, `${crypto.randomUUID()}.tar.gz`);
      try {
        mkdirSync(tmpDir, { recursive: true });
        mkdirSync(root, { recursive: true });

        // Step 1: Copy database with VACUUM INTO, fallback to plain copy
        const dbDest = join(tmpDir, "remotecode.sqlite");
        const vacuumOk = vacuumCopy(databasePath, dbDest);
        if (!vacuumOk) {
          copyFileFallback(databasePath, dbDest);
        }

        // Compute database sha256
        const dbSha256 = sha256File(dbDest);

        // Step 2: Build manifest
        const manifest = buildManifest(dbSha256);
        writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify(manifest));

        // Copy workspaces/ and bots/ into tmpDir for archiving
        for (const dir of ["workspaces", "bots"]) {
          const srcDir = join(dataRoot, dir);
          const destDir = join(tmpDir, dir);
          if (existsSync(srcDir)) {
            copyDir(srcDir, destDir);
          }
        }

        // Step 3: Create tar.gz using tar -czf through Bun.spawn with argv array
        const tarArgs: string[] = [
          "-czf", archivePath,
          "manifest.json", "remotecode.sqlite",
        ];
        for (const dir of ["workspaces", "bots"]) {
          if (existsSync(join(tmpDir, dir))) {
            tarArgs.push(dir);
          }
        }

        const tarResult = Bun.spawnSync(["tar", ...tarArgs], { cwd: tmpDir });
        if (tarResult.exitCode !== 0) {
          throw new Error("tar failed");
        }

        // Compute archive sha256
        const archiveBytes = readFileSync(archivePath);
        const archiveSha256 = sha256Bytes(archiveBytes);

        // Clean up temp dir
        rmSync(tmpDir, { recursive: true, force: true });

        set.status = 201;
        return {
          id: archivePath,
          path: archivePath,
          bytes: archiveBytes.length,
          sha256: archiveSha256,
          manifest,
        };
      } catch {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { rmSync(archivePath, { force: true }); } catch { /* ignore */ }
        set.status = 503;
        return { error: "backup_unavailable" as const };
      }
    })
    .post("/api/restore", async ({ body, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }

      const { archivePath } = body as { archivePath: string };

      // Step 1: Validate archivePath is absolute and inside root
      if (typeof archivePath !== "string" || !archivePath.startsWith("/")) {
        set.status = 400;
        return { error: "invalid_backup_path" as const };
      }
      const resolved = resolve(archivePath);
      const resolvedRoot = resolve(root);
      if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
        set.status = 400;
        return { error: "invalid_backup_path" as const };
      }

      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        set.status = 400;
        return { error: "invalid_backup" as const };
      }

      // Step 2: Extract into a fresh temp directory
      const extractDir = join(tmpdir(), `rc-restore-${crypto.randomUUID()}`);
      try {
        mkdirSync(extractDir, { recursive: true });
        const tarResult = Bun.spawnSync(["tar", "-xzf", resolved], { cwd: extractDir });
        if (tarResult.exitCode !== 0) {
          set.status = 400;
          return { error: "invalid_backup" as const };
        }

        // Step 3: Require manifest.json with schemaVersion === 1, databaseSha256 string, members array
        const manifestPath = join(extractDir, "manifest.json");
        let manifest: unknown;
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8") ?? "");
        } catch {
          set.status = 400;
          return { error: "invalid_backup" as const };
        }

        if (
          typeof manifest !== "object" || manifest === null ||
          (manifest as { schemaVersion?: unknown }).schemaVersion !== 1 ||
          typeof (manifest as { databaseSha256?: unknown }).databaseSha256 !== "string" ||
          !Array.isArray((manifest as { members?: unknown }).members)
        ) {
          set.status = 400;
          return { error: "invalid_backup" as const };
        }

        const m = manifest as {
          schemaVersion: number;
          createdAt: string;
          databaseSha256: string;
          counts: { workspaces: number; bots: number; runs: number; schedules: number; history: number };
          members: { path: string; sha256: string }[];
        };

        // Step 4: Verify EVERY member's sha256 and that no extra files exist
        const manifestPaths = new Set(m.members.map((member: { path: string }) => member.path));
        const extractedFiles = new Set<string>();

        function collectExtracted(dir: string, prefix: string): void {
          if (!existsSync(dir)) return;
          for (const entry of readdirSync(dir).sort()) {
            const fullPath = join(dir, entry);
            const relPath = prefix ? `${prefix}/${entry}` : entry;
            if (statSync(fullPath).isDirectory()) {
              collectExtracted(fullPath, relPath);
            } else {
              extractedFiles.add(relPath);
            }
          }
        }
        collectExtracted(extractDir, "");

        // Check for missing members
        for (const member of m.members) {
          const memberPath = join(extractDir, member.path);
          if (!existsSync(memberPath) || !statSync(memberPath).isFile()) {
            set.status = 400;
            return { error: "backup_corrupt" as const };
          }
          const actualSha256 = sha256File(memberPath);
          if (actualSha256 !== member.sha256) {
            set.status = 400;
            return { error: "backup_corrupt" as const };
          }
        }

        // The manifest describes the archive and therefore cannot hash itself.
        extractedFiles.delete("manifest.json");

        // Check for extra files not in manifest
        for (const file of extractedFiles) {
          if (!manifestPaths.has(file)) {
            set.status = 400;
            return { error: "backup_corrupt" as const };
          }
        }

        // Verify database sha256
        const dbPath = join(extractDir, "remotecode.sqlite");
        if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
          set.status = 400;
          return { error: "backup_corrupt" as const };
        }
        const extractedDbSha256 = sha256File(dbPath);
        if (extractedDbSha256 !== m.databaseSha256) {
          set.status = 400;
          return { error: "backup_corrupt" as const };
        }

        // Step 5: Verify database integrity
        const extractedDb = openDatabase(dbPath, true);
        try {
          const integrityResult = extractedDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
          if (integrityResult.length !== 1 || integrityResult[0]?.integrity_check !== "ok") {
            set.status = 400;
            return { error: "backup_corrupt" as const };
          }
          const quickCheckResult = extractedDb.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
          if (quickCheckResult.length !== 1 || quickCheckResult[0]?.quick_check !== "ok") {
            set.status = 400;
            return { error: "backup_corrupt" as const };
          }
        } finally {
          extractedDb.close();
        }

        // Step 6: Replace live state
        const workspacesDir = join(dataRoot, "workspaces");
        const botsDir = join(dataRoot, "bots");
        // The extracted copy lives on a different filesystem from the volume,
        // so anything moved must be copied; the aside copies stay inside the
        // volume so they can be renamed cheaply and removed afterwards.
        const swapTag = crypto.randomUUID();
        const workspacesBackup = join(dataRoot, `.rc-restore-ws-${swapTag}`);
        const botsBackup = join(dataRoot, `.rc-restore-bots-${swapTag}`);
        const liveDbBackup = join(dataRoot, `.rc-restore-db-${swapTag}.sqlite`);

        try {
          // Move current database aside
          if (existsSync(databasePath)) {
            renameSync(databasePath, liveDbBackup);
          }

          // Copy the extracted database into place (cross-filesystem).
          copyFileSync(dbPath, databasePath);

          // Replace workspaces/
          if (existsSync(workspacesDir)) {
            renameSync(workspacesDir, workspacesBackup);
          }
          if (existsSync(join(extractDir, "workspaces"))) {
            cpSync(join(extractDir, "workspaces"), workspacesDir, { recursive: true });
            chmodSync(workspacesDir, 0o700);
            // A copy does not carry the ownership and modes the workspace
            // folder guard checks, so re-stamp every restored leaf: the folder
            // 0700 and its marker 0600, both owned by this process.
            for (const entry of readdirSync(workspacesDir)) {
              const leaf = join(workspacesDir, entry);
              if (!statSync(leaf).isDirectory()) continue;
              chmodSync(leaf, 0o700);
              const marker = join(leaf, ".remotecode-workspace");
              if (existsSync(marker)) chmodSync(marker, 0o600);
            }
          }

          // Replace bots/
          if (existsSync(botsDir)) {
            renameSync(botsDir, botsBackup);
          }
          if (existsSync(join(extractDir, "bots"))) {
            cpSync(join(extractDir, "bots"), botsDir, { recursive: true });
          }

          // Delete live directories only after extracted ones are in place
          if (existsSync(workspacesBackup)) {
            rmSync(workspacesBackup, { recursive: true, force: true });
          }
          if (existsSync(botsBackup)) {
            rmSync(botsBackup, { recursive: true, force: true });
          }
          if (existsSync(liveDbBackup)) {
            rmSync(liveDbBackup, { force: true });
          }

          // Delete every row from sessions in the restored database, and re-stamp the
          // workspace folder identity: a device/inode pair is not portable, so
          // the guard would refuse every restored workspace without this.
          const restoredDb = openDatabase(databasePath, false);
          try {
            restoredDb.exec("DELETE FROM sessions");
            const folders = restoredDb.query<{ workspace_id: string }, []>(
              "SELECT workspace_id FROM workspace_folder_requests WHERE state = 'provisioned'",
            ).all();
            const updateFloor = restoredDb.query(
              "UPDATE workspace_folder_requests SET folder_device = ?, folder_inode = ? WHERE workspace_id = ?",
            );
            for (const folder of folders) {
              const leaf = join(workspacesDir, folder.workspace_id);
              if (!existsSync(leaf)) continue;
              const info = statSync(leaf);
              updateFloor.run(String(info.dev), String(info.ino), folder.workspace_id);
            }
          } finally {
            restoredDb.close();
          }

          // Count restored files and profile directories
          let restoredFiles = 0;
          let profiles = 0;
          for (const member of m.members) {
            if (member.path.startsWith("workspaces/") || member.path.startsWith("bots/")) {
              restoredFiles++;
            }
            if (member.path.startsWith("bots/")) {
              const memberFullPath = join(dataRoot, "bots", member.path.slice("bots/".length));
              if (existsSync(memberFullPath) && statSync(memberFullPath).isDirectory()) {
                profiles++;
              }
            }
          }

          set.status = 200;
          return {
            restored: {
              database: true,
              files: restoredFiles,
              profiles,
              sessionsInvalidated: true,
            },
            counts: m.counts,
            requiresNewLogin: true,
          };
        } catch {
          // Rollback: try to restore from backups
          try {
            if (existsSync(liveDbBackup) && !existsSync(databasePath)) {
              renameSync(liveDbBackup, databasePath);
            }
          } catch { /* ignore */ }
          try {
            if (existsSync(workspacesBackup) && !existsSync(workspacesDir)) {
              renameSync(workspacesBackup, workspacesDir);
            }
          } catch { /* ignore */ }
          try {
            if (existsSync(botsBackup) && !existsSync(botsDir)) {
              renameSync(botsBackup, botsDir);
            }
          } catch { /* ignore */ }
          set.status = 503;
          return { error: "backup_unavailable" as const };
        } finally {
          try { rmSync(liveDbBackup, { force: true }); } catch { /* ignore */ }
          try { rmSync(workspacesBackup, { recursive: true, force: true }); } catch { /* ignore */ }
          try { rmSync(botsBackup, { recursive: true, force: true }); } catch { /* ignore */ }
          try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      } catch {
        try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
        set.status = 503;
        return { error: "backup_unavailable" as const };
      }
    }, {
      body: t.Object({
        archivePath: t.String(),
      }),
    });
}
