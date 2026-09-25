import { Elysia } from "elysia";
import { actionsFeature } from "./features/actions";
import { healthFeature } from "./features/health";

export function createApi() {
  return new Elysia()
    .use(healthFeature())
    .use(actionsFeature());
}

export const app = createApi();
export type App = typeof app;
