import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { actionsFeature } from "./features/actions";
import { authFeature, sessionToken } from "./features/auth";
import { compatibilityFeature } from "./features/compatibility";
import { storageFeature } from "./features/storage";
import { fileRequestSchemaReady } from "./features/file-requests";
import { workspaceFilesFeature } from "./features/workspace-files";
import { gitStatusFeature } from "./features/workspace-git";
import { botsFeature } from "./features/bots";
import { sshFeature } from "./features/ssh";
import { workspaceLayoutFeature } from "./features/workspace-layout";
import { terminalsFeature } from "./features/terminals";
import { runsFeature } from "./features/runs";
import { workspaceFolderSchemaReady, workspaceFoldersFeature } from "./features/workspace-folders";
import { checkDatabase, healthFeature, initializeDatabase, type ReadinessCheck } from "./features/health";

const databasePath = process.env.DATABASE_PATH ?? "/tmp/remotecode.sqlite";

function corruptAtStartup(path: string) {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, create: false });
    const result = database.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    return result.length !== 1 || result[0]?.quick_check !== "ok";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") return false;
    return true;
  } finally {
    database?.close();
  }
}

export function createApi(
  configuredDatabasePath = databasePath,
  readinessCheck: ReadinessCheck = () => checkDatabase(configuredDatabasePath),
  authConfig: {
    password?: string;
    sessionTtlMs?: number;
    webOrigin?: string;
  } = {
    password: process.env.REMOTECODE_AUTH_PASSWORD,
    sessionTtlMs: process.env.REMOTECODE_AUTH_SESSION_TTL_MS
      ? Number(process.env.REMOTECODE_AUTH_SESSION_TTL_MS)
      : undefined,
    webOrigin: process.env.REMOTECODE_WEB_ORIGIN ?? "http://localhost:5173",
  },
  terminalConfig: Parameters<typeof terminalsFeature>[1] =
    process.env.REMOTECODE_TERMINAL_VOLUME && process.env.REMOTECODE_TERMINAL_IMAGE
      ? { volumeName: process.env.REMOTECODE_TERMINAL_VOLUME, image: process.env.REMOTECODE_TERMINAL_IMAGE }
      : undefined,
  runsConfig: Parameters<typeof runsFeature>[1] =
    process.env.REMOTECODE_DISTILL_BIN || process.env.REMOTECODE_RUNS_CWD || process.env.REMOTECODE_AGENT_USER
      ? {
          command: process.env.REMOTECODE_DISTILL_BIN,
          cwd: process.env.REMOTECODE_RUNS_CWD,
          agentUser: process.env.REMOTECODE_AGENT_USER,
          agentHome: process.env.REMOTECODE_AGENT_HOME,
        }
      : undefined,
) {
  initializeDatabase(configuredDatabasePath);
  const actions = actionsFeature(configuredDatabasePath, authConfig.webOrigin ?? "http://localhost:5173");
  const storage = storageFeature(configuredDatabasePath);
  const terminals = terminalsFeature(configuredDatabasePath, terminalConfig);
  const runs = runsFeature(configuredDatabasePath, {
    ...(runsConfig ?? {}),
    onUpdate: (run) => actions.broadcast({ type: "run.updated", run }),
  });
  if (configuredDatabasePath === databasePath) registerTerminalsShutdown(terminals.shutdown);
  const workspaceFolders = workspaceFoldersFeature(configuredDatabasePath, undefined, terminals.workspaceIdentity);
  let storageUnavailable = corruptAtStartup(configuredDatabasePath) || !workspaceFolders.isReady() ||
    !fileRequestSchemaReady(configuredDatabasePath);
  let probe: Promise<boolean> | null = null;
  const observeReadiness = () => {
    if (probe) return probe;
    let timer: ReturnType<typeof setTimeout> | undefined;
    probe = Promise.race([
      Promise.resolve().then(readinessCheck)
        .then((ready) => ready && workspaceFolders.isReady() && workspaceFolderSchemaReady(configuredDatabasePath) &&
          fileRequestSchemaReady(configuredDatabasePath))
        .catch(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 400); }),
    ]).then((ready) => { storageUnavailable = !ready; return ready; })
      .finally(() => { if (timer) clearTimeout(timer); probe = null; });
    return probe;
  };
  return new Elysia()
    .onBeforeHandle({ as: "global" }, async ({ request, set, route }) => {
      const path = route;
      const receiptLookup = request.method === "POST" && /^\/api\/auth\/receipts\/[^/]+\/lookup$/.test(path);
      // Password-only receipt lookup is read-only; a cookie-carrying lookup
      // may delete an expired session row, so it still probes storage below.
      if (receiptLookup && !sessionToken(request)) return;
      // GET /api/auth/session and file receipts may write during recovery; other GETs are reads.
      const sessionCheck = request.method === "GET" && path === "/api/auth/session";
      const fileReceiptLookup = request.method === "GET" &&
        /^\/api\/workspaces\/[^/]+\/files\/receipts\/[^/]+\/?$/.test(path);
      if ((sessionCheck || fileReceiptLookup) && !sessionToken(request)) return;
      if (sessionCheck || fileReceiptLookup || request.method !== "GET") {
        const publicCredentialMutation = path === "/api/auth/login" || /^\/api\/auth\/login\/[^/]+\/revoke$/.test(path);
        if (!publicCredentialMutation && !sessionToken(request)) return;
        await observeReadiness();
        if (!storageUnavailable) return;
        set.status = 503;
        return { error: "storage_unavailable" as const };
      }
      return;
    })
    .use(compatibilityFeature())
    .use(healthFeature(observeReadiness))
    .use(authFeature(configuredDatabasePath, authConfig, (userId, tokenHash) => {
      actions.revokeSessions(userId, tokenHash);
      terminals.revokeSessions(userId, tokenHash);
    }))
    .use(actions.routes)
    .use(storage)
    .use(workspaceFolders.routes)
    .use(workspaceFilesFeature(configuredDatabasePath))
    .use(gitStatusFeature(configuredDatabasePath))
    .use(sshFeature(configuredDatabasePath))
    .use(botsFeature(configuredDatabasePath))
    .use(workspaceLayoutFeature(configuredDatabasePath).routes)
    .use(terminals.routes)
    .use(runs.routes)
    .onStop(() => { terminals.stopAll(); runs.stopAll(); });
}

let terminalsShutdownHandler: (() => Promise<void>) | null = null;

// Direct terminal shutdown for process signal handlers. Elysia's stop()
// only fires onStop when app.server is set; a SIGTERM racing server reload
// would otherwise skip terminals.stopAll and strand live PTY actors.
export function terminalsShutdown(): Promise<void> {
  if (!terminalsShutdownHandler) return Promise.resolve();
  return terminalsShutdownHandler();
}

export function registerTerminalsShutdown(handler: () => Promise<void>) {
  terminalsShutdownHandler = handler;
}

export const app = createApi();
export type App = typeof app;
