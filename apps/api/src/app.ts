import { Elysia } from "elysia";
import { actionsFeature } from "./features/actions";
import { checkDatabase, healthFeature, initializeDatabase, type ReadinessCheck } from "./features/health";

const databasePath = process.env.DATABASE_PATH ?? "/tmp/remotecode.sqlite";

export function createApi(
  configuredDatabasePath = databasePath,
  readinessCheck: ReadinessCheck = () => checkDatabase(configuredDatabasePath),
) {
  initializeDatabase(configuredDatabasePath);
  return new Elysia()
    .use(healthFeature(readinessCheck))
    .use(actionsFeature(configuredDatabasePath));
}

export const app = createApi();
export type App = typeof app;
