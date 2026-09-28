import { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { createApi } from "../src/app";
import { isAuthenticated } from "../src/features/auth";

export function createNativeRecoveryTestApi(databasePath: string, password: string) {
  let lockOwner: Database | undefined;
  let lockCookie: string | undefined;
  let authFault: string | null = null;
  let loginPosts = 0;
  let revokePosts = 0;
  let logoutPosts = 0;
  let loginRequestId: string | null = null;
  let revokeRequestId: string | null = null;
  let logoutRequestId: string | null = null;
  let armed = false;
  let lostResponse = false;
  let failedRead = false;
  let actionPosts = 0;
  let requestId: string | null = null;
  return new Elysia()
    .onBeforeHandle({ as: "global" }, ({ request, body, set }) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string") {
        if (path === "/api/auth/login") { loginPosts++; loginRequestId = body.requestId; }
        if (path.endsWith("/revoke")) { revokePosts++; revokeRequestId = body.requestId; }
        if (path === "/api/auth/logout") { logoutPosts++; logoutRequestId = body.requestId; }
      }
      if (authFault === "login-before" && request.method === "POST" && path === "/api/auth/login") {
        authFault = null;
        set.status = 503;
        return { error: "injected_before_login" };
      }
      if (armed && request.method === "POST" && path === "/api/actions") actionPosts++;
      if (lostResponse && !failedRead && request.method === "GET" && path.startsWith("/api/actions/receipts/")) {
        failedRead = true;
        set.status = 503;
        return { error: "injected_receipt_read_unavailable" };
      }
    })
    .onAfterHandle({ as: "global" }, ({ request, body, set }) => {
      const path = new URL(request.url).pathname;
      const matchesAuth = request.method === "POST" && (
        (path === "/api/auth/login" && (authFault === "login-cookie" || authFault === "login-body" || authFault === "login-401"))
        || (path.endsWith("/revoke") && (authFault === "revoke-body" || authFault === "revoke-401"))
        || (path === "/api/auth/logout" && authFault === "logout-body")
      );
      if (matchesAuth && (set.status === 200 || set.status === undefined)) {
        if (authFault === "login-cookie" || authFault === "login-401") delete set.headers["set-cookie"];
        if (authFault === "login-401" || authFault === "revoke-401") {
          authFault = null;
          return new Response(JSON.stringify({ error: "injected_proxy_unauthorized" }), {
            status: 401, headers: { "content-type": "application/json" },
          });
        }
        authFault = null;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"receipt":')); },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (!armed || lostResponse || request.method !== "POST" || new URL(request.url).pathname !== "/api/actions" || set.status !== 201) return;
      lostResponse = true;
      if (typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string") requestId = body.requestId;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
      }), { status: 201, headers: { "content-type": "application/json" } });
    })
    .use(createApi(databasePath, undefined, { password, webOrigin: "http://localhost:5173" }))
    .post("/__test__/storage-lock", ({ request, body, set }) => {
      const cookie = request.headers.get("cookie") ?? "";
      if (!cookie || (lockOwner ? cookie !== lockCookie : !isAuthenticated(databasePath, request))) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (body.locked && !lockOwner) {
        const owner = new Database(databasePath);
        try { owner.exec("BEGIN EXCLUSIVE"); }
        catch (error) { owner.close(); throw error; }
        lockOwner = owner;
        lockCookie = cookie;
      } else if (!body.locked && lockOwner) {
        lockOwner.exec("ROLLBACK");
        lockOwner.close();
        lockOwner = undefined;
        lockCookie = undefined;
      }
      return { locked: Boolean(lockOwner) };
    }, { body: t.Object({ locked: t.Boolean() }) })
    .post("/__test__/auth-fault", ({ request, body, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (body.fault === "login-cookie") {
        loginPosts = 0;
        revokePosts = 0;
        logoutPosts = 0;
        loginRequestId = null;
        revokeRequestId = null;
        logoutRequestId = null;
      }
      authFault = body.fault;
      return { armed: true };
    }, { body: t.Object({ fault: t.Union([t.Literal("login-cookie"), t.Literal("login-body"), t.Literal("login-before"), t.Literal("login-401"), t.Literal("revoke-body"), t.Literal("revoke-401"), t.Literal("logout-body")]) }) })
    .get("/__test__/auth-diagnostics", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return { loginPosts, revokePosts, logoutPosts, loginRequestId, revokeRequestId, logoutRequestId };
    })
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
