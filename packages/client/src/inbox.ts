import { createApiClient, type ApiClientOptions } from "./index";

export type InboxKind = "needs_you" | "result" | "approval" | "intervention";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  botId: string | null;
  workspaceId: string | null;
  runId: string | null;
  title: string;
  destination: Record<string, unknown>;
  state: string;
  read: boolean;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
};

export function inboxItemFromValue(value: unknown): InboxItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<InboxItem>;
  return typeof item.id === "string" && typeof item.title === "string" && typeof item.state === "string" &&
    typeof item.read === "boolean" ? item as InboxItem : null;
}

export function inboxListFromValue(value: unknown): InboxItem[] | null {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { items?: unknown }).items)) return null;
  const items = (value as { items: unknown[] }).items.map(inboxItemFromValue);
  return items.every((item): item is InboxItem => item !== null) ? items : null;
}

export async function listInbox(
  origin: string,
  options?: ApiClientOptions,
): Promise<InboxItem[]> {
  const { data, error } = await createApiClient(origin, options).api.inbox.get();
  if (error) throw error;
  const items = inboxListFromValue(data);
  if (!items) throw new Error("Host returned an unreadable Inbox list");
  return items;
}

async function single(
  request: Promise<{ data: unknown; error: unknown }>,
  what: string,
): Promise<InboxItem> {
  const { data, error } = await request;
  if (error) throw error;
  const item = inboxItemFromValue(data);
  if (!item) throw new Error(`Host returned an unreadable Inbox item for ${what}`);
  return item;
}

export function readInboxItem(id: string, origin: string, options?: ApiClientOptions): Promise<InboxItem> {
  return single(createApiClient(origin, options).api.inbox({ id }).get(), "read");
}

export function markInboxItemRead(id: string, origin: string, options?: ApiClientOptions): Promise<InboxItem> {
  return single(createApiClient(origin, options).api.inbox({ id }).read.post(), "mark read");
}

export function resolveInboxItem(id: string, origin: string, options?: ApiClientOptions): Promise<InboxItem> {
  return single(createApiClient(origin, options).api.inbox({ id }).resolve.post(), "resolve");
}