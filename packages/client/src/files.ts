export type FileKind = "create" | "save" | "move";
export type PendingFile = {
  requestId: string;
  workspaceId: string;
} & (
  | { kind: "create" | "save"; path: string; resultSha256: string }
  | { kind: "move"; sourcePath: string; destinationPath: string; expectedVersion: string }
);
export type FileReceipt = {
  requestId: string;
  workspaceId: string;
  path: string;
  version: string;
  createdAt: string;
} & ({ kind: "create" | "save" } | { kind: "move"; sourcePath: string });

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;

function filePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return value.split("/").every((part) => part && part !== "." && part !== ".." &&
    part !== ".remotecode-workspace" && !part.startsWith(".remotecode-stage-"));
}

export function pendingFileFromValue(value: unknown): PendingFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.requestId !== "string" || !uuid.test(row.requestId) ||
    typeof row.workspaceId !== "string" || !uuid.test(row.workspaceId)) return null;
  const keys = Object.keys(row).sort().join(",");
  if (row.kind === "create" || row.kind === "save") {
    if (keys !== "kind,path,requestId,resultSha256,workspaceId" || !filePath(row.path) ||
      typeof row.resultSha256 !== "string" || !sha256.test(row.resultSha256)) return null;
    return { kind: row.kind, requestId: row.requestId, workspaceId: row.workspaceId, path: row.path, resultSha256: row.resultSha256 };
  }
  if (row.kind !== "move" || keys !== "destinationPath,expectedVersion,kind,requestId,sourcePath,workspaceId" ||
    !filePath(row.sourcePath) || !filePath(row.destinationPath) || row.sourcePath === row.destinationPath ||
    typeof row.expectedVersion !== "string" || !sha256.test(row.expectedVersion)) return null;
  return { kind: "move", requestId: row.requestId, workspaceId: row.workspaceId,
    sourcePath: row.sourcePath, destinationPath: row.destinationPath, expectedVersion: row.expectedVersion };
}

export function pendingFileValueMatches(stored: unknown, expected: PendingFile): boolean {
  let value = stored;
  if (typeof stored === "string") {
    try { value = JSON.parse(stored); } catch { return false; }
  }
  const parsed = pendingFileFromValue(value);
  const pending = pendingFileFromValue(expected);
  return parsed !== null && pending !== null && JSON.stringify(parsed) === JSON.stringify(pending);
}

export function fileReceiptFromValue(value: unknown, pending: PendingFile, expectedWorkspaceId?: string): FileReceipt | null {
  const identity = pendingFileFromValue(pending);
  if (!identity || (expectedWorkspaceId !== undefined && identity.workspaceId !== expectedWorkspaceId) ||
    !value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (keys !== (identity.kind === "move" ? "createdAt,kind,path,requestId,sourcePath,version,workspaceId" : "createdAt,kind,path,requestId,version,workspaceId") ||
    row.requestId !== identity.requestId || row.workspaceId !== identity.workspaceId || row.kind !== identity.kind ||
    !filePath(row.path) || typeof row.version !== "string" || !sha256.test(row.version)) return null;
  if (identity.kind === "move") {
    if (row.sourcePath !== identity.sourcePath || row.path !== identity.destinationPath || row.version !== identity.expectedVersion) return null;
  } else if (row.path !== identity.path || row.version !== identity.resultSha256) return null;
  const createdAt = row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime())
    ? row.createdAt.toISOString()
    : typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)) && new Date(row.createdAt).toISOString() === row.createdAt
      ? row.createdAt : null;
  if (createdAt === null) return null;
  const receipt = { requestId: identity.requestId, workspaceId: identity.workspaceId, path: row.path, version: row.version, createdAt };
  return identity.kind === "move" ? { ...receipt, kind: "move", sourcePath: identity.sourcePath } : { ...receipt, kind: identity.kind };
}
