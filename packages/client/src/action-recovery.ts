import type { ActionReceipt } from "./action-events";

type ActionResponse = { status: number; data: unknown; error: unknown };

export function actionReceiptFromResponse(response: ActionResponse): ActionReceipt | null {
  if (response.error || response.status < 200 || response.status >= 300) return null;
  const value = response.data;
  if (typeof value !== "object" || value === null
    || !("id" in value) || typeof value.id !== "string" || !value.id
    || !("action" in value) || typeof value.action !== "string"
    || !("createdAt" in value)) return null;
  const timestamp = value.createdAt;
  if (timestamp instanceof Date && !Number.isFinite(timestamp.getTime())) return null;
  const createdAt = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  if (typeof createdAt !== "string" || !createdAt) return null;
  const parsedTimestamp = new Date(createdAt);
  if (!Number.isFinite(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== createdAt) return null;
  return { id: value.id, action: value.action, createdAt };
}

export function isDefinitiveActionRejection(response: ActionResponse) {
  return Boolean(response.error) && [401, 403, 422, 426].includes(response.status);
}
