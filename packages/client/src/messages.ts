import { createApiClient, type ApiClientOptions } from "./index";
import type { RunChange } from "./screen";

export type Thread = { id: string; workspaceId: string; title: string; createdAt: string; updatedAt: string };
export type MessageAttachment = { path: string; sha256: string; size: number };
export type ThreadMessage = {
  id: string;
  kind: string;
  body: string;
  runId: string | null;
  attachments: MessageAttachment[];
  changes: { files: Array<{ path: string; changeKind: string }>; diff: string; truncated: boolean } | null;
  createdAt: string;
};
export type ThreadMessagesResult = { threadId: string; messages: ThreadMessage[] };
export type CreateThreadResult = { id: string; workspaceId: string; title: string; createdAt: string; updatedAt: string };
export type PostMessageResult = {
  id: string;
  threadId: string;
  kind: string;
  body: string;
  runId: string | null;
  attachments: MessageAttachment[];
  createdAt: string;
};

export async function createThread(
  workspaceId: string,
  title: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<CreateThreadResult> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .threads.post({ title });
  if (error) throw error;
  if (!data) throw new Error("Missing thread creation result");
  return data as CreateThreadResult;
}

export async function listThreads(
  workspaceId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<Thread[]> {
  const { data, error } = await createApiClient(origin, options)
    .api.workspaces({ workspaceId })
    .threads.get();
  if (error) throw error;
  if (!data) return [];
  return (data as { threads: Thread[] }).threads;
}

export async function postThreadMessage(
  workspaceId: string,
  threadId: string,
  body: string,
  attachments: string[] | undefined,
  runId: string | undefined,
  origin: string,
  options?: ApiClientOptions,
): Promise<PostMessageResult> {
  const { data, error } = await createApiClient(origin, options)
    .api.threads({ threadId })
    .messages.post({ body, attachments, runId });
  if (error) throw error;
  if (!data) throw new Error("Missing post message result");
  return data as PostMessageResult;
}

export async function listThreadMessages(
  workspaceId: string,
  threadId: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<ThreadMessagesResult> {
  const { data, error } = await createApiClient(origin, options)
    .api.threads({ threadId })
    .messages.get();
  if (error) throw error;
  if (!data) throw new Error("Missing thread messages");
  return data as ThreadMessagesResult;
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
