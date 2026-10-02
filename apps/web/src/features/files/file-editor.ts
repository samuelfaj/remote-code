import { pendingFileFromValue, pendingFileValueMatches, fileContentFromValue, validFileText, type PendingFile } from "@remotecode/client";

export type { FileFolderState as FolderState, FileEntry } from "@remotecode/client";
export type OpenFile = { workspaceId: string; path: string; content: string; version: string };

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export { validFilePath as validPath, validFileText as validText, fileFolderStateFromValue as folderStateFromValue, fileDirectoryFromValue as directoryFromValue } from "@remotecode/client";

export async function textSha256(content: string) {
  if (!validFileText(content)) throw new Error("Unsupported text or file too large");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function openFileFromValue(value: unknown, workspaceId: string, path: string): Promise<OpenFile | null> {
  const data = fileContentFromValue(value, path);
  if (!data || await textSha256(data.content) !== data.version) return null;
  return { workspaceId, ...data };
}

export function fileStorageKey(origin: string, userId: string) {
  return `remotecode.pending-file:${JSON.stringify([origin, userId])}`;
}

export function readPendingFile(storage: Storage, key: string): PendingFile | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const pending = pendingFileFromValue(JSON.parse(raw));
  if (!pending) throw new Error("Invalid pending file identity");
  return pending;
}

export function persistPendingFile(storage: Storage, key: string, pending: PendingFile) {
  const parsed = pendingFileFromValue(pending);
  if (!parsed || storage.getItem(key) !== null) throw new Error("Pending file identity changed");
  storage.setItem(key, JSON.stringify(parsed));
  if (!pendingFileValueMatches(storage.getItem(key), parsed)) throw new Error("Pending file identity not persisted");
}

export function clearPendingFile(storage: Storage, key: string, pending: PendingFile) {
  if (!pendingFileValueMatches(storage.getItem(key), pending)) throw new Error("Pending file identity changed");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Pending file identity not cleared");
}

export function isTargetExists(error: unknown) {
  const data = row(error);
  const value = row(data?.value);
  return data?.status === 409 && value?.error === "target_exists" && Object.keys(value).join(",") === "error";
}

export function isMissingFilePath(error: unknown, kind: "create" | "move") {
  const data = row(error);
  const value = row(data?.value);
  const codes = kind === "create" ? ["parent_directory_not_found"]
    : ["source_parent_not_found", "destination_parent_not_found", "file_not_found"];
  return data?.status === 404 && typeof value?.error === "string" && codes.includes(value.error) && Object.keys(value).join(",") === "error";
}

export { fileVersionConflict as isVersionConflict } from "@remotecode/client";
