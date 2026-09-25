import { Elysia } from "elysia";

export function healthFeature() {
  return new Elysia().get("/api/health", () => ({ status: "ready" as const }));
}
