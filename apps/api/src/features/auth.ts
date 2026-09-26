import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";

const sessionCookie = "remotecode_session";

type AuthConfig = {
  password?: string;
  sessionTtlMs?: number;
};

type Session = { userId: string; expiresAt: number };

function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: true });
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function usesHttps(request: Request) {
  return new URL(request.url).protocol === "https:";
}

function isLoopbackPeer(address: string | undefined) {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function sessionToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const pair of cookie.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === sessionCookie) {
      const token = value.join("=");
      return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
    }
  }
  return undefined;
}

function readSession(database: Database, token: string | undefined): Session | undefined {
  if (!token) return undefined;
  const row = database.query<{ userId: string; expiresAt: number }, [string]>(
    "SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?",
  ).get(tokenHash(token));
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    database.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    return undefined;
  }
  return { userId: row.userId, expiresAt: row.expiresAt };
}

export function sessionExpiresAt(databasePath: string, request: Request) {
  let database: Database | undefined;
  try {
    database = openDatabase(databasePath);
    return readSession(database, sessionToken(request))?.expiresAt;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export function isAuthenticated(databasePath: string, request: Request) {
  return sessionExpiresAt(databasePath, request) !== undefined;
}

export function authFeature(
  databasePath: string,
  config: AuthConfig = {},
  revokeSessions: () => void = () => {},
) {
  let database: Database | undefined;
  try {
    database = openDatabase(databasePath);
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  } catch {
    // Liveness remains available; auth requests fail closed if storage is unavailable.
  } finally {
    database?.close();
  }

  const ttl = config.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  return new Elysia()
    .post(
      "/api/auth/login",
      ({ body, set, request, server }) => {
        if (!usesHttps(request) && !isLoopbackPeer(server?.requestIP(request)?.address)) {
          set.status = 403;
          return { error: "https_required" as const };
        }
        if (!config.password || config.password.length < 16) {
          set.status = 503;
          return { error: "host_auth_not_configured" as const };
        }
        const actual = createHash("sha256").update(body.password).digest();
        const expected = createHash("sha256").update(config.password).digest();
        if (!timingSafeEqual(actual, expected)) {
          set.status = 401;
          return { error: "unauthorized" as const };
        }
        if (!Number.isFinite(ttl) || ttl < 1000) {
          set.status = 503;
          return { error: "invalid_session_lifetime" as const };
        }

        const token = randomBytes(32).toString("hex");
        const expiresAt = Date.now() + ttl;
        const connection = openDatabase(databasePath);
        try {
          connection.query(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
          ).run(tokenHash(token), "local", expiresAt);
        } finally {
          connection.close();
        }
        const secure = usesHttps(request) ? "; Secure" : "";
        set.headers["set-cookie"] = `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${secure}`;
        return { userId: "local", expiresAt: new Date(expiresAt).toISOString() };
      },
      { body: t.Object({ password: t.String({ minLength: 1, maxLength: 1024 }) }) },
    )
    .get("/api/auth/session", ({ request, set }) => {
      const connection = openDatabase(databasePath);
      try {
        const session = readSession(connection, sessionToken(request));
        if (!session) {
          set.status = 401;
          return { error: "unauthorized" as const };
        }
        return { userId: session.userId };
      } finally {
        connection.close();
      }
    })
    .post("/api/auth/logout", ({ request, set }) => {
      const token = sessionToken(request);
      if (token) {
        const connection = openDatabase(databasePath);
        let validSession = false;
        try {
          validSession = readSession(connection, token) !== undefined;
          if (validSession) connection.query("DELETE FROM sessions WHERE user_id = ?").run("local");
        } finally {
          connection.close();
        }
        if (validSession) revokeSessions();
      }
      set.status = 204;
      const secure = usesHttps(request) ? "; Secure" : "";
      set.headers["set-cookie"] = `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
    });
}
