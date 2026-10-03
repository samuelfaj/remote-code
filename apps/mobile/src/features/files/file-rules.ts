import { pendingFileFromValue, pendingFileValueMatches, pendingFolderFromValue, pendingFolderMatches, type PendingFile, type PendingFolder } from "@remotecode/client";

export { validFilePath as validPath, validFileText as validText, fileFolderStateFromValue as folderStateFromValue, fileDirectoryFromValue as directoryFromValue } from "@remotecode/client";
export type { FileEntry, FileFolderState as FolderState } from "@remotecode/client";
export type FileStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type FileInputScope = { origin: string; userId: string; workspaceId: string | null };
export function nextFileInputScope(previous: FileInputScope | null, origin: string, userId: string, workspaceId: string | null): FileInputScope {
  return previous?.origin === origin && previous.userId === userId && previous.workspaceId === workspaceId
    ? previous : { origin, userId, workspaceId };
}

export function fileStorageKey(origin: string, userId: string) { return `remotecode.pending-file:${JSON.stringify([origin, userId])}`; }
export function folderStorageKey(origin: string, userId: string) { return `${fileStorageKey(origin, userId)}:folder`; }
export async function readPendingFolder(storage: FileStorage, key: string): Promise<PendingFolder | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  const parsed = pendingFolderFromValue(JSON.parse(raw));
  if (!parsed) throw new Error("Invalid pending folder identity");
  return parsed;
}
export async function persistPendingFolder(storage: FileStorage, key: string, value: PendingFolder, allowed: () => boolean) {
  if (!allowed()) return "not_written" as const;
  if (await storage.getItem(key) !== null) return "unsafe" as const;
  if (!allowed()) return "not_written" as const;
  try {
    await storage.setItem(key, JSON.stringify(value));
    return pendingFolderMatches(await storage.getItem(key), value) && allowed() ? "saved" as const : "unsafe" as const;
  } catch { return "unsafe" as const; }
}
export async function clearPendingFolder(storage: FileStorage, key: string, value: PendingFolder, allowed: () => boolean) {
  if (!allowed() || !pendingFolderMatches(await storage.getItem(key), value) || !allowed()) return false;
  await storage.removeItem(key);
  return await storage.getItem(key) === null && allowed();
}
export function readPendingFile(raw: string | null): PendingFile | null {
  if (raw === null) return null;
  const parsed = pendingFileFromValue(JSON.parse(raw));
  if (!parsed) throw new Error("Invalid pending file identity");
  return parsed;
}

export { fileVersionConflict as isVersionConflict, fileTargetExists as isTargetExists, fileMissingPath as isMissingFilePath } from "@remotecode/client";

export async function beforeFileDeadline<T>(work: Promise<T>, end: number) {
  const remaining = end - Date.now();
  if (remaining <= 0) return { expired: true as const };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work.then(value => ({ expired: false as const, value })),
      new Promise<{ expired: true }>(resolve => { timer = setTimeout(() => resolve({ expired: true }), remaining); }),
    ]);
    return result.expired || Date.now() >= end ? { expired: true as const } : result;
  } finally { if (timer) clearTimeout(timer); }
}

export async function clearStoredFile(storage: FileStorage, key: string, operation: PendingFile, allowed: () => boolean, absentIsSafe = false) {
  if (!allowed()) return false;
  const raw = await storage.getItem(key);
  if (!allowed()) return false;
  if (raw === null) return absentIsSafe;
  if (!pendingFileValueMatches(raw, operation)) return false;
  await storage.removeItem(key);
  return (await storage.getItem(key)) === null && allowed();
}

export async function persistStoredFile(storage: FileStorage, key: string, operation: PendingFile, allowed: () => boolean) {
  if (!allowed()) return "not_written" as const;
  if ((await storage.getItem(key)) !== null) return "unsafe" as const;
  if (!allowed()) return "not_written" as const;
  try {
    await storage.setItem(key, JSON.stringify(operation));
    if (!pendingFileValueMatches(await storage.getItem(key), operation)) return "unsafe" as const;
    if (allowed()) return "saved" as const;
  } catch { /* A failed write may have stored the identity. */ }
  return await clearStoredFile(storage, key, operation, () => true, true) ? "cleaned" as const : "unsafe" as const;
}
