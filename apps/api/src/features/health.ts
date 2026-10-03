import { Database } from "bun:sqlite";
import { Elysia } from "elysia";

const readinessTimeoutMs = 500;
const databaseProbeTimeoutMs = 400;

export type ReadinessCheck = () => Promise<boolean>;

export function initializeDatabase(databasePath: string) {
  let database: Database | undefined;
  try {
    database = new Database(databasePath);
    database.query("SELECT 1").get();
  } catch {
    // Readiness reports unavailable storage without preventing liveness.
  } finally {
    database?.close();
  }
}

export function checkDatabase(databasePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./sqlite-readiness.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const timer = setTimeout(() => finish(false), databaseProbeTimeoutMs);
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(ready);
    };
    worker.onmessage = (event: MessageEvent<boolean>) => finish(event.data);
    worker.onerror = () => finish(false);
    worker.postMessage(databasePath);
  });
}

export function healthFeature(readinessCheck: ReadinessCheck) {
  return new Elysia()
    .get("/api/health/live", () => ({ status: "alive" as const }))
    .get("/api/health/ready", async ({ set }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = await Promise.race([
        Promise.resolve().then(readinessCheck).catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), readinessTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!ready) {
        set.status = 503;
        return { status: "not_ready" as const };
      }
      return { status: "ready" as const };
    });
}
