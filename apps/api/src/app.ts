import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { actionsFeature } from "./features/actions";
import { authFeature } from "./features/auth";
import { compatibilityFeature } from "./features/compatibility";
import { storageFeature } from "./features/storage";
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
) {
  initializeDatabase(configuredDatabasePath);
  const actions = actionsFeature(configuredDatabasePath, authConfig.webOrigin ?? "http://localhost:5173");
  const corrupt = corruptAtStartup(configuredDatabasePath);
  return new Elysia()
    .onRequest(({ request, set }) => {
      if (!corrupt || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
      set.status = 503;
      return { error: "storage_unavailable" as const };
    })
    .use(compatibilityFeature())
    .use(healthFeature(readinessCheck))
    .use(authFeature(configuredDatabasePath, authConfig, actions.revokeSessions))
    .use(actions.routes)
    .use(storageFeature(configuredDatabasePath));
}

export const app = createApi();
export type App = typeof app;
