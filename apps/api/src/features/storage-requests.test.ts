import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../app";
import { checkDatabase } from "./health";
import { createApiClient, isUnknownOutcomeError } from "../../../../packages/client/src";

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(process.env.RC_STORAGE_TEST_WORK_DIR ?? tmpdir(), "rc018-storage-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const app = createApi(path);
  const database = new Database(path);
  for (const [token, user] of [["a".repeat(64), "alice"], ["b".repeat(64), "bob"]]) {
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(token!).digest("hex"), user!, Date.now() + 60_000);
  }
  database.close();
  return { app, path };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function request(method: string, route: string, body?: unknown, user = "a") {
  return new Request(`http://localhost/api/workspaces${route}`, {
    method, headers: { "content-type": "application/json", cookie: `remotecode_session=${user.repeat(64)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("recovers a committed workspace through authenticated lookup after response loss and API recreation", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  expect((await app.handle(request("GET", `/receipts/${requestId}`))).status).toBe(404);
  expect((await app.handle(request("POST", "", { requestId, name: "first" }))).status).toBe(201);
  // The first response is discarded; a new API instance must recover the committed result.
  const restarted = createApi(path);
  const lookup = await restarted.handle(request("GET", `/receipts/${requestId}`));
  expect(lookup.status).toBe(200);
  const canonical = await lookup.json();
  const replay = await restarted.handle(request("POST", "", { requestId, name: "first" }));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(canonical);
  expect((await restarted.handle(request("POST", "", { requestId, name: "changed" }))).status).toBe(409);
  expect((await restarted.handle(request("GET", `/receipts/${requestId}`, undefined, "b"))).status).toBe(404);
  expect((await restarted.handle(request("GET", `/receipts/${requestId}`, undefined, "c"))).status).toBe(401);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("normalizes workspace request-ID case and rejects URN aliases before any second effect", async () => {
  const { app, path } = setup();
  const canonical = "abcdefab-1234-4abc-8def-abcdefabcdef";
  expect((await app.handle(request("POST", "", { requestId: canonical.toUpperCase(), name: "single workspace" }))).status).toBe(201);
  expect((await app.handle(request("GET", `/receipts/${canonical}`))).status).toBe(200);
  expect((await app.handle(request("POST", "", { requestId: canonical, name: "single workspace" }))).status).toBe(200);
  expect((await app.handle(request("POST", "", { requestId: `urn:uuid:${canonical}`, name: "second workspace" }))).status).toBe(422);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(database.query("SELECT request_id FROM workspace_requests").get()).toEqual({ request_id: canonical });
  } finally { database.close(); }
});

it("recovers a timed-out Eden workspace submission through a fresh client without retrying blindly", async () => {
  const { app, path } = setup();
  let submissions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const response = await app.handle(request);
      if (request.method === "POST" && new URL(request.url).pathname === "/api/workspaces") {
        submissions++;
        if (response.status === 201) return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
        }), { headers: { "content-type": "application/json" } });
      }
      return response;
    },
  });
  try {
    const options = { timeoutMs: 100, headers: { cookie: `remotecode_session=${"a".repeat(64)}` } };
    const origin = `http://127.0.0.1:${server.port}`;
    const requestId = crypto.randomUUID();
    const body = { requestId, name: "committed despite response loss" };
    const lost = await createApiClient(origin, options).api.workspaces.post(body);
    expect(lost.data).toBeNull();
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    const fresh = createApiClient(origin, options);
    const lookup = await fresh.api.workspaces.receipts({ requestId }).get();
    expect(lookup.error).toBeNull();
    expect(lookup.data).toMatchObject({ name: body.name });
    expect(submissions).toBe(1);
    const replay = await fresh.api.workspaces.post(body);
    expect(replay.error).toBeNull();
    if (!lookup.data || !("id" in lookup.data)) throw new Error("Expected workspace receipt");
    expect(replay.data).toEqual(lookup.data);
    const database = new Database(path);
    try { expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 }); }
    finally { database.close(); }
  } finally { server.stop(true); }
});

it("accepts concurrent repeats once and reports missing receipt storage as unready", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.handle(request("POST", "", { requestId, name: "once" }))));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    database.exec("DROP TABLE workspace_requests");
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
  } finally { database.close(); }
});

it("does not accept an invalid workspace or a workspace whose receipt cannot commit", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  expect((await app.handle(request("POST", "", { requestId, name: "" }))).status).toBe(422);
  const database = new Database(path);
  try {
    database.exec("CREATE TRIGGER reject_workspace_receipt BEFORE INSERT ON workspace_requests BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    expect((await app.handle(request("POST", "", { requestId, name: "valid" }))).status).toBe(500);
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
    expect((await app.handle(request("GET", `/receipts/${requestId}`))).status).toBe(404);
    database.exec("DROP TRIGGER reject_workspace_receipt");
    expect((await app.handle(request("POST", "", { requestId, name: "valid" }))).status).toBe(201);
  } finally { database.close(); }
});

function profileRequest(method: string, route = "", body?: unknown, user = "a") {
  return new Request(`http://localhost/api/profile${route}`, {
    method, headers: { "content-type": "application/json", cookie: `remotecode_session=${user.repeat(64)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("replays a profile update without changing its timestamp and keeps older receipts immutable", async () => {
  const { app, path } = setup();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  expect((await app.handle(profileRequest("GET", `/receipts/${firstId}`))).status).toBe(404);
  const initial = await app.handle(profileRequest("PUT", "", { requestId: firstId, displayName: "initial" }));
  expect(initial.status).toBe(200);
  const first = await initial.json();
  const guard = new Database(path);
  const restarted = createApi(path);
  try {
    guard.exec("CREATE TRIGGER reject_replay BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT, 'reapplied profile'); END");
    expect(await (await restarted.handle(profileRequest("PUT", "", { requestId: firstId, displayName: "initial" }))).json()).toEqual(first);
    guard.exec("DROP TRIGGER reject_replay");
  } finally { guard.close(); }
  expect((await restarted.handle(profileRequest("PUT", "", { requestId: firstId, displayName: "changed" }))).status).toBe(409);
  expect((await restarted.handle(profileRequest("GET", `/receipts/${firstId}`, undefined, "b"))).status).toBe(404);
  expect((await restarted.handle(profileRequest("GET", `/receipts/${firstId}`, undefined, "c"))).status).toBe(401);
  expect((await restarted.handle(profileRequest("PUT", "", { requestId: secondId, displayName: "changed" }))).status).toBe(200);
  const oldReceipt = await (await restarted.handle(profileRequest("GET", `/receipts/${firstId}`))).json();
  expect(oldReceipt).toEqual(first);
  expect(Object.keys(oldReceipt).sort()).toEqual(["displayName", "updatedAt", "userId"]);
  expect(JSON.stringify(oldReceipt)).not.toContain("remotecode_session");
  const current = await (await restarted.handle(profileRequest("GET"))).json();
  expect(current.profile.displayName).toBe("changed");
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM profile_requests").get()).toEqual({ count: 2 });
    expect(database.query("SELECT count(*) AS count FROM profiles").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("normalizes profile UUID aliases and rejects invalid input without a receipt or effect", async () => {
  const { app, path } = setup();
  const id = "abcdefab-1234-4abc-8def-abcdefabcdef";
  expect((await app.handle(profileRequest("PUT", "", { requestId: id, displayName: "" }))).status).toBe(422);
  expect((await app.handle(profileRequest("PUT", "", { requestId: `urn:uuid:${id}`, displayName: "bad" }))).status).toBe(422);
  expect((await app.handle(profileRequest("GET", `/receipts/${id}`))).status).toBe(404);
  expect((await app.handle(profileRequest("PUT", "", { requestId: id.toUpperCase(), displayName: "valid" }))).status).toBe(200);
  expect((await app.handle(profileRequest("PUT", "", { requestId: id, displayName: "valid" }))).status).toBe(200);
  expect((await app.handle(profileRequest("GET", `/receipts/${id.toUpperCase()}`))).status).toBe(200);
  const database = new Database(path);
  try { expect(database.query("SELECT request_id FROM profile_requests").get()).toEqual({ request_id: id }); }
  finally { database.close(); }
});

it("rolls back a profile update when receipt persistence fails and preserves ID-less updates", async () => {
  const { app, path } = setup();
  const id = crypto.randomUUID();
  const original = await (await app.handle(profileRequest("PUT", "", { displayName: "legacy" }))).json();
  const database = new Database(path);
  try {
    database.exec("CREATE TRIGGER reject_profile_receipt BEFORE INSERT ON profile_requests BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    expect((await app.handle(profileRequest("PUT", "", { requestId: id, displayName: "rejected" }))).status).toBe(500);
    expect(await (await app.handle(profileRequest("GET"))).json()).toEqual({ profile: original });
    expect((await app.handle(profileRequest("GET", `/receipts/${id}`))).status).toBe(404);
    database.exec("DROP TRIGGER reject_profile_receipt");
    expect((await app.handle(profileRequest("PUT", "", { requestId: id, displayName: "accepted" }))).status).toBe(200);
    database.exec("DROP TABLE profile_requests");
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
  } finally { database.close(); }
});

it("accepts concurrent profile repeats once with one immutable receipt", async () => {
  const { app, path } = setup();
  const id = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.handle(profileRequest("PUT", "", { requestId: id, displayName: "once" }))));
  const values = await Promise.all(responses.map((response) => response.json()));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
  const database = new Database(path);
  try { expect(database.query("SELECT count(*) AS count FROM profile_requests").get()).toEqual({ count: 1 }); }
  finally { database.close(); }
});

it("recovers a lost Eden profile response by receipt lookup after API recreation", async () => {
  const { app, path } = setup();
  let submissions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const response = await app.handle(request);
      if (request.method === "PUT" && new URL(request.url).pathname === "/api/profile") {
        submissions++;
        if (response.status === 200) return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"userId":')); },
        }), { headers: { "content-type": "application/json" } });
      }
      return response;
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const options = { timeoutMs: 100, headers: { cookie: `remotecode_session=${"a".repeat(64)}` } };
    const requestId = crypto.randomUUID();
    const lost = await createApiClient(origin, options).api.profile.put({ requestId, displayName: "recovered" });
    expect(lost.data).toBeNull();
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    const recovered = createApi(path);
    const receipt = await recovered.handle(profileRequest("GET", `/receipts/${requestId}`));
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toEqual(await (await recovered.handle(profileRequest("GET"))).json().then((result) => result.profile));
    expect(submissions).toBe(1);
  } finally { server.stop(true); }
});

function historyRequest(method: string, workspaceId: string, route = "", body?: unknown, user = "a") {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/history${route}`, {
    method, headers: { "content-type": "application/json", cookie: `remotecode_session=${user.repeat(64)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeWorkspace(app: ReturnType<typeof createApi>, name: string, user = "a") {
  const response = await app.handle(request("POST", "", { name }, user));
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

it("recovers canonical history across API restart without duplicating the entry", async () => {
  const { app, path } = setup();
  const workspace = await makeWorkspace(app, "first");
  const other = await makeWorkspace(app, "second");
  const requestId = crypto.randomUUID();
  const body = { requestId, type: "note", content: "first message" };
  expect((await app.handle(historyRequest("GET", workspace, `/receipts/${requestId}`))).status).toBe(404);
  const first = await app.handle(historyRequest("POST", workspace, "", body));
  expect(first.status).toBe(201);
  const canonical = await first.json();
  const restarted = createApi(path);
  const receipt = await restarted.handle(historyRequest("GET", workspace, `/receipts/${requestId}`));
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toEqual(canonical);
  const replay = await restarted.handle(historyRequest("POST", workspace, "", body));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(canonical);
  for (const changed of [{ ...body, type: "edit" }, { ...body, content: "changed" }]) {
    expect((await restarted.handle(historyRequest("POST", workspace, "", changed))).status).toBe(409);
  }
  expect((await restarted.handle(historyRequest("POST", other, "", body))).status).toBe(409);
  expect((await restarted.handle(historyRequest("GET", other, `/receipts/${requestId}`))).status).toBe(409);
  expect((await restarted.handle(historyRequest("GET", other, `/receipts/${crypto.randomUUID()}`))).status).toBe(404);
  const entries = await (await restarted.handle(historyRequest("GET", workspace))).json();
  expect(entries.history).toEqual([canonical]);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM history").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM history_requests").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("checks workspace ownership before replay or receipt lookup and hides foreign resources", async () => {
  const { app, path } = setup();
  const alice = await makeWorkspace(app, "alice");
  const bob = await makeWorkspace(app, "bob", "b");
  const missing = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const body = { requestId, type: "note", content: "private" };
  expect((await app.handle(historyRequest("POST", alice, "", body))).status).toBe(201);
  for (const inaccessible of [bob, missing]) {
    expect((await app.handle(historyRequest("POST", inaccessible, "", body))).status).toBe(404);
    expect((await app.handle(historyRequest("GET", inaccessible, `/receipts/${requestId}`))).status).toBe(404);
  }
  expect((await app.handle(historyRequest("POST", alice, "", body, "b"))).status).toBe(404);
  expect((await app.handle(historyRequest("GET", alice, `/receipts/${requestId}`, undefined, "b"))).status).toBe(404);
  expect((await app.handle(historyRequest("GET", bob, `/receipts/${requestId}`, undefined, "b"))).status).toBe(404);
  const bobEntry = await app.handle(historyRequest("POST", bob, "", { ...body, content: "bob's own" }, "b"));
  expect(bobEntry.status).toBe(201);
  expect((await app.handle(historyRequest("GET", bob, `/receipts/${requestId}`, undefined, "b"))).status).toBe(200);
  expect((await app.handle(historyRequest("GET", bob, `/receipts/${requestId}`))).status).toBe(404);
  expect((await app.handle(historyRequest("GET", alice, `/receipts/${requestId}`, undefined, "c"))).status).toBe(401);
  expect((await app.handle(historyRequest("POST", alice, "", body, "c"))).status).toBe(401);
  const database = new Database(path);
  try { expect(database.query("SELECT count(*) AS count FROM history").get()).toEqual({ count: 2 }); }
  finally { database.close(); }
});

it("normalizes UUID aliases, rejects invalid history before acceptance, and preserves ID-less callers", async () => {
  const { app, path } = setup();
  const workspace = await makeWorkspace(app, "legacy");
  const id = "abcdefab-1234-4abc-8def-abcdefabcdef";
  expect((await app.handle(historyRequest("POST", workspace, "", { requestId: id, type: "note", content: "" }))).status).toBe(422);
  expect((await app.handle(historyRequest("POST", workspace, "", { requestId: `urn:uuid:${id}`, type: "note", content: "bad" }))).status).toBe(422);
  const body = { requestId: id.toUpperCase(), type: "note", content: "valid" };
  expect((await app.handle(historyRequest("POST", workspace, "", body))).status).toBe(201);
  expect((await app.handle(historyRequest("GET", workspace, `/receipts/${id.toUpperCase()}`))).status).toBe(200);
  expect((await app.handle(historyRequest("POST", workspace, "", { ...body, requestId: id }))).status).toBe(200);
  expect((await app.handle(historyRequest("POST", workspace, "", { type: "note", content: "legacy" }))).status).toBe(201);
  const database = new Database(path);
  try {
    expect(database.query("SELECT request_id FROM history_requests").get()).toEqual({ request_id: id });
    expect(database.query("SELECT count(*) AS count FROM history").get()).toEqual({ count: 2 });
  } finally { database.close(); }
});

it("rolls back history when its receipt cannot commit and marks missing mapping unready", async () => {
  const { app, path } = setup();
  const workspace = await makeWorkspace(app, "rollback");
  const id = crypto.randomUUID();
  const database = new Database(path);
  try {
    database.exec("CREATE TRIGGER reject_history_receipt BEFORE INSERT ON history_requests BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    expect((await app.handle(historyRequest("POST", workspace, "", { requestId: id, type: "note", content: "reject" }))).status).toBe(500);
    expect(database.query("SELECT count(*) AS count FROM history").get()).toEqual({ count: 0 });
    expect((await app.handle(historyRequest("GET", workspace, `/receipts/${id}`))).status).toBe(404);
    database.exec("DROP TRIGGER reject_history_receipt");
    expect((await app.handle(historyRequest("POST", workspace, "", { requestId: id, type: "note", content: "accept" }))).status).toBe(201);
    database.exec("DROP TABLE history_requests");
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
  } finally { database.close(); }
});

it("accepts concurrent history repeats once", async () => {
  const { app, path } = setup();
  const workspace = await makeWorkspace(app, "concurrent");
  const id = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.handle(historyRequest("POST", workspace, "", { requestId: id, type: "note", content: "once" }))));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
  const values = await Promise.all(responses.map((response) => response.json()));
  expect(values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
  const database = new Database(path);
  try { expect(database.query("SELECT count(*) AS count FROM history").get()).toEqual({ count: 1 }); }
  finally { database.close(); }
});

it("recovers a timed-out Eden history write by lookup on a recreated API without resubmission", async () => {
  const { app, path } = setup();
  const workspaceId = await makeWorkspace(app, "response loss");
  let submissions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const response = await app.handle(request);
      if (request.method === "POST" && new URL(request.url).pathname === `/api/workspaces/${workspaceId}/history`) {
        submissions++;
        if (response.status === 201) return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
        }), { headers: { "content-type": "application/json" } });
      }
      return response;
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const options = { timeoutMs: 100, headers: { cookie: `remotecode_session=${"a".repeat(64)}` } };
    const requestId = crypto.randomUUID();
    const lost = await createApiClient(origin, options).api.workspaces({ workspaceId }).history.post({ requestId, type: "note", content: "persisted" });
    expect(lost.data).toBeNull();
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    const recovered = createApi(path);
    const receipt = await recovered.handle(historyRequest("GET", workspaceId, `/receipts/${requestId}`));
    expect(receipt.status).toBe(200);
    const canonical = await receipt.json();
    expect(canonical).toMatchObject({ type: "note", content: "persisted" });
    expect(submissions).toBe(1);
    expect((await recovered.handle(historyRequest("GET", workspaceId))).status).toBe(200);
  } finally { server.stop(true); }
});

it("opens and edits only the session owner's workspace without changing another workspace", async () => {
  const { app, path } = setup();
  const alice = await makeWorkspace(app, "alice");
  const other = await makeWorkspace(app, "other");
  const bob = await makeWorkspace(app, "bob", "b");
  const before = await (await app.handle(request("GET", `/${other}`))).json();
  const id = crypto.randomUUID();
  for (const inaccessible of [bob, crypto.randomUUID()]) {
    for (const method of ["GET", "PATCH"]) {
      expect((await app.handle(request(method, `/${inaccessible}`, method === "PATCH" ? { requestId: id, name: "forged" } : undefined))).status).toBe(404);
    }
    expect((await app.handle(request("PATCH", `/${inaccessible}`, { requestId: id, archived: true }))).status).toBe(404);
    expect((await app.handle(request("GET", `/${inaccessible}/receipts/${id}`))).status).toBe(404);
  }
  for (const body of [{ requestId: id, name: "anonymous" }, { requestId: id, archived: true }]) {
    expect((await app.handle(request("PATCH", `/${alice}`, body, "c"))).status).toBe(401);
    expect((await app.handle(request("PATCH", `/${alice}`, body, "b"))).status).toBe(404);
  }
  expect((await app.handle(new Request(`http://localhost/api/workspaces/${alice}`))).status).toBe(401);
  expect((await app.handle(request("GET", `/${alice}/receipts/${id}`, undefined, "c"))).status).toBe(401);
  const renamed = await app.handle(request("PATCH", `/${alice}`, { requestId: id, name: "alice renamed" }));
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ requestId: id, kind: "rename", workspace: { id: alice, name: "alice renamed", archived: false } });
  expect(await (await app.handle(request("GET", `/${other}`))).json()).toEqual(before);
  expect(await (await app.handle(request("GET", `/${bob}`, undefined, "b"))).json()).toMatchObject({ id: bob, name: "bob" });
  expect((await app.handle(request("GET", `/${alice}/receipts/${id}`, undefined, "b"))).status).toBe(404);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE kind = 'rename'").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("keeps creation and older rename receipts immutable through archive and API recreation while preserving history", async () => {
  const { app, path } = setup();
  const creationId = crypto.randomUUID();
  const created = await (await app.handle(request("POST", "", { requestId: creationId, name: "original" }))).json();
  const other = await makeWorkspace(app, "untouched");
  const historyId = crypto.randomUUID();
  const historyBody = { requestId: historyId, type: "note", content: "durable history" };
  const history = await (await app.handle(historyRequest("POST", created.id, "", historyBody))).json();
  const renameBody = { requestId: crypto.randomUUID(), name: "first rename" };
  const first = await (await app.handle(request("PATCH", `/${created.id}`, renameBody))).json();
  expect(first).toEqual({ requestId: renameBody.requestId, kind: "rename", workspace: { ...created, name: renameBody.name, archived: false } });
  expect((await app.handle(request("PATCH", `/${created.id}`, { requestId: crypto.randomUUID(), name: "second rename" }))).status).toBe(200);
  const guard = new Database(path);
  try {
    guard.exec("CREATE TRIGGER reject_metadata_replay BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'reapplied metadata'); END");
    expect(await (await app.handle(request("PATCH", `/${created.id}`, renameBody))).json()).toEqual(first);
    guard.exec("DROP TRIGGER reject_metadata_replay");
  } finally { guard.close(); }
  expect(await (await app.handle(request("GET", `/${created.id}`))).json()).toMatchObject({ name: "second rename", archived: false });
  const archiveBody = { requestId: crypto.randomUUID(), archived: true };
  const archive = await (await app.handle(request("PATCH", `/${created.id}`, archiveBody))).json();
  expect(archive).toEqual({ requestId: archiveBody.requestId, kind: "archive", workspace: { ...created, name: "second rename", archived: true } });
  const restarted = createApi(path);
  expect(await (await restarted.handle(request("GET", `/${created.id}`))).json()).toEqual(archive.workspace);
  expect(await (await restarted.handle(request("GET", `/${created.id}/receipts/${renameBody.requestId}`))).json()).toEqual(first);
  expect(await (await restarted.handle(request("PATCH", `/${created.id}`, renameBody))).json()).toEqual(first);
  expect(await (await restarted.handle(request("PATCH", `/${created.id}`, archiveBody))).json()).toEqual(archive);
  expect(await (await restarted.handle(request("GET", `/${created.id}/receipts/${creationId.toUpperCase()}`))).json()).toEqual({
    requestId: creationId, kind: "create", workspace: { ...created, archived: false },
  });
  expect(await (await restarted.handle(request("GET", `/receipts/${creationId}`))).json()).toEqual(created);
  expect(await (await restarted.handle(request("POST", "", { requestId: creationId, name: "original" }))).json()).toEqual(created);
  for (const body of [{ requestId: crypto.randomUUID(), name: "not allowed" }, { requestId: crypto.randomUUID(), archived: true }]) {
    const response = await restarted.handle(request("PATCH", `/${created.id}`, body));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "workspace_archived" });
    expect((await restarted.handle(request("GET", `/${created.id}/receipts/${body.requestId}`))).status).toBe(404);
  }
  for (const body of [{ type: "note", content: "legacy new write" }, { ...historyBody, requestId: crypto.randomUUID() }]) {
    expect((await restarted.handle(historyRequest("POST", created.id, "", body))).status).toBe(409);
  }
  expect(await (await restarted.handle(historyRequest("GET", created.id))).json()).toEqual({ history: [history] });
  expect(await (await restarted.handle(historyRequest("GET", created.id, `/receipts/${historyId}`))).json()).toEqual(history);
  expect(await (await restarted.handle(historyRequest("POST", created.id, "", historyBody))).json()).toEqual(history);
  const listed = await (await restarted.handle(request("GET", ""))).json();
  expect(listed.workspaces).toContainEqual(archive.workspace);
  expect(await (await restarted.handle(request("GET", `/${other}`))).json()).toMatchObject({ name: "untouched", archived: false });
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 2 });
    expect(database.query("SELECT count(*) AS count FROM history").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 4 });
  } finally { database.close(); }
});

it("requires canonical UUIDs for metadata, deduplicates concurrent changes, and conflicts across kind, target, or payload", async () => {
  const { app: initialApi, path } = setup();
  const probes: { instance: string; durationMs: number; ready: boolean }[] = [];
  const errors: { instance: string; code: string | number; message: string; sqliteCode: unknown; errno: unknown; stack: string | undefined }[] = [];
  const [app, peer] = ["first", "second"].map((instance) => createApi(path, async () => {
    const start = performance.now();
    const ready = await checkDatabase(path);
    probes.push({ instance, durationMs: performance.now() - start, ready });
    return ready;
  }).onError({ as: "global" }, ({ error, code }) => {
    if (code === "VALIDATION") return;
    errors.push({ instance, code, message: error instanceof Error ? error.message : String(error),
      sqliteCode: "code" in error ? error.code : null, errno: "errno" in error ? error.errno : null,
      stack: error instanceof Error ? error.stack : undefined });
  }));
  const creationId = crypto.randomUUID();
  const first = await (await initialApi.handle(request("POST", "", { requestId: creationId, name: "first" }))).json();
  const second = await makeWorkspace(initialApi, "second");
  const id = "abcdefab-1234-4abc-8def-abcdefabcdef";
  for (const body of [
    { name: "no ID" }, { archived: true }, { requestId: `urn:uuid:${id}`, name: "alias" },
    { requestId: "invalid", archived: true }, { requestId: id, name: "" }, { requestId: id, name: "x".repeat(121) },
    { requestId: id, archived: false }, { requestId: id, name: "ambiguous", archived: true },
  ]) expect((await app.handle(request("PATCH", `/${first.id}`, body))).status).toBe(422);
  const guard = new Database(path);
  guard.exec(`
    CREATE TRIGGER reject_duplicate_workspace_edit BEFORE UPDATE ON workspaces
    WHEN NEW.name = OLD.name AND NEW.archived = OLD.archived BEGIN
      SELECT RAISE(ABORT, 'workspace mutation was reapplied');
    END;
  `);
  guard.close();
  const body = { requestId: id.toUpperCase(), name: "once" };
  const renameProbeStart = probes.length;
  const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => (index % 2 ? app : peer).handle(request("PATCH", `/${first.id}`, body))));
  expect(errors, JSON.stringify({ probes, errors })).toEqual([]);
  expect(responses.some((response) => response.status === 200)).toBe(true);
  const canonicalRename = { requestId: id, kind: "rename", workspace: { ...first, name: body.name, archived: false } };
  for (const [index, response] of responses.entries()) {
    const snapshot = await response.json();
    if (response.status === 503) {
      expect(snapshot).toEqual({ error: "storage_unavailable" });
      expect(probes.slice(renameProbeStart).some((probe) => probe.instance === (index % 2 ? "first" : "second") && !probe.ready)).toBe(true);
    } else {
      expect(response.status, JSON.stringify({ snapshot, probes, errors })).toBe(200);
      expect(snapshot).toEqual(canonicalRename);
    }
  }
  const renameReceipt = await app.handle(request("GET", `/${first.id}/receipts/${id.toUpperCase()}`));
  expect(renameReceipt.status).toBe(200);
  expect(await renameReceipt.json()).toEqual(canonicalRename);
  const renamed = new Database(path);
  try {
    expect(renamed.query("SELECT name, archived FROM workspaces WHERE id = ?").get(first.id)).toEqual({ name: body.name, archived: 0 });
    expect(renamed.query("SELECT count(*) AS count FROM workspace_receipts WHERE user_id = 'alice' AND request_id = ?").get(id)).toEqual({ count: 1 });
    expect(renamed.query("SELECT workspace_id, kind FROM workspace_change_requests WHERE user_id = 'alice' AND request_id = ?").get(id)).toEqual({ workspace_id: first.id, kind: "rename" });
  } finally { renamed.close(); }
  for (const [target, changed] of [
    [first.id, { requestId: id, name: "changed" }], [first.id, { requestId: id, archived: true }],
    [second, { requestId: id, name: "once" }], [first.id, { requestId: creationId, name: "first" }],
    [first.id, { requestId: creationId, archived: true }],
  ] as const) expect((await app.handle(request("PATCH", `/${target}`, changed))).status).toBe(409);
  expect((await app.handle(request("POST", "", { requestId: id, name: "once" }))).status).toBe(409);
  expect((await app.handle(request("GET", `/receipts/${id}`))).status).toBe(409);
  expect((await app.handle(request("GET", `/${second}/receipts/${id}`))).status).toBe(409);
  const archiveId = crypto.randomUUID();
  const archiveProbeStart = probes.length;
  const archived = await Promise.all(Array.from({ length: 4 }, (_, index) => (index % 2 ? app : peer).handle(request("PATCH", `/${first.id}`, { requestId: archiveId, archived: true }))));
  const archiveBodies = await Promise.all(archived.map((response) => response.text()));
  expect(errors, JSON.stringify({ archiveBodies, probes, errors })).toEqual([]);
  expect(archived.some((response) => response.status === 200)).toBe(true);
  const canonicalArchive = { requestId: archiveId, kind: "archive", workspace: { ...first, name: body.name, archived: true } };
  for (const [index, response] of archived.entries()) {
    const snapshot = JSON.parse(archiveBodies[index]!);
    if (response.status === 503) {
      expect(snapshot).toEqual({ error: "storage_unavailable" });
      expect(probes.slice(archiveProbeStart).some((probe) => probe.instance === (index % 2 ? "first" : "second") && !probe.ready)).toBe(true);
    } else {
      expect(response.status, JSON.stringify({ archiveBodies, probes, errors })).toBe(200);
      expect(snapshot).toEqual(canonicalArchive);
    }
  }
  const archiveReceipt = await app.handle(request("GET", `/${first.id}/receipts/${archiveId}`));
  expect(archiveReceipt.status).toBe(200);
  expect(await archiveReceipt.json()).toEqual(canonicalArchive);
  expect(await (await app.handle(request("GET", `/${first.id}`))).json()).toEqual(canonicalArchive.workspace);
  expect(await (await app.handle(request("GET", `/${first.id}/receipts/${id}`))).json()).toEqual(canonicalRename);
  expect((await app.handle(request("PATCH", `/${first.id}`, { requestId: archiveId, name: "once" }))).status).toBe(409);
  const bob = await makeWorkspace(app, "bob", "b");
  expect((await app.handle(request("PATCH", `/${bob}`, { requestId: id, name: "bob own key" }, "b"))).status).toBe(200);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE user_id = 'alice' AND kind = 'rename'").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE user_id = 'alice' AND kind = 'archive'").get()).toEqual({ count: 1 });
    expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(second)).toEqual({ name: "second", archived: 0 });
    expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(first.id)).toEqual({ name: body.name, archived: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_requests WHERE workspace_id = ?").get(first.id)).toEqual({ count: 1 });
    expect(database.query("SELECT workspace_id, kind FROM workspace_change_requests WHERE user_id = 'alice' AND request_id = ?").get(archiveId)).toEqual({ workspace_id: first.id, kind: "archive" });
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 3 });
    expect(database.query("SELECT count(*) AS count FROM workspace_change_requests").get()).toEqual({ count: 3 });
  } finally { database.close(); }
});

it("rolls back creation, rename, and archive when the immutable outcome cannot commit", async () => {
  const { app, path } = setup();
  const workspace = await makeWorkspace(app, "original");
  const database = new Database(path);
  try {
    for (const failure of ["ABORT, 'outcome unavailable'", "IGNORE"]) {
      database.exec(`CREATE TRIGGER reject_workspace_outcome BEFORE INSERT ON workspace_receipts BEGIN SELECT RAISE(${failure}); END`);
      for (const body of [{ requestId: crypto.randomUUID(), name: "rename rejected" }, { requestId: crypto.randomUUID(), archived: true }]) {
        expect((await app.handle(request("PATCH", `/${workspace}`, body))).status).toBe(500);
        expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(workspace)).toEqual({ name: "original", archived: 0 });
        expect((await app.handle(request("GET", `/${workspace}/receipts/${body.requestId}`))).status).toBe(404);
      }
      expect((await app.handle(request("POST", "", { requestId: crypto.randomUUID(), name: "create rejected" }))).status).toBe(500);
      expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
      expect(database.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 0 });
      expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 0 });
      expect(database.query("SELECT count(*) AS count FROM workspace_change_requests").get()).toEqual({ count: 0 });
      database.exec("DROP TRIGGER reject_workspace_outcome");
    }
    database.exec("CREATE TRIGGER reject_metadata_update BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(IGNORE); END");
    expect((await app.handle(request("PATCH", `/${workspace}`, { requestId: crypto.randomUUID(), name: "ignored update" }))).status).toBe(500);
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 0 });
    database.exec("DROP TRIGGER reject_metadata_update");
    database.exec("CREATE TRIGGER ignore_creation_mapping BEFORE INSERT ON workspace_requests BEGIN SELECT RAISE(IGNORE); END");
    expect((await app.handle(request("POST", "", { requestId: crypto.randomUUID(), name: "ignored mapping" }))).status).toBe(500);
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 0 });
    database.exec("DROP TRIGGER ignore_creation_mapping");
    expect((await app.handle(request("PATCH", `/${workspace}`, { requestId: crypto.randomUUID(), name: "accepted" }))).status).toBe(200);
  } finally { database.close(); }
});

function legacyStorage() {
  const directory = mkdtempSync(join(process.env.RC_STORAGE_TEST_WORK_DIR ?? tmpdir(), "rc028-legacy-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX workspaces_user_id ON workspaces(user_id);
    CREATE TABLE workspace_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id), PRIMARY KEY (user_id, request_id));
    CREATE TABLE profiles (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE profile_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, display_name TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, request_id));
    CREATE TABLE history (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), type TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX history_workspace_id ON history(workspace_id, created_at, id);
    CREATE TABLE history_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), history_id TEXT NOT NULL UNIQUE REFERENCES history(id), PRIMARY KEY (user_id, request_id));
  `);
  const requestId = crypto.randomUUID();
  const workspace = { id: crypto.randomUUID(), name: "legacy canonical", createdAt: "2026-09-28T00:00:00.000Z" };
  database.query("INSERT INTO workspaces VALUES (?, 'alice', ?, ?)").run(workspace.id, workspace.name, workspace.createdAt);
  database.query("INSERT INTO workspace_requests VALUES ('alice', ?, ?)").run(requestId, workspace.id);
  database.query("INSERT INTO history VALUES ('legacy-entry', 'alice', ?, 'note', 'keep data', ?)").run(workspace.id, workspace.createdAt);
  database.query("INSERT INTO profiles VALUES ('alice', 'keep profile', ?)").run(workspace.createdAt);
  const historyRequestId = crypto.randomUUID();
  const profileRequestId = crypto.randomUUID();
  database.query("INSERT INTO history_requests VALUES ('alice', ?, ?, 'legacy-entry')").run(historyRequestId, workspace.id);
  database.query("INSERT INTO profile_requests VALUES ('alice', ?, 'keep profile', ?)").run(profileRequestId, workspace.createdAt);
  return { path, database, requestId, workspace, historyRequestId, profileRequestId };
}

it("atomically backfills the real legacy schema before edits and never refreshes old snapshots on restart", async () => {
  const { path, database, requestId, workspace, historyRequestId, profileRequestId } = legacyStorage();
  try {
    const app = createApi(path);
    database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)")
      .run(createHash("sha256").update("a".repeat(64)).digest("hex"), Date.now() + 60_000);
    expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    expect(await (await app.handle(request("GET", `/receipts/${requestId}`))).json()).toEqual(workspace);
    expect((await app.handle(request("PATCH", `/${workspace.id}`, { requestId: crypto.randomUUID(), name: "renamed legacy" }))).status).toBe(200);
    expect((await app.handle(request("PATCH", `/${workspace.id}`, { requestId: crypto.randomUUID(), archived: true }))).status).toBe(200);
    const restarted = createApi(path);
    expect(await (await restarted.handle(request("POST", "", { requestId, name: workspace.name }))).json()).toEqual(workspace);
    expect(await (await restarted.handle(request("GET", `/receipts/${requestId}`))).json()).toEqual(workspace);
    expect(await (await restarted.handle(request("GET", `/${workspace.id}`))).json()).toEqual({ ...workspace, name: "renamed legacy", archived: true });
    expect(await (await restarted.handle(historyRequest("GET", workspace.id))).json()).toEqual({ history: [{ id: "legacy-entry", type: "note", content: "keep data", createdAt: workspace.createdAt }] });
    expect(await (await restarted.handle(profileRequest("GET"))).json()).toMatchObject({ profile: { displayName: "keep profile" } });
    expect(await (await restarted.handle(profileRequest("GET", `/receipts/${profileRequestId}`))).json()).toEqual({ userId: "alice", displayName: "keep profile", updatedAt: workspace.createdAt });
    expect(await (await restarted.handle(historyRequest("GET", workspace.id, `/receipts/${historyRequestId}`))).json()).toEqual({ id: "legacy-entry", type: "note", content: "keep data", createdAt: workspace.createdAt });
    expect(database.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("fails closed and rolls back migration for orphan, foreign-owner, or corrupt legacy creation receipts", async () => {
  for (const corruption of ["orphan", "foreign-owner", "invalid-name"]) {
    const { path, database, workspace } = legacyStorage();
    try {
      if (corruption === "orphan") database.exec("UPDATE workspace_requests SET workspace_id = 'missing'");
      if (corruption === "foreign-owner") database.exec("UPDATE workspace_requests SET user_id = 'bob'");
      if (corruption === "invalid-name") database.exec("UPDATE workspaces SET name = ''");
      const before = database.query("SELECT * FROM workspaces").all();
      const app = createApi(path);
      database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)")
        .run(createHash("sha256").update("a".repeat(64)).digest("hex"), Date.now() + 60_000);
      expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
      expect((await app.handle(request("PATCH", `/${workspace.id}`, { requestId: crypto.randomUUID(), name: "must not edit" }))).status).toBe(503);
      expect((await app.handle(request("POST", "", { name: "legacy must not bypass" }))).status).toBe(503);
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'workspace_receipts'").get()).toBeNull();
      expect(database.query<{ name: string }, []>("PRAGMA table_info(workspaces)").all().some((column) => column.name === "archived")).toBe(false);
      expect(database.query("SELECT * FROM workspaces").all()).toEqual(before);
    } finally { database.close(); }
  }
});

it("marks missing or corrupt receipt and archive schemas unready before accepting edits", async () => {
  for (const corruption of ["missing-receipts", "missing-archive", "orphan-outcome", "missing-outcome", "corrupt-workspace"]) {
    const { app, path } = setup();
    const id = crypto.randomUUID();
    const workspace = await (await app.handle(request("POST", "", { requestId: id, name: "durable" }))).json();
    const database = new Database(path);
    try {
      if (corruption === "missing-receipts") database.exec("DROP TABLE workspace_receipts");
      if (corruption === "missing-archive") database.exec("ALTER TABLE workspaces DROP COLUMN archived");
      if (corruption === "orphan-outcome") database.exec("UPDATE workspace_receipts SET workspace_id = 'missing'");
      if (corruption === "missing-outcome") database.exec("DELETE FROM workspace_receipts");
      if (corruption === "corrupt-workspace") database.exec("UPDATE workspaces SET created_at = ''");
      expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
      expect((await app.handle(request("PATCH", `/${workspace.id}`, { requestId: crypto.randomUUID(), name: "not accepted" }))).status).toBe(503);
      expect(database.query("SELECT name FROM workspaces").get()).toEqual({ name: "durable" });
      const restarted = createApi(path);
      expect((await restarted.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
      expect((await restarted.handle(request("PATCH", `/${workspace.id}`, { requestId: crypto.randomUUID(), name: "must not repair snapshots" }))).status).toBe(503);
      expect(database.query("SELECT name FROM workspaces").get()).toEqual({ name: "durable" });
    } finally { database.close(); }
  }
});

it("uses shared Eden detail, rename, archive and outcome lookup to recover a lost metadata response without resubmission", async () => {
  const { app, path } = setup();
  const workspaceId = await makeWorkspace(app, "first");
  const otherId = await makeWorkspace(app, "second");
  let current = app;
  let submissions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const response = await current.handle(request);
      if (request.method === "PATCH") {
        submissions++;
        if (submissions === 1 && response.status === 200) return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
        }), { headers: { "content-type": "application/json" } });
      }
      return response;
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const options = { timeoutMs: 100, headers: { cookie: `remotecode_session=${"a".repeat(64)}` } };
    const client = createApiClient(origin, options);
    const requestId = crypto.randomUUID();
    const lost = await client.api.workspaces({ workspaceId }).patch({ requestId, name: "committed rename" });
    expect(isUnknownOutcomeError(lost.error)).toBe(true);
    current = createApi(path);
    const fresh = createApiClient(origin, options);
    const receipt = await fresh.api.workspaces({ workspaceId }).receipts({ requestId }).get();
    expect(receipt.error).toBeNull();
    expect(receipt.data).toMatchObject({ requestId, kind: "rename", workspace: { id: workspaceId, name: "committed rename", archived: false } });
    expect(submissions).toBe(1);
    if (!receipt.data || receipt.data.kind !== "rename") throw new Error("Expected rename receipt");
    expect((await fresh.api.workspaces({ workspaceId }).get()).data).toEqual(receipt.data.workspace);
    expect((await fresh.api.workspaces({ workspaceId: otherId }).get()).data).toMatchObject({ id: otherId, name: "second" });
    const archiveId = crypto.randomUUID();
    const archive = await fresh.api.workspaces({ workspaceId }).patch({ requestId: archiveId, archived: true });
    expect(archive.error).toBeNull();
    expect(archive.data).toMatchObject({ requestId: archiveId, kind: "archive", workspace: { id: workspaceId, archived: true } });
    if (!archive.data || archive.data.kind !== "archive") throw new Error("Expected archive outcome");
    expect((await fresh.api.workspaces({ workspaceId }).receipts({ requestId: archiveId }).get()).data).toEqual(archive.data);
    expect((await fresh.api.workspaces({ workspaceId }).receipts({ requestId }).get()).data).toEqual(receipt.data);
  } finally { server.stop(true); }
});

it("waits for a brief real SQLite writer after readiness and commits one canonical metadata outcome", async () => {
  const { app: initialApi, path } = setup();
  const workspaceId = await makeWorkspace(initialApi, "before contention");
  const url = URL.createObjectURL(new Blob([`
    import { Database } from "bun:sqlite";
    self.onmessage = (event) => {
      const database = new Database(event.data);
      database.exec("BEGIN IMMEDIATE");
      self.postMessage("locked");
      setTimeout(() => {
        database.exec("ROLLBACK");
        database.close();
        self.postMessage("released");
      }, 40);
    };
  `], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  let locked: () => void;
  let released: () => void;
  const lock = new Promise<void>((resolve) => { locked = resolve; });
  const release = new Promise<void>((resolve) => { released = resolve; });
  let held = false;
  let unlocked = false;
  let workerFailure: string | null = null;
  worker.onmessage = (event: MessageEvent<string>) => {
    if (event.data === "locked") { held = true; locked(); }
    if (event.data === "released") { unlocked = true; released(); }
  };
  worker.onerror = (event) => { workerFailure = event.message; locked(); released(); };
  const timer = setTimeout(() => { workerFailure = "SQLite test worker timed out"; locked(); released(); }, 1500);
  const errors: { message: string; code: unknown; errno: unknown }[] = [];
  let durationMs = 0;
  let ready = false;
  const app = createApi(path, async () => {
    const started = performance.now();
    ready = await checkDatabase(path);
    durationMs = performance.now() - started;
    if (ready) {
      worker.postMessage(path);
      await lock;
      if (!held || workerFailure) throw new Error(workerFailure ?? "SQLite test worker did not acquire its lock");
    }
    return ready;
  }).onError({ as: "global" }, ({ error }) => {
    errors.push({ message: error instanceof Error ? error.message : String(error),
      code: "code" in error ? error.code : null, errno: "errno" in error ? error.errno : null });
  });
  const requestId = crypto.randomUUID();
  try {
    const response = await app.handle(request("PATCH", `/${workspaceId}`, { requestId, name: "after contention" }));
    if (!ready) throw new Error("Readiness failed before the controlled writer started");
    await release;
    expect(unlocked, workerFailure ?? "SQLite test worker did not release its lock").toBe(true);
    const body = await response.text();
    expect(response.status, JSON.stringify({ body, errors, durationMs, ready })).toBe(200);
    expect(errors).toEqual([]);
    const canonical = JSON.parse(body);
    expect(canonical).toMatchObject({ requestId, kind: "rename", workspace: { id: workspaceId, name: "after contention" } });
    expect(await (await app.handle(request("GET", `/${workspaceId}/receipts/${requestId}`))).json()).toEqual(canonical);
    const database = new Database(path);
    try {
      expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE request_id = ?").get(requestId)).toEqual({ count: 1 });
    } finally { database.close(); }
  } finally {
    clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(url);
  }
});

it("rejects real probe contention before acceptance and recovers only after an authoritative absent receipt", async () => {
  const { app: initialApi, path } = setup();
  const creationId = crypto.randomUUID();
  const created = await (await initialApi.handle(request("POST", "", { requestId: creationId, name: "before rejection" }))).json();
  const probes: { durationMs: number; ready: boolean }[] = [];
  const app = createApi(path, async () => {
    const start = performance.now();
    const ready = await checkDatabase(path);
    probes.push({ durationMs: performance.now() - start, ready });
    return ready;
  });
  const requestId = crypto.randomUUID();
  const body = { requestId, name: "after recovery" };
  const owner = new Database(path);
  owner.exec("BEGIN IMMEDIATE");
  try {
    const rejected = await app.handle(request("PATCH", `/${created.id}`, body));
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: "storage_unavailable" });
    expect(probes).toHaveLength(1);
    expect(probes[0]?.ready).toBe(false);
    expect(owner.query("SELECT name, archived FROM workspaces WHERE id = ?").get(created.id)).toEqual({ name: created.name, archived: 0 });
    expect(owner.query("SELECT count(*) AS count FROM workspace_receipts WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    expect(owner.query("SELECT count(*) AS count FROM workspace_change_requests WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    expect(owner.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 1 });
    expect(owner.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 1 });
  } finally {
    owner.exec("ROLLBACK");
    owner.close();
  }
  const absent = await app.handle(request("GET", `/${created.id}/receipts/${requestId}`));
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: "receipt_not_found" });
  expect(await (await app.handle(request("GET", `/${created.id}`))).json()).toEqual({ ...created, archived: false });
  expect(await (await app.handle(request("GET", `/receipts/${creationId}`))).json()).toEqual(created);
  const accepted = await app.handle(request("PATCH", `/${created.id}`, body));
  expect(accepted.status).toBe(200);
  const canonical = { requestId, kind: "rename", workspace: { ...created, name: body.name, archived: false } };
  expect(await accepted.json()).toEqual(canonical);
  expect(await (await app.handle(request("GET", `/${created.id}/receipts/${requestId}`))).json()).toEqual(canonical);
  expect(await (await app.handle(request("PATCH", `/${created.id}`, body))).json()).toEqual(canonical);
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE request_id = ?").get(requestId)).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM workspace_change_requests WHERE request_id = ?").get(requestId)).toEqual({ count: 1 });
  } finally { database.close(); }
});

it("keeps accepted change IDs unavailable when their immutable outcome is lost, including after restart", async () => {
  for (const kind of ["rename", "archive"] as const) {
    const { app, path } = setup();
    const workspaceId = await makeWorkspace(app, "original");
    const requestId = crypto.randomUUID();
    const body = kind === "rename" ? { requestId, name: "accepted" } : { requestId, archived: true };
    const accepted = await app.handle(request("PATCH", `/${workspaceId}`, body));
    expect(accepted.status).toBe(200);
    const canonical = await accepted.json();
    const database = new Database(path);
    try {
      database.query("DELETE FROM workspace_receipts WHERE user_id = 'alice' AND request_id = ?").run(requestId);
      const lookup = await app.handle(request("GET", `/${workspaceId}/receipts/${requestId}`));
      expect([500, 503]).toContain(lookup.status);
      expect([500, 503]).toContain((await app.handle(request("GET", `/receipts/${requestId}/outcome`))).status);
      expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
      const restarted = createApi(path);
      for (const candidate of [body, { requestId, name: "must not reuse acceptance" }]) {
        const replay = await restarted.handle(request("PATCH", `/${workspaceId}`, candidate));
        expect([500, 503]).toContain(replay.status);
      }
      expect([500, 503]).toContain((await restarted.handle(request("GET", `/${workspaceId}/receipts/${requestId}`))).status);
      expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({
        name: canonical.workspace.name, archived: Number(canonical.workspace.archived),
      });
      expect(database.query("SELECT workspace_id, kind FROM workspace_change_requests WHERE user_id = 'alice' AND request_id = ?").get(requestId))
        .toEqual({ workspace_id: workspaceId, kind });
      expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    } finally { database.close(); }
  }
});

it("never reports an accepted creation ID as absent when its outcome is lost", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  const created = await (await app.handle(request("POST", "", { requestId, name: "accepted creation" }))).json();
  const database = new Database(path);
  try {
    database.query("DELETE FROM workspace_receipts WHERE request_id = ?").run(requestId);
    for (const route of [`/receipts/${requestId}`, `/${created.id}/receipts/${requestId}`, `/receipts/${requestId}/outcome`]) {
      expect([500, 503]).toContain((await app.handle(request("GET", route))).status);
    }
    const restarted = createApi(path);
    expect([500, 503]).toContain((await restarted.handle(request("GET", `/receipts/${requestId}`))).status);
    expect([500, 503]).toContain((await restarted.handle(request("POST", "", { requestId, name: "must not create" }))).status);
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(database.query("SELECT workspace_id FROM workspace_requests WHERE request_id = ?").get(requestId)).toEqual({ workspace_id: created.id });
  } finally { database.close(); }
});

it("validates receipt target ownership and acceptance directly before either GET can emit metadata", async () => {
  for (const kind of ["create", "rename"] as const) {
    for (const corruption of ["foreign-target", "receipt-owner", "mapping-owner", "missing-mapping", "wrong-kind"]) {
      const { app, path } = setup();
      const requestId = crypto.randomUUID();
      const alice = kind === "create"
        ? (await (await app.handle(request("POST", "", { requestId, name: "alice" }))).json()).id
        : await makeWorkspace(app, "alice");
      if (kind === "rename") expect((await app.handle(request("PATCH", `/${alice}`, { requestId, name: "alice renamed" }))).status).toBe(200);
      const bob = await makeWorkspace(app, "bob secret metadata", "b");
      const database = new Database(path);
      try {
        const mapping = kind === "create" ? "workspace_requests" : "workspace_change_requests";
        if (corruption === "foreign-target") database.query("UPDATE workspace_receipts SET workspace_id = ?, name = 'bob secret metadata' WHERE request_id = ?").run(bob, requestId);
        if (corruption === "receipt-owner") database.query("UPDATE workspace_receipts SET user_id = 'bob' WHERE request_id = ?").run(requestId);
        if (corruption === "mapping-owner") database.query(`UPDATE ${mapping} SET user_id = 'bob' WHERE request_id = ?`).run(requestId);
        if (corruption === "missing-mapping") database.query(`DELETE FROM ${mapping} WHERE request_id = ?`).run(requestId);
        if (corruption === "wrong-kind") database.query("UPDATE workspace_receipts SET kind = ? WHERE request_id = ?").run(kind === "create" ? "rename" : "create", requestId);
        for (const [user, target] of [["a", alice], ["b", bob]]) {
          for (const route of [`/receipts/${requestId}`, `/${target}/receipts/${requestId}`, `/receipts/${requestId}/outcome`]) {
            const response = await app.handle(request("GET", route, undefined, user));
            expect([404, 500, 503]).toContain(response.status);
            const text = await response.text();
            expect(text).not.toContain("bob secret metadata");
            expect(text).not.toContain("alice renamed");
            if (user === "a") expect([500, 503]).toContain(response.status);
          }
        }
        expect((await app.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
      } finally { database.close(); }
    }
  }
});

it("rolls back new metadata effects and outcomes when acceptance mapping inserts abort or are ignored", async () => {
  const { app, path } = setup();
  const workspaceId = await makeWorkspace(app, "original");
  const database = new Database(path);
  try {
    for (const failure of ["ABORT, 'mapping unavailable'", "IGNORE"]) {
      database.exec(`CREATE TRIGGER reject_workspace_change BEFORE INSERT ON workspace_change_requests BEGIN SELECT RAISE(${failure}); END`);
      for (const body of [{ requestId: crypto.randomUUID(), name: "not accepted" }, { requestId: crypto.randomUUID(), archived: true }]) {
        expect((await app.handle(request("PATCH", `/${workspaceId}`, body))).status).toBe(500);
        expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ name: "original", archived: 0 });
        expect((await app.handle(request("GET", `/${workspaceId}/receipts/${body.requestId}`))).status).toBe(404);
        expect(database.query("SELECT count(*) AS count FROM workspace_change_requests").get()).toEqual({ count: 0 });
        expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 0 });
      }
      database.exec("DROP TRIGGER reject_workspace_change");
    }
  } finally { database.close(); }
});

it("backfills pre-marker changes only from immutable outcomes and never repairs missing mappings or outcomes on restart", async () => {
  const { app, path } = setup();
  const workspaceId = await makeWorkspace(app, "original");
  const firstId = crypto.randomUUID();
  const archiveId = crypto.randomUUID();
  const first = await (await app.handle(request("PATCH", `/${workspaceId}`, { requestId: firstId, name: "first snapshot" }))).json();
  expect((await app.handle(request("PATCH", `/${workspaceId}`, { requestId: crypto.randomUUID(), name: "current name" }))).status).toBe(200);
  const archived = await (await app.handle(request("PATCH", `/${workspaceId}`, { requestId: archiveId, archived: true }))).json();
  const database = new Database(path);
  try {
    database.exec("DROP TABLE workspace_change_requests");
    const migrated = createApi(path);
    expect((await migrated.handle(new Request("http://localhost/api/health/ready"))).status).toBe(200);
    expect(await (await migrated.handle(request("GET", `/${workspaceId}/receipts/${firstId}`))).json()).toEqual(first);
    expect(await (await migrated.handle(request("GET", `/${workspaceId}/receipts/${archiveId}`))).json()).toEqual(archived);
    expect(database.query("SELECT count(*) AS count FROM workspace_change_requests").get()).toEqual({ count: 3 });
    database.query("DELETE FROM workspace_change_requests WHERE request_id = ?").run(firstId);
    const damaged = createApi(path);
    expect((await damaged.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
    expect([500, 503]).toContain((await damaged.handle(request("GET", `/${workspaceId}/receipts/${firstId}`))).status);
    expect(database.query("SELECT count(*) AS count FROM workspace_change_requests WHERE request_id = ?").get(firstId)).toEqual({ count: 0 });
    expect(database.query("SELECT name FROM workspace_receipts WHERE request_id = ?").get(firstId)).toEqual({ name: "first snapshot" });
  } finally { database.close(); }
});

it("blocks accepted-ID replay if its result disappears after a real successful readiness probe", async () => {
  for (const kind of ["create", "rename"] as const) {
    const { app, path } = setup();
    const requestId = crypto.randomUUID();
    const workspaceId = kind === "create"
      ? (await (await app.handle(request("POST", "", { requestId, name: "original" }))).json()).id
      : await makeWorkspace(app, "original");
    if (kind === "rename") expect((await app.handle(request("PATCH", `/${workspaceId}`, { requestId, name: "original accepted" }))).status).toBe(200);
    const database = new Database(path);
    database.exec("PRAGMA busy_timeout = 250");
    const before = database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(workspaceId);
    let probedReady = false;
    const raced = createApi(path, async () => {
      probedReady = await checkDatabase(path);
      if (probedReady) database.query("DELETE FROM workspace_receipts WHERE request_id = ?").run(requestId);
      return probedReady;
    });
    try {
      const response = await raced.handle(kind === "create"
        ? request("POST", "", { requestId, name: "must not create again" })
        : request("PATCH", `/${workspaceId}`, { requestId, name: "must not rename again" }));
      expect(probedReady).toBe(true);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Stored workspace receipt is unavailable");
      expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual(before);
      expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
      expect(database.query("SELECT count(*) AS count FROM workspace_receipts WHERE request_id = ?").get(requestId)).toEqual({ count: 0 });
    } finally { database.close(); }
  }
});

it("rolls back marker backfill when a pre-marker snapshot points to another owner", async () => {
  const { app, path } = setup();
  const workspaceId = await makeWorkspace(app, "alice");
  const foreignId = await makeWorkspace(app, "bob private", "b");
  const requestId = crypto.randomUUID();
  expect((await app.handle(request("PATCH", `/${workspaceId}`, { requestId, name: "alice accepted" }))).status).toBe(200);
  const database = new Database(path);
  try {
    database.exec("DROP TABLE workspace_change_requests");
    database.query("UPDATE workspace_receipts SET workspace_id = ? WHERE request_id = ?").run(foreignId, requestId);
    const migrated = createApi(path);
    expect((await migrated.handle(new Request("http://localhost/api/health/ready"))).status).toBe(503);
    const lookup = await migrated.handle(request("GET", `/${workspaceId}/receipts/${requestId}`));
    expect([500, 503]).toContain(lookup.status);
    expect(await lookup.text()).not.toContain("bob private");
    expect(database.query("SELECT name FROM sqlite_master WHERE name = 'workspace_change_requests'").get()).toBeNull();
    expect(database.query("SELECT name FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ name: "alice accepted" });
    expect(database.query("SELECT workspace_id FROM workspace_receipts WHERE request_id = ?").get(requestId)).toEqual({ workspace_id: foreignId });
  } finally { database.close(); }
});

it("confirms creation and metadata operation IDs and kinds through the all-kind Eden outcome route after restart", async () => {
  const { app, path } = setup();
  let current = app;
  const server = Bun.serve({ port: 0, fetch: (request) => current.handle(request) });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const options = { headers: { cookie: `remotecode_session=${"a".repeat(64)}` } };
    const client = createApiClient(origin, options);
    const requestId = "abcdefab-1234-4abc-8def-abcdefabcdef";
    const creation = await client.api.workspaces.post({ requestId: requestId.toUpperCase(), name: "original" });
    expect(creation.status).toBe(201);
    if (!creation.data || !("id" in creation.data) || typeof creation.data.id !== "string") throw new Error("Expected created workspace");
    expect(Object.keys(creation.data).sort()).toEqual(["createdAt", "id", "name"]);
    const canonicalCreate = { requestId, kind: "create" as const, workspace: { ...creation.data, archived: false } };
    const createdOutcome = await client.api.workspaces.receipts({ requestId: requestId.toUpperCase() }).outcome.get();
    expect(createdOutcome.error).toBeNull();
    expect(createdOutcome.data).toEqual(canonicalCreate);
    const workspaceId = creation.data.id;
    const renameId = crypto.randomUUID();
    const renamed = await client.api.workspaces({ workspaceId }).patch({ requestId: renameId, name: "renamed" });
    if (!renamed.data || renamed.data.kind !== "rename") throw new Error("Expected rename outcome");
    const archiveId = crypto.randomUUID();
    const archived = await client.api.workspaces({ workspaceId }).patch({ requestId: archiveId, archived: true });
    if (!archived.data || archived.data.kind !== "archive") throw new Error("Expected archive outcome");
    current = createApi(path);
    const fresh = createApiClient(origin, options);
    expect((await fresh.api.workspaces.receipts({ requestId }).outcome.get()).data).toEqual(canonicalCreate);
    expect((await fresh.api.workspaces.receipts({ requestId: renameId }).outcome.get()).data).toEqual(renamed.data);
    expect((await fresh.api.workspaces.receipts({ requestId: archiveId }).outcome.get()).data).toEqual(archived.data);
    expect((await fresh.api.workspaces.receipts({ requestId }).get()).data).toEqual(creation.data);
    expect((await fresh.api.workspaces.post({ requestId, name: "original" })).data).toEqual(creation.data);
    expect((await fresh.api.workspaces({ workspaceId }).receipts({ requestId: renameId }).get()).data).toEqual(renamed.data);
    const database = new Database(path);
    try {
      expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
      expect(database.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 1 });
      expect(database.query("SELECT count(*) AS count FROM workspace_change_requests").get()).toEqual({ count: 2 });
      expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 3 });
      expect(database.query("SELECT name, archived FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({ name: "renamed", archived: 1 });
    } finally { database.close(); }
  } finally { server.stop(true); }
});

it("rejects malformed and anonymous outcome lookups and hides other owners' operation IDs without writes", async () => {
  const { app, path } = setup();
  const requestId = crypto.randomUUID();
  const created = await (await app.handle(request("POST", "", { requestId, name: "alice private" }))).json();
  for (const invalid of ["invalid", requestId.replaceAll("-", ""), `urn:uuid:${requestId}`]) {
    expect((await app.handle(request("GET", `/receipts/${invalid}/outcome`))).status).toBe(422);
  }
  expect((await app.handle(new Request(`http://localhost/api/workspaces/receipts/${requestId}/outcome`))).status).toBe(401);
  expect((await app.handle(request("GET", `/receipts/${requestId}/outcome`, undefined, "c"))).status).toBe(401);
  for (const [id, user] of [[requestId, "b"], [crypto.randomUUID(), "a"]]) {
    const missing = await app.handle(request("GET", `/receipts/${id}/outcome`, undefined, user));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "receipt_not_found" });
  }
  const bob = await (await app.handle(request("POST", "", { requestId, name: "bob own operation" }, "b"))).json();
  expect(await (await app.handle(request("GET", `/receipts/${requestId}/outcome`, undefined, "b"))).json())
    .toEqual({ requestId, kind: "create", workspace: { ...bob, archived: false } });
  expect(await (await app.handle(request("GET", `/receipts/${requestId}/outcome`))).json())
    .toEqual({ requestId, kind: "create", workspace: { ...created, archived: false } });
  const database = new Database(path);
  try {
    expect(database.query("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 2 });
    expect(database.query("SELECT count(*) AS count FROM workspace_requests").get()).toEqual({ count: 2 });
    expect(database.query("SELECT count(*) AS count FROM workspace_receipts").get()).toEqual({ count: 2 });
    expect(database.query("SELECT count(*) AS count FROM workspace_change_requests").get()).toEqual({ count: 0 });
  } finally { database.close(); }
});
