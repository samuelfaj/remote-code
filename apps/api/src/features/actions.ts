import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";

type ActionReceipt = {
  id: string;
  action: string;
  createdAt: string;
};

type EventsClient = {
  send(data: string): void;
};

function readActions(database: Database): ActionReceipt[] {
  const rows = database.query<unknown, []>(
    "SELECT id, action, created_at AS createdAt FROM actions ORDER BY created_at DESC, rowid DESC",
  ).all();
  return rows.map((row) => {
    if (
      typeof row !== "object" || row === null ||
      !("id" in row) || typeof row.id !== "string" ||
      !("action" in row) || typeof row.action !== "string" ||
      !("createdAt" in row) || typeof row.createdAt !== "string"
    ) {
      throw new Error("Stored action receipt is invalid");
    }
    return { id: row.id, action: row.action, createdAt: row.createdAt };
  });
}

function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  return new Database(databasePath, { create: true });
}

export function actionsFeature(databasePath: string) {
  try {
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    } finally {
      database.close();
    }
  } catch {
    // Liveness remains available; readiness reports an unavailable database.
  }

  const clients = new Set<EventsClient>();

  return new Elysia()
    .get("/api/actions", () => {
      const database = openDatabase(databasePath);
      try {
        return { actions: readActions(database) };
      } finally {
        database.close();
      }
    })
    .post(
      "/api/actions",
      ({ body, set }) => {
        const receipt: ActionReceipt = {
          id: crypto.randomUUID(),
          action: body.action,
          createdAt: new Date().toISOString(),
        };
        const database = openDatabase(databasePath);
        try {
          database.query("INSERT INTO actions (id, action, created_at) VALUES (?, ?, ?)").run(
            receipt.id,
            receipt.action,
            receipt.createdAt,
          );
        } finally {
          database.close();
        }

        set.status = 201;
        const event = JSON.stringify({ type: "action.created", receipt });
        for (const client of clients) client.send(event);
        return receipt;
      },
      { body: t.Object({ action: t.String({ minLength: 1, maxLength: 120 }) }) },
    )
    .ws("/api/events", {
      open(client) {
        clients.add(client);
        const database = openDatabase(databasePath);
        try {
          client.send(JSON.stringify({ type: "snapshot", actions: readActions(database) }));
        } finally {
          database.close();
        }
      },
      close(client) {
        clients.delete(client);
      },
    });
}
