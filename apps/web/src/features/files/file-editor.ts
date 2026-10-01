import { pendingFileFromValue, pendingFileValueMatches, type PendingFile } from "@remotecode/client";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
export type FolderState = "provisioned" | "not_provisioned" | "unknown";
export type FileEntry = { name: string; type: "file" | "directory"; size: number };
export type OpenFile = { workspaceId: string; path: string; content: string; version: string };

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validText(value: string) {
  const bytes = new TextEncoder().encode(value);
  return !value.includes("\0") && bytes.length <= 1024 * 1024 &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) === value;
}

export function validPath(path: unknown, root = false): path is string {
  return typeof path === "string" && (root && path === "" ||
    path.length > 0 && path.length <= 4096 && validText(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." &&
      part !== ".remotecode-workspace" && !part.startsWith(".remotecode-stage-")));
}

export function folderStateFromValue(value: unknown, workspaceId: string): FolderState | null {
  const data = row(value);
  if (!data || data.workspaceId !== workspaceId) return null;
  const keys = Object.keys(data).sort().join(",");
  if (data.state === "not_provisioned" && keys === "state,workspaceId") return data.state;
  if ((data.state === "provisioned" || data.state === "unknown") &&
    keys === "requestId,state,workspaceId" && typeof data.requestId === "string" && uuid.test(data.requestId)) return data.state;
  return null;
}

export function directoryFromValue(value: unknown, path: string): FileEntry[] | null {
  const data = row(value);
  if (!data || Object.keys(data).sort().join(",") !== "entries,path" || data.path !== path ||
    !validPath(path, true) || !Array.isArray(data.entries) || data.entries.length > 1000) return null;
  const entries: FileEntry[] = [];
  const names = new Set<string>();
  for (const item of data.entries) {
    const entry = row(item);
    if (!entry || Object.keys(entry).sort().join(",") !== "name,size,type" || !validPath(entry.name) ||
      entry.name.includes("/") || names.has(entry.name) ||
      (entry.type !== "file" && entry.type !== "directory") ||
      typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      (entry.type === "directory" && entry.size !== 0) || !validPath(path ? `${path}/${entry.name}` : entry.name)) return null;
    names.add(entry.name);
    entries.push({ name: entry.name, type: entry.type, size: entry.size });
  }
  return entries;
}

export async function textSha256(content: string) {
  if (!validText(content)) throw new Error("Unsupported text or file too large");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function openFileFromValue(value: unknown, workspaceId: string, path: string): Promise<OpenFile | null> {
  const data = row(value);
  if (!data || Object.keys(data).sort().join(",") !== "content,path,version" || data.path !== path ||
    !validPath(path) || typeof data.content !== "string" || !validText(data.content) ||
    typeof data.version !== "string" || !sha256.test(data.version) || await textSha256(data.content) !== data.version) return null;
  return { workspaceId, path, content: data.content, version: data.version };
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

export function isVersionConflict(error: unknown) {
  const data = row(error);
  const value = row(data?.value);
  if (data?.status !== 409 || value?.error !== "version_conflict") return false;
  const keys = Object.keys(value).sort().join(",");
  return keys === "error" || keys === "currentVersion,error" &&
    typeof value.currentVersion === "string" && sha256.test(value.currentVersion);
}
