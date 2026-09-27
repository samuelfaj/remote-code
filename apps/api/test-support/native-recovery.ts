import { Elysia } from "elysia";
import { createApi } from "../src/app";
import { isAuthenticated } from "../src/features/auth";

export function createNativeRecoveryTestApi(databasePath: string, password: string) {
  let armed = false;
  let lostResponse = false;
  let failedRead = false;
  let actionPosts = 0;
  let requestId: string | null = null;
  return new Elysia()
    .onBeforeHandle({ as: "global" }, ({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (armed && request.method === "POST" && path === "/api/actions") actionPosts++;
      if (lostResponse && !failedRead && request.method === "GET" && path.startsWith("/api/actions/receipts/")) {
        failedRead = true;
        set.status = 503;
        return { error: "injected_receipt_read_unavailable" };
      }
    })
    .onAfterHandle({ as: "global" }, ({ request, body, set }) => {
      if (!armed || lostResponse || request.method !== "POST" || new URL(request.url).pathname !== "/api/actions" || set.status !== 201) return;
      lostResponse = true;
      if (typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string") requestId = body.requestId;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
      }), { status: 201, headers: { "content-type": "application/json" } });
    })
    .use(createApi(databasePath, undefined, { password, webOrigin: "http://localhost:5173" }))
    .post("/__test__/lose-action-response", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      armed = true;
      lostResponse = false;
      failedRead = false;
      actionPosts = 0;
      requestId = null;
      return { armed: true };
    })
    .get("/__test__/response-loss", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return { lostResponse, failedRead, actionPosts, requestId };
    });
}

if (import.meta.main) {
  const path = process.env.DATABASE_PATH;
  const password = process.env.REMOTECODE_AUTH_PASSWORD;
  if (!path || !password) throw new Error("The native test requires an isolated database and host password");
  createNativeRecoveryTestApi(path, password).listen({ hostname: "127.0.0.1", port: Number(process.env.API_PORT ?? 39211) });
}
