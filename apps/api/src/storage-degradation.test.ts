import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { getHealth } from "../../../packages/client/src/index";
import { createApi } from "./app";
import { sessionExpiresAt } from "./features/auth";

const root = process.env.RC020_TEST_WORK_DIR ?? tmpdir();

function removeDatabase(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

it("refuses a corrupt SQLite copy after restart without damaging the prior durable database", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `healthy-${crypto.randomUUID()}.sqlite`);
  const corruptPath = join(root, `corrupt-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const database = new Database(path);
    database.exec("CREATE TABLE proof (value TEXT NOT NULL)");
    database.query("INSERT INTO proof (value) VALUES (?)").run("previous durable value");
    database.close();
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    copyFileSync(path, corruptPath);
    const fd = openSync(corruptPath, "r+");
    try {
      writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, 4096);
    } finally {
      closeSync(fd);
    }
    const corruptedBytes = readFileSync(corruptPath);
    const restarted = createApi(corruptPath, undefined, { password: "test-storage-password" });
    const ready = await restarted.handle(new Request("http://localhost/api/health/ready"));
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready" });
    expect((await restarted.handle(new Request("http://localhost/api/health/live"))).status).toBe(200);
    const write = await restarted.handle(new Request("http://localhost/api/workspaces", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name: "not accepted" }),
    }));
    expect(write.status).toBe(503);
    expect(readFileSync(corruptPath)).toEqual(corruptedBytes);
    const original = new Database(path, { readonly: true, create: false });
    expect(original.query<{ value: string }, []>("SELECT value FROM proof").get()?.value).toBe("previous durable value");
    original.close();
  } finally {
    removeDatabase(path);
    removeDatabase(corruptPath);
  }
});

it("latches runtime corruption after readiness fails and refuses a keyed action receipt", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `runtime-corrupt-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const database = new Database(path);
    database.exec("CREATE TABLE corruption_probe (payload BLOB NOT NULL)");
    database.query("INSERT INTO corruption_probe (payload) VALUES (?)").run(Buffer.alloc(16384, 42));
    database.close();
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);

    const bytes = readFileSync(path);
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, bytes.length - 4096);
    } finally {
      closeSync(fd);
    }
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
    const requestId = crypto.randomUUID();
    const write = await app.handle(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ action: "must not be confirmed", requestId }),
    }));
    expect(write.status).toBe(503);
    expect(await write.json()).toEqual({ error: "storage_unavailable" });
    const check = new Database(path, { readonly: true, create: false });
    try {
      expect(check.query("SELECT COUNT(*) AS count FROM action_requests WHERE request_id = ?").get(requestId))
        .toEqual({ count: 0 });
      expect(check.query("SELECT COUNT(*) AS count FROM actions").get()).toEqual({ count: 0 });
    } finally {
      check.close();
    }
  } finally {
    removeDatabase(path);
  }
});

it("rejects a keyed action after runtime corruption before the first readiness request", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `corrupt-before-probe-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const baselineId = crypto.randomUUID();
    const baseline = await app.handle(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ action: "previous durable action", requestId: baselineId }),
    }));
    expect(baseline.status).toBe(201);
    const baselineReceipt = await baseline.json() as { id: string };

    const database = new Database(path);
    database.exec("CREATE TABLE corruption_probe (payload BLOB NOT NULL)");
    database.query("INSERT INTO corruption_probe (payload) VALUES (?)").run(Buffer.alloc(16384, 42));
    database.close();
    const healthyBytes = readFileSync(path);
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, healthyBytes.length - 4096);
    } finally {
      closeSync(fd);
    }
    const corruptedBytes = readFileSync(path);

    const requestId = crypto.randomUUID();
    const attempted = await app.handle(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ action: "must not be confirmed before readiness", requestId }),
    }));
    const outcome = await attempted.json();
    const state = new Database(path, { readonly: true, create: false });
    try {
      expect(state.query("SELECT id, action FROM actions WHERE id = ?").get(baselineReceipt.id))
        .toEqual({ id: baselineReceipt.id, action: "previous durable action" });
      expect(state.query("SELECT action_id FROM action_requests WHERE request_id = ?").get(baselineId))
        .toEqual({ action_id: baselineReceipt.id });
      expect(state.query("SELECT COUNT(*) AS count FROM actions").get()).toEqual({ count: 1 });
      expect(state.query("SELECT COUNT(*) AS count FROM action_requests WHERE request_id = ?").get(requestId))
        .toEqual({ count: 0 });
      expect(readFileSync(path)).toEqual(corruptedBytes);
    } finally {
      state.close();
    }
    expect(attempted.status).toBe(503);
    expect(outcome).toEqual({ error: "storage_unavailable" });
  } finally {
    removeDatabase(path);
  }
});

it("does not start integrity probes for anonymous, unmatched, or read-only requests", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `mutation-probe-auth-${crypto.randomUUID()}.sqlite`);
  let readinessCalls = 0;
  try {
    const app = createApi(path, async () => { readinessCalls++; return true; }, { password: "test-storage-password" });
    const anonymous = await app.handle(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "anonymous mutation must not probe" }),
    }));
    const unmatched = await app.handle(new Request("http://localhost/api/not-a-route", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `remotecode_session=${"a".repeat(64)}` },
      body: JSON.stringify({}),
    }));
    const lookup = await app.handle(new Request(`https://localhost/api/auth/receipts/${crypto.randomUUID()}/lookup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect({ anonymous: anonymous.status, unmatched: unmatched.status, lookup: lookup.status, readinessCalls })
      .toEqual({ anonymous: 401, unmatched: 404, lookup: 404, readinessCalls: 0 });

    const login = await app.handle(new Request("https://localhost/api/auth/login", {      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    expect(readinessCalls).toBe(1);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const action = await app.handle(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ action: "authorized mutation probes storage", requestId: crypto.randomUUID() }),
    }));
    expect(action.status).toBe(201);
    expect(readinessCalls).toBe(2);

    // A cookie-carrying receipt lookup may delete an expired session row, so it still probes.
    const cookieLookup = await app.handle(new Request(`https://localhost/api/auth/receipts/${crypto.randomUUID()}/lookup`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({}),
    }));
    expect(cookieLookup.status).toBe(404);
    expect(readinessCalls).toBe(3);

    // GET /api/auth/session deletes an expired session row, so a cookie-carrying
    // session check probes storage while staying read-only without a cookie.
    // The probe runs before the route: a failing probe returns 503 with the
    // expired row intact; a passing probe then lets the route clean it up.
    const { Database: SessionDatabase } = await import("bun:sqlite");
    const expiredSessionCalls = async (path: string, cookie: string) => {
      const gated = createApi(path, async () => false, { password: "test-storage-password" });
      const response = await gated.handle(new Request("http://localhost/api/auth/session", {
        headers: { cookie },
      }));
      const outcome = await response.json();
      const state = new SessionDatabase(path, { readonly: true, create: false });
      try {
        return {
          status: response.status,
          outcome,
          sessions: state.query("SELECT COUNT(*) AS count FROM sessions").get(),
        };
      } finally {
        state.close();
      }
    };
    const sessionDb = new SessionDatabase(path);
    try {
      sessionDb.exec("UPDATE sessions SET expires_at = 1");
    } finally {
      sessionDb.close();
    }
    expect(await expiredSessionCalls(path, cookie!)).toEqual({
      status: 503,
      outcome: { error: "storage_unavailable" },
      sessions: { count: 1 },
    });
    const cookieSession = await app.handle(new Request("http://localhost/api/auth/session", {
      headers: { cookie: cookie! },
    }));
    expect(cookieSession.status).toBe(401);
    const cleanedSessionDb = new SessionDatabase(path, { readonly: true, create: false });
    try { expect(cleanedSessionDb.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 }); }
    finally { cleanedSessionDb.close(); }
    expect(readinessCalls).toBe(4);
    const anonymousSession = await app.handle(new Request("http://localhost/api/auth/session"));
    expect(anonymousSession.status).toBe(401);
    expect(readinessCalls).toBe(4);
  } finally {
    removeDatabase(path);
  }
});

it("gates file receipt recovery on readiness without probing anonymous or unmatched GETs", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `receipt-readiness-${crypto.randomUUID()}.sqlite`);
  let readinessCalls = 0;
  let readinessReady = true;
  try {
    const app = createApi(path, async () => { readinessCalls++; return readinessReady; }, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    readinessCalls = 0;
    readinessReady = false;

    const workspaceId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const anonymous = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/files/receipts/${requestId}`));
    const unmatched = await app.handle(new Request("http://localhost/api/not-a-receipt"));
    expect({ anonymous: anonymous.status, unmatched: unmatched.status, readinessCalls })
      .toEqual({ anonymous: 401, unmatched: 404, readinessCalls: 0 });

    const receiptUrl = `http://localhost/api/workspaces/${workspaceId}/files/receipts/${requestId}`;
    const blocked = await app.handle(new Request(receiptUrl, { headers: { cookie: cookie! } }));
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "storage_unavailable" });
    expect(readinessCalls).toBe(1);

    const trailingSlash = await app.handle(new Request(`${receiptUrl}/`, { headers: { cookie: cookie! } }));
    expect(trailingSlash.status).toBe(503);
    expect(await trailingSlash.json()).toEqual({ error: "storage_unavailable" });
    expect(readinessCalls).toBe(2);

    const sessionAlias = await app.handle(new Request("https://localhost/api/auth/session/", { headers: { cookie: cookie! } }));
    expect(sessionAlias.status).toBe(503);
    expect(readinessCalls).toBe(3);
    const loginAlias = await app.handle(new Request("https://localhost/api/auth/login/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(loginAlias.status).toBe(503);
    expect(readinessCalls).toBe(4);
    const state = new Database(path, { readonly: true });
    try { expect(state.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 }); }
    finally { state.close(); }
  } finally {
    removeDatabase(path);
  }
});

it("never creates a missing database from private GET authority or session-expiry reads", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `missing-authority-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    removeDatabase(path);
    const request = new Request("http://localhost/api/profile", { headers: { cookie: `remotecode_session=${"a".repeat(64)}` } });
    expect((await app.handle(request)).status).toBe(401);
    expect(existsSync(path)).toBe(false);
    expect(sessionExpiresAt(path, request)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  } finally { removeDatabase(path); }
});

it.skipIf(process.platform !== "linux")("blocks corrupted prepared file receipts before SQL recovery and recovers once after repair", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `receipt-runtime-corrupt-${crypto.randomUUID()}.sqlite`);
  const healthyPath = join(root, `receipt-runtime-healthy-${crypto.randomUUID()}.sqlite`);
  let workspaceId: string | undefined;
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const createWorkspace = await app.handle(new Request("http://localhost/api/workspaces", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name: "receipt recovery" }),
    }));
    expect(createWorkspace.status).toBe(201);
    const workspace = await createWorkspace.json() as { id: string };
    workspaceId = workspace.id;
    const folder = await app.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/folder`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    }));
    expect(folder.status).toBe(200);
    const folderPath = join(root, `workspaces/${workspace.id}`);

    for (const kind of ["create", "save"] as const) {
      const requestId = crypto.randomUUID();
      const filePath = "witness.txt";
      if (kind === "save") {
        const db = new Database(path);
        try { db.exec("DROP TRIGGER IF EXISTS fail_file_outcome"); } finally { db.close(); }
      }
      const db = new Database(path);
      try {
        db.exec("CREATE TRIGGER fail_file_outcome BEFORE INSERT ON file_operation_outcomes BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END");
      } finally { db.close(); }

      if (kind === "create") {
        const write = await app.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/files`, {
          method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
          body: JSON.stringify({ requestId, path: filePath, content: "original bytes" }),
        }));
        expect(write.status).toBe(503);
      } else {
        const current = await app.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/files/content?path=${filePath}`, { headers: { cookie: cookie! } }));
        expect(current.status).toBe(200);
        const version = (await current.json() as { version: string }).version;
        const write = await app.handle(new Request(`http://localhost/api/workspaces/${workspace.id}/files/content`, {
          method: "PUT", headers: { "content-type": "application/json", cookie: cookie! },
          body: JSON.stringify({ requestId, path: filePath, content: "saved bytes", expectedVersion: version }),
        }));
        expect(write.status).toBe(503);
      }
      const preparedDb = new Database(path);
      let prepared: { state: string } | null;
      try {
        prepared = preparedDb.query<{ state: string }, [string]>("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId) ?? null;
        expect(prepared).toEqual({ state: "prepared" });
        expect(preparedDb.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
          .toEqual({ count: 0 });
        preparedDb.exec("DROP TRIGGER fail_file_outcome");
        preparedDb.exec("CREATE TABLE IF NOT EXISTS corruption_probe (payload BLOB NOT NULL)");
        preparedDb.query("DELETE FROM corruption_probe").run();
        preparedDb.query("INSERT INTO corruption_probe (payload) VALUES (?)").run(Buffer.alloc(16384, 42));
        preparedDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally { preparedDb.close(); }

      const healthyBytes = readFileSync(path);
      copyFileSync(path, healthyPath);
      const fd = openSync(path, "r+");
      try { writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, healthyBytes.length - 4096); }
      finally { closeSync(fd); }
      const corruptedBytes = readFileSync(path);
      const target = join(folderPath, filePath);
      const targetBefore = statSync(target);
      const receiptUrl = `http://localhost/api/workspaces/${workspace.id}/files/receipts/${requestId}`;
      for (const suffix of ["", "/"] as const) {
        const blocked = await app.handle(new Request(`${receiptUrl}${suffix}`, { headers: { cookie: cookie! } }));
        expect(blocked.status).toBe(503);
        expect(await blocked.json()).toEqual({ error: "storage_unavailable" });
        expect(readFileSync(path)).toEqual(corruptedBytes);
        expect(statSync(target).ino).toBe(targetBefore.ino);
        expect(readFileSync(target, "utf8")).toBe(kind === "create" ? "original bytes" : "saved bytes");
      }

      copyFileSync(healthyPath, path);
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      const state = new Database(path, { readonly: true, create: false });
      try {
        expect(state.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId))
          .toEqual({ state: "prepared" });
        expect(state.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
          .toEqual({ count: 0 });
        expect(state.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
      } finally { state.close(); }
      const recovered = await app.handle(new Request(receiptUrl, { headers: { cookie: cookie! } }));
      expect(recovered.status).toBe(200);
      const receipt = await recovered.json() as { requestId: string; path: string };
      expect(receipt).toMatchObject({ requestId, path: filePath });
      expect(statSync(target).ino).toBe(targetBefore.ino);
      const outcomeState = new Database(path, { readonly: true, create: false });
      try {
        expect(outcomeState.query("SELECT state FROM file_operation_intents WHERE request_id = ?").get(requestId))
          .toEqual({ state: "completed" });
        expect(outcomeState.query("SELECT COUNT(*) AS count FROM file_operation_outcomes WHERE request_id = ?").get(requestId))
          .toEqual({ count: 1 });
      } finally { outcomeState.close(); }
    }
  } finally {
    if (workspaceId) rmSync(join(root, "workspaces", workspaceId), { recursive: true, force: true });
    removeDatabase(path);
    removeDatabase(healthyPath);
  }
});

it.skipIf(process.platform !== "linux")("does not delete expired sessions during private GET authority checks after corruption", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `expired-session-corrupt-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const db = new Database(path);
    try {
      db.exec("UPDATE sessions SET expires_at = 1");
      db.exec("CREATE TABLE corruption_probe (payload BLOB NOT NULL)");
      db.query("INSERT INTO corruption_probe (payload) VALUES (?)").run(Buffer.alloc(16384, 42));
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    const healthyBytes = readFileSync(path);
    const fd = openSync(path, "r+");
    try { writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, healthyBytes.length - 4096); }
    finally { closeSync(fd); }
    const corruptedBytes = readFileSync(path);
    const response = await app.handle(new Request("http://localhost/api/workspaces", { headers: { cookie: cookie! } }));
    expect(response.status).toBe(401);
    expect(readFileSync(path)).toEqual(corruptedBytes);
    const state = new Database(path, { readonly: true, create: false });
    try { expect(state.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 }); }
    finally { state.close(); }
  } finally {
    removeDatabase(path);
  }
});

it("rechecks readiness before a blocked mutation so a recovered host does not wait for another health poll", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `recovered-probe-${crypto.randomUUID()}.sqlite`);
  try {
    let probes = 0;
    const app = createApi(path, async () => ++probes > 1, { password: "test-storage-password" });
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password", requestId: crypto.randomUUID() }),
    }));
    expect(login.status).toBe(200);
    expect(probes).toBe(2);
    const database = new Database(path, { readonly: true, create: false });
    try { expect(database.query("SELECT COUNT(*) AS count FROM auth_requests").get()).toEqual({ count: 1 }); }
    finally { database.close(); }
  } finally {
    removeDatabase(path);
  }
});

it("keeps concurrent duplicate keyed actions at one durable receipt", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `duplicate-${crypto.randomUUID()}.sqlite`);
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const requestId = crypto.randomUUID();
    const request = () => new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ action: "one effect", requestId }),
    });
    const [first, second] = await Promise.all([app.handle(request()), app.handle(request())]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(await first.json()).toEqual(await second.json());
    const check = new Database(path, { readonly: true, create: false });
    try {
      expect(check.query("SELECT COUNT(*) AS count FROM actions").get()).toEqual({ count: 1 });
      expect(check.query("SELECT COUNT(*) AS count FROM action_requests WHERE request_id = ?").get(requestId))
        .toEqual({ count: 1 });
    } finally {
      check.close();
    }
  } finally {
    removeDatabase(path);
  }
});

it("rejects a write under an exclusive SQLite lock and recovers after release and restart", async () => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `locked-${crypto.randomUUID()}.sqlite`);
  let owner: Database | undefined;
  let listener: ReturnType<typeof createApi> | undefined;
  try {
    const app = createApi(path, undefined, { password: "test-storage-password" });
    const login = await app.handle(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-storage-password" }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const request = (name: string) => new Request("http://localhost/api/workspaces", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name }),
    });
    expect((await app.handle(request("previous durable workspace"))).status).toBe(201);
    owner = new Database(path);
    owner.exec("BEGIN EXCLUSIVE");
    const restarted = createApi(path, undefined, { password: "test-storage-password" });
    listener = restarted.listen({ hostname: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${listener.server!.port}`;
    expect((await restarted.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
    expect(await getHealth(origin)).toBe("not_ready");
    expect((await restarted.handle(request("not accepted"))).status).not.toBe(201);
    owner.exec("ROLLBACK");
    owner.close();
    owner = undefined;
    expect((await restarted.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    expect(await getHealth(origin)).toBe("ready");
    const recovered = await restarted.handle(new Request("http://localhost/api/workspaces", {
      headers: { cookie: cookie! },
    }));
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as { workspaces: { name: string }[] }).workspaces.map((row) => row.name))
      .toEqual(["previous durable workspace"]);
    expect((await restarted.handle(request("safe after lock"))).status).toBe(201);
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    expect((await app.handle(request("safe on original process"))).status).toBe(201);
  } finally {
    if (owner) {
      owner.exec("ROLLBACK");
      owner.close();
    }
    await listener?.stop(true);
    removeDatabase(path);
  }
});
