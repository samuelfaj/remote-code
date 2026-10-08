import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };

function openDatabase(path: string, readonly: boolean) {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !readonly, readonly });
}

export function billingFeature(databasePath: string, options: { webhookSecret?: string; retentionDays?: number } = {}) {
  const webhookSecret = options.webhookSecret ?? process.env.REMOTECODE_BILLING_WEBHOOK_SECRET ?? "";
  const retentionDays = options.retentionDays ?? Number(process.env.REMOTECODE_BILLING_RETENTION_DAYS ?? 30);

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

  function initializeSchema(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS billing_events (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload_sha256 TEXT NOT NULL,
      applied INTEGER NOT NULL,
      reason TEXT,
      received_at TEXT NOT NULL,
      applied_at TEXT,
      user_id TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id)");
    db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      plan TEXT,
      hosted_account_id TEXT,
      last_event_sequence INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 30,
      data_purge_after TEXT,
      updated_at TEXT NOT NULL
    )`);
  }

  try {
    db((database) => { initializeSchema(database); });
  } catch {
    // Storage unavailable; readiness reports it and every route fails closed.
  }

  function verifySignature(body: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = createHmac("sha256", webhookSecret).update(body).digest("hex");
    return expected === signature;
  }

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_request" as const };
      }
    })
    .post("/api/billing/webhook", async ({ request, set }) => {
      const rawBody = await request.text();
      const signature = request.headers.get("x-rc-signature");
      if (!verifySignature(rawBody, signature)) {
        set.status = 401;
        return { error: "signature_invalid" as const };
      }

      let payload: {
        eventId: string;
        kind: string;
        sequence: number;
        userId: string;
        plan?: string;
        hostedAccountId?: string;
        occurredAt: string;
      };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        set.status = 422;
        return { error: "malformed_payload" as const };
      }

      const validKinds = ["checkout.completed", "subscription.canceled", "payment.failed"];
      if (
        typeof payload.eventId !== "string" || !payload.eventId ||
        !validKinds.includes(payload.kind) ||
        typeof payload.sequence !== "number" || !Number.isInteger(payload.sequence) ||
        typeof payload.userId !== "string" || !payload.userId ||
        typeof payload.occurredAt !== "string" || !payload.occurredAt
      ) {
        set.status = 422;
        return { error: "malformed_payload" as const };
      }

      const userId = payload.userId;
      const eventId = payload.eventId;
      const kind = payload.kind;
      const sequence = payload.sequence;
      const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
      const receivedAt = new Date().toISOString();

      return db((database) => {
        database.exec("BEGIN");
        try {
          const existing = database.query<{ event_id: string }, [string]>
            ("SELECT event_id FROM billing_events WHERE event_id = ?").get(eventId);
          if (existing) {
            database.exec("COMMIT");
            return { applied: false, reason: "duplicate" as const };
          }

          const subscription = database.query<
            { user_id: string; state: string; last_event_sequence: number; retention_days: number },
            [string]
          >("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);

          if (subscription && sequence <= subscription.last_event_sequence) {
            database.query(
              "INSERT INTO billing_events (event_id, kind, sequence, payload_sha256, applied, reason, received_at, applied_at, user_id) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)",
            ).run(eventId, kind, sequence, payloadSha256, "out_of_order", receivedAt, userId);
            database.exec("COMMIT");
            return { applied: false, reason: "out_of_order" as const };
          }

          let applied = false;
          let reason = "applied" as const;
          let appliedAt: string | null = null;

          if (kind === "checkout.completed") {
            database.query(
              "INSERT INTO subscriptions (user_id, state, plan, hosted_account_id, last_event_sequence, retention_days, data_purge_after, updated_at) VALUES (?, 'active', ?, ?, ?, ?, NULL, ?) ON CONFLICT(user_id) DO UPDATE SET state = 'active', plan = excluded.plan, hosted_account_id = excluded.hosted_account_id, data_purge_after = NULL, last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
            ).run(userId, payload.plan ?? null, payload.hostedAccountId ?? null, sequence, retentionDays, receivedAt);
            applied = true;
            appliedAt = receivedAt;
          } else if (kind === "payment.failed") {
            if (subscription) {
              database.query(
                "UPDATE subscriptions SET state = 'past_due', last_event_sequence = ?, updated_at = ? WHERE user_id = ?",
              ).run(sequence, receivedAt, userId);
            } else {
              database.query(
                "INSERT INTO subscriptions (user_id, state, plan, hosted_account_id, last_event_sequence, retention_days, data_purge_after, updated_at) VALUES (?, 'past_due', NULL, NULL, ?, ?, NULL, ?)",
              ).run(userId, sequence, retentionDays, receivedAt);
            }
            applied = true;
            appliedAt = receivedAt;
          } else if (kind === "subscription.canceled") {
            const purgeAfter = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
            if (subscription) {
              database.query(
                "UPDATE subscriptions SET state = 'canceled', last_event_sequence = ?, data_purge_after = ?, updated_at = ? WHERE user_id = ?",
              ).run(sequence, purgeAfter, receivedAt, userId);
            } else {
              database.query(
                "INSERT INTO subscriptions (user_id, state, plan, hosted_account_id, last_event_sequence, retention_days, data_purge_after, updated_at) VALUES (?, 'canceled', NULL, NULL, ?, ?, ?, ?)",
              ).run(userId, sequence, retentionDays, purgeAfter, receivedAt);
            }
            applied = true;
            appliedAt = receivedAt;
          }

          database.query(
            "INSERT INTO billing_events (event_id, kind, sequence, payload_sha256, applied, reason, received_at, applied_at, user_id) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?)",
          ).run(eventId, kind, sequence, payloadSha256, receivedAt, appliedAt, userId);

          database.exec("COMMIT");

          const subRow = database.query<
            { user_id: string; state: string; plan: string | null; hosted_account_id: string | null; last_event_sequence: number; retention_days: number; data_purge_after: string | null; updated_at: string },
            [string]
          >("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);

          return {
            applied: true,
            reason,
            subscription: subRow ? {
              state: subRow.state,
              plan: subRow.plan,
              hostedAccountId: subRow.hosted_account_id,
              lastEventSequence: subRow.last_event_sequence,
              retentionDays: subRow.retention_days,
              dataPurgeAfter: subRow.data_purge_after,
              updatedAt: subRow.updated_at,
            } : null,
          };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
    })
    .get("/api/billing/receipt/:eventId", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      const eventId = params.eventId;

      return db((database) => {
        const event = database.query<
          { event_id: string; kind: string; sequence: number; applied: number; reason: string | null; received_at: string; applied_at: string | null; user_id: string },
          [string]
        >("SELECT * FROM billing_events WHERE event_id = ?").get(eventId);

        if (event && event.user_id !== userId) {
          return { eventId, found: false, applied: false, reason: null as string | null, receivedAt: null as string | null, appliedAt: null as string | null };
        }

        const subscription = database.query<{ user_id: string }, [string]>
          ("SELECT user_id FROM subscriptions WHERE user_id = ?").get(userId);

        if (!event && !subscription) {
          set.status = 404;
          return { error: "not_found" as const };
        }

        if (!event) {
          return { eventId, found: false, applied: false, reason: null as string | null, receivedAt: null as string | null, appliedAt: null as string | null };
        }

        return {
          eventId,
          found: true,
          applied: event.applied === 1,
          reason: event.reason,
          receivedAt: event.received_at,
          appliedAt: event.applied_at,
        };
      });
    })
    .get("/api/billing/subscription", ({ request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      return db((database) => {
        const row = database.query<
          { user_id: string; state: string; plan: string | null; hosted_account_id: string | null; last_event_sequence: number; retention_days: number; data_purge_after: string | null; updated_at: string },
          [string]
        >("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);

        if (!row) {
          return { state: "inactive" as const };
        }

        return {
          state: row.state,
          plan: row.plan,
          hostedAccountId: row.hosted_account_id,
          lastEventSequence: row.last_event_sequence,
          retentionDays: row.retention_days,
          dataPurgeAfter: row.data_purge_after,
          updatedAt: row.updated_at,
        };
      });
    });
}