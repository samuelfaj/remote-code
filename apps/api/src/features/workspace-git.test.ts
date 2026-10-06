import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc030-git-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");
  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  const workspaceId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'alice', 'workspace', ?)")
    .run(workspaceId, new Date().toISOString());
  database.close();
  return { app, databasePath, workspaceId, folderPath: join(dirname(databasePath), "workspaces", workspaceId) };
}

afterEach(() => { for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function provision(app: ReturnType<typeof createApi>, workspaceId: string) {
  const response = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/folder`, {
    method: "POST",
    headers: { cookie: `remotecode_session=${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
  }));
  expect(response.status).toBe(200);
}

function git(folderPath: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: folderPath } });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
}

it.skipIf(process.platform !== "linux")("reports branch and clean state, then changed and untracked files", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  git(folderPath, ["init", "-b", "main"]);
  git(folderPath, ["config", "user.email", "test@example.com"]);
  git(folderPath, ["config", "user.name", "test"]);
  writeFileSync(join(folderPath, "tracked.txt"), "one");
  git(folderPath, ["add", "tracked.txt"]);
  git(folderPath, ["commit", "-m", "init"]);
  const clean = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/git/status`, {
    headers: { cookie: `remotecode_session=${ownerToken}` },
  }));
  expect(clean.status).toBe(200);
  const cleanBody = await clean.json() as { branch: string; clean: boolean; changed: string[]; untracked: string[] };
  expect(cleanBody.branch).toBe("main");
  expect(cleanBody.clean).toBe(true);
  writeFileSync(join(folderPath, "tracked.txt"), "two");
  writeFileSync(join(folderPath, "new.txt"), "new");
  const dirty = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/git/status`, {
    headers: { cookie: `remotecode_session=${ownerToken}` },
  }));
  expect(dirty.status).toBe(200);
  const dirtyBody = await dirty.json() as typeof cleanBody;
  expect(dirtyBody.clean).toBe(false);
  expect(dirtyBody.changed).toContain("tracked.txt");
  expect(dirtyBody.untracked).toContain("new.txt");
});

it.skipIf(process.platform !== "linux")("commits through the route and replays the same request id without a second commit", async () => {
  const { app, workspaceId, folderPath } = setup();
  await provision(app, workspaceId);
  git(folderPath, ["init", "-b", "main"]);
  writeFileSync(join(folderPath, "a.txt"), "one");
  const requestId = crypto.randomUUID();
  const post = (body: unknown, token = ownerToken) => app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/git/commit`, {
    method: "POST",
    headers: { cookie: `remotecode_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const first = await post({ requestId, message: "first" });
  expect(first.status).toBe(200);
  const firstBody = await first.json() as { commit: string; branch: string | null };
  expect(firstBody.commit).toMatch(/^[0-9a-f]{40}$/);
  const replay = await post({ requestId, message: "first" });
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as typeof firstBody).commit).toBe(firstBody.commit);
  const log = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: folderPath, stdout: "pipe" });
  expect(log.stdout.toString().trim()).toBe("1");
  const empty = await post({ requestId: crypto.randomUUID(), message: "nothing new" });
  expect(empty.status).toBe(409);
  const bad = await post({ requestId: "not-a-uuid", message: "x" });
  expect(bad.status).toBe(400);
  const anon = await post({ requestId: crypto.randomUUID(), message: "x" }, "");
  expect(anon.status).toBe(401);
});

it.skipIf(process.platform !== "linux")("returns 404 when the folder is not a repository and 401 without session", async () => {
  const { app, workspaceId } = setup();
  await provision(app, workspaceId);
  const missing = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/git/status`, {
    headers: { cookie: `remotecode_session=${ownerToken}` },
  }));
  expect(missing.status).toBe(404);
  const anon = await app.handle(new Request(`http://localhost/api/workspaces/${workspaceId}/git/status`));
  expect(anon.status).toBe(401);
});

it.skipIf(process.platform !== "linux")("refuses a foreign workspace id", async () => {
  const { app, databasePath } = setup();
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update("b".repeat(64)).digest("hex"), "bob", Date.now() + 60_000);
  const otherId = crypto.randomUUID();
  database.query("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, 'bob', 'other', ?)")
    .run(otherId, new Date().toISOString());
  database.close();
  const response = await app.handle(new Request(`http://localhost/api/workspaces/${otherId}/git/status`, {
    headers: { cookie: `remotecode_session=${ownerToken}` },
  }));
  expect(response.status).toBe(404);
  void mkdirSync;
});
