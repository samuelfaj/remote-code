import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { dirname } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

export function capacityAllows(db: Database): { allowed: boolean; reason: string | null } {
  const maxAccounts = Number(process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS ?? 8);
  const reservedHeadroomBytes = Number(process.env.REMOTECODE_HOSTED_RESERVED_HEADROOM_BYTES ?? 2_147_483_648);

  const accountsProvisioned = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM hosted_accounts WHERE state IN ('ready', 'provisioning', 'suspended')",
  ).get()?.count ?? 0;

  if (accountsProvisioned >= maxAccounts) {
    return { allowed: false, reason: "account_limit" };
  }

  const dataRoot = process.env.REMOTECODE_DATA_ROOT ?? "/var/lib/remotecode";
  const freeDisk = getFreeDiskBytes(dataRoot);
  if (freeDisk !== null && freeDisk <= reservedHeadroomBytes) {
    return { allowed: false, reason: "disk_pressure" };
  }

  const freeMemory = getFreeMemoryBytes();
  if (freeMemory !== null && freeMemory <= reservedHeadroomBytes) {
    return { allowed: false, reason: "memory_pressure" };
  }

  return { allowed: true, reason: null };
}

function getFreeDiskBytes(dirPath: string): number | null {
  try {
    const proc = Bun.spawnSync(["df", "-k", dirPath]);
    if (proc.exitCode !== 0) return null;
    const output = proc.stdout.toString().trim();
    const lines = output.split("\n");
    if (lines.length < 2) return null;
    const lastLine = lines[lines.length - 1];
    const fields = lastLine.trim().split(/\s+/);
    if (fields.length < 4) return null;
    const availKiB = Number(fields[3]);
    if (Number.isNaN(availKiB)) return null;
    return availKiB * 1024;
  } catch {
    return null;
  }
}

function getFreeMemoryBytes(): number | null {
  try {
    const content = readFileSync("/proc/meminfo", "utf-8");
    const match = content.match(/^MemAvailable:\s+(\d+)\s+kB/);
    if (!match) return null;
    return Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

export function capacityFeature(
  databasePath: string,
  options: {
    maxAccounts?: number;
    cpuCores?: number;
    memoryBytes?: number;
    diskBytes?: number;
    reservedHeadroomBytes?: number;
    dataRoot?: string;
  } = {},
) {
  const maxAccounts = options.maxAccounts ?? Number(process.env.REMOTECODE_HOSTED_MAX_ACCOUNTS ?? 8);
  const cpuCores = options.cpuCores ?? Number(process.env.REMOTECODE_HOSTED_CPU_CORES ?? 2);
  const memoryBytes = options.memoryBytes ?? Number(process.env.REMOTECODE_HOSTED_MEMORY_BYTES ?? 4_294_967_296);
  const diskBytes = options.diskBytes ?? Number(process.env.REMOTECODE_HOSTED_DISK_BYTES ?? 21_474_836_480);
  const reservedHeadroomBytes = options.reservedHeadroomBytes ?? Number(process.env.REMOTECODE_HOSTED_RESERVED_HEADROOM_BYTES ?? 2_147_483_648);
  const dataRoot = options.dataRoot ?? process.env.REMOTECODE_DATA_ROOT ?? "/var/lib/remotecode";

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

  function resolveOwner(request: Request): { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string } {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return { kind: "anonymous" };
    const database = new Database(databasePath, { readonly: true, create: false });
    try {
      const live = database.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(userId, tokenHash);
      if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return { kind: "anonymous" };
      return { kind: "ok", userId };
    } catch {
      return { kind: "unavailable" };
    } finally {
      database.close();
    }
  }

  return new Elysia()
    .get("/api/hosted/capacity", ({ request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }

      let accountsProvisioned = 0;
      try {
        accountsProvisioned = db((database) =>
          database.query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM hosted_accounts WHERE state IN ('ready', 'provisioning', 'suspended')",
          ).get()?.count ?? 0,
        );
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }

      let freeDiskBytes: number | null = null;
      try {
        freeDiskBytes = getFreeDiskBytes(dataRoot);
      } catch {
        freeDiskBytes = null;
      }

      let freeMemoryBytes: number | null = null;
      try {
        freeMemoryBytes = getFreeMemoryBytes();
      } catch {
        freeMemoryBytes = null;
      }

      const { allowed, reason } = db((database) => capacityAllows(database));

      return {
        acceptingNewAccounts: allowed,
        reason,
        maxAccounts,
        accountsProvisioned,
        perAccount: { cpuCores, memoryBytes, diskBytes },
        reservedHeadroomBytes,
        host: { freeDiskBytes, freeMemoryBytes },
      };
    });
}
