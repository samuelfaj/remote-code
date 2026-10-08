import { Database } from "bun:sqlite";
import { readlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { startAcpPrompt, type AcpSessionHandle } from "./acp-distill";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";
import { hasGitDir, parsePorcelain, runGit } from "./workspace-git";
import { recordInboxItem } from "./inbox";
import type { LiveNotifier } from "./live";
import { appendRunMessage, ensureRunThread } from "./messages";

export type RunState = "starting" | "running" | "completed" | "interrupted" | "failed" | "needs_user";

export type RunView = {
  id: string;
  workspaceId: string;
  botId: string | null;
  state: RunState;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string | null;
  stopRequestedAt: string | null;
  stopReason: string | null;
  error: string | null;
  sessionId: string | null;
  handoffReason: string | null;
  retryAfterSeconds: number | null;
  threadId: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.String({ minLength: 36, maxLength: 36 });
const TERMINAL_STATES: RunState[] = ["completed", "interrupted", "failed"];
const STOP_DEADLINE_MS = 10_000;
const maxDiffBytes = 64 * 1024;

type RunRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  bot_id: string | null;
  prompt: string;
  state: RunState;
  created_at: string;
  updated_at: string;
  heartbeat_at: string | null;
  stop_requested_at: string | null;
  stop_reason: string | null;
  error: string | null;
  session_id: string | null;
  handoff_reason: string | null;
  retry_after_seconds: number | null;
  thread_id: string | null;
};

function view(row: RunRow): RunView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    botId: row.bot_id,
    state: row.state,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    heartbeatAt: row.heartbeat_at,
    stopRequestedAt: row.stop_requested_at,
    stopReason: row.stop_reason,
    error: row.error,
    sessionId: row.session_id,
    handoffReason: row.handoff_reason,
    retryAfterSeconds: row.retry_after_seconds,
    threadId: row.thread_id,
  };
}

export function classifyProviderFailure(stopReason: string | null, message: string | null):
  { stopReason: string | null; retryAfterSeconds: number | null } {
  if (stopReason !== "prompt_error") return { stopReason, retryAfterSeconds: null };
  const msg = (message ?? "").toLowerCase();
  if (/401|403|unauthori|unauthoriz|credential|api[-_ ]?key|token (expired|invalid)|expired/i.test(msg)) {
    return { stopReason: "provider_auth_expired", retryAfterSeconds: null };
  }
  if (/429|rate[-_ ]?limit|too many requests|quota|usage limit/i.test(msg)) {
    const match = msg.match(/retry[-_ ]?after[^0-9]{0,4}(\d{1,6})/i);
    return { stopReason: "provider_rate_limited", retryAfterSeconds: match ? parseInt(match[1], 10) : null };
  }
  if (/503|502|500|unavailable|econn|etimedout|timed out|network|socket|overloaded|temporar/i.test(msg)) {
    return { stopReason: "provider_unavailable", retryAfterSeconds: null };
  }
  return { stopReason: "provider_failed", retryAfterSeconds: null };
}

export function runsFeature(
  databasePath: string,
  options: {
    command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
    agentUser?: string; agentHome?: string;
    wrapSpawn?: (command: string, args: string[]) => { command: string; args: string[] };
    onUpdate?: (run: RunView, userId: string) => void;
    onChange?: LiveNotifier;
    stallMs?: number;
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
  const pendingPermissions = new Map<string, {
    runId: string;
    requestId: string;
    title: string;
    kind: string | null;
    options: Array<{ optionId: string; kind: string; name: string | null }>;
    toolCall: unknown;
    requestedAt: string;
    resolve: (result: { optionId?: string; cancelled?: boolean }) => void;
  }>();

  function cancelPendingPermissions(runId: string) {
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.runId === runId) {
        pending.resolve({ cancelled: true });
        pendingPermissions.delete(requestId);
      }
    }
  }

  const stallMs = options.stallMs ?? Number(process.env.REMOTECODE_RUN_STALL_MS ?? 600_000);
  let watchdogInterval: ReturnType<typeof setInterval> | undefined;
  if (stallMs > 0) {
    const period = Math.max(250, Math.min(Math.floor(stallMs / 2), 5_000));
    watchdogInterval = setInterval(() => {
      // Only a run with a live agent process can stall; skipping the scan when
      // there is none keeps the watchdog from polling an idle API's database.
      if (live.size === 0) return;
      try {
        const now = Date.now();
        const rows = database((db) => db.query<RunRow, []>(
          "SELECT * FROM runs WHERE state IN ('starting', 'running')",
        ).all());
        for (const row of rows) {
          const progressAt = row.heartbeat_at
            ? new Date(row.heartbeat_at).getTime()
            : new Date(row.created_at).getTime();
          if (now - progressAt <= stallMs) continue;
          const current = readRow(row.id);
          if (!current || TERMINAL_STATES.includes(current.state) || current.state === "needs_user") continue;
          live.get(row.id)?.kill();
          live.delete(row.id);
          transition(row.id, { state: "interrupted", stop_reason: "stalled" });
          emit(row.id);
        }
      } catch {
        // Storage is unavailable; readiness reports the degraded service and
        // the next tick retries. A timer must never crash the API.
      }
    }, period);
  }

  function database<T>(callback: (db: Database) => T): T {
    mkdirSync(dirname(databasePath), { recursive: true });
    const db = new Database(databasePath, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 250");
      db.exec(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        bot_id TEXT,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        heartbeat_at TEXT,
        stop_requested_at TEXT,
        stop_reason TEXT,
        error TEXT,
        session_id TEXT,
        handoff_reason TEXT,
        retry_after_seconds INTEGER,
        thread_id TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS runs_workspace ON runs(workspace_id, created_at)");
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
      const columnNames = columns.map((column) => column.name);
      if (!columnNames.includes("bot_id")) db.exec("ALTER TABLE runs ADD COLUMN bot_id TEXT");
      if (!columnNames.includes("thread_id")) db.exec("ALTER TABLE runs ADD COLUMN thread_id TEXT");
      for (const name of ["session_id", "handoff_reason", "retry_after_seconds"]) {
        if (!columnNames.includes(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} INTEGER`);
      }
      const changeColumns = db.query<{ name: string }, []>("PRAGMA table_info(run_changes)").all();
      const changeColumnNames = changeColumns.map((column) => column.name);
      if (changeColumnNames.length === 0) {
        db.exec(`CREATE TABLE IF NOT EXISTS run_changes (
          run_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          payload TEXT NOT NULL
        )`);
      }
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
    if (row) options.onUpdate(view(row), row.user_id);
  }

  function captureRunChanges(runId: string, workspaceId: string, userId: string): void {
    try {
      const result = withProvisionedWorkspaceFolder(databasePath, userId, workspaceId, (folderFd, openAt, close) => {
        if (!hasGitDir(folderFd, openAt, close)) return { status: 404 as const };
        const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
        const status = runGit(folderPath, ["status", "--porcelain=v1", "--untracked-files=normal", "--", "."]);
        if (status.exitCode !== 0) return { status: 503 as const };
        const lines = status.stdout.split("\n").filter((l) => l.length >= 4);
        const files = lines.map((line) => ({ path: line.slice(3).trim(), changeKind: line.slice(0, 2) }));
        const diff = runGit(folderPath, ["diff", "--no-color", "--no-ext-diff", "--"]);
        if (diff.exitCode !== 0) return { status: 503 as const };
        const bytes = Buffer.from(diff.stdout, "utf8");
        const truncated = bytes.length > maxDiffBytes;
        const payload = JSON.stringify({
          files,
          diff: bytes.subarray(0, maxDiffBytes).toString("utf8"),
          truncated,
        });
        return { status: 200 as const, payload };
      });
      if (result.kind !== "opened" || result.value.status !== 200) return;
      database((db) => {
        db.query("INSERT OR IGNORE INTO run_changes (run_id, workspace_id, captured_at, payload) VALUES (?, ?, ?, ?)")
          .run(runId, workspaceId, new Date().toISOString(), result.value.payload as string);
      });
    } catch {
      // Never fail the run state machine for a capture error.
    }
  }

  function transition(id: string, patch: Partial<Pick<RunRow, "state" | "heartbeat_at" | "stop_requested_at" | "stop_reason" | "error" | "session_id" | "handoff_reason" | "retry_after_seconds">>) {
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
        onPermissionRequest: (request) => {
          return new Promise((resolve) => {
            pendingPermissions.set(request.requestId, {
              ...request,
              runId: id,
              requestedAt: new Date().toISOString(),
              resolve,
            });
          });
        },
        onSessionId: (sessionId) => {
          // A handoff can arrive while the agent is still creating its session;
          // record the id without pulling the run back out of needs_user.
          const waiting = readRow(id)?.state === "needs_user";
          transition(id, {
            ...(waiting ? {} : { state: "running" as const }),
            heartbeat_at: new Date().toISOString(),
            session_id: sessionId,
          });
          emit(id);
        },
        onProgress: () => { transition(id, { heartbeat_at: new Date().toISOString() }); emit(id); },
      });
    } catch (error) {
      transition(id, { state: "failed", stop_reason: "spawn_failed", error: String(error) });
      emit(id);
      return;
    }
    live.set(id, handle);
    const requestedStop = () => readRow(id)?.stop_requested_at ?? null;
    handle.done.then(({ stopReason, error: acpError, text }) => {
      cancelPendingPermissions(id);
      live.delete(id);
      const current = readRow(id);
      // A handoff or an earlier honest ending (stop deadline, stall watchdog)
      // must not be replaced by whatever the agent reports afterwards.
      if (!current || TERMINAL_STATES.includes(current.state) || current.state === "needs_user") return;
      const stopped = requestedStop() !== null;
      const state: RunState = stopReason === "cancelled" || stopped
        ? "interrupted"
        : stopReason === "end_turn" ? "completed" : "failed";
      const classified = classifyProviderFailure(stopReason, acpError ?? null);
      transition(id, {
        state,
        stop_reason: classified.stopReason ?? (stopped ? "stop_requested" : "unknown"),
        ...(acpError ? { error: acpError } : {}),
        ...(classified.retryAfterSeconds !== null ? { retry_after_seconds: classified.retryAfterSeconds } : {}),
      });
      emit(id);
      // Record the agent's reply on the run's thread. An empty answer records
      // nothing: the transcript must never invent agent words.
      if (current?.thread_id && state === "completed" && text.trim().length > 0) {
        const appended = appendRunMessage(databasePath, { userId: current.user_id, threadId: current.thread_id, runId: id, kind: "assistant", body: text });
        if (appended) options.onChange?.({ userId: current.user_id, type: "message.changed", workspaceId: current.workspace_id });
      }
      if (current) captureRunChanges(id, current.workspace_id, current.user_id);
      if (current) {
        const dest = { screen: "run" as const, runId: id, workspaceId: current.workspace_id, botId: current.bot_id };
        const kind = state === "failed" ? "intervention" : state === "completed" ? "result" : "intervention";
        const title = state === "failed" ? "Run failed" : state === "completed" ? "Run finished" : "Run interrupted";
        try { recordInboxItem(databasePath, { userId: current.user_id, kind, botId: current.bot_id, workspaceId: current.workspace_id, runId: id, title, destination: dest, dedupeKey: `run:${id}:${kind}` }); } catch { /* never fail the run state machine */ }
      }
    }).catch((error) => {
      cancelPendingPermissions(id);
      live.delete(id);
      transition(id, { state: "failed", stop_reason: "client_error", error: String(error) });
      emit(id);
      const current = readRow(id);
      if (current) {
        const dest = { screen: "run" as const, runId: id, workspaceId: current.workspace_id, botId: current.bot_id };
        try { recordInboxItem(databasePath, { userId: current.user_id, kind: "intervention", botId: current.bot_id, workspaceId: current.workspace_id, runId: id, title: "Run failed", destination: dest, dedupeKey: `run:${id}:intervention` }); } catch { /* never fail the run state machine */ }
      }
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

  function startRun(owner: { userId: string }, input: { workspaceId: string; prompt: string; botId?: string; requestId?: string }):
    { kind: "ok"; run: RunView; created: boolean } | { kind: "not_found"; what: "workspace" | "bot" } | { kind: "failed"; error: string } {
    const result: { workspaceMissing: true } | { botNotFound: true } | { existing: RunRow; conflict?: boolean } | { row: RunRow; botName: string | null } = database((db) => db.transaction(() => {
      const workspace = db.query<{ id: string }, [string, string]>(
        "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
      ).get(input.workspaceId, owner.userId);
      if (!workspace) return { workspaceMissing: true as const };
      let composedPrompt = input.prompt;
      let botName: string | null = null;
      if (input.botId) {
        const bot = db.query<{ id: string; user_id: string; instructions: string; name: string }, [string, string]>(
          "SELECT id, user_id, instructions, name FROM bots WHERE id = ? AND user_id = ?",
        ).get(input.botId, owner.userId);
        if (!bot) return { botNotFound: true as const };
        botName = bot.name;
        composedPrompt = bot.instructions ? `${bot.instructions}\n\n${input.prompt}` : input.prompt;
      }
      if (input.requestId) {
        const existing = db.query<RunRow, [string, string]>(
          "SELECT * FROM runs WHERE id = ? AND user_id = ?",
        ).get(input.requestId, owner.userId);
        if (existing) {
          if (existing.prompt !== composedPrompt) return { existing, conflict: true };
          return { existing };
        }
      }
      const id = input.requestId ?? crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const row: RunRow = {
        id, user_id: owner.userId, workspace_id: input.workspaceId,
        bot_id: input.botId ?? null, prompt: composedPrompt, state: "starting", created_at: createdAt, updated_at: createdAt,
        heartbeat_at: null, stop_requested_at: null, stop_reason: null, error: null,
        session_id: null, handoff_reason: null, retry_after_seconds: null, thread_id: null,
      };
      db.query(`INSERT INTO runs (id, user_id, workspace_id, bot_id, prompt, state, created_at, updated_at, heartbeat_at, stop_requested_at, stop_reason, error, session_id, handoff_reason, retry_after_seconds, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, row.user_id, row.workspace_id, row.bot_id, row.prompt, row.state, row.created_at, row.updated_at,
        row.heartbeat_at, row.stop_requested_at, row.stop_reason, row.error, row.session_id, row.handoff_reason, row.retry_after_seconds,
        row.thread_id,
      );
      return { row, botName };
    }).immediate());
    if ("workspaceMissing" in result) return { kind: "not_found", what: "workspace" };
    if ("botNotFound" in result) return { kind: "not_found", what: "bot" };
    if ("existing" in result) {
      if (result.conflict) return { kind: "failed", error: "request_id_conflict" };
      // A repeated request id returns the existing run, so the caller sees 200.
      return { kind: "ok", run: view(result.existing), created: false };
    }
    // Only a freshly inserted run records a transcript: the prompt as the user
    // turn, on a thread titled after the bot (or "Chat" for a plain run).
    const row = result.row;
    const title = result.botName ?? "Chat";
    const threadId = ensureRunThread(databasePath, { userId: owner.userId, workspaceId: row.workspace_id, title });
    if (threadId) {
      row.thread_id = threadId;
      database((db) => db.query("UPDATE runs SET thread_id = ? WHERE id = ?").run(threadId, row.id));
      const appended = appendRunMessage(databasePath, { userId: owner.userId, threadId, runId: row.id, kind: "user", body: row.prompt });
      if (appended) options.onChange?.({ userId: owner.userId, type: "message.changed", workspaceId: row.workspace_id });
    }
    // A host that names the variable holding the model's credential must have it.
    // Failing here says exactly what is missing, instead of letting the agent
    // start and report the provider's opaque "Internal error".
    const modelKey = process.env.REMOTECODE_AGENT_MODEL_ENV_KEY;
    if (modelKey && !process.env[modelKey]) {
      transition(row.id, {
        state: "failed",
        stop_reason: "credential_missing",
        error: `${modelKey} is not set on this host, so the agent has no provider credential. Set it and start the dev host again.`,
      });
      emit(row.id);
      try {
        recordInboxItem(databasePath, {
          userId: owner.userId,
          kind: "intervention",
          botId: row.bot_id,
          workspaceId: row.workspace_id,
          runId: row.id,
          title: "Run failed",
          destination: { screen: "run", runId: row.id, workspaceId: row.workspace_id, botId: row.bot_id },
          dedupeKey: `run:${row.id}:intervention`,
        });
      } catch { /* never fail the run state machine */ }
      return { kind: "ok", run: view(readRow(row.id) ?? row), created: true };
    }
    launch(row.id, row.prompt);
    return { kind: "ok", run: view(row), created: true };
  }

  const routes = new Elysia()
    .post("/api/runs", ({ body, request, set }) => {
      const owner = identity(request);
      if (!owner) { set.status = 401; return { error: "unauthorized" as const }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const result = startRun(owner, { workspaceId: body.workspaceId, prompt: body.prompt, requestId: body.requestId });
      if (result.kind === "not_found") { set.status = 404; return { error: result.what === "workspace" ? "workspace_not_found" : "bot_not_found" }; }
      if (result.kind === "failed") { set.status = 409; return { error: result.error }; }
      set.status = result.created ? 201 : 200;
      return result.run;
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
      const result = database((db) => {
        // Another user's workspace is denied like every other per-workspace
        // route, instead of answering an empty list.
        const workspace = db.query<unknown, [string, string]>(
          "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
        ).get(params.workspaceId, owner.userId);
        if (!workspace) return null;
        return db.query<RunRow, [string, string]>(
          "SELECT * FROM runs WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50",
        ).all(params.workspaceId, owner.userId);
      });
      if (result === null) { set.status = 404; return { error: "not_found" as const }; }
      return { runs: result.map(view) };
    }, { params: t.Object({ workspaceId: uuidSchema }) })
    .post("/api/bots/:id/run", ({ params, body, request, set }) => {
      const owner = identity(request);
      if (!owner) { set.status = 401; return { error: "unauthorized" as const }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const result = startRun(owner, { workspaceId: body.workspaceId, prompt: body.prompt, botId: params.id, requestId: body.requestId });
      if (result.kind === "not_found") { set.status = 404; return { error: result.what === "workspace" ? "workspace_not_found" : "bot_not_found" }; }
      if (result.kind === "failed") { set.status = 409; return { error: result.error }; }
      set.status = result.created ? 201 : 200;
      return result.run;
    }, { body: t.Object({
      workspaceId: uuidSchema,
      prompt: t.String({ minLength: 1, maxLength: 8_000 }),
      requestId: t.Optional(uuidSchema),
    }) })
    .get("/api/bots/:id/runs", ({ params, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.id)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const bot = database((db) => db.query<{ user_id: string }, [string]>(
        "SELECT user_id FROM bots WHERE id = ?",
      ).get(params.id));
      if (!bot || bot.user_id !== owner.userId) { set.status = 404; return { error: "bot_not_found" as const }; }
      const rows = database((db) => db.query<RunRow, [string]>(
        "SELECT * FROM runs WHERE bot_id = ? ORDER BY created_at DESC LIMIT 50",
      ).all(params.id));
      return { runs: rows.map(view) };
    }, { params: t.Object({ id: uuidSchema }) })
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
            const dest = { screen: "run" as const, runId: row.id, workspaceId: current.workspace_id, botId: current.bot_id };
            try { recordInboxItem(databasePath, { userId: current.user_id, kind: "intervention", botId: current.bot_id, workspaceId: current.workspace_id, runId: row.id, title: "Run interrupted", destination: dest, dedupeKey: `run:${row.id}:intervention` }); } catch { /* never fail the run state machine */ }
          }
        }, STOP_DEADLINE_MS);
      } else {
        transition(row.id, { state: "interrupted", stop_reason: "not_running" });
        emit(row.id);
        const current = readRow(row.id);
        if (current) {
          const dest = { screen: "run" as const, runId: row.id, workspaceId: current.workspace_id, botId: current.bot_id };
          try { recordInboxItem(databasePath, { userId: current.user_id, kind: "intervention", botId: current.bot_id, workspaceId: current.workspace_id, runId: row.id, title: "Run interrupted", destination: dest, dedupeKey: `run:${row.id}:intervention` }); } catch { /* never fail the run state machine */ }
        }
      }
      return view(readRow(row.id)!);
    }, { params: t.Object({ id: uuidSchema }) })
    .post("/api/runs/:id/handoff", ({ params, body, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.id)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const row = database((db) => db.query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE id = ? AND user_id = ?",
      ).get(params.id, owner.userId) ?? null);
      if (!row) { set.status = 404; return { error: "not_found" as const }; }
      if (TERMINAL_STATES.includes(row.state)) { set.status = 409; return { error: "run_finished" as const }; }
      if (row.state === "needs_user") return view(row);
      cancelPendingPermissions(row.id);
      transition(row.id, { state: "needs_user", handoff_reason: body.reason });
      emit(row.id);
      const handoffRow = readRow(row.id)!;
      const handoffDest = { screen: "run" as const, runId: row.id, workspaceId: handoffRow.workspace_id, botId: handoffRow.bot_id };
      try { recordInboxItem(databasePath, { userId: handoffRow.user_id, kind: "needs_you", botId: handoffRow.bot_id, workspaceId: handoffRow.workspace_id, runId: row.id, title: "Needs you", destination: handoffDest, dedupeKey: `run:${row.id}:needs_you` }); } catch { /* never fail the run state machine */ }
      return view(handoffRow);
    }, { params: t.Object({ id: uuidSchema }), body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) }) })
    .get("/api/runs/:id/permissions", ({ params, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.id)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const row = database((db) => db.query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE id = ? AND user_id = ?",
      ).get(params.id, owner.userId) ?? null);
      if (!row) { set.status = 404; return { error: "not_found" as const }; }
      const permissions = Array.from(pendingPermissions.values())
        .filter((pending) => pending.runId === row.id)
        .map((pending) => ({
          requestId: pending.requestId,
          title: pending.title,
          kind: pending.kind,
          options: pending.options,
          toolCall: pending.toolCall,
          requestedAt: pending.requestedAt,
        }));
      return { permissions };
    }, { params: t.Object({ id: uuidSchema }) })
    .post("/api/runs/:id/permissions/:requestId", ({ params, body, request, set }) => {
      const owner = identity(request);
      if (!owner || !uuid.test(params.id)) { set.status = owner ? 404 : 401; return { error: owner ? "not_found" : "unauthorized" }; }
      try { assertSession(owner); } catch { set.status = 401; return { error: "unauthorized" as const }; }
      const row = database((db) => db.query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE id = ? AND user_id = ?",
      ).get(params.id, owner.userId) ?? null);
      if (!row) { set.status = 404; return { error: "not_found" as const }; }
      const pending = pendingPermissions.get(params.requestId);
      if (!pending || pending.runId !== row.id) { set.status = 404; return { error: "permission_not_found" as const }; }
      const decision = body.decision as string;
      if (decision === "allow") {
        const allowOption = pending.options.find(
          (option) => option.kind === "allow_once" || option.kind === "allow_always" ||
            option.optionId.includes("allow") || option.kind.includes("allow"),
        );
        if (!allowOption) { set.status = 409; return { error: "permission_not_available" as const }; }
        pending.resolve({ optionId: allowOption.optionId });
        pendingPermissions.delete(params.requestId);
        return { decision: "allow", optionId: allowOption.optionId };
      }
      const denyOption = pending.options.find(
        (option) => option.optionId.includes("deny") || option.optionId.includes("reject") || option.optionId.includes("abort") ||
          option.kind.includes("deny") || option.kind.includes("reject") || option.kind.includes("abort"),
      );
      pending.resolve(denyOption ? { optionId: denyOption.optionId } : { cancelled: true });
      pendingPermissions.delete(params.requestId);
      return { decision: "deny", optionId: denyOption?.optionId };
    }, { params: t.Object({ id: uuidSchema, requestId: t.String({ minLength: 1 }) }), body: t.Object({
      decision: t.Union([t.Literal("allow"), t.Literal("deny")]),
    }) });

  return { routes, startRun, stopAll: () => { if (watchdogInterval !== undefined) clearInterval(watchdogInterval); for (const handle of live.values()) handle.kill(); live.clear(); } };
}
