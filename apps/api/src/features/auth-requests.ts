import type { Database } from "bun:sqlite";

export type AuthReceipt = {
  requestId: string;
  kind: "login" | "logout" | "revoke_login";
  targetRequestId: string | null;
  outcome: "session_created" | "sessions_revoked" | "login_revoked" | "closed_before_acceptance";
  createdAt: string;
  expiresAt: string | null;
};
export type AuthRequestRecord = AuthReceipt & { sessionTokenHash: string | null };

export function initializeAuthRequests(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_requests (
      user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('login', 'logout', 'revoke_login')),
      target_request_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('session_created', 'sessions_revoked', 'login_revoked', 'closed_before_acceptance')),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      session_token_hash TEXT,
      PRIMARY KEY (user_id, request_id)
    )
  `);
}

export function readAuthRequest(database: Database, userId: string, requestId: string) {
  return database.query<AuthRequestRecord, [string, string]>(`
    SELECT request_id AS requestId, kind, target_request_id AS targetRequestId,
      outcome, created_at AS createdAt, expires_at AS expiresAt, session_token_hash AS sessionTokenHash
    FROM auth_requests WHERE user_id = ? AND request_id = ?
  `).get(userId, requestId);
}

export function authReceipt(record: AuthRequestRecord): AuthReceipt {
  return {
    requestId: record.requestId, kind: record.kind, targetRequestId: record.targetRequestId,
    outcome: record.outcome, createdAt: record.createdAt, expiresAt: record.expiresAt,
  };
}

export function insertAuthRequest(database: Database, userId: string, receipt: AuthReceipt, sessionTokenHash: string | null = null) {
  database.query(`
    INSERT INTO auth_requests (user_id, request_id, kind, target_request_id, outcome, created_at, expires_at, session_token_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, receipt.requestId, receipt.kind, receipt.targetRequestId, receipt.outcome, receipt.createdAt, receipt.expiresAt, sessionTokenHash);
}
