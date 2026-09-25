import { treaty } from "@elysiajs/eden";
import type { App } from "../../../apps/api/src/app";

export function createApiClient(origin: string) {
  return treaty<App>(origin);
}
