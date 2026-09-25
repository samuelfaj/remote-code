import { Elysia } from "elysia";
import { actionsFeature } from "./features/actions";

export function createApi() {
  return new Elysia()
    .get("/api/health", () => ({ status: "ready" }))
    .use(actionsFeature());
}

export const app = createApi();
export type App = typeof app;
