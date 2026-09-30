export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
  archived: boolean;
};
export type WorkspaceKind = "create" | "rename" | "archive";
export type PendingWorkspace = {
  kind: WorkspaceKind;
  requestId: string;
  workspaceId?: string;
};

export function workspacePanelUserId(
  userId: string | null,
  sessionCurrent: boolean,
) {
  return sessionCurrent && userId ? userId : null;
}

export function workspaceDeadlineIsOpen(deadline: number, now = Date.now()) {
  return now < deadline;
}

export function pendingWorkspaceValueMatches(
  stored: unknown,
  expected: PendingWorkspace,
): boolean {
  let value = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      return false;
    }
  }
  const parsed = pendingWorkspaceFromValue(value);
  return (
    parsed?.kind === expected.kind &&
    parsed.requestId === expected.requestId &&
    parsed.workspaceId === expected.workspaceId
  );
}

export function workspaceErrorStatus(error: unknown): number | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("status" in error) ||
    typeof error.status !== "number"
  )
    return null;
  return error.status;
}

export function workspaceFromValue(value: unknown): Workspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  const createdAt =
    row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime())
      ? row.createdAt.toISOString()
      : typeof row.createdAt === "string" &&
          Number.isFinite(Date.parse(row.createdAt)) &&
          new Date(row.createdAt).toISOString() === row.createdAt
        ? row.createdAt
        : null;
  if (
    (keys !== "createdAt,id,name" && keys !== "archived,createdAt,id,name") ||
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.name !== "string" ||
    !row.name ||
    createdAt === null ||
    (row.archived !== undefined && typeof row.archived !== "boolean")
  )
    return null;
  return {
    id: row.id,
    name: row.name,
    createdAt,
    archived: row.archived === true,
  };
}

export function workspaceListFromValue(value: unknown): Workspace[] | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("workspaces" in value) ||
    !Array.isArray(value.workspaces)
  )
    return null;
  const workspaces = value.workspaces.map(workspaceFromValue);
  return workspaces.every((workspace) => workspace !== null)
    ? (workspaces as Workspace[])
    : null;
}

export function workspaceReceiptFromValue(
  value: unknown,
  pending: PendingWorkspace,
  expectedWorkspaceId?: string,
): Workspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !== "kind,requestId,workspace" ||
    receipt.kind !== pending.kind ||
    receipt.requestId !== pending.requestId
  )
    return null;
  const workspaceValue = receipt.workspace;
  if (
    !workspaceValue ||
    typeof workspaceValue !== "object" ||
    Array.isArray(workspaceValue) ||
    Object.keys(workspaceValue).sort().join(",") !==
      "archived,createdAt,id,name"
  )
    return null;
  const workspace = workspaceFromValue(workspaceValue);
  const targetWorkspaceId = expectedWorkspaceId ?? pending.workspaceId;
  if (
    !workspace ||
    workspace.archived !== (pending.kind === "archive") ||
    (pending.kind !== "create" &&
      (!targetWorkspaceId || workspace.id !== targetWorkspaceId)) ||
    (expectedWorkspaceId !== undefined &&
      pending.workspaceId !== expectedWorkspaceId)
  )
    return null;
  return workspace;
}

export function pendingWorkspaceFromValue(
  value: unknown,
): PendingWorkspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !["archive", "create", "rename"].includes(String(row.kind)) ||
    typeof row.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      row.requestId,
    )
  )
    return null;
  if (
    (row.kind === "create" &&
      Object.keys(row).sort().join(",") !== "kind,requestId") ||
    (row.kind === "rename" &&
      Object.keys(row).sort().join(",") !== "kind,requestId,workspaceId") ||
    (row.kind === "archive" &&
      Object.keys(row).sort().join(",") !== "kind,requestId,workspaceId") ||
    (row.kind !== "create" &&
      (typeof row.workspaceId !== "string" || !row.workspaceId))
  )
    return null;
  return row.kind === "create"
    ? { kind: "create", requestId: row.requestId }
    : {
        kind: row.kind as "rename" | "archive",
        requestId: row.requestId,
        workspaceId: row.workspaceId as string,
      };
}
