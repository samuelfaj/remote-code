import { createApiClient, type ApiClientOptions } from "./index";

export type ScreenPossessionResult = {
  possessionId: string;
  token: string;
  epoch: number;
  expiresAt: number;
};

export type ScreenPossessionState = {
  state: "holder" | "superseded" | "expired" | "none";
  expiresAt: number | null;
  epoch: number;
  supersededCount: number;
};

export type RunChange = {
  runId: string;
  workspaceId: string;
  capturedAt: string;
  files: Array<{ path: string; changeKind: string }>;
  diff: string;
  truncated: boolean;
};

export type WorkspaceRun = {
  id: string;
  workspaceId: string;
  botId: string | null;
  state: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string | null;
  stopRequestedAt: string | null;
  stopReason: string | null;
  error: string | null;
  sessionId: string | null;
  handoffReason: string | null;
  retryAfterSeconds: number | null;
};

export async function takeScreenPossession(
  workspaceId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<ScreenPossessionResult> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .screen.possession.post();
  if (error) throw error;
  if (!data) throw new Error("Missing possession result");
  return data as ScreenPossessionResult;
}

export async function readScreenPossession(
  workspaceId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<ScreenPossessionState> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .screen.possession.get();
  if (error) throw error;
  if (!data) throw new Error("Missing possession state");
  return data as ScreenPossessionState;
}

export async function heartbeatScreenPossession(
  workspaceId: string,
  token: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<{ expiresAt: number }> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .screen.possession.heartbeat.post({ token });
  if (error) throw error;
  if (!data) throw new Error("Missing heartbeat result");
  return data as { expiresAt: number };
}

export type ScreenInputEvent =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string };

/// Sends one human input event to the held screen. The host refuses it with
/// possession_lost or possession_superseded once this client no longer holds the
/// screen, so the caller shows the host's answer rather than its own.
export async function sendScreenInput(
  workspaceId: string,
  token: string,
  event: ScreenInputEvent,
  origin: string,
  options?: ApiClientOptions,
): Promise<{ applied: boolean }> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .screen.input.post({ token, event });
  if (error) throw error;
  if (!data) throw new Error("Missing screen input result");
  return data as { applied: boolean };
}

export async function releaseScreenPossession(
  workspaceId: string,
  token: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<{ releasedAt: number }> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .screen.possession.release.post({ token });
  if (error) throw error;
  if (!data) throw new Error("Missing release result");
  return data as { releasedAt: number };
}

export async function readRun(
  id: string,
  origin: string,
  options?: ApiClientOptions,
) {
  const { data, error } = await createApiClient(origin, options)
    .api.runs({ id })
    .get();
  if (error) throw error;
  return data;
}

export async function readRunChanges(
  id: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<RunChange> {
  const { data, error } = await createApiClient(origin, options)
    .api.runs({ id })
    .changes.get();
  if (error) throw error;
  if (!data) throw new Error("Missing run changes");
  return data as RunChange;
}

export async function readWorkspaceRuns(
  workspaceId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<WorkspaceRun[]> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .runs.get();
  if (error) throw error;
  if (!data) return [];
  return (data as { runs: WorkspaceRun[] }).runs;
}