import { createApiClient, type ApiClientOptions } from "./index";

export type GitStatus = { branch: string | null; clean: boolean; changed: string[]; untracked: string[] };
export type GitDiff = { path: string; diff: string; truncated: boolean };
export type GitBranches = { current: string | null; branches: string[] };
export type GitCommit = { commit: string; branch: string | null };

export async function workspaceGitStatus(
  workspaceId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<GitStatus> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .git.status.get();
  if (error) throw error;
  if (!data) throw new Error("Missing git status");
  return data as GitStatus;
}

export async function workspaceGitDiff(
  workspaceId: string,
  path: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<GitDiff> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .git.diff.get({ query: { path } });
  if (error) throw error;
  if (!data) throw new Error("Missing git diff");
  return data as GitDiff;
}

export async function workspaceGitBranches(
  workspaceId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<GitBranches> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .git.branches.get();
  if (error) throw error;
  if (!data) throw new Error("Missing git branches");
  return data as GitBranches;
}

export async function commitGit(
  workspaceId: string,
  requestId: string,
  message: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<GitCommit> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .git.commit.post({ requestId, message });
  if (error) throw error;
  if (!data) throw new Error("Missing git commit result");
  return data as GitCommit;
}
