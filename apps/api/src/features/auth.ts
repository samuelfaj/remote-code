import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { authReceipt, initializeAuthRequests, insertAuthRequest, readAuthRequest, type AuthReceipt } from "./auth-requests";

const sessionCookie = "remotecode_session";

type AuthConfig = {
  password?: string;
  sessionTtlMs?: number;
};

type Session = { userId: string; expiresAt: number };

function openDatabase(path: string, readonly = false) {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !readonly, readonly });
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

export function sessionTokenHash(request: Request) {
  const token = sessionToken(request);
  return token ? tokenHash(token) : undefined;
}

function readSession(database: Database, token: string | undefined, cleanupExpired = true): Session | undefined {
  if (!token) return undefined;
  const row = database.query<{ userId: string; expiresAt: number }, [string]>(
    "SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?",
  ).get(tokenHash(token));
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    if (cleanupExpired) database.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    return undefined;
  }
  return { userId: row.userId, expiresAt: row.expiresAt };
}

export function sessionExpiresAt(databasePath: string, request: Request) {
  let database: Database | undefined;
  try {
    database = openDatabase(databasePath, true);
    return readSession(database, sessionToken(request), false)?.expiresAt;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export function sessionUserId(databasePath: string, request: Request) {
  let database: Database | undefined;
  try {
    database = openDatabase(databasePath, true);
    return readSession(database, sessionToken(request), false)?.userId;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export function isAuthenticated(databasePath: string, request: Request) {
  return sessionUserId(databasePath, request) !== undefined;
}

export function authFeature(
  databasePath: string,
  config: AuthConfig = {},
  revokeSessions: (userId: string, sessionHash?: string) => void = () => {},
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
    initializeAuthRequests(database);
  } catch {
    // Liveness remains available; auth requests fail closed if storage is unavailable.
  } finally {
    database?.close();
  }

  function credentialError(request: Request, peer: string | undefined, password: string) {
    if (!usesHttps(request) && !isLoopbackPeer(peer)) return { status: 403 as const, error: "https_required" as const };
    if (!config.password || config.password.length < 16) return { status: 503 as const, error: "host_auth_not_configured" as const };
    const actual = createHash("sha256").update(password).digest();
    const expected = createHash("sha256").update(config.password).digest();
    if (!timingSafeEqual(actual, expected)) return { status: 401 as const, error: "unauthorized" as const };
    return null;
  }

  const passwordSchema = t.String({ minLength: 1, maxLength: 1024 });
  const requestIdSchema = t.Transform(t.String({ format: "uuid", minLength: 36, maxLength: 36 }))
    .Decode((value) => value.toLowerCase())
    .Encode((value) => value.toLowerCase());
  const ttl = config.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  return new Elysia()
    .onBeforeHandle(({ set }) => { set.headers["cache-control"] = "no-store"; })
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 422;
        return { error: "invalid_auth_request" as const };
      }
    })
    .post(
      "/api/auth/login",
      ({ body, set, request, server }) => {
        const rejected = credentialError(request, server?.requestIP(request)?.address, body.password);
        if (rejected) {
          set.status = rejected.status;
          return { error: rejected.error };
        }
        if (!Number.isFinite(ttl) || ttl < 1000) {
          set.status = 503;
          return { error: "invalid_session_lifetime" as const };
        }
        const connection = openDatabase(databasePath);
        const result = (() => {
          try {
            return connection.transaction(() => {
              if (body.requestId) {
                const previous = readAuthRequest(connection, "local", body.requestId);
                if (previous) return { receipt: authReceipt(previous), token: undefined, expiresAt: previous.expiresAt };
              }
              const token = randomBytes(32).toString("hex");
              const now = Date.now();
              const expiresAt = new Date(now + ttl).toISOString();
              connection.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
                .run(tokenHash(token), "local", now + ttl);
              let receipt: AuthReceipt | undefined;
              if (body.requestId) {
                receipt = {
                  requestId: body.requestId, kind: "login", targetRequestId: null,
                  outcome: "session_created", createdAt: new Date(now).toISOString(), expiresAt,
                };
                insertAuthRequest(connection, "local", receipt, tokenHash(token));
              }
              return { receipt, token, expiresAt };
            }).immediate();
          } finally { connection.close(); }
        })();
        if (result.receipt && result.receipt.kind !== "login") {
          set.status = 409;
          return { error: "request_id_conflict" as const };
        }
        if (result.receipt?.outcome === "closed_before_acceptance") {
          set.status = 409;
          return { error: "login_request_closed" as const, receipt: result.receipt };
        }
        if (result.token) {
          const secure = usesHttps(request) ? "; Secure" : "";
          set.headers["set-cookie"] = `${sessionCookie}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${secure}`;
        }
        return result.receipt
          ? { userId: "local", expiresAt: result.expiresAt, receipt: result.receipt }
          : { userId: "local", expiresAt: result.expiresAt };
      },
      { body: t.Object({ password: passwordSchema, requestId: t.Optional(requestIdSchema) }) },
    )
    .get("/api/auth/session", ({ request, set }) => {
      const connection = openDatabase(databasePath);
      try {
        const session = readSession(connection, sessionToken(request));
        if (!session) {
          set.status = 401;
          return { error: "unauthorized" as const };
        }
        const login = connection.query<{ requestId: string }, [string, string]>(
          "SELECT request_id AS requestId FROM auth_requests WHERE user_id = ? AND session_token_hash = ? AND kind = 'login'",
        ).get(session.userId, sessionTokenHash(request)!);
        return login ? { userId: session.userId, loginRequestId: login.requestId } : { userId: session.userId };
      } finally { connection.close(); }
    })
    .post("/api/auth/receipts/:requestId/lookup", ({ params, body, request, server, set }) => {
      let userId: string | undefined;
      if (body?.password !== undefined) {
        const rejected = credentialError(request, server?.requestIP(request)?.address, body.password);
        if (rejected) {
          set.status = rejected.status;
          return { error: rejected.error };
        }
        userId = "local";
      } else userId = sessionUserId(databasePath, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const connection = openDatabase(databasePath);
      try {
        const record = readAuthRequest(connection, userId, params.requestId);
        if (!record) {
          set.status = 404;
          return { error: "receipt_not_found" as const };
        }
        const active = record.sessionTokenHash && connection.query<{ active: number }, [string, string, number]>(
          "SELECT 1 AS active FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?",
        ).get(record.sessionTokenHash, userId, Date.now());
        const sessionStatus = record.kind === "login" ? (active ? "active" as const : "inactive" as const) : "not_applicable" as const;
        return { receipt: authReceipt(record), sessionStatus };
      } finally { connection.close(); }
    }, { params: t.Object({ requestId: requestIdSchema }), body: t.Optional(t.Object({ password: t.Optional(passwordSchema) })) })
    .post("/api/auth/login/:loginRequestId/revoke", ({ params, body, request, server, set }) => {
      const rejected = credentialError(request, server?.requestIP(request)?.address, body.password);
      if (rejected) {
        set.status = rejected.status;
        return { error: rejected.error };
      }
      if (body.requestId === params.loginRequestId) {
        set.status = 409;
        return { error: "request_id_conflict" as const };
      }
      const connection = openDatabase(databasePath);
      const result = (() => {
        try {
          return connection.transaction(() => {
            const previous = readAuthRequest(connection, "local", body.requestId);
            if (previous) return { receipt: authReceipt(previous), sessionHash: null };
            const target = readAuthRequest(connection, "local", params.loginRequestId);
            if (target && target.kind !== "login") return null;
            const createdAt = new Date().toISOString();
            if (!target) {
              const fence: AuthReceipt = {
                requestId: params.loginRequestId, kind: "login", targetRequestId: null,
                outcome: "closed_before_acceptance", createdAt, expiresAt: null,
              };
              insertAuthRequest(connection, "local", fence);
            } else if (target.sessionTokenHash) {
              connection.query("DELETE FROM sessions WHERE user_id = ? AND token_hash = ?").run("local", target.sessionTokenHash);
            }
            const receipt: AuthReceipt = {
              requestId: body.requestId, kind: "revoke_login", targetRequestId: params.loginRequestId,
              outcome: "login_revoked", createdAt, expiresAt: null,
            };
            insertAuthRequest(connection, "local", receipt);
            return { receipt, sessionHash: target?.sessionTokenHash ?? null };
          }).immediate();
        } finally { connection.close(); }
      })();
      if (!result || result.receipt.kind !== "revoke_login" || result.receipt.targetRequestId !== params.loginRequestId) {
        set.status = 409;
        return { error: "request_id_conflict" as const };
      }
      if (result.sessionHash) revokeSessions("local", result.sessionHash);
      return result.receipt;
    }, { params: t.Object({ loginRequestId: requestIdSchema }), body: t.Object({ password: passwordSchema, requestId: requestIdSchema }) })
    .post("/api/auth/logout", ({ body, request, set }) => {
      const requestId = body?.requestId;
      const token = sessionToken(request);
      const connection = token ? openDatabase(databasePath) : undefined;
      const result = (() => {
        if (!connection) return null;
        try {
          return connection.transaction(() => {
            const userId = readSession(connection, token)?.userId;
            if (!userId) return null;
            if (requestId) {
              const previous = readAuthRequest(connection, userId, requestId);
              if (previous) return { userId, changed: false, receipt: authReceipt(previous) };
            }
            let receipt: AuthReceipt | undefined;
            if (requestId) {
              receipt = { requestId, kind: "logout", targetRequestId: null, outcome: "sessions_revoked", createdAt: new Date().toISOString(), expiresAt: null };
              insertAuthRequest(connection, userId, receipt);
            }
            connection.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
            return { userId, changed: true, receipt };
          }).immediate();
        } finally { connection.close(); }
      })();
      if (requestId && !result) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      if (result?.receipt && result.receipt.kind !== "logout") {
        set.status = 409;
        return { error: "request_id_conflict" as const };
      }
      if (result?.changed) revokeSessions(result.userId);
      if (result?.changed || !requestId) {
        const secure = usesHttps(request) ? "; Secure" : "";
        set.headers["set-cookie"] = `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
      }
      if (result?.receipt) return result.receipt;
      set.status = 204;
    }, { body: t.Optional(t.Object({ requestId: t.Optional(requestIdSchema) })) });
}
