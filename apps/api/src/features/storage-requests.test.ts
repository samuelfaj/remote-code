import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../app";
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
