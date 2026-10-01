import { describe, expect, it } from "bun:test";
import { createApiClient, fileReceiptFromValue, workspaceErrorStatus, type FileReceipt, type PendingFile } from "@remotecode/client";
import { clearPendingFile, directoryFromValue, fileStorageKey, folderStateFromValue, isMissingFilePath, isTargetExists, isVersionConflict, openFileFromValue, persistPendingFile, readPendingFile, textSha256, validPath, validText, type FileEntry } from "./file-editor";

const workspaceId = "123e4567-e89b-42d3-a456-426614174001";
const requestId = "123e4567-e89b-42d3-a456-426614174002";
const content = "\uFEFFHello 🌍\r\n";
const version = await textSha256(content);
const pending: PendingFile = { kind: "save", requestId, workspaceId, path: "src/main.txt", resultSha256: version };
const receipt: FileReceipt = { kind: "save", requestId, workspaceId, path: pending.path, version, createdAt: "2026-10-01T00:00:00.000Z" };
const key = fileStorageKey("https://host.example", "owner");

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) { return values.get(name) ?? null; },
    setItem(name, value) { values.set(name, String(value)); },
    removeItem(name) { values.delete(name); },
    clear() { values.clear(); },
  };
}

describe("selected-workspace file boundaries", () => {
  it("never treats another folder, a provision intent or malformed status as a provisioned folder", () => {
    expect(folderStateFromValue({ workspaceId, state: "provisioned", requestId }, workspaceId)).toBe("provisioned");
    expect(folderStateFromValue({ workspaceId, state: "unknown", requestId }, workspaceId)).toBe("unknown");
    expect(folderStateFromValue({ workspaceId, state: "not_provisioned" }, workspaceId)).toBe("not_provisioned");
    for (const value of [
      { workspaceId, state: "provisioned" }, { workspaceId, state: "provisioned", requestId: "bad" },
      { workspaceId: requestId, state: "provisioned", requestId }, { workspaceId, state: "not_provisioned", requestId },
      { workspaceId, state: "provisioned", requestId, content: "not status" }, null,
    ]) expect(folderStateFromValue(value, workspaceId)).toBeNull();
  });

  it("lists only the requested directory and safe, unique child paths", () => {
    const entries: FileEntry[] = [{ name: "nested", type: "directory", size: 0 }, { name: "readme.txt", type: "file", size: 3 }];
    expect(directoryFromValue({ path: "src", entries }, "src")).toEqual(entries);
    expect(directoryFromValue({ path: "", entries: [] }, "")).toEqual([]);
    expect(directoryFromValue({ path: "another", entries }, "src")).toBeNull();
    for (const name of ["../escape", "a/b", ".", "", "\ud800", ".remotecode-workspace", ".remotecode-stage-private"]) {
      expect(directoryFromValue({ path: "src", entries: [{ name, type: "file", size: 0 }] }, "src")).toBeNull();
    }
    for (const changed of [{ size: -1 }, { size: 1.1 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { type: "symlink" }, { extra: true }]) {
      expect(directoryFromValue({ path: "src", entries: [{ ...entries[1], ...changed }] }, "src")).toBeNull();
    }
    expect(directoryFromValue({ path: "src", entries: [entries[1], entries[1]] }, "src")).toBeNull();
    expect(directoryFromValue({ path: "src", entries: Array(1001).fill(entries[1]) }, "src")).toBeNull();
  });

  it("binds OPEN version to exact UTF-8 bytes, preserving BOM, CRLF and non-ASCII text", async () => {
    expect(version).toBe(new Bun.CryptoHasher("sha256").update(content).digest("hex"));
    expect(await openFileFromValue({ path: pending.path, content, version }, workspaceId, pending.path)).toEqual({ workspaceId, path: pending.path, content, version });
    for (const changed of [{ path: "other.txt" }, { content: "different" }, { version: "a".repeat(64) }, { extra: true }]) {
      expect(await openFileFromValue({ path: pending.path, content, version, ...changed }, workspaceId, pending.path)).toBeNull();
    }
    for (const value of ["a\0b", "\ud800", "x".repeat(1024 * 1024 + 1)]) {
      expect(validText(value)).toBe(false);
      await expect(textSha256(value)).rejects.toThrow();
    }
    expect(validText("x".repeat(1024 * 1024))).toBe(true);
  });
});

describe("content-free pending SAVE storage", () => {
  it("scopes recovery to user and origin and persists a read-back identity, not draft or expectedVersion", () => {
    const storage = memoryStorage();
    expect(fileStorageKey("https://other.example", "owner")).not.toBe(key);
    expect(fileStorageKey("https://host.example", "other-owner")).not.toBe(key);
    expect(readPendingFile(storage, key)).toBeNull();
    persistPendingFile(storage, key, pending);
    expect(readPendingFile(storage, key)).toEqual(pending);
    expect(Object.keys(JSON.parse(storage.getItem(key)!)).sort()).toEqual(["kind", "path", "requestId", "resultSha256", "workspaceId"]);
    expect(storage.getItem(key)).not.toContain(content);
    expect(() => persistPendingFile(storage, key, { ...pending, requestId: crypto.randomUUID() })).toThrow();
    expect(readPendingFile(storage, key)).toEqual(pending);
  });

  it("never clears a replaced or corrupt identity and fails closed on storage write/readback/removal errors", () => {
    const storage = memoryStorage();
    const other = { ...pending, requestId: crypto.randomUUID() };
    persistPendingFile(storage, key, pending);
    storage.setItem(key, JSON.stringify(other));
    expect(() => clearPendingFile(storage, key, pending)).toThrow();
    expect(readPendingFile(storage, key)).toEqual(other);
    storage.setItem(key, "not JSON");
    expect(() => readPendingFile(storage, key)).toThrow();
    expect(() => clearPendingFile(storage, key, pending)).toThrow();
    storage.clear();
    expect(() => persistPendingFile({ ...storage, setItem() { throw new Error("Quota exceeded"); } }, key, pending)).toThrow();
    expect(() => persistPendingFile({ ...storage, setItem() {} }, key, pending)).toThrow();
    persistPendingFile(storage, key, pending);
    expect(() => clearPendingFile({ ...storage, removeItem() {} }, key, pending)).toThrow();
    expect(readPendingFile(storage, key)).toEqual(pending);
    clearPendingFile(storage, key, pending);
    expect(readPendingFile(storage, key)).toBeNull();
  });

  it("uses stored result bytes, not a changed draft or current OPEN, to bind historical receipts", async () => {
    const storage = memoryStorage();
    persistPendingFile(storage, key, pending);
    const changedDraftDigest = await textSha256("draft edited after timeout");
    const restored = readPendingFile(storage, key)!;
    expect(fileReceiptFromValue(receipt, restored, workspaceId)).toEqual(receipt);
    expect(fileReceiptFromValue({ ...receipt, version: changedDraftDigest }, restored, workspaceId)).toBeNull();
    expect(fileReceiptFromValue({ ...receipt, workspaceId: requestId }, restored, workspaceId)).toBeNull();
    expect(readPendingFile(storage, key)).toEqual(pending);
    clearPendingFile(storage, key, restored);
    expect(readPendingFile(storage, key)).toBeNull();
  });

  it("recognizes only an exact backend version refusal, never generic conflict or outcome uncertainty", () => {
    expect(isVersionConflict({ status: 409, value: { error: "version_conflict", currentVersion: version } })).toBe(true);
    expect(isVersionConflict({ status: 409, value: { error: "version_conflict" } })).toBe(true);
    for (const error of [
      { status: 503, value: { error: "version_conflict" } }, { status: 409, value: { error: "request_id_conflict" } },
      { status: 409, value: { error: "version_conflict", currentVersion: "bad" } },
      { status: 409, value: { error: "version_conflict", extra: true } }, null,
    ]) expect(isVersionConflict(error)).toBe(false);
  });
});

describe("CREATE and MOVE input and refusal rules", () => {
  it("accepts exact relative paths without trimming and rejects traversal, reserved names and invalid Unicode", () => {
    for (const path of ["src/new.txt", "nested/🌍.txt", " spaced name.txt ", ".hidden", "a".repeat(4096)]) expect(validPath(path)).toBe(true);
    for (const path of ["", "/absolute", "a//b", "a/../b", "./a", "a/", "a\0b", "\ud800", "\udfff", "a".repeat(4097),
      ".remotecode-workspace", "dir/.remotecode-stage-private"]) expect(validPath(path)).toBe(false);
  });

  it("recognizes only exact preflight target refusal, not an uncertain staged-operation error or request ID conflict", () => {
    expect(isTargetExists({ status: 409, value: { error: "target_exists" } })).toBe(true);
    for (const error of [
      { status: 400, value: { error: "target_exists" } }, { status: 503, value: { error: "target_exists" } },
      { status: 409, value: { error: "file_operation_unavailable" } }, { status: 409, value: { error: "request_id_conflict" } },
      { status: 409, value: { error: "target_exists", requestId } }, { status: 409, value: { error: "target_exists", currentVersion: version } },
      { status: 409, value: "target_exists" }, null,
    ]) expect(isTargetExists(error)).toBe(false);
  });

  it("persists content-free CREATE/MOVE identities and binds receipts to original bytes or source/destination/version", () => {
    const storage = memoryStorage();
    const create: PendingFile = { ...pending, kind: "create" };
    const created: FileReceipt = { ...receipt, kind: "create" };
    persistPendingFile(storage, key, create);
    expect(readPendingFile(storage, key)).toEqual(create);
    expect(fileReceiptFromValue(created, readPendingFile(storage, key)!, workspaceId)).toEqual(created);
    expect(fileReceiptFromValue({ ...created, path: "newer-input.txt" }, create, workspaceId)).toBeNull();
    expect(fileReceiptFromValue({ ...created, version: "0".repeat(64) }, create, workspaceId)).toBeNull();
    clearPendingFile(storage, key, create);
    const move: PendingFile = { kind: "move", requestId: crypto.randomUUID(), workspaceId, sourcePath: pending.path,
      destinationPath: "nested/moved.txt", expectedVersion: version };
    const moved: FileReceipt = { kind: "move", requestId: move.requestId, workspaceId, sourcePath: move.sourcePath,
      path: move.destinationPath, version, createdAt: receipt.createdAt };
    persistPendingFile(storage, key, move);
    expect(Object.keys(JSON.parse(storage.getItem(key)!)).sort()).toEqual(["destinationPath", "expectedVersion", "kind", "requestId", "sourcePath", "workspaceId"]);
    expect(fileReceiptFromValue(moved, readPendingFile(storage, key)!, workspaceId)).toEqual(moved);
    for (const changed of [{ sourcePath: "other.txt" }, { path: "newer-destination.txt" }, { version: "0".repeat(64) }, { workspaceId: requestId }]) {
      expect(fileReceiptFromValue({ ...moved, ...changed }, move, workspaceId)).toBeNull();
    }
    expect(() => clearPendingFile(storage, key, { ...move, destinationPath: "newer-destination.txt" })).toThrow();
    expect(readPendingFile(storage, key)).toEqual(move);
    clearPendingFile(storage, key, move);
    expect(() => persistPendingFile(storage, key, { ...move, destinationPath: move.sourcePath })).toThrow();
    expect(storage.getItem(key)).toBeNull();
  });
});

it("exercises Eden SAVE/receipt HTTP boundaries without transport retries after lost or malformed responses", async () => {
  const storage = memoryStorage();
  const requests: { method: string; path: string; body: unknown }[] = [];
  let mode: "lost" | "malformed" | "receipt" = "lost";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "PUT" ? await request.json() : null;
    requests.push({ method: request.method, path, body });
    if (request.method === "PUT") {
      if (mode === "lost") { await new Promise((resolve) => setTimeout(resolve, 80)); return Response.json(receipt); }
      if (mode === "malformed") return Response.json({ ...receipt, requestId: body.requestId, version: "0".repeat(64) });
    }
    return Response.json(receipt);
  } });
  try {
    const api = createApiClient(server.url.origin, { timeoutMs: 20 });
    const files = api.api.workspaces({ workspaceId }).files;
    persistPendingFile(storage, key, pending);
    const result = await files.content.put({ requestId, path: pending.path, content, expectedVersion: version });
    expect(workspaceErrorStatus(result.error)).toBe(503);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(requests[0].body).toEqual({ requestId, path: pending.path, content, expectedVersion: version });
    expect(readPendingFile(storage, key)).toEqual(pending);
    mode = "receipt";
    const recovered = await files.receipts({ requestId }).get();
    expect(recovered.error).toBeNull();
    expect(fileReceiptFromValue(recovered.data, readPendingFile(storage, key)!, workspaceId)).toEqual(receipt);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(requests.at(-1)?.path).toBe(`/api/workspaces/${workspaceId}/files/receipts/${requestId}`);
    clearPendingFile(storage, key, pending);
    mode = "malformed";
    const next = { ...pending, requestId: crypto.randomUUID() };
    persistPendingFile(storage, key, next);
    const malformed = await files.content.put({ requestId: next.requestId, path: next.path, content, expectedVersion: version });
    expect(fileReceiptFromValue(malformed.data, next, workspaceId)).toBeNull();
    expect(readPendingFile(storage, key)).toEqual(next);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(2);
  } finally { server.stop(true); }
});


it("recognizes only exact synchronous CREATE/MOVE missing-path refusals, never receipt absence or unknown status bodies", () => {
  for (const kind of ["create", "move"] as const) {
    const codes = kind === "create" ? ["parent_directory_not_found"] : ["source_parent_not_found", "destination_parent_not_found", "file_not_found"];
    for (const error of codes) {
      expect(isMissingFilePath({ status: 404, value: { error } }, kind)).toBe(true);
      expect(isMissingFilePath({ status: 503, value: { error } }, kind)).toBe(false);
      expect(isMissingFilePath({ status: 404, value: { error, extra: true } }, kind)).toBe(false);
    }
    for (const error of ["not_found", "receipt_not_found", "outcome_unknown", "request_id_conflict", "file_operation_unavailable"]) {
      expect(isMissingFilePath({ status: 404, value: { error } }, kind)).toBe(false);
    }
    expect(isMissingFilePath(null, kind)).toBe(false);
  }
  expect(isMissingFilePath({ status: 404, value: { error: "parent_directory_not_found" } }, "move")).toBe(false);
  expect(isMissingFilePath({ status: 404, value: { error: "destination_parent_not_found" } }, "create")).toBe(false);
});
