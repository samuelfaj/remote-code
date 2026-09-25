import { treaty } from "@elysiajs/eden";
import type { App } from "@remotecode/api";

export function createApiClient(origin: string) {
  return treaty<App>(origin);
}
