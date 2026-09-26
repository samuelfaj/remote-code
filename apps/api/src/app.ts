import { Elysia } from "elysia";
import { actionsFeature } from "./features/actions";
import { authFeature } from "./features/auth";
import { compatibilityFeature } from "./features/compatibility";
import { storageFeature } from "./features/storage";
import { checkDatabase, healthFeature, initializeDatabase, type ReadinessCheck } from "./features/health";

const databasePath = process.env.DATABASE_PATH ?? "/tmp/remotecode.sqlite";

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
  return new Elysia()
    .use(compatibilityFeature())
    .use(healthFeature(readinessCheck))
    .use(authFeature(configuredDatabasePath, authConfig, actions.revokeSessions))
    .use(actions.routes)
    .use(storageFeature(configuredDatabasePath));
}

export const app = createApi();
export type App = typeof app;
