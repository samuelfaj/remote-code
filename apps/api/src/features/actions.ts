import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { isAuthenticated, sessionExpiresAt } from "./auth";

type ActionReceipt = {
  id: string;
  action: string;
  createdAt: string;
};

type CursorAction = ActionReceipt & { cursor: number };

type EventsClient = {
  data: { request: Request };
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

function readActions(database: Database): CursorAction[] {
  const rows = database.query<unknown, []>(
    "SELECT sequence AS cursor, id, action, created_at AS createdAt FROM actions ORDER BY sequence DESC",
  ).all();
  return rows.map((row) => {
    if (
      typeof row !== "object" || row === null ||
      !("cursor" in row) || typeof row.cursor !== "number" ||
      !("id" in row) || typeof row.id !== "string" ||
      !("action" in row) || typeof row.action !== "string" ||
      !("createdAt" in row) || typeof row.createdAt !== "string"
    ) {
      throw new Error("Stored action receipt is invalid");
    }
    return { cursor: row.cursor, id: row.id, action: row.action, createdAt: row.createdAt };
  });
}

function sendSnapshot(databasePath: string, client: EventsClient) {
  let database: Database | undefined;
  try {
    database = openDatabase(databasePath);
    const actions = readActions(database);
    const cursor = actions[0]?.cursor ?? 0;
    const payload = JSON.stringify({
      type: "snapshot",
      cursor,
      actions: actions.map(({ cursor: _cursor, ...receipt }) => receipt),
    });
    client.send(payload);
  } catch {
    try {
      client.close(1011, "snapshot unavailable");
    } catch {
      // The connection is already unavailable.
    }
  } finally {
    database?.close();
  }
}

function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  return new Database(databasePath, { create: true });
}

export function actionsFeature(databasePath: string, allowedOrigin: string) {
  try {
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          action TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      const columns = database.query<{ name: string }, []>("PRAGMA table_info(actions)").all();
      if (!columns.some((column) => column.name === "sequence")) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(`
            CREATE TABLE actions_with_sequence (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              action TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            INSERT INTO actions_with_sequence (sequence, id, action, created_at)
              SELECT rowid, id, action, created_at FROM actions ORDER BY rowid;
            DROP TABLE actions;
            ALTER TABLE actions_with_sequence RENAME TO actions;
          `);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    } finally {
      database.close();
    }
  } catch {
    // Liveness remains available; readiness reports an unavailable database.
  }

  const clients = new Set<EventsClient>();
  const expiryTimers = new Map<EventsClient, ReturnType<typeof setTimeout>>();

  function revokeClient(client: EventsClient, reason: string) {
    clients.delete(client);
    const timer = expiryTimers.get(client);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(client);
    try {
      client.close(4401, reason);
    } catch {
      // The connection is already unavailable.
    }
  }

  const routes = new Elysia()
    .get("/api/actions", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const database = openDatabase(databasePath);
      try {
        return { actions: readActions(database).map(({ cursor: _cursor, ...receipt }) => receipt) };
      } finally {
        database.close();
      }
    })
    .post(
      "/api/actions",
      ({ body, request, set }) => {
        if (!isAuthenticated(databasePath, request)) {
          set.status = 401;
          return { error: "unauthorized" as const };
        }
        const receipt: ActionReceipt = {
          id: crypto.randomUUID(),
          action: body.action,
          createdAt: new Date().toISOString(),
        };
        const database = openDatabase(databasePath);
        let cursor: number;
        try {
          const result = database.query("INSERT INTO actions (id, action, created_at) VALUES (?, ?, ?)").run(
            receipt.id,
            receipt.action,
            receipt.createdAt,
          );
          cursor = Number(result.lastInsertRowid);
        } finally {
          database.close();
        }

        set.status = 201;
        const event = JSON.stringify({ type: "action.created", cursor, receipt });
        for (const client of clients) {
          if (!isAuthenticated(databasePath, client.data.request)) {
            revokeClient(client, "session expired or revoked");
          } else {
            try {
              client.send(event);
            } catch {
              revokeClient(client, "event delivery failed");
            }
          }
        }
        return receipt;
      },
      { body: t.Object({ action: t.String({ minLength: 1, maxLength: 120 }) }) },
    )
    .ws("/api/events", {
      beforeHandle({ request, set }) {
        if (request.headers.get("origin") !== allowedOrigin) {
          set.status = 403;
          return { error: "origin_not_allowed" as const };
        }
        if (!isAuthenticated(databasePath, request)) {
          set.status = 401;
          return { error: "unauthorized" as const };
        }
      },
      open(client) {
        if (!isAuthenticated(databasePath, client.data.request)) {
          client.close(4401, "unauthorized");
          return;
        }
        const expiresAt = sessionExpiresAt(databasePath, client.data.request);
        if (expiresAt === undefined) {
          client.close(4401, "session expired or unavailable");
          return;
        }
        clients.add(client);
        expiryTimers.set(client, setTimeout(() => revokeClient(client, "session expired"), Math.max(0, expiresAt - Date.now())));
        sendSnapshot(databasePath, client);
      },
      message(client, message) {
        let command: unknown = message;
        if (typeof message === "string" || Buffer.isBuffer(message)) {
          try {
            command = JSON.parse(String(message));
          } catch {
            return;
          }
        }
        if (typeof command !== "object" || command === null || !("type" in command) || command.type !== "sync") return;
        if (!isAuthenticated(databasePath, client.data.request)) {
          revokeClient(client, "session expired or revoked");
          return;
        }
        sendSnapshot(databasePath, client);
      },
      close(client) {
        clients.delete(client);
        const timer = expiryTimers.get(client);
        if (timer) clearTimeout(timer);
        expiryTimers.delete(client);
      },
    });

  return {
    routes,
    revokeSessions() {
      for (const client of clients) revokeClient(client, "session revoked");
    },
  };
}
