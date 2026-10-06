import { readlinkSync } from "node:fs";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";
import { Database } from "bun:sqlite";
import { fsyncSync } from "node:fs";

type GitStatus = { branch: string | null; clean: boolean; changed: string[]; untracked: string[] };

function parsePorcelain(output: string): { changed: string[]; untracked: string[] } {
  const changed: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path || path.includes("\n") || path.includes("..")) continue;
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
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId, (folderFd) => {
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
  });
}
