import { expect, it } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createApi } from "./app";

const dir = mkdtempSync(join(tmpdir(), "rc033-layout-"));
const databasePath = join(dir, "layout.sqlite");
const password = randomBytes(32).toString("base64url");
const app = createApi(databasePath, undefined, { password, sessionTtlMs: 120_000 });

// Two real sessions for distinct users, seeded like action-requests.test.ts.
// INSERT OR IGNORE: logout deletes all sessions mid-file, so reseeds after
// that must not fail on the surviving bob row.
function seedSession(token: string, userId: string) {
  const database = new Database(databasePath);
  try {
    database.query("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), userId, Date.now() + 60_000);
  } finally { database.close(); }
}
const cookieA = `remotecode_session=${"a".repeat(64)}`;
const cookieB = `remotecode_session=${"b".repeat(64)}`;
seedSession("a".repeat(64), "alice");
seedSession("b".repeat(64), "bob");

async function call(path: string, cookie = "", method = "GET", body?: unknown) {
  const request = new Request(`https://localhost${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await app.handle(request);
  return { status: response.status, body: await response.json().catch(() => null) as any,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

const loginBody = (requestId = randomUUID()) => ({ password, requestId });

it("saves and reopens per-workspace tabs without moving the other workspace", async () => {
  const makeWorkspace = async (name: string) => {
    const created = await call("/api/workspaces", cookieA, "POST", { name, requestId: randomUUID() });
    expect(created.status).toBe(201);
    const listed = await call("/api/workspaces", cookieA);
    return listed.body.workspaces.find((row: any) => row.name === name).id as string;
  };
  const workspaceA = await makeWorkspace(`layout-a-${randomUUID()}`);
  const workspaceB = await makeWorkspace(`layout-b-${randomUUID()}`);
  // Empty layout reads null, not fabricated tabs.
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceA, layout: null });
  const layoutA = { tabs: [{ id: "tab-1", kind: "file", targetId: "seed.txt" }, { id: "tab-2", kind: "terminal", targetId: "term-1" }], activeTabId: "tab-2" };
  const saved = await call(`/api/workspaces/${workspaceA}/layout`, cookieA, "PUT", layoutA);
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({ workspaceId: workspaceA, layout: layoutA });
  // Reopen returns the same tabs; the other workspace is untouched.
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceA, layout: layoutA });
  expect((await call(`/api/workspaces/${workspaceB}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceB, layout: null });
  // Switching tabs on A never moves B.
  const switched = { tabs: layoutA.tabs, activeTabId: "tab-1" };
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA, "PUT", switched)).body).toEqual({ workspaceId: workspaceA, layout: switched });
  expect((await call(`/api/workspaces/${workspaceB}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceB, layout: null });
  // Authoritative read-back: one row, exact JSON.
  const db = new Database(databasePath, { readonly: true });
  const rows = db.query<{ workspace_id: string; layout: string }, []>("SELECT workspace_id, layout FROM workspace_layouts").all();
  db.close();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ workspace_id: workspaceA, layout: JSON.stringify(switched) });
});

it("rejects anonymous, invalid-session and invalid layouts without effect", async () => {
  const created = await call("/api/workspaces", cookieA, "POST", { name: `layout-c-${randomUUID()}`, requestId: randomUUID() });
  expect(created.status).toBe(201);
  const listed = await call("/api/workspaces", cookieA);
  const workspaceId = listed.body.workspaces.find((row: any) => row.name.startsWith("layout-c-")).id as string;
  void created;
  const layout = { tabs: [{ id: "t1", kind: "file", targetId: "a.txt" }], activeTabId: "t1" };
  expect((await call(`/api/workspaces/${workspaceId}/layout`, "", "PUT", layout)).status).toBe(401);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, "")).status).toBe(401);
  // Second login for the same local user shares the local identity; use a
  // fabricated session cookie to prove invalid-session isolation instead.
  // Authenticated cross-user isolation is inherited from the workspace
  // ownership lookup (workspaces are per-user rows); no second user exists
  // in this single-local-user auth model.
  expect((await call(`/api/workspaces/${workspaceId}/layout`, "remotecode_session=" + "0".repeat(64), "PUT", layout)).status).toBe(401);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, "remotecode_session=" + "0".repeat(64))).status).toBe(401);
  for (const bad of [
    { tabs: [], activeTabId: "nope" },
    { tabs: [{ id: "t1", kind: "browser", targetId: "x" }], activeTabId: "t1" },
    { tabs: [{ id: "t1", kind: "file", targetId: "x" }, { id: "t1", kind: "file", targetId: "y" }], activeTabId: "t1" },
    { tabs: [], activeTabId: null, activePaneId: null },
    { tabs: [{ id: "t1", kind: "file", targetId: "x" }], activeTabId: "t1",
      panes: [{ id: "p1", tabId: "t1", order: 0 }, { id: "p2", tabId: "t1", order: 2 }], activePaneId: "p1" },
  ]) expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieA, "PUT", bad)).status).toBe(422);
  // Rejected writes changed nothing.
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieA)).body).toEqual({ workspaceId, layout: null });
});

it("denies a valid B session on A's workspace layout and leaves A's row unchanged", async () => {
  const created = await call("/api/workspaces", cookieA, "POST", { name: `layout-d-${randomUUID()}`, requestId: randomUUID() });
  expect(created.status).toBe(201);
  const listed = await call("/api/workspaces", cookieA);
  const workspaceId = listed.body.workspaces.find((row: any) => row.name.startsWith("layout-d-")).id as string;
  const layout = { tabs: [{ id: "t1", kind: "file", targetId: "a.txt" }], activeTabId: "t1" };
  const saved = await call(`/api/workspaces/${workspaceId}/layout`, cookieA, "PUT", layout);
  expect(saved.status).toBe(200);
  // Valid B session: both endpoints 404, no row created or changed for B —
  // including with a pane payload, so panes cannot change ownership either.
  const paneLayout = { ...layout, panes: [{ id: "p1", tabId: "t1", order: 0 }], activePaneId: "p1" };
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieB, "PUT", layout)).status).toBe(404);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieB, "PUT", paneLayout)).status).toBe(404);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieB)).status).toBe(404);
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db.query<{ user_id: string; layout: string }, [string]>(
      "SELECT user_id, layout FROM workspace_layouts WHERE workspace_id = ?").all(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ user_id: "alice", layout: JSON.stringify(layout) });
  } finally { db.close(); }
  // A's layout still reads back intact.
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieA)).body).toEqual({ workspaceId, layout });
});

it("stops layout access after logout and after session expiry", async () => {
  const created = await call("/api/workspaces", cookieA, "POST", { name: `layout-g-${randomUUID()}`, requestId: randomUUID() });
  expect(created.status).toBe(201);
  const listed = await call("/api/workspaces", cookieA);
  const workspaceId = listed.body.workspaces.find((row: any) => row.name.startsWith("layout-g-")).id as string;
  const layout = { tabs: [{ id: "t1", kind: "file", targetId: "a.txt" }], activeTabId: "t1" };
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieA, "PUT", layout)).status).toBe(200);
  // Logout revokes the session: the same cookie is now unauthorized.
  const logout = await call("/api/auth/logout", cookieA, "POST", {});
  expect([200, 204].includes(logout.status)).toBe(true);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieA)).status).toBe(401);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookieA, "PUT", layout)).status).toBe(401);
  // Expired session row: same denial without touching the layout row.
  const stale = `remotecode_session=${"c".repeat(64)}`;
  const db = new Database(databasePath);
  try {
    const { createHash } = await import("node:crypto");
    db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("c".repeat(64)).digest("hex"), "alice", Date.now() - 1000);
  } finally { db.close(); }
  expect((await call(`/api/workspaces/${workspaceId}/layout`, stale)).status).toBe(401);
  expect((await call(`/api/workspaces/${workspaceId}/layout`, stale, "PUT", layout)).status).toBe(401);
  // Logout deletes all alice sessions (bob's too if shared); reseed both
  // before later tests — this file shares one database.
  seedSession("b".repeat(64), "bob");
});

it("saves two panes and restores them after reopen without moving the other workspace", async () => {
  seedSession("a".repeat(64), "alice");
  const created = await call("/api/workspaces", cookieA, "POST", { name: `layout-e-${randomUUID()}`, requestId: randomUUID() });
  expect(created.status).toBe(201);
  const listed = await call("/api/workspaces", cookieA);
  const workspaceA = listed.body.workspaces.find((row: any) => row.name.startsWith("layout-e-")).id as string;
  const other = await call("/api/workspaces", cookieA, "POST", { name: `layout-f-${randomUUID()}`, requestId: randomUUID() });
  expect(other.status).toBe(201);
  const relisted = await call("/api/workspaces", cookieA);
  const workspaceB = relisted.body.workspaces.find((row: any) => row.name.startsWith("layout-f-")).id as string;
  const layout = {
    tabs: [{ id: "tab-1", kind: "file", targetId: "a.txt" }],
    activeTabId: "tab-1",
    panes: [{ id: "pane-1", tabId: "tab-1", order: 0 }, { id: "pane-2", tabId: "tab-1", order: 1 }],
    activePaneId: "pane-2",
  };
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA, "PUT", layout)).status).toBe(200);
  // Close and reopen: both panes return, active pane intact, B untouched.
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceA, layout });
  expect((await call(`/api/workspaces/${workspaceB}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceB, layout: null });
  // Selecting the other pane on A never moves B.
  const switched = { ...layout, activePaneId: "pane-1" };
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA, "PUT", switched)).status).toBe(200);
  expect((await call(`/api/workspaces/${workspaceB}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceB, layout: null });
  expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA)).body).toEqual({ workspaceId: workspaceA, layout: switched });
  for (const bad of [
    { ...layout, panes: [{ id: "pane-1", tabId: "missing", order: 0 }] },
    { ...layout, panes: [{ id: "pane-1", tabId: "tab-1", order: 1 }] },
    { ...layout, activePaneId: "pane-9" },
  ]) expect((await call(`/api/workspaces/${workspaceA}/layout`, cookieA, "PUT", bad)).status).toBe(422);
});
