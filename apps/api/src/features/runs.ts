import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { startAcpPrompt, type AcpSessionHandle } from "./acp-distill";

export type RunState = "starting" | "running" | "completed" | "interrupted" | "failed";

export type RunView = {
  id: string;
  workspaceId: string;
  state: RunState;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string | null;
  stopRequestedAt: string | null;
  stopReason: string | null;
  error: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.String({ minLength: 36, maxLength: 36 });
const TERMINAL_STATES: RunState[] = ["completed", "interrupted", "failed"];
const STOP_DEADLINE_MS = 10_000;

type RunRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  prompt: string;
  state: RunState;
  created_at: string;
  updated_at: string;
  heartbeat_at: string | null;
  stop_requested_at: string | null;
  stop_reason: string | null;
  error: string | null;
};

function view(row: RunRow): RunView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    state: row.state,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    heartbeatAt: row.heartbeat_at,
    stopRequestedAt: row.stop_requested_at,
    stopReason: row.stop_reason,
    error: row.error,
  };
}

export function runsFeature(
  databasePath: string,
  options: {
    command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
    agentUser?: string; agentHome?: string;
    wrapSpawn?: (command: string, args: string[]) => { command: string; args: string[] };
    onUpdate?: (run: RunView) => void;
  } = {},
) {
  const command = options.command ?? process.env.REMOTECODE_DISTILL_BIN ?? "distill";
  const args = options.args ?? ["agent", "stdio"];
  const cwd = options.cwd ?? process.env.REMOTECODE_RUNS_CWD ?? process.cwd();
  // The agent must not inherit the backend's environment: RC-015 requires that
  // gateway/routing secrets never reach the Distill/terminal process. Keep the
  // rest (PATH, DISPLAY, locale, ...) so the agent still works.
  const agentUser = options.agentUser ?? process.env.REMOTECODE_AGENT_USER;
  const agentHome = options.agentHome ?? process.env.REMOTECODE_AGENT_HOME ??
    (agentUser ? `/home/${agentUser}` : process.env.HOME);
  const agentEnv = options.env ?? Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("REMOTECODE_")),
  ) as NodeJS.ProcessEnv;
  agentEnv.HOME = agentHome;
  // Drop privileges for the agent and every terminal command it asks for, so
  // the agent identity is separate from the backend identity (RC-015).
  const wrapSpawn = options.wrapSpawn ?? (agentUser
    ? (command: string, args: string[]) => ({
        command: "runuser",
        args: ["-u", agentUser, "--", command, ...args],
      })
    : undefined);
  const live = new Map<string, AcpSessionHandle>();

  function database<T>(callback: (db: Database) => T): T {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 250");
      db.exec(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        heartbeat_at TEXT,
        stop_requested_at TEXT,
        stop_reason TEXT,
        error TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS runs_workspace ON runs(workspace_id, created_at)");
      return callback(db);
    } finally {
      db.close();
    }
  }

  // A run whose owning API process is gone can never still be executing: on
  // startup every non-terminal run becomes interrupted, never "in progress",
  // and the prompt is never replayed. A storage failure here must not stop the
  // API from starting: the readiness gate already reports the degraded service.
  try {
    const now = new Date().toISOString();
    database((db) => {
      db.query(
        "UPDATE runs SET state = 'interrupted', stop_reason = 'host_restart', updated_at = ?, heartbeat_at = ? WHERE state IN ('starting','running')",
      ).run(now, now);
    });
  } catch {
    // Storage is unavailable; readiness is reported by the health gate.
  }

  function readRow(id: string): RunRow | null {
    return database((db) => db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id) ?? null);
  }

  function emit(id: string) {
    if (!options.onUpdate) return;
    const row = readRow(id);
    if (row) options.onUpdate(view(row));
  }

  function transition(id: string, patch: Partial<Pick<RunRow, "state" | "heartbeat_at" | "stop_requested_at" | "stop_reason" | "error">>) {
    const at = new Date().toISOString();
    const fields = Object.keys(patch);
    if (!fields.length) return;
    const assignments = fields.map((field) => `${field} = ?`).join(", ");
    database((db) => db.query(`UPDATE runs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((field) => patch[field as keyof typeof patch] ?? null), at, id));
  }

  function launch(id: string, prompt: string) {
    let handle: AcpSessionHandle;
    try {
      handle = startAcpPrompt({
        command,
        args,
        cwd,
        prompt,
        env: agentEnv,
        wrapSpawn,
        onSessionId: () => { transition(id, { state: "running", heartbeat_at: new Date().toISOString() }); emit(id); },
        onProgress: () => { transition(id, { heartbeat_at: new Date().toISOString() }); emit(id); },
      });
    } catch (error) {
      transition(id, { state: "failed", stop_reason: "spawn_failed", error: String(error) });
      emit(id);
      return;
    }
    live.set(id, handle);
    const requestedStop = () => readRow(id)?.stop_requested_at ?? null;
    handle.done.then(({ stopReason }) => {
      live.delete(id);
      const stopped = requestedStop() !== null;
      const state: RunState = stopReason === "cancelled" || stopped
        ? "interrupted"
        : stopReason === "end_turn" ? "completed" : "failed";
      transition(id, { state, stop_reason: stopReason ?? (stopped ? "stop_requested" : "unknown") });
      emit(id);
    }).catch((error) => {
      live.delete(id);
      transition(id, { state: "failed", stop_reason: "client_error", error: String(error) });
      emit(id);
    });
  }

  function identity(request: Request): { userId: string; tokenHash: string; expiresAt: number } | null {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return null;
    return { userId, tokenHash, expiresAt };
  }

  function assertSession(owner: { userId: string; tokenHash: string; expiresAt: number }) {
    const db = new Database(databasePath, { readonly: true, create: false });
    try {
      const row = db.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(owner.userId, owner.tokenHash);
      if (!row || row.expires_at !== owner.expiresAt || row.expires_at <= Date.now()) throw new Error("unauthorized");
    } finally {
      db.close();
    }
  }

  const routes = new Elysia()
    .post("/api/runs", ({ body, request, set }) => {
      const owner = identity(request);
      if (!owner) { set.status = 401; return { error: "unauthorized" as const }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const result: { missing: true } | { existing: RunRow } | { row: RunRow } = database((db) => db.transaction(() => {
        const workspace = db.query<{ id: string }, [string, string]>(
          "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(body.workspaceId, owner.userId);
        if (!workspace) return { missing: true as const };
        if (body.requestId) {
          const existing = db.query<RunRow, [string, string]>(
            "SELECT * FROM runs WHERE id = ? AND user_id = ?",
          ).get(body.requestId, owner.userId);
          if (existing) return { existing };
        }
        const row: RunRow = {
          id: body.requestId ?? id, user_id: owner.userId, workspace_id: body.workspaceId,
          prompt: body.prompt, state: "starting", created_at: createdAt, updated_at: createdAt,
          heartbeat_at: null, stop_requested_at: null, stop_reason: null, error: null,
        };
        db.query(`INSERT INTO runs (id, user_id, workspace_id, prompt, state, created_at, updated_at, heartbeat_at, stop_requested_at, stop_reason, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          row.id, row.user_id, row.workspace_id, row.prompt, row.state, row.created_at, row.updated_at,
          row.heartbeat_at, row.stop_requested_at, row.stop_reason, row.error,
        );
        return { row };
      }).immediate());
      if ("missing" in result) { set.status = 404; return { error: "workspace_not_found" as const }; }
      if ("existing" in result) return view(result.existing);
      set.status = 201;
      launch(result.row.id, result.row.prompt);
      return view(result.row);
    }, { body: t.Object({
      workspaceId: uuidSchema,
      prompt: t.String({ minLength: 1, maxLength: 8_000 }),
      requestId: t.Optional(uuidSchema),
    }) })
    .get("/api/runs/:id", ({ params, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.id)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const row = database((db) => db.query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE id = ? AND user_id = ?",
      ).get(params.id, owner.userId) ?? null);
      if (!row) { set.status = 404; return { error: "not_found" as const }; }
      return view(row);
    }, { params: t.Object({ id: uuidSchema }) })
    .get("/api/workspaces/:workspaceId/runs", ({ params, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.workspaceId)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const rows = database((db) => db.query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50",
      ).all(params.workspaceId, owner.userId));
      return { runs: rows.map(view) };
    }, { params: t.Object({ workspaceId: uuidSchema }) })
    .post("/api/runs/:id/stop", ({ params, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.id)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const row = database((db) => db.query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE id = ? AND user_id = ?",
      ).get(params.id, owner.userId) ?? null);
      if (!row) { set.status = 404; return { error: "not_found" as const }; }
      if (TERMINAL_STATES.includes(row.state)) return view(row);
      const at = new Date().toISOString();
      transition(row.id, { stop_requested_at: at });
      emit(row.id);
      const handle = live.get(row.id);
      if (handle) {
        handle.cancel();
        // Bounded: if the agent does not report the cancelled final state, stop it.
        setTimeout(() => {
          const current = readRow(row.id);
          if (current && !TERMINAL_STATES.includes(current.state)) {
            live.get(row.id)?.kill();
            transition(row.id, { state: "interrupted", stop_reason: "stop_deadline" });
            emit(row.id);
          }
        }, STOP_DEADLINE_MS);
      } else {
        transition(row.id, { state: "interrupted", stop_reason: "not_running" });
        emit(row.id);
      }
      return view(readRow(row.id)!);
    }, { params: t.Object({ id: uuidSchema }) });

  return { routes, stopAll: () => { for (const handle of live.values()) handle.kill(); live.clear(); } };
}