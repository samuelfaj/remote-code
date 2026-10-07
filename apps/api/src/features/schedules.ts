import { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";

export function nextOccurrence(localTime: string, timezone: string, after: Date):
  { plannedAt: Date; decision: "exact" | "shifted_forward" | "deduplicated" } {
  const [targetHour, targetMinute] = localTime.split(":").map(Number);
  const targetMinutes = targetHour * 60 + targetMinute;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function getLocalMinutes(date: Date): number {
    const formatted = formatter.format(date);
    const [h, m] = formatted.split(":").map(Number);
    return h * 60 + m;
  }

  // Policy (stated in a comment per requirement):
  // A local time that does not exist because of a spring-forward gap is
  // planned at the first instant after the gap (shifted_forward). A
  // local time that occurs twice in a fall-back transition is planned
  // only once, at the FIRST occurrence (deduplicated).
  const day = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()));

  while (true) {
    let foundFirst: Date | null = null;
    let foundSecond: Date | null = null;

    for (let minute = 0; minute < 1440; minute++) {
      const candidate = new Date(day.getTime() + minute * 60000);
      const localMinutes = getLocalMinutes(candidate);

      if (localMinutes === targetMinutes) {
        if (!foundFirst) {
          foundFirst = candidate;
        } else {
          foundSecond = candidate;
          break;
        }
      }
    }

    if (foundFirst) {
      if (foundFirst >= after) {
        return { plannedAt: foundFirst, decision: foundSecond ? "deduplicated" : "exact" };
      }
      // The first occurrence is before `after`; skip to the next day
      // to avoid returning a past time or the second (duplicate) occurrence.
      day.setUTCDate(day.getUTCDate() + 1);
      continue;
    }

    // Spring-forward gap: find the first local time strictly after the target
    // that is also at or after `after`.
    let gapCandidate: Date | null = null;
    for (let minute = 0; minute < 1440; minute++) {
      const candidate = new Date(day.getTime() + minute * 60000);
      const localMinutes = getLocalMinutes(candidate);

      if (localMinutes > targetMinutes && candidate >= after && gapCandidate === null) {
        gapCandidate = candidate;
      }
    }

    if (gapCandidate !== null) {
      return { plannedAt: gapCandidate, decision: "shifted_forward" };
    }

    // No valid gap time on this day (the gap is entirely before `after`);
    // move to the next day.
    day.setUTCDate(day.getUTCDate() + 1);
  }
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.String({ minLength: 36, maxLength: 36 });
const localTimePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function schedulesFeature(
  databasePath: string,
  options: {
    startRun: (owner: { userId: string }, input: { workspaceId: string; prompt: string; botId?: string; requestId?: string }) =>
      { kind: "ok"; run: { id: string; workspaceId: string; botId: string | null; state: string; prompt: string; createdAt: string; updatedAt: string; heartbeatAt: string | null; stopRequestedAt: string | null; stopReason: string | null; error: string | null; sessionId: string | null; handoffReason: string | null; retryAfterSeconds: number | null } } | { kind: "not_found"; what: "workspace" | "bot" } | { kind: "failed"; error: string };
    now?: () => Date;
  },
) {
  const now = options.now ?? (() => new Date());

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

  try {
    db((database) => {
      database.exec(`CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        workspace_id TEXT,
        bot_id TEXT,
        prompt TEXT NOT NULL,
        local_time TEXT NOT NULL,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      database.exec(`CREATE TABLE IF NOT EXISTS schedule_occurrences (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        planned_at TEXT NOT NULL,
        state TEXT NOT NULL,
        run_id TEXT,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrences_schedule_planned ON schedule_occurrences(schedule_id, planned_at)");
      database.exec("CREATE INDEX IF NOT EXISTS idx_occurrences_state ON schedule_occurrences(state)");
    });
  } catch {
    // Storage unavailable; readiness reports it and every route fails closed.
  }

  // Startup recovery: an occurrence from before this process started is only
  // `succeeded` when its run finished cleanly. A run that was interrupted or
  // failed (including one reconciled by the run supervisor on this same boot)
  // may or may not have had its external effect, so the occurrence becomes
  // `unknown` with decision `requires_verification` and is never restarted.
  try {
    db((database) => {
      const rows = database.query<
        { id: string; schedule_id: string; user_id: string; planned_at: string; decision: string; state: string; run_id: string | null },
        []
      >(
        "SELECT id, schedule_id, user_id, planned_at, decision, state, run_id FROM schedule_occurrences WHERE state IN ('started', 'succeeded')",
      ).all();

      for (const row of rows) {
        const ambiguous = () => database.query(
          "UPDATE schedule_occurrences SET state = ?, decision = ?, updated_at = ? WHERE id = ?",
        ).run("unknown", "requires_verification", new Date().toISOString(), row.id);

        if (!row.run_id) { ambiguous(); continue; }
        const run = database.query<{ state: string }, [string]>(
          "SELECT state FROM runs WHERE id = ?",
        ).get(row.run_id);
        if (!run) { ambiguous(); continue; }
        if (run.state === "starting" || run.state === "running") continue;
        if (run.state === "completed") {
          if (row.state !== "succeeded") {
            database.query("UPDATE schedule_occurrences SET state = ?, updated_at = ? WHERE id = ?")
              .run("succeeded", new Date().toISOString(), row.id);
          }
          continue;
        }
        ambiguous();
      }
    });
  } catch {
    // Storage unavailable; skip recovery.
  }

  function resolveOwner(request: Request) {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return { kind: "anonymous" as const };
    const database = new Database(databasePath, { readonly: true, create: false });
    try {
      const live = database.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(userId, tokenHash);
      if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return { kind: "anonymous" as const };
      return { kind: "ok" as const, userId };
    } catch {
      return { kind: "unavailable" as const };
    } finally {
      database.close();
    }
  }

  function viewSchedule(row: {
    id: string; user_id: string; kind: string; workspace_id: string | null;
    bot_id: string | null; prompt: string; local_time: string; timezone: string;
    enabled: number; created_at: string; updated_at: string;
  }) {
    return {
      id: row.id,
      kind: row.kind,
      workspaceId: row.workspace_id,
      botId: row.bot_id,
      prompt: row.prompt,
      localTime: row.local_time,
      timezone: row.timezone,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function viewOccurrence(row: {
    id: string; schedule_id: string; user_id: string; planned_at: string;
    state: string; run_id: string | null; decision: string;
    created_at: string; updated_at: string;
  }) {
    return {
      id: row.id,
      plannedAt: row.planned_at,
      state: row.state,
      decision: row.decision,
      runId: row.run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const routes = new Elysia()
    .onError(({ code, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "invalid_schedule_request" as const };
      }
    })
    .post("/api/schedules", ({ body, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      const kind = typeof body.kind === "string" ? body.kind : "";
      if (kind !== "task" && kind !== "routine") { set.status = 400; return { error: "invalid_kind" as const }; }

      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : null;
      const botId = typeof body.botId === "string" ? body.botId : null;

      if (kind === "task" && !workspaceId) { set.status = 400; return { error: "invalid_schedule_request" as const }; }
      if (kind === "routine" && !botId) { set.status = 400; return { error: "invalid_schedule_request" as const }; }

      const localTime = typeof body.localTime === "string" ? body.localTime : "";
      if (!localTimePattern.test(localTime)) { set.status = 400; return { error: "invalid_local_time" as const }; }

      const timezone = typeof body.timezone === "string" ? body.timezone : "";
      if (!validateTimezone(timezone)) { set.status = 400; return { error: "invalid_timezone" as const }; }

      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (prompt.length < 1 || prompt.length > 2000) { set.status = 400; return { error: "invalid_prompt" as const }; }

      const result = db((database) => {
        if (kind === "task") {
          if (!workspaceId) { set.status = 400; return { error: "invalid_schedule_request" as const }; }
          const workspace = database.query<{ id: string }, [string, string]>(
            "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
          ).get(workspaceId, userId);
          if (!workspace) return { notFound: "workspace" as const };
        } else {
          if (!botId) { set.status = 400; return { error: "invalid_schedule_request" as const }; }
          const bot = database.query<{ id: string; user_id: string }, [string, string]>(
            "SELECT id, user_id FROM bots WHERE id = ? AND user_id = ?",
          ).get(botId, userId);
          if (!bot) return { notFound: "bot" as const };
          // A Bot routine runs through the same supervisor as a thread, and a
          // run always belongs to a workspace, so the routine needs one too.
          if (!workspaceId) { set.status = 400; return { error: "invalid_schedule_request" as const }; }
          const workspace = database.query<{ id: string }, [string, string]>(
            "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
          ).get(workspaceId, userId);
          if (!workspace) return { notFound: "workspace" as const };
        }

        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        database.query(
          "INSERT INTO schedules (id, user_id, kind, workspace_id, bot_id, prompt, local_time, timezone, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        ).run(id, userId, kind, workspaceId ?? null, botId ?? null, prompt, localTime, timezone, createdAt, createdAt);

        const scheduleRow = database.query<
          { id: string; user_id: string; kind: string; workspace_id: string | null; bot_id: string | null; prompt: string; local_time: string; timezone: string; enabled: number; created_at: string; updated_at: string },
          [string]
        >("SELECT * FROM schedules WHERE id = ?").get(id);

        let nextOcc: { plannedAt: Date; decision: "exact" | "shifted_forward" | "deduplicated" } | null = null;
        if (scheduleRow) {
          try {
            nextOcc = nextOccurrence(scheduleRow.local_time, scheduleRow.timezone, new Date());
          } catch {
            // ignore
          }
        }

        return {
          ...viewSchedule(scheduleRow!),
          nextOccurrence: nextOcc
            ? { plannedAt: nextOcc.plannedAt.toISOString(), decision: nextOcc.decision }
            : null,
        };
      });

      if ("notFound" in result) { set.status = 404; return { error: result.notFound === "workspace" ? "workspace_not_found" as const : "bot_not_found" as const }; }
      set.status = 201;
      return result;
    }, { body: t.Object({
      kind: t.String(),
      workspaceId: t.Optional(t.String({ minLength: 36, maxLength: 36 })),
      botId: t.Optional(t.String({ minLength: 36, maxLength: 36 })),
      prompt: t.String(),
      localTime: t.String(),
      timezone: t.String(),
    }) })
    .get("/api/schedules", ({ request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      try {
        const schedules = db((database) => {
          const rows = database.query<
            { id: string; user_id: string; kind: string; workspace_id: string | null; bot_id: string | null; prompt: string; local_time: string; timezone: string; enabled: number; created_at: string; updated_at: string },
            [string]
          >(
            "SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at DESC",
          ).all(userId);
          return rows.map((row) => {
            let nextOcc: { plannedAt: Date; decision: "exact" | "shifted_forward" | "deduplicated" } | null = null;
            try {
              nextOcc = nextOccurrence(row.local_time, row.timezone, new Date());
            } catch {
              // ignore
            }
            return {
              ...viewSchedule(row),
              nextOccurrence: nextOcc
                ? { plannedAt: nextOcc.plannedAt.toISOString(), decision: nextOcc.decision }
                : null,
            };
          });
        });
        return { schedules };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    })
    .patch("/api/schedules/:id", ({ body, params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }

      const updates: string[] = [];
      const values: SQLQueryBindings[] = [];

      if (body.enabled !== undefined) { updates.push("enabled = ?"); values.push(body.enabled ? 1 : 0); }
      if (body.localTime !== undefined) {
        if (!localTimePattern.test(body.localTime)) { set.status = 400; return { error: "invalid_local_time" as const }; }
        updates.push("local_time = ?"); values.push(body.localTime);
      }
      if (body.timezone !== undefined) {
        if (!validateTimezone(body.timezone)) { set.status = 400; return { error: "invalid_timezone" as const }; }
        updates.push("timezone = ?"); values.push(body.timezone);
      }
      if (body.prompt !== undefined) {
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (prompt.length < 1 || prompt.length > 2000) { set.status = 400; return { error: "invalid_prompt" as const }; }
        updates.push("prompt = ?"); values.push(prompt);
      }

      if (updates.length === 0) { set.status = 400; return { error: "invalid_schedule_request" as const }; }

      try {
        const result = db((database) => {
          const existing = database.query<{ user_id: string }, [string]>(
            "SELECT user_id FROM schedules WHERE id = ?",
          ).get(params.id);
          if (!existing || existing.user_id !== userId) return null;

          updates.push("updated_at = ?");
          values.push(new Date().toISOString());
          values.push(params.id);
          values.push(userId);

          database.query(`UPDATE schedules SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);

          const row = database.query<
            { id: string; user_id: string; kind: string; workspace_id: string | null; bot_id: string | null; prompt: string; local_time: string; timezone: string; enabled: number; created_at: string; updated_at: string },
            [string]
          >("SELECT * FROM schedules WHERE id = ?").get(params.id);
          return row ? viewSchedule(row) : null;
        });

        if (!result) { set.status = 404; return { error: "not_found" as const }; }
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { body: t.Object({
      enabled: t.Optional(t.Boolean()),
      localTime: t.Optional(t.String()),
      timezone: t.Optional(t.String()),
      prompt: t.Optional(t.String()),
    }) })
    .delete("/api/schedules/:id", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }

      try {
        const result = db((database) => {
          const existing = database.query<{ user_id: string }, [string]>(
            "SELECT user_id FROM schedules WHERE id = ?",
          ).get(params.id);
          if (!existing || existing.user_id !== userId) return null;
          database.query("DELETE FROM schedule_occurrences WHERE schedule_id = ?").run(params.id);
          database.query("DELETE FROM schedules WHERE id = ?").run(params.id);
          return true;
        });

        if (!result) { set.status = 404; return { error: "not_found" as const }; }
        return { deleted: true };
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ id: uuidSchema }) })
    .get("/api/schedules/:id/occurrences", ({ params, request, set }) => {
      const owner = resolveOwner(request);
      if (owner.kind === "anonymous") { set.status = 401; return { error: "unauthorized" as const }; }
      if (owner.kind === "unavailable") { set.status = 503; return { error: "storage_unavailable" as const }; }
      const userId = owner.userId;

      if (!canonicalUuid.test(params.id)) { set.status = 404; return { error: "not_found" as const }; }

      try {
        const result = db((database) => {
          const schedule = database.query<{ user_id: string }, [string]>(
            "SELECT user_id FROM schedules WHERE id = ?",
          ).get(params.id);
          if (!schedule || schedule.user_id !== userId) return null;

          const rows = database.query<
            { id: string; schedule_id: string; user_id: string; planned_at: string; state: string; run_id: string | null; decision: string; created_at: string; updated_at: string },
            [string]
          >(
            "SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY planned_at DESC",
          ).all(params.id);
          return { occurrences: rows.map(viewOccurrence) };
        });

        if (result === null) { set.status = 404; return { error: "not_found" as const }; }
        return result;
      } catch {
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
    }, { params: t.Object({ id: uuidSchema }) });

  let timerInterval: ReturnType<typeof setInterval> | undefined;

  function tick() {
    const currentNow = now();
    try {
      const schedules = db((database) => {
        const rows = database.query<
          { id: string; user_id: string; kind: string; workspace_id: string | null; bot_id: string | null; prompt: string; local_time: string; timezone: string; enabled: number; created_at: string },
          []
        >("SELECT * FROM schedules WHERE enabled = 1").all();
        return rows;
      });

      for (const schedule of schedules) {
        // `nextOccurrence` looks forward from `after`, so asking it about `now`
        // would always answer a future instant and never be due. Look back one
        // day instead - but never before the schedule existed, or creating a
        // schedule would immediately replay the previous day's occurrence.
        const windowStart = new Date(Math.max(
          new Date(schedule.created_at).getTime(),
          currentNow.getTime() - 86_400_000,
        ));
        const occurrence = nextOccurrence(schedule.local_time, schedule.timezone, windowStart);
        if (occurrence.plannedAt > currentNow) continue;

        const plannedAtIso = occurrence.plannedAt.toISOString();

        const existing = db((database) => database.query<{ id: string }, [string, string]>(
          "SELECT id FROM schedule_occurrences WHERE schedule_id = ? AND planned_at = ?",
        ).get(schedule.id, plannedAtIso));
        if (existing) continue;

        const occurrenceId = crypto.randomUUID();
        const createdAt = new Date().toISOString();

        db((database) => {
          database.query(
            "INSERT INTO schedule_occurrences (id, schedule_id, user_id, planned_at, state, decision, created_at, updated_at) VALUES (?, ?, ?, ?, 'started', ?, ?, ?)",
          ).run(occurrenceId, schedule.id, schedule.user_id, plannedAtIso, occurrence.decision, createdAt, createdAt);
        });

        const startRunResult = options.startRun(
          { userId: schedule.user_id },
          {
            workspaceId: schedule.workspace_id!,
            prompt: schedule.prompt,
            botId: schedule.bot_id ?? undefined,
            requestId: occurrenceId,
          },
        );

        if (startRunResult.kind === "ok") {
          db((database) => {
            database.query(
              "UPDATE schedule_occurrences SET state = ?, run_id = ?, updated_at = ? WHERE id = ?",
            ).run("succeeded", startRunResult.run.id, new Date().toISOString(), occurrenceId);
          });
        } else {
          db((database) => {
            database.query(
              "UPDATE schedule_occurrences SET state = ?, updated_at = ? WHERE id = ?",
            ).run("failed", new Date().toISOString(), occurrenceId);
          });
        }
      }
    } catch {
      // Storage unavailable; skip this tick.
    }
  }

  timerInterval = setInterval(tick, 15_000);

  function stop() {
    if (timerInterval !== undefined) clearInterval(timerInterval);
  }

  return { routes, stop, tick };
}
