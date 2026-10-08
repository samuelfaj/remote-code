import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../../../apps/api/src/app";
import { createApiClient } from "./index";
import { listSchedules, createSchedule, setScheduleEnabled } from "./routines";
import type { Schedule } from "./routines";

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rc048-routines-client-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function login(app: ReturnType<typeof createApi>) {
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "routines-client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test login cookie missing");
  return cookie;
}

it("createSchedule creates a task schedule and returns the result", async () => {
  const app = createApi(databasePath(), undefined, { password: "routines-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "routines-test", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    const result = await createSchedule("task", workspaceId, undefined, "test prompt", "10:00", "America/New_York", origin, options);
    expect(result.kind).toBe("task");
    expect(result.workspaceId).toBe(workspaceId);
    expect(result.prompt).toBe("test prompt");
    expect(result.enabled).toBe(true);
    expect(result.id).toBeTruthy();
  } finally { await app.stop(true); }
});

it("createSchedule rejects an invalid local_time with 400", async () => {
  const app = createApi(databasePath(), undefined, { password: "routines-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "routines-test2", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    let thrown = false;
    try {
      await createSchedule("task", workspaceId, undefined, "test prompt", "25:00", "America/New_York", origin, options);
    } catch (error) {
      thrown = true;
      expect((error as { status?: number }).status).toBe(400);
    }
    expect(thrown).toBe(true);
  } finally { await app.stop(true); }
});

it("listSchedules returns schedules for the owner", async () => {
  const app = createApi(databasePath(), undefined, { password: "routines-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "routines-test3", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    await createSchedule("task", workspaceId, undefined, "listed prompt", "10:00", "America/New_York", origin, options);
    const schedules = await listSchedules(origin, options);
    expect(schedules.length).toBeGreaterThanOrEqual(1);
  } finally { await app.stop(true); }
});

it("setScheduleEnabled toggles the enabled flag", async () => {
  const app = createApi(databasePath(), undefined, { password: "routines-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "routines-test4", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    const schedule = await createSchedule("task", workspaceId, undefined, "toggle prompt", "10:00", "America/New_York", origin, options);
    expect(schedule.enabled).toBe(true);

    const disabled = await setScheduleEnabled(schedule.id, false, origin, options);
    expect(disabled.enabled).toBe(false);

    const reenabled = await setScheduleEnabled(schedule.id, true, origin, options);
    expect(reenabled.enabled).toBe(true);
  } finally { await app.stop(true); }
});

it("setScheduleEnabled rejects a foreign schedule id with 404", async () => {
  const app = createApi(databasePath(), undefined, { password: "routines-client-test-password" });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const cookie = await login(app);
  const options = { headers: { cookie } };
  const client = createApiClient(origin, options);
  try {
    const created = await client.api.workspaces.post({ name: "routines-test5", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    await createSchedule("task", workspaceId, undefined, "foreign prompt", "10:00", "America/New_York", origin, options);
    let thrown = false;
    try {
      await setScheduleEnabled("00000000-0000-4000-8000-000000000000", false, origin, options);
    } catch (error) {
      thrown = true;
      expect((error as { status?: number }).status).toBe(404);
    }
    expect(thrown).toBe(true);
  } finally { await app.stop(true); }
});
