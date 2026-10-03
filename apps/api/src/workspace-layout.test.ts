import { expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createApi } from "./app";

const dir = mkdtempSync(join(tmpdir(), "rc033-layout-"));
const databasePath = join(dir, "layout.sqlite");
const password = randomBytes(32).toString("base64url");
const app = createApi(databasePath, undefined, { password, sessionTtlMs: 120_000 });

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
  const loginA = await call("/api/auth/login", "", "POST", { password });
  expect(loginA.status).toBe(200);
  const cookieA = loginA.cookie;
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
  const login = await call("/api/auth/login", "", "POST", { password });
  const cookie = login.cookie;
  const created = await call("/api/workspaces", cookie, "POST", { name: `layout-c-${randomUUID()}`, requestId: randomUUID() });
  const listed = await call("/api/workspaces", cookie);
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
  ]) expect((await call(`/api/workspaces/${workspaceId}/layout`, cookie, "PUT", bad)).status).toBe(422);
  // Rejected writes changed nothing.
  expect((await call(`/api/workspaces/${workspaceId}/layout`, cookie)).body).toEqual({ workspaceId, layout: null });
});
