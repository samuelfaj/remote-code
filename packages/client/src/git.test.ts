import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../../../apps/api/src/app";
import { createApiClient } from "./index";
import { workspaceGitStatus, workspaceGitDiff, workspaceGitBranches, commitGit } from "./git";
import type { GitStatus } from "./git";

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rc048-git-client-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("workspaceGitStatus rejects an unauthorized request with 401", async () => {
  const app = createApi(databasePath(), undefined, { password: "git-client-test-password" });
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  try {
    const result = await createApiClient(origin).api.workspaces({ workspaceId: "00000000-0000-4000-8000-000000000000" }).git.status.get();
    expect(result.error).not.toBeNull();
  } finally {
    await server.stop(true);
  }
});

it.skipIf(process.platform !== "linux")("reports git status through the client helper", async () => {
  const app = createApi(databasePath(), undefined, { password: "git-client-test-password" });
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "git-client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test login cookie missing");
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("API did not bind");
  const origin = `http://127.0.0.1:${port}`;
  const options = { headers: { cookie } };
  const directory = directories[directories.length - 1];

  try {
    const client = createApiClient(origin, options);
    const created = await client.api.workspaces.post({ name: "git-test", requestId: crypto.randomUUID() });
    if (created.error || !created.data || !("id" in created.data)) throw new Error("Workspace unavailable");
    const workspaceId = created.data.id;
    const folderPath = join(directory, "workspaces", workspaceId);
    mkdirSync(folderPath, { recursive: true });

    const provision = await client.api.workspaces({ workspaceId }).folder.post({ requestId: crypto.randomUUID() });
    expect(provision.error).toBeNull();

    const run = (args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "test"]);
    writeFileSync(join(folderPath, "tracked.txt"), "one");
    run(["add", "tracked.txt"]);
    run(["commit", "-m", "init"]);

    const result = await workspaceGitStatus(workspaceId, origin, options);
    expect(result.branch).toBe("main");
    expect(result.clean).toBe(true);

    writeFileSync(join(folderPath, "tracked.txt"), "two");
    writeFileSync(join(folderPath, "new.txt"), "new");
    const dirty = await workspaceGitStatus(workspaceId, origin, options);
    expect(dirty.clean).toBe(false);
    expect(dirty.changed).toContain("tracked.txt");
    expect(dirty.untracked).toContain("new.txt");
  } finally {
    await app.stop(true);
  }
});
