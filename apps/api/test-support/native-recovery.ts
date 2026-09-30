import { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { createApi } from "../src/app";
import { isAuthenticated, sessionTokenHash, sessionUserId } from "../src/features/auth";

export function createNativeRecoveryTestApi(databasePath: string, password: string) {
  let lockOwner: Database | undefined;
  let lockCookie: string | undefined;
  let authFault: string | null = null;
  let loginPosts = 0;
  let loginReceiptReads = 0;
  let stallLoginReceipt = false;
  let revokePosts = 0;
  let logoutPosts = 0;
  let loginRequestId: string | null = null;
  let revokeRequestId: string | null = null;
  let logoutRequestId: string | null = null;
  let authDeadlineScenario = false;
  let loginPostDelayCompleted = false;
  let loginPostDelayGate: Promise<void> | null = null;
  let releaseLoginPostDelay: (() => void) | null = null;
  let armed = false;
  let lostResponse = false;
  let failedRead = false;
  let receiptReads = 0;
  let receiptReadAtMs: number[] = [];
  let receiptFault: "fail" | "stall" | "malformed" | null = "fail";
  let actionDeadlineScenario = false;
  let actionDeadlinePostDelayScenario = false;
  let lateReceiptCompleted = false;
  let actionPostDelayCompleted = false;
  let actionPostDelayGate: Promise<void> | null = null;
  let releaseActionPostDelay: (() => void) | null = null;
  let actionPosts = 0;
  let requestId: string | null = null;
  let actionPostStarted: Promise<void> | null = null;
  let markActionPostStarted: (() => void) | null = null;
  let actionPostAccepted: Promise<void> | null = null;
  let markActionPostAccepted: (() => void) | null = null;
  let loginPostStarted: Promise<void> | null = null;
  let markLoginPostStarted: (() => void) | null = null;
  let loginPreflightDeadlineScenario = false;
  let loginVersionRequests = 0;
  let loginVersionGate: Promise<void> | null = null;
  let releaseLoginVersionGate: (() => void) | null = null;
  let loginVersionStarted: Promise<void> | null = null;
  let markLoginVersionStarted: (() => void) | null = null;
  let loginVersionFinished: Promise<void> | null = null;
  let markLoginVersionFinished: (() => void) | null = null;
  let loginVersionRequestFinished = false;
  let privacyUnauthorizedReceipt = false;
  let privacyReceiptReads = 0;
  let privacySessionRevocations = 0;
  let privacySessionRevoked = false;
  let privacyReceiptRequestId: string | null = null;
  let privacyReceiptResponseStatus: number | null = null;
  let privacyReceiptStarted: Promise<void> | null = null;
  let markPrivacyReceiptStarted: (() => void) | null = null;
  let privacyReceiptGate: Promise<void> | null = null;
  let releasePrivacyReceiptGate: (() => void) | null = null;
  return new Elysia()
    .onBeforeHandle({ as: "global" }, async ({ request, body, set }) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/version") {
        loginVersionRequests++;
        if (loginPreflightDeadlineScenario) {
          if (!loginVersionGate) throw new Error("Missing delayed login capability gate");
          markLoginVersionStarted?.();
          await loginVersionGate;
        }
      }
      if (request.method === "GET" && path === "/api/version" && (actionDeadlineScenario || (actionDeadlinePostDelayScenario && !actionPostDelayCompleted))) {
        // The six-second preflight leaves little of the tap-relative budget for the POST.
        await Bun.sleep(6_000);
      }
      if (request.method === "GET" && path === "/api/version" && authDeadlineScenario) {
        // Leave four seconds in the tap budget for login identity and POST work.
        await Bun.sleep(9_000);
      }
      if (request.method === "POST" && typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string") {
        if (path === "/api/auth/login") {
          loginPosts++;
          loginRequestId = body.requestId;
          if (authDeadlineScenario) {
            if (!loginPostDelayGate) throw new Error("Missing delayed login gate");
            markLoginPostStarted?.();
            await loginPostDelayGate;
            loginPostDelayCompleted = true;
          }
        }
        if (path.endsWith("/revoke")) { revokePosts++; revokeRequestId = body.requestId; }
        if (path === "/api/auth/logout") { logoutPosts++; logoutRequestId = body.requestId; }
      }
      if (request.method === "POST" && loginRequestId && path === `/api/auth/receipts/${loginRequestId}/lookup`) {
        loginReceiptReads++;
        if (stallLoginReceipt) {
          stallLoginReceipt = false;
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('{"receipt":'));
          } }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      if (authFault === "login-before" && request.method === "POST" && path === "/api/auth/login") {
        authFault = null;
        set.status = 503;
        return { error: "injected_before_login" };
      }
      if (privacyUnauthorizedReceipt && lostResponse && request.method === "GET" && path.startsWith("/api/actions/receipts/")) {
        privacyReceiptReads++;
        privacyReceiptRequestId = path.slice("/api/actions/receipts/".length).toLowerCase();
        if (!privacySessionRevoked) {
          const userId = sessionUserId(databasePath, request);
          const tokenHash = sessionTokenHash(request);
          if (!userId || !tokenHash || !privacyReceiptGate) throw new Error("Privacy fixture requires the authenticated native receipt session");
          const database = new Database(databasePath);
          try {
            const deleted = database.query("DELETE FROM sessions WHERE user_id = ? AND token_hash = ?").run(userId, tokenHash);
            if (deleted.changes !== 1) throw new Error("Privacy fixture did not revoke exactly the receipt session");
            privacySessionRevocations += deleted.changes;
          } finally { database.close(); }
          privacySessionRevoked = true;
          markPrivacyReceiptStarted?.();
          await privacyReceiptGate;
        }
      }
      if (armed && request.method === "POST" && path === "/api/actions") {
        actionPosts++;
        markActionPostStarted?.();
        if (actionDeadlinePostDelayScenario) {
          if (typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string") requestId = body.requestId;
          if (!actionPostDelayGate) throw new Error("Missing delayed action gate");
          await actionPostDelayGate;
        }
      }
      if ((lostResponse || (actionDeadlinePostDelayScenario && actionPosts > 0)) && request.method === "GET" && path.startsWith("/api/actions/receipts/")) {
        receiptReads++;
        receiptReadAtMs.push(Math.trunc(performance.now()));
        if (actionDeadlineScenario && !lateReceiptCompleted) {
          // Keep the canonical read on the far side of the UI deadline.
          await Bun.sleep(5_000);
        }
        if (!failedRead && receiptFault) {
          failedRead = true;
          if (receiptFault === "stall") return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":'));
          } }), { status: 200, headers: { "content-type": "application/json" } });
          if (receiptFault === "malformed") {
            const database = new Database(databasePath);
            let receipt: { id: string; action: string; createdAt: string } | null | undefined;
            try {
              receipt = database.query<{ id: string; action: string; createdAt: string }, [string]>(`
                SELECT actions.id, actions.action, actions.created_at AS createdAt
                FROM action_requests JOIN actions ON actions.id = action_requests.action_id
                WHERE action_requests.request_id = ?
              `).get(path.slice("/api/actions/receipts/".length).toLowerCase());
            } finally { database.close(); }
            if (!receipt) throw new Error("Expected the committed action receipt for malformed-response injection");
            return { ...receipt, createdAt: "not-a-date" };
          }
          set.status = 503;
          return { error: "injected_receipt_read_unavailable" };
        }
      }
    })
    .onAfterHandle({ as: "global" }, ({ request, body, set }) => {
      const path = new URL(request.url).pathname;
      if (privacyUnauthorizedReceipt && privacySessionRevoked && request.method === "GET" && path.startsWith("/api/actions/receipts/")) {
        privacyReceiptResponseStatus = typeof set.status === "number" ? set.status : 200;
      }
      if (request.method === "GET" && path === "/api/version" && loginVersionFinished && !loginVersionRequestFinished) {
        loginVersionRequestFinished = true;
        markLoginVersionFinished?.();
      }
      if (actionDeadlineScenario && lostResponse && request.method === "GET" && path.startsWith("/api/actions/receipts/")) {
        lateReceiptCompleted = true;
      }
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
      if (actionDeadlinePostDelayScenario && armed && !lostResponse && request.method === "POST" && path === "/api/actions" && set.status === 201) {
        actionPostDelayCompleted = true;
        markActionPostAccepted?.();
        return;
      }
      if (!armed || lostResponse || request.method !== "POST" || path !== "/api/actions" || set.status !== 201) return;
      lostResponse = true;
      markActionPostAccepted?.();
      if (typeof body === "object" && body !== null && "requestId" in body && typeof body.requestId === "string") requestId = body.requestId;
      // The action has committed; only its response body is malformed.
      if (actionDeadlineScenario || privacyUnauthorizedReceipt) return new Response('{"id":', { status: 201, headers: { "content-type": "application/json" } });
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
      if (!lockOwner) {
        const owner = new Database(databasePath);
        try { owner.exec("BEGIN EXCLUSIVE"); }
        catch (error) { owner.close(); throw error; }
        lockOwner = owner;
        lockCookie = cookie;
      }
      return { locked: true };
    }, { body: t.Object({ locked: t.Literal(true) }) })
    .get("/__test__/storage-unlock", ({ request, set }) => {
      if (!lockOwner || request.headers.get("cookie") !== lockCookie) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      lockOwner.exec("ROLLBACK");
      lockOwner.close();
      lockOwner = undefined;
      lockCookie = undefined;
      return { locked: false };
    })
    .post("/__test__/auth-fault", ({ request, body, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if ((body.loginDeadline || body.loginPreflightDeadline) && body.fault !== "login-before") {
        set.status = 422;
        return { error: "login_deadline_requires_preacceptance_fault" };
      }
      if (body.fault === "login-cookie" || body.fault === "login-cookie-stall" || body.loginDeadline || body.loginPreflightDeadline) {
        loginPosts = 0;
        loginReceiptReads = 0;
        revokePosts = 0;
        logoutPosts = 0;
        loginRequestId = null;
        revokeRequestId = null;
        logoutRequestId = null;
      }
      authDeadlineScenario = body.loginDeadline === true;
      loginPreflightDeadlineScenario = body.loginPreflightDeadline === true;
      loginVersionRequests = 0;
      loginVersionRequestFinished = false;
      loginVersionGate = null;
      releaseLoginVersionGate = null;
      loginVersionStarted = null;
      markLoginVersionStarted = null;
      loginVersionFinished = null;
      markLoginVersionFinished = null;
      if (loginPreflightDeadlineScenario) {
        loginVersionGate = new Promise<void>((resolve) => { releaseLoginVersionGate = resolve; });
        loginVersionStarted = new Promise<void>((resolve) => { markLoginVersionStarted = resolve; });
        loginVersionFinished = new Promise<void>((resolve) => { markLoginVersionFinished = resolve; });
      }
      loginPostDelayCompleted = false;
      loginPostDelayGate = null;
      releaseLoginPostDelay = null;
      loginPostStarted = null;
      markLoginPostStarted = null;
      if (authDeadlineScenario) {
        loginPostDelayGate = new Promise<void>((resolve) => { releaseLoginPostDelay = resolve; });
        loginPostStarted = new Promise<void>((resolve) => { markLoginPostStarted = resolve; });
      }
      authFault = loginPreflightDeadlineScenario ? null : body.fault === "login-cookie-stall" ? "login-cookie" : body.fault;
      stallLoginReceipt = body.fault === "login-cookie-stall";
      return { armed: true };
    }, { body: t.Object({
      fault: t.Union([t.Literal("login-cookie"), t.Literal("login-cookie-stall"), t.Literal("login-body"), t.Literal("login-before"), t.Literal("login-401"), t.Literal("revoke-body"), t.Literal("revoke-401"), t.Literal("logout-body")]),
      loginDeadline: t.Optional(t.Literal(true)),
      loginPreflightDeadline: t.Optional(t.Literal(true)),
    }) })
    .get("/__test__/auth-diagnostics", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      let loginReceiptExists = false;
      if (loginRequestId) {
        const database = new Database(databasePath, { readonly: true, create: false });
        try {
          loginReceiptExists = Boolean(database.query<{ requestId: string }, [string, string]>(`
            SELECT request_id AS requestId FROM auth_requests WHERE user_id = ? AND request_id = ? AND kind = 'login'
          `).get("local", loginRequestId));
        } finally { database.close(); }
      }
      return { loginPosts, loginReceiptReads, revokePosts, logoutPosts, loginRequestId, revokeRequestId, logoutRequestId, loginPostDelayCompleted, loginReceiptExists, loginVersionRequests, loginVersionRequestFinished };
    })
    .get("/__test__/wait-login-post", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const started = loginPostStarted;
      if (!authDeadlineScenario || !started) {
        set.status = 409;
        return { waiting: false };
      }
      await started;
      return { loginPosts, loginRequestId, loginPostDelayCompleted };
    })
    .post("/__test__/release-login-post", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!authDeadlineScenario || loginPosts !== 1 || loginPostDelayCompleted || !releaseLoginPostDelay) {
        set.status = 409;
        return { released: false };
      }
      const release = releaseLoginPostDelay;
      releaseLoginPostDelay = null;
      authDeadlineScenario = false;
      release();
      return { released: true };
    })
    .get("/__test__/wait-login-version", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const started = loginVersionStarted;
      if (!loginPreflightDeadlineScenario || !started) {
        set.status = 409;
        return { waiting: false };
      }
      await started;
      return { loginVersionRequests };
    })
    .post("/__test__/release-login-version", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!loginPreflightDeadlineScenario || loginVersionRequests !== 1 || !releaseLoginVersionGate) {
        set.status = 409;
        return { released: false };
      }
      const release = releaseLoginVersionGate;
      releaseLoginVersionGate = null;
      loginPreflightDeadlineScenario = false;
      release();
      return { released: true };
    })
    .get("/__test__/wait-login-version-finished", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const finished = loginVersionFinished;
      if (!finished || loginVersionRequests < 1) {
        set.status = 409;
        return { waiting: false };
      }
      await finished;
      return { loginVersionRequests, loginVersionRequestFinished };
    })
    .post("/__test__/lose-action-response", ({ request, body, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      armed = true;
      lostResponse = false;
      failedRead = false;
      receiptReads = 0;
      receiptReadAtMs = [];
      actionDeadlineScenario = body?.actionDeadline === true;
      actionDeadlinePostDelayScenario = body?.actionDeadlinePostDelay === true;
      lateReceiptCompleted = false;
      actionPostDelayCompleted = false;
      actionPostDelayGate = null;
      releaseActionPostDelay = null;
      actionPostStarted = null;
      markActionPostStarted = null;
      actionPostAccepted = null;
      markActionPostAccepted = null;
      actionPostStarted = new Promise<void>((resolve) => { markActionPostStarted = resolve; });
      actionPostAccepted = new Promise<void>((resolve) => { markActionPostAccepted = resolve; });
      if (actionDeadlinePostDelayScenario) {
        actionPostDelayGate = new Promise<void>((resolve) => { releaseActionPostDelay = resolve; });
      }
      privacyUnauthorizedReceipt = body?.privacyUnauthorizedReceipt === true;
      receiptFault = privacyUnauthorizedReceipt || actionDeadlineScenario || actionDeadlinePostDelayScenario ? null : body?.receiptFault === "none" ? null : body?.receiptFault ?? "fail";
      actionPosts = 0;
      requestId = null;
      privacyReceiptReads = 0;
      privacySessionRevocations = 0;
      privacySessionRevoked = false;
      privacyReceiptRequestId = null;
      privacyReceiptResponseStatus = null;
      privacyReceiptGate = null;
      releasePrivacyReceiptGate = null;
      privacyReceiptStarted = null;
      markPrivacyReceiptStarted = null;
      if (privacyUnauthorizedReceipt) {
        privacyReceiptGate = new Promise<void>((resolve) => { releasePrivacyReceiptGate = resolve; });
        privacyReceiptStarted = new Promise<void>((resolve) => { markPrivacyReceiptStarted = resolve; });
      }
      return { armed: true };
    }, { body: t.Optional(t.Object({
      receiptFault: t.Optional(t.Union([t.Literal("fail"), t.Literal("stall"), t.Literal("malformed"), t.Literal("none")])),
      actionDeadline: t.Optional(t.Literal(true)),
      actionDeadlinePostDelay: t.Optional(t.Literal(true)),
      privacyUnauthorizedReceipt: t.Optional(t.Literal(true)),
    })) })
    .post("/__test__/release-action-post", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!actionDeadlinePostDelayScenario || !armed || actionPosts < 1 || actionPostDelayCompleted || !releaseActionPostDelay) {
        set.status = 409;
        return { released: false };
      }
      const release = releaseActionPostDelay;
      releaseActionPostDelay = null;
      release();
      return { released: true };
    })
    .get("/__test__/wait-action-post", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const started = actionPostStarted;
      if (!armed || !started) {
        set.status = 409;
        return { waiting: false };
      }
      await started;
      return { actionPosts, actionPostDelayCompleted, receiptReads };
    })
    .get("/__test__/wait-action-accepted", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const accepted = actionPostAccepted;
      if (!armed || !accepted) {
        set.status = 409;
        return { waiting: false };
      }
      await accepted;
      return { actionPosts, actionPostDelayCompleted, lostResponse };
    })
    .get("/__test__/wait-privacy-receipt", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!privacyUnauthorizedReceipt || !privacyReceiptStarted) {
        set.status = 409;
        return { waiting: false };
      }
      await privacyReceiptStarted;
      return { privacyReceiptReads, privacySessionRevocations, privacyReceiptRequestId };
    })
    .post("/__test__/release-privacy-receipt", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!privacyUnauthorizedReceipt || !privacySessionRevoked || !releasePrivacyReceiptGate) {
        set.status = 409;
        return { released: false };
      }
      const release = releasePrivacyReceiptGate;
      releasePrivacyReceiptGate = null;
      privacyReceiptGate = null;
      release();
      return { released: true };
    })
    .get("/__test__/response-loss", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return { lostResponse, failedRead, receiptReads, receiptReadAtMs, receiptDelayCompleted: lateReceiptCompleted, actionPostDelayCompleted, actionPosts, requestId: requestId ?? "", privacyReceiptReads, privacySessionRevocations, privacyReceiptRequestId, privacyReceiptResponseStatus };
    });
}

if (import.meta.main) {
  const path = process.env.DATABASE_PATH;
  const password = process.env.REMOTECODE_AUTH_PASSWORD;
  if (!path || !password) throw new Error("The native test requires an isolated database and host password");
  createNativeRecoveryTestApi(path, password).listen({ hostname: "127.0.0.1", port: Number(process.env.API_PORT ?? 39211) });
}
