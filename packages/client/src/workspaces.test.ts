import { describe, expect, test } from "bun:test";
import {
  pendingWorkspaceFromValue,
  pendingWorkspaceValueMatches,
  workspaceDeadlineIsOpen,
  workspaceErrorStatus,
  workspaceFromValue,
  workspaceListFromValue,
  workspaceReceiptFromValue,
  workspacePanelUserId,
} from "./workspaces";

const createdAt = "2026-01-01T00:00:00.000Z";
const active = { id: "workspace-a", name: "A", createdAt, archived: false };

describe("workspace metadata parsing", () => {
  test("accepts legacy active list rows and explicit archived views", () => {
    expect(
      workspaceFromValue({ id: "workspace-a", name: "A", createdAt }),
    ).toEqual(active);
    expect(
      workspaceFromValue({
        id: "workspace-a",
        name: "A",
        createdAt: new Date(createdAt),
      }),
    ).toEqual(active);
    expect(
      workspaceFromValue({
        id: "workspace-a",
        name: "A",
        createdAt: new Date(Number.NaN),
      }),
    ).toBeNull();
    expect(
      workspaceListFromValue({
        workspaces: [
          { id: "workspace-a", name: "A", createdAt },
          { ...active, id: "workspace-b", archived: true },
        ],
      }),
    ).toEqual([active, { ...active, id: "workspace-b", archived: true }]);
    expect(
      workspaceListFromValue({
        workspaces: [{ ...active, createdAt: "2026-01-01" }],
      }),
    ).toBeNull();
    expect(
      workspaceListFromValue({
        workspaces: [{ ...active, extra: "unexpected" }],
      }),
    ).toBeNull();
  });

  test("accepts only exact operation envelopes matching pending ID, kind, and target", () => {
    const rename = {
      kind: "rename" as const,
      requestId: "r",
      workspaceId: "workspace-a",
    };
    const receipt = {
      requestId: "r",
      kind: "rename",
      workspace: { ...active, name: "Renamed" },
    };
    expect(workspaceReceiptFromValue(receipt, rename, "workspace-a")).toEqual(
      receipt.workspace,
    );
    expect(
      workspaceReceiptFromValue({ ...receipt, requestId: "other" }, rename),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue({ ...receipt, kind: "archive" }, rename),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue(
        { ...receipt, workspace: { ...receipt.workspace, id: "workspace-b" } },
        rename,
      ),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue({ ...receipt, extra: true }, rename),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue(receipt, rename, "workspace-b"),
    ).toBeNull();

    const create = { kind: "create" as const, requestId: "c" };
    const createReceipt = { requestId: "c", kind: "create", workspace: active };
    expect(workspaceReceiptFromValue(createReceipt, create)).toEqual(active);
    expect(
      workspaceReceiptFromValue(
        { id: "workspace-a", name: "A", createdAt },
        create,
      ),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue(
        { ...createReceipt, requestId: "other" },
        create,
      ),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue({ ...createReceipt, kind: "rename" }, create),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue(
        { ...createReceipt, workspace: { ...active, archived: true } },
        create,
      ),
    ).toBeNull();
    expect(
      workspaceReceiptFromValue(
        { ...createReceipt, workspace: { ...active, createdAt: "2026-01-01" } },
        create,
      ),
    ).toBeNull();
  });

  test("rejects malformed pending identities and reads numeric API statuses safely", () => {
    expect(
      pendingWorkspaceFromValue({
        kind: "archive",
        requestId: "123",
        workspaceId: "workspace-a",
      }),
    ).toBeNull();
    expect(
      pendingWorkspaceFromValue({
        kind: "create",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toEqual({
      kind: "create",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    });
    const pending = {
      kind: "rename" as const,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      workspaceId: "workspace-a",
    };
    expect(pendingWorkspaceValueMatches(JSON.stringify(pending), pending)).toBe(
      true,
    );
    expect(
      pendingWorkspaceValueMatches(
        JSON.stringify({
          ...pending,
          requestId: "123e4567-e89b-42d3-a456-426614174001",
        }),
        pending,
      ),
    ).toBe(false);
    expect(pendingWorkspaceValueMatches("not-json", pending)).toBe(false);
    expect(workspaceDeadlineIsOpen(100, 99)).toBe(true);
    expect(workspaceDeadlineIsOpen(100, 100)).toBe(false);
    expect(workspacePanelUserId("user-a", true)).toBe("user-a");
    expect(workspacePanelUserId("user-a", false)).toBeNull();
    expect(workspacePanelUserId(null, true)).toBeNull();
    expect(workspaceErrorStatus({ status: 401 })).toBe(401);
    expect(workspaceErrorStatus({ status: "401" })).toBeNull();
  });
});
