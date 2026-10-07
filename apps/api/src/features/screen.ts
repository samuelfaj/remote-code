import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.Transform(t.String({ format: "uuid", minLength: 36, maxLength: 36 }))
  .Decode((value) => value.toLowerCase()).Encode((value) => value.toLowerCase());

type Owner = { kind: "anonymous" } | { kind: "unavailable" } | { kind: "ok"; userId: string };
type ScreenInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string };

class ScreenError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function openDatabase(path: string, readonly = false) {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  return new Database(path, { create: !readonly, readonly });
}

export function screenFeature(
  databasePath: string,
  options?: {
    possessionMs?: number;
    previewMs?: number;
    capture?: (request: { workspaceId: string; botId: string }) => Promise<Uint8Array>;
    input?: (workspaceId: string, event: ScreenInput) => Promise<void>;
  },
) {
  const possessionMs = options?.possessionMs ?? Number(process.env.REMOTECODE_SCREEN_POSSESSION_MS ?? 30_000);
  const previewMs = options?.previewMs ?? Number(process.env.REMOTECODE_SCREEN_PREVIEW_MS ?? 60_000);

  const captureSeam = options?.capture ?? (async (request) => {
    const { workspaceId, botId } = request;
    let display: string;
    try {
      const botDisplays = JSON.parse(process.env.REMOTECODE_BOT_DISPLAYS ?? "{}") as Record<string, string>;
      display = botDisplays[botId] ?? process.env.REMOTECODE_DISPLAY ?? ":99";
    } catch {
      display = process.env.REMOTECODE_DISPLAY ?? ":99";
    }
    const proc = Bun.spawnSync(
      ["import", "-window", "root", "png:-"],
      { env: { ...process.env, DISPLAY: display }, timeout: 15_000 },
    );
    if (proc.exitCode !== 0) throw new ScreenError(503, "capture_failed");
    return new Uint8Array(proc.stdout);
  });

  const inputSeam = options?.input ?? (async (_workspaceId: string, event: ScreenInput) => {
    let args: string[];
    switch (event.kind) {
      case "click": args = ["mousemove", "--sync", String(event.x), String(event.y), "click", "1"]; break;
      case "type": args = ["type", "--clearmodifiers", "--delay", "12", event.text]; break;
      case "key": args = ["key", "--clearmodifiers", event.key]; break;
    }
    Bun.spawnSync(["xdotool", ...args], {
      env: { ...process.env, DISPLAY: process.env.REMOTECODE_DISPLAY ?? ":99" },
      timeout: 10_000,
    });
  });

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
    db.exec(`CREATE TABLE IF NOT EXISTS screen_possessions (
      workspace_id TEXT PRIMARY KEY,
      possession_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      holder_user_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS screen_observations (
      token_hash TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS screen_previews (
      preview_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      holder_user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
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

  function tokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  function workspaceExists(workspaceId: string, userId: string): boolean {
    return Boolean(db((database) => database.query<{ id: string }, [string, string]>(
      "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
    ).get(workspaceId, userId)));
  }

  function livePossessionExists(workspaceId: string): boolean {
    const row = db((database) => database.query<{ expires_at: number; released_at: number | null }, [string]>(
      "SELECT expires_at, released_at FROM screen_possessions WHERE workspace_id = ?",
    ).get(workspaceId));
    return !!row && row.released_at === null && row.expires_at > Date.now();
  }

  function botBelongsToUser(botId: string, userId: string): boolean {
    return Boolean(db((database) => database.query<{ id: string }, [string, string]>(
      "SELECT id FROM bots WHERE id = ? AND user_id = ?",
    ).get(botId, userId)));
  }

  function previewForBotExists(workspaceId: string, botId: string): boolean {
    return Boolean(db((database) => database.query<{ preview_id: string }, [string, string]>(
      "SELECT preview_id FROM screen_previews WHERE workspace_id = ? AND bot_id = ?",
    ).get(workspaceId, botId)));
  }

  return new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_request" as const };
      }
    })
    .post("/api/workspaces/:workspaceId/screen/possession", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      try {
        const result = db((database) => {
          initializeSchema(database);
          const existing = database.query<
            { possession_id: string; token_hash: string; epoch: number; expires_at: number },
            [string]
          >("SELECT * FROM screen_possessions WHERE workspace_id = ?").get(params.workspaceId);

          const newEpoch = existing ? existing.epoch + 1 : 1;
          const token = randomBytes(32).toString("hex");
          const hash = tokenHash(token);
          const possessionId = crypto.randomUUID();
          const expiresAt = Date.now() + possessionMs;
          const now = new Date().toISOString();

          if (existing) {
            database.query(
              "UPDATE screen_possessions SET possession_id = ?, token_hash = ?, holder_user_id = ?, epoch = ?, expires_at = ?, released_at = NULL, created_at = ? WHERE workspace_id = ?",
            ).run(possessionId, hash, owner.userId, newEpoch, expiresAt, now, params.workspaceId);
          } else {
            database.query(
              "INSERT INTO screen_possessions (workspace_id, possession_id, token_hash, holder_user_id, epoch, expires_at, released_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
            ).run(params.workspaceId, possessionId, hash, owner.userId, newEpoch, expiresAt, now);
          }

          return { possessionId, token, epoch: newEpoch, expiresAt };
        });
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({}) })
    .post("/api/workspaces/:workspaceId/screen/possession/heartbeat", ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const token = typeof body?.token === "string" ? body.token : "";
      if (!token) { set.status = 409; return { error: "possession_lost" as const }; }

      try {
        const hash = tokenHash(token);
        const row = db((database) => database.query<
          { token_hash: string; expires_at: number; released_at: number | null },
          [string]
        >("SELECT * FROM screen_possessions WHERE workspace_id = ?").get(params.workspaceId));

        if (!row || row.token_hash !== hash || row.released_at !== null || row.expires_at <= Date.now()) {
          set.status = 409;
          return { error: "possession_lost" as const };
        }

        const newExpiresAt = Date.now() + possessionMs;
        db((database) => database.query(
          "UPDATE screen_possessions SET expires_at = ? WHERE workspace_id = ?",
        ).run(newExpiresAt, params.workspaceId));
        return { expiresAt: newExpiresAt };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({ token: t.String() }) })
    .post("/api/workspaces/:workspaceId/screen/possession/release", ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const token = typeof body?.token === "string" ? body.token : "";
      if (!token) { set.status = 409; return { error: "possession_lost" as const }; }

      try {
        const hash = tokenHash(token);
        const row = db((database) => database.query<
          { token_hash: string; expires_at: number; released_at: number | null },
          [string]
        >("SELECT * FROM screen_possessions WHERE workspace_id = ?").get(params.workspaceId));

        if (!row || row.token_hash !== hash || row.released_at !== null || row.expires_at <= Date.now()) {
          set.status = 409;
          return { error: "possession_lost" as const };
        }

        const releasedAt = Date.now();
        db((database) => database.query(
          "UPDATE screen_possessions SET released_at = ? WHERE workspace_id = ?",
        ).run(releasedAt, params.workspaceId));
        return { releasedAt };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({ token: t.String() }) })
    .get("/api/workspaces/:workspaceId/screen/frame", async ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const token = request.headers.get("x-rc-possession") ?? "";
      if (!token) { set.status = 409; return { error: "possession_required" as const }; }

      try {
        const hash = tokenHash(token);
        const row = db((database) => database.query<
          { token_hash: string; expires_at: number; released_at: number | null },
          [string]
        >("SELECT * FROM screen_possessions WHERE workspace_id = ?").get(params.workspaceId));

        if (!row || row.token_hash !== hash || row.released_at !== null || row.expires_at <= Date.now()) {
          set.status = 409;
          return { error: "possession_required" as const };
        }

        const bytes = await captureSeam({ workspaceId: params.workspaceId, botId: "" });
        return new Response(Buffer.from(bytes), { headers: { "content-type": "image/png" } });
      } catch (error) {
        if (error instanceof ScreenError && error.status === 503) {
          set.status = 503;
          return { error: "capture_failed" as const };
        }
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }) })
    .post("/api/workspaces/:workspaceId/screen/input", async ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const token = typeof body?.token === "string" ? body.token : "";
      if (!token) { set.status = 409; return { error: "possession_required" as const }; }

      try {
        const hash = tokenHash(token);
        const row = db((database) => database.query<
          { token_hash: string; expires_at: number; released_at: number | null },
          [string]
        >("SELECT * FROM screen_possessions WHERE workspace_id = ?").get(params.workspaceId));

        if (!row || row.token_hash !== hash || row.released_at !== null || row.expires_at <= Date.now()) {
          set.status = 409;
          return { error: "possession_required" as const };
        }

        const event = body.event;
        if (!event || typeof event !== "object") {
          set.status = 422;
          return { error: "invalid_event" as const };
        }
        const kind = (event as { kind?: unknown }).kind;
        if (kind === "click") {
          const x = (event as { x?: unknown }).x;
          const y = (event as { y?: unknown }).y;
          if (typeof x !== "number" || typeof y !== "number") {
            set.status = 422;
            return { error: "invalid_event" as const };
          }
          await inputSeam(params.workspaceId, { kind: "click", x, y });
        } else if (kind === "type") {
          const text = (event as { text?: unknown }).text;
          if (typeof text !== "string") {
            set.status = 422;
            return { error: "invalid_event" as const };
          }
          await inputSeam(params.workspaceId, { kind: "type", text });
        } else if (kind === "key") {
          const key = (event as { key?: unknown }).key;
          if (typeof key !== "string") {
            set.status = 422;
            return { error: "invalid_event" as const };
          }
          await inputSeam(params.workspaceId, { kind: "key", key });
        } else {
          set.status = 422;
          return { error: "invalid_event" as const };
        }

        return { applied: true };
      } catch (error) {
        if (error instanceof ScreenError && error.status === 503) {
          set.status = 503;
          return { error: "capture_failed" as const };
        }
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({
      token: t.String(),
      event: t.Object({
        kind: t.String(),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        text: t.Optional(t.String()),
        key: t.Optional(t.String()),
      }),
    }) })
    .post("/api/workspaces/:workspaceId/screen/agent/observation", ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      try {
        const result = db((database) => {
          initializeSchema(database);
          const existing = database.query<{ epoch: number }, [string]>(
            "SELECT epoch FROM screen_possessions WHERE workspace_id = ?",
          ).get(params.workspaceId);
          const epoch = existing ? existing.epoch : 1;
          const stateToken = randomBytes(32).toString("hex");
          const stateTokenHash = tokenHash(stateToken);
          const now = new Date().toISOString();

          if (!existing) {
            database.query(
              "INSERT INTO screen_possessions (workspace_id, possession_id, token_hash, holder_user_id, epoch, expires_at, released_at, created_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)",
            ).run(params.workspaceId, crypto.randomUUID(), "", owner.userId, epoch, now);
          }

          database.query(
            "INSERT INTO screen_observations (token_hash, workspace_id, epoch, created_at) VALUES (?, ?, ?, ?)",
          ).run(stateTokenHash, params.workspaceId, epoch, now);

          return { stateToken, epoch, observedAt: now };
        });
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({ agentId: t.String() }) })
    .post("/api/workspaces/:workspaceId/screen/agent/input", async ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const stateToken = typeof body?.stateToken === "string" ? body.stateToken : "";
      const event = body?.event;

      try {
        if (livePossessionExists(params.workspaceId)) {
          set.status = 409;
          return { error: "possession_held_by_user" as const };
        }

        if (!stateToken) {
          set.status = 409;
          return { error: "stale_observation" as const };
        }

        const stateTokenHash = tokenHash(stateToken);
        // Scoped to this workspace: an observation taken anywhere else is not
        // evidence about this screen.
        const observation = db((database) => database.query<
          { epoch: number },
          [string, string]
        >("SELECT * FROM screen_observations WHERE token_hash = ? AND workspace_id = ?").get(stateTokenHash, params.workspaceId));

        if (!observation) {
          set.status = 409;
          return { error: "stale_observation" as const };
        }

        const currentEpoch = db((database) => {
          initializeSchema(database);
          const row = database.query<{ epoch: number }, [string]>(
            "SELECT epoch FROM screen_possessions WHERE workspace_id = ?",
          ).get(params.workspaceId);
          return row ? row.epoch : 1;
        });

        if (observation.epoch < currentEpoch) {
          set.status = 409;
          return { error: "stale_observation" as const };
        }

        if (!event || typeof event !== "object") {
          set.status = 422;
          return { error: "invalid_event" as const };
        }
        const kind = (event as { kind?: unknown }).kind;
        if (kind === "click") {
          const x = (event as { x?: unknown }).x;
          const y = (event as { y?: unknown }).y;
          if (typeof x !== "number" || typeof y !== "number") {
            set.status = 422;
            return { error: "invalid_event" as const };
          }
          await inputSeam(params.workspaceId, { kind: "click", x, y });
        } else if (kind === "type") {
          const text = (event as { text?: unknown }).text;
          if (typeof text !== "string") {
            set.status = 422;
            return { error: "invalid_event" as const };
          }
          await inputSeam(params.workspaceId, { kind: "type", text });
        } else if (kind === "key") {
          const key = (event as { key?: unknown }).key;
          if (typeof key !== "string") {
            set.status = 422;
            return { error: "invalid_event" as const };
          }
          await inputSeam(params.workspaceId, { kind: "key", key });
        } else {
          set.status = 422;
          return { error: "invalid_event" as const };
        }

        return { applied: true, epoch: currentEpoch };
      } catch (error) {
        if (error instanceof ScreenError && error.status === 503) {
          set.status = 503;
          return { error: "capture_failed" as const };
        }
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({
      stateToken: t.String(),
      event: t.Object({
        kind: t.String(),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        text: t.Optional(t.String()),
        key: t.Optional(t.String()),
      }),
    }) })
    .post("/api/workspaces/:workspaceId/screen/preview", ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const botId = typeof body?.botId === "string" ? body.botId : "";
      if (!botId) { set.status = 404; return { error: "not_found" as const }; }
      if (!botBelongsToUser(botId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      try {
        const result = db((database) => {
          initializeSchema(database);
          const now = new Date().toISOString();
          const expiresAt = Date.now() + previewMs;
          const previewId = crypto.randomUUID();
          const token = randomBytes(32).toString("hex");
          const hash = tokenHash(token);

          const existing = database.query<{ preview_id: string }, [string, string]>(
            "SELECT preview_id FROM screen_previews WHERE workspace_id = ? AND bot_id = ?",
          ).get(params.workspaceId, botId);

          if (existing) {
            database.query(
              "UPDATE screen_previews SET token_hash = ?, holder_user_id = ?, expires_at = ?, created_at = ? WHERE workspace_id = ? AND bot_id = ?",
            ).run(hash, owner.userId, expiresAt, now, params.workspaceId, botId);
          } else {
            database.query(
              "INSERT INTO screen_previews (preview_id, workspace_id, bot_id, token_hash, holder_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).run(previewId, params.workspaceId, botId, hash, owner.userId, expiresAt, now);
          }

          set.cookie = {
            rc_screen_preview: {
              value: token,
              httpOnly: true,
              sameSite: "strict",
              maxAge: Math.floor((expiresAt - Date.now()) / 1000),
              path: "/",
            },
          };

          return { previewId, botId, expiresAt };
        });
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({ botId: t.String() }) })
    .get("/api/workspaces/:workspaceId/screen/preview/frame", async ({ params, request, set, query }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const botId = typeof query.botId === "string" ? query.botId : "";
      if (!botId) { set.status = 404; return { error: "not_found" as const }; }

      const token = request.headers.get("cookie") ?? "";
      const match = token.match(/(?:^|;\s*)rc_screen_preview=([^;]+)/);
      const cookieToken = match ? match[1] : "";
      if (!cookieToken) { set.status = 409; return { error: "preview_required" as const }; }

      try {
        const hash = tokenHash(cookieToken);
        const row = db((database) => database.query<
          { preview_id: string; token_hash: string; holder_user_id: string; expires_at: number },
          [string, string]
        >("SELECT * FROM screen_previews WHERE workspace_id = ? AND bot_id = ?").get(params.workspaceId, botId));

        if (!row || row.token_hash !== hash || row.expires_at <= Date.now() || row.holder_user_id !== owner.userId) {
          set.status = 409;
          return { error: "preview_required" as const };
        }

        const bytes = await captureSeam({ workspaceId: params.workspaceId, botId });
        return new Response(Buffer.from(bytes), { headers: { "content-type": "image/png" } });
      } catch (error) {
        if (error instanceof ScreenError && error.status === 503) {
          set.status = 503;
          return { error: "capture_failed" as const };
        }
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), query: t.Object({ botId: t.String() }) })
    .post("/api/workspaces/:workspaceId/screen/preview/refresh", ({ params, request, set, body }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      if (!canonicalUuid.test(params.workspaceId)) { set.status = 404; return { error: "not_found" as const }; }
      if (!workspaceExists(params.workspaceId, owner.userId)) { set.status = 404; return { error: "not_found" as const }; }

      const botId = typeof body?.botId === "string" ? body.botId : "";
      if (!botId) { set.status = 404; return { error: "not_found" as const }; }

      const token = request.headers.get("cookie") ?? "";
      const match = token.match(/(?:^|;\s*)rc_screen_preview=([^;]+)/);
      const cookieToken = match ? match[1] : "";
      if (!cookieToken) { set.status = 409; return { error: "preview_required" as const }; }

      try {
        const result = db((database) => {
          initializeSchema(database);
          const hash = tokenHash(cookieToken);
          const row = database.query<
            { preview_id: string; token_hash: string; holder_user_id: string; expires_at: number },
            [string, string]
          >("SELECT * FROM screen_previews WHERE workspace_id = ? AND bot_id = ?").get(params.workspaceId, botId);

          if (!row || row.token_hash !== hash || row.holder_user_id !== owner.userId || row.expires_at <= Date.now()) {
            return null;
          }

          const newToken = randomBytes(32).toString("hex");
          const newHash = tokenHash(newToken);
          const expiresAt = Date.now() + previewMs;
          const now = new Date().toISOString();

          database.query(
            "UPDATE screen_previews SET token_hash = ?, expires_at = ?, created_at = ? WHERE workspace_id = ? AND bot_id = ?",
          ).run(newHash, expiresAt, now, params.workspaceId, botId);

          set.cookie = {
            rc_screen_preview: {
              value: newToken,
              httpOnly: true,
              sameSite: "strict",
              maxAge: Math.floor((expiresAt - Date.now()) / 1000),
              path: "/",
            },
          };

          return { previewId: row.preview_id, botId, expiresAt };
        });

        if (!result) { set.status = 409; return { error: "preview_required" as const }; }
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({ botId: t.String() }) });
}
