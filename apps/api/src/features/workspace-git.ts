import { constants, readlinkSync } from "node:fs";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";
import { Database } from "bun:sqlite";
import { fsyncSync } from "node:fs";

// Fail closed before spawning git: require a real .git directory through the
// fd guard (O_DIRECTORY|O_NOFOLLOW), never a path probe.
function hasGitDir(folderFd: number, openAt: (parentFd: number, name: string, flags: number, mode?: number) => number, close: (fd: number) => void): boolean {
  const gitFd = openAt(folderFd, ".git", constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
  if (gitFd < 0) return false;
  close(gitFd);
  return true;
}

type GitStatus = { branch: string | null; clean: boolean; changed: string[]; untracked: string[] };
type GitCommit = { commit: string; branch: string | null };
type GitBranches = { current: string | null; branches: string[] };
type GitDiff = { path: string; diff: string; truncated: boolean };

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function parsePorcelain(output: string): { changed: string[]; untracked: string[] } {
  const changed: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path || path.includes("\n") || path.includes("..")) continue;
    if (path === ".remotecode-workspace" || path.startsWith(".remotecode-stage-")) continue;
    if (code === "??") untracked.push(path);
    else changed.push(path);
  }
  return { changed, untracked };
}

export function gitStatusFeature(databasePath: string, syncDirectory: (fd: number) => void = fsyncSync) {
  function liveUserId(request: Request): string | null {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) return null;
    const db = new Database(databasePath, { readonly: true, create: false });
    try {
      const live = db.query<{ expires_at: number }, [string, string]>(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
      ).get(userId, tokenHash);
      if (!live || live.expires_at !== expiresAt || live.expires_at <= Date.now()) return null;
      return userId;
    } catch { return null; }
    finally { db.close(); }
  }
  void syncDirectory;
  return new Elysia().get("/api/workspaces/:workspaceId/git/status", ({ params, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    if (process.platform !== "linux") { set.status = 501; return { error: "workspace_git_require_linux" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
      if (!hasGitDir(folderFd, openAt, close)) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
      const run = (args: string[]) => {
        const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
      };
      const rev = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (rev.exitCode !== 0) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const branch = rev.stdout.trim() || null;
      const porcelain = run(["status", "--porcelain=v1", "--untracked-files=normal", "--", "."]);
      if (porcelain.exitCode !== 0) return { status: 503 as const, body: { error: "git_status_unavailable" as const } };
      const { changed, untracked } = parsePorcelain(porcelain.stdout);
      if (changed.length + untracked.length > 1000) return { status: 503 as const, body: { error: "git_status_unavailable" as const } };
      const body: GitStatus = { branch, clean: changed.length === 0 && untracked.length === 0, changed, untracked };
      return { status: 200 as const, body };
    });
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_git_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
  }).post("/api/workspaces/:workspaceId/git/commit", ({ params, body, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const id = body.requestId.toLowerCase();
    if (!canonicalUuid.test(id) || typeof body.message !== "string" || body.message.length === 0 || body.message.length > 500 ||
      !/^[\x20-\x7E\r\n\t]*$/.test(body.message)) { set.status = 400; return { error: "invalid_git_commit_request" as const }; }
    if (process.platform !== "linux") { set.status = 501; return { error: "workspace_git_require_linux" as const }; }
    let db: Database | undefined;
    try {
      db = new Database(databasePath);
      db.exec("PRAGMA busy_timeout = 250");
      db.exec(`CREATE TABLE IF NOT EXISTS git_commit_outcomes (user_id TEXT NOT NULL, request_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, commit_sha TEXT NOT NULL, branch TEXT, completed_at TEXT NOT NULL,
        PRIMARY KEY (user_id, request_id))`);
      const prior = db.query<{ commit_sha: string; branch: string | null }, [string, string]>(
        "SELECT commit_sha, branch FROM git_commit_outcomes WHERE user_id = ? AND request_id = ?").get(userId, id);
      if (prior && shaPattern.test(prior.commit_sha)) {
        const receipt: GitCommit = { commit: prior.commit_sha, branch: prior.branch };
        set.status = 200;
        return receipt;
      }
    } catch { set.status = 503; return { error: "receipt_unavailable" as const }; }
    finally { db?.close(); }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
      if (!hasGitDir(folderFd, openAt, close)) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
      const run = (args: string[], input?: string) => {
        const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdin: input ? Buffer.from(input) : undefined,
          stdout: "pipe", stderr: "pipe", timeout: 15_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
      };
      if (run(["rev-parse", "--git-dir"]).exitCode !== 0) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const add = run(["add", "-A", "--", "."]);
      if (add.exitCode !== 0) return { status: 503 as const, body: { error: "git_commit_unavailable" as const } };
      const commit = run(["-c", "user.email=remotecode@local", "-c", "user.name=remotecode", "commit", "-m", body.message, "--", "."]);
      if (commit.exitCode !== 0) {
        if (/nothing to commit/i.test(commit.stdout + commit.stderr)) return { status: 409 as const, body: { error: "nothing_to_commit" as const } };
        return { status: 503 as const, body: { error: "git_commit_unavailable" as const } };
      }
      const sha = run(["rev-parse", "HEAD"]);
      const rev = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      const commitSha = sha.stdout.trim();
      if (sha.exitCode !== 0 || !shaPattern.test(commitSha)) return { status: 503 as const, body: { error: "git_commit_unavailable" as const } };
      return { status: 200 as const, body: { commit: commitSha, branch: rev.exitCode === 0 ? rev.stdout.trim() || null : null } satisfies GitCommit };
    });
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_git_require_linux" };
    }
    if (result.value.status !== 200) { set.status = result.value.status; return result.value.body; }
    try {
      db = new Database(databasePath);
      db.exec("PRAGMA busy_timeout = 250");
      db.query(`INSERT OR IGNORE INTO git_commit_outcomes (user_id, request_id, workspace_id, commit_sha, branch, completed_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(userId, id, params.workspaceId, result.value.body.commit, result.value.body.branch, new Date().toISOString());
    } catch { set.status = 503; return { error: "receipt_unavailable" as const }; }
    finally { db?.close(); }
    set.status = 200;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ requestId: t.String({ minLength: 36, maxLength: 36 }), message: t.String({ minLength: 1, maxLength: 500 }) }),
  }).get("/api/workspaces/:workspaceId/git/branches", ({ params, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    if (process.platform !== "linux") { set.status = 501; return { error: "workspace_git_require_linux" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
      if (!hasGitDir(folderFd, openAt, close)) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
      const run = (args: string[]) => {
        const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdout: "pipe", stderr: "pipe", timeout: 10_000,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
      };
      if (run(["rev-parse", "--git-dir"]).exitCode !== 0) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const current = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      const list = run(["branch", "--format=%(refname:short)"]);
      if (list.exitCode !== 0) return { status: 503 as const, body: { error: "git_branches_unavailable" as const } };
      const branches = list.stdout.split("\n").map((s) => s.trim()).filter((s) => s && !s.includes(" ") && !s.includes("..") && s.length <= 250);
      if (branches.length > 100) return { status: 503 as const, body: { error: "git_branches_unavailable" as const } };
      const body: GitBranches = { current: current.exitCode === 0 ? current.stdout.trim() || null : null, branches };
      return { status: 200 as const, body };
    });
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_git_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
  }).post("/api/workspaces/:workspaceId/git/branch", ({ params, body, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 250 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(body.name) || body.name.includes("..") || body.name.endsWith("/") ||
      body.name.endsWith(".lock") || body.name.includes("//")) { set.status = 400; return { error: "invalid_branch_name" as const }; }
    if (process.platform !== "linux") { set.status = 501; return { error: "workspace_git_require_linux" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
      if (!hasGitDir(folderFd, openAt, close)) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
      const run = (args: string[]) => {
        const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdout: "pipe", stderr: "pipe", timeout: 15_000,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
      };
      if (run(["rev-parse", "--git-dir"]).exitCode !== 0) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const dirty = run(["status", "--porcelain=v1", "--", "."]);
      if (dirty.exitCode !== 0) return { status: 503 as const, body: { error: "git_branch_unavailable" as const } };
      if (dirty.stdout.trim() !== "") return { status: 409 as const, body: { error: "working_tree_dirty" as const } };
      const switched = run(body.create ? ["switch", "-c", body.name] : ["switch", body.name]);
      if (switched.exitCode !== 0) return { status: 404 as const, body: { error: "branch_not_found" as const } };
      const rev = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      return { status: 200 as const, body: { branch: rev.exitCode === 0 ? rev.stdout.trim() || null : null } };
    });
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_git_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    body: t.Object({ name: t.String({ minLength: 1, maxLength: 250 }), create: t.Optional(t.Boolean()) }),
  }).get("/api/workspaces/:workspaceId/git/diff", ({ params, query, request, set }) => {
    const userId = liveUserId(request);
    if (!userId) { set.status = 401; return { error: "unauthorized" as const }; }
    const raw = query.path ?? "";
    if (raw.length === 0 || raw.length > 4096 || raw.startsWith("/") || raw.includes("..") || raw.includes("\n") ||
      raw === ".remotecode-workspace" || raw.startsWith(".remotecode-stage-") ||
      /(^|\/)\.git(\/|$)/.test(raw)) { set.status = 400; return { error: "invalid_path" as const }; }
    if (process.platform !== "linux") { set.status = 501; return { error: "workspace_git_require_linux" as const }; }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd, openAt, close) => {
      if (!hasGitDir(folderFd, openAt, close)) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const folderPath = readlinkSync(`/proc/self/fd/${folderFd}`);
      const run = (args: string[]) => {
        const proc = Bun.spawnSync(["git", ...args], { cwd: folderPath, stdout: "pipe", stderr: "pipe", timeout: 10_000,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
      };
      if (run(["rev-parse", "--git-dir"]).exitCode !== 0) return { status: 404 as const, body: { error: "not_a_repository" as const } };
      const diff = run(["diff", "--no-color", "--no-ext-diff", "--", raw]);
      if (diff.exitCode !== 0) return { status: 503 as const, body: { error: "git_diff_unavailable" as const } };
      const maxDiffBytes = 64 * 1024;
      const bytes = Buffer.from(diff.stdout, "utf8");
      const truncated = bytes.length > maxDiffBytes;
      const body: GitDiff = { path: raw, diff: bytes.subarray(0, maxDiffBytes).toString("utf8"), truncated };
      return { status: 200 as const, body };
    });
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_git_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    query: t.Object({ path: t.String({ minLength: 1, maxLength: 4096 }) }),
  });
}
