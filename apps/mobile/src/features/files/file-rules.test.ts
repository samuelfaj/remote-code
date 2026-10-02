import { expect, it } from "bun:test";
import type { PendingFile } from "@remotecode/client";
import { beforeFileDeadline, clearStoredFile, directoryFromValue, fileStorageKey, folderStateFromValue, nextFileInputScope, persistStoredFile, readPendingFile, validPath, validText, type FileStorage } from "./file-rules";

const workspaceId = "123e4567-e89b-42d3-a456-426614174001";
const requestId = "123e4567-e89b-42d3-a456-426614174002";
const operation: PendingFile = { kind: "save", workspaceId, requestId, path: "nested/file.txt", resultSha256: "ab".repeat(32) };
const key = fileStorageKey("https://host.example", "owner");
function storage() {
  const values = new Map<string, string>();
  const result: FileStorage = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
  return { values, result };
}

it("keeps callbacks from an earlier A visit fenced after A-B-A without invalidating same-scope typing", () => {
  let current = nextFileInputScope(null, "https://host", "owner", "A");
  const captured = current;
  let input = "first visit";
  const oldCallback = (value: string) => { if (current === captured) input = value; };
  expect(nextFileInputScope(current, "https://host", "owner", "A")).toBe(current);
  current = nextFileInputScope(current, "https://host", "owner", "B");
  current = nextFileInputScope(current, "https://host", "owner", "A");
  expect(current).not.toBe(captured);
  input = "new visit";
  oldCallback("stale text");
  expect(input).toBe("new visit");
  expect(nextFileInputScope(current, "https://other-host", "owner", "A")).not.toBe(current);
  expect(nextFileInputScope(current, "https://host", "other-owner", "A")).not.toBe(current);
});

it("enforces encoded UTF-8 size and exact scalar/BOM preservation before native SAVE", () => {
  expect(validText("é".repeat(524_288))).toBe(true);
  expect(validText("é".repeat(524_289))).toBe(false);
  expect(validText("\uFEFF🌍\r\n")).toBe(true);
  for (const value of ["a\0b", "\ud800", "\udfff", "x".repeat(1024 * 1024 + 1)]) expect(validText(value)).toBe(false);
  expect(validPath("src/main.txt")).toBe(true);
  for (const path of ["../main.txt", "/main.txt", "a//b", "a/./b", "a/", ".remotecode-workspace", "nested/.remotecode-stage-owned", "\ud800"]) expect(validPath(path)).toBe(false);
  expect(validPath("", true)).toBe(true);
});

it("binds provisioned folder and nested listing to requested workspace/path without treating unknown as provisioned", () => {
  expect(folderStateFromValue({ workspaceId, state: "provisioned", requestId }, workspaceId)).toBe("provisioned");
  expect(folderStateFromValue({ workspaceId, state: "unknown", requestId }, workspaceId)).toBe("unknown");
  expect(folderStateFromValue({ workspaceId: requestId, state: "provisioned", requestId }, workspaceId)).toBeNull();
  expect(folderStateFromValue({ workspaceId, state: "provisioned" }, workspaceId)).toBeNull();
  const entries = [{ name: "file.txt", type: "file" as const, size: 4 }];
  expect(directoryFromValue({ path: "nested", entries }, "nested")).toEqual(entries);
  expect(directoryFromValue({ path: "", entries }, "nested")).toBeNull();
  expect(directoryFromValue({ path: "nested", entries: [entries[0], entries[0]] }, "nested")).toBeNull();
});

it("persists content-free CREATE/MOVE identities without draft bytes or substituting MOVE baseline", async () => {
  const { values, result } = storage();
  const create: PendingFile = { kind: "create", workspaceId, requestId, path: "new.txt", resultSha256: "cd".repeat(32) };
  expect(await persistStoredFile(result, key, create, () => true)).toBe("saved");
  expect(readPendingFile(values.get(key)!)).toEqual(create);
  expect(values.get(key)).not.toContain("content");
  expect(await clearStoredFile(result, key, create, () => true)).toBe(true);
  const move: PendingFile = { kind: "move", workspaceId, requestId, sourcePath: "nested/file.txt", destinationPath: "moved.txt", expectedVersion: "ab".repeat(32) };
  expect(await persistStoredFile(result, key, move, () => true)).toBe("saved");
  expect(readPendingFile(values.get(key)!)).toEqual(move);
  expect(Object.keys(JSON.parse(values.get(key)!)).sort()).toEqual(["destinationPath", "expectedVersion", "kind", "requestId", "sourcePath", "workspaceId"]);
  expect(await clearStoredFile(result, key, { ...move, expectedVersion: "ef".repeat(32) }, () => true)).toBe(false);
  expect(readPendingFile(values.get(key)!)).toEqual(move);
});

it("persists only a content-free matching identity and refuses a replacement before clearing", async () => {
  const { values, result } = storage();
  expect(await persistStoredFile(result, key, operation, () => true)).toBe("saved");
  expect(readPendingFile(values.get(key)!)).toEqual(operation);
  expect(Object.keys(JSON.parse(values.get(key)!)).sort()).toEqual(["kind", "path", "requestId", "resultSha256", "workspaceId"]);
  expect(await persistStoredFile(result, key, operation, () => true)).toBe("unsafe");
  const replacement = { ...operation, requestId: crypto.randomUUID() };
  values.set(key, JSON.stringify(replacement));
  expect(await clearStoredFile(result, key, operation, () => true)).toBe(false);
  expect(readPendingFile(values.get(key)!)).toEqual(replacement);
  expect(fileStorageKey("https://other.example", "owner")).not.toBe(key);
  expect(fileStorageKey("https://host.example", "other")).not.toBe(key);
});

it("cleans a completed late unsent write instead of declaring it ready for PUT", async () => {
  const { values, result } = storage();
  let allowed = true;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const delayed: FileStorage = { ...result, async setItem(key, value) { markStarted(); await gate; values.set(key, value); } };
  const write = persistStoredFile(delayed, key, operation, () => allowed);
  await started;
  allowed = false;
  release();
  const outcome = await write;
  expect(outcome).toBe("cleaned");
  expect(values.has(key)).toBe(false);
});

it("fails closed when storage readback/removal is uncertain and never removes after context revocation", async () => {
  const { values, result } = storage();
  expect(await persistStoredFile({ ...result, async setItem() {} }, key, operation, () => true)).toBe("unsafe");
  values.set(key, JSON.stringify(operation));
  expect(await clearStoredFile({ ...result, async removeItem() {} }, key, operation, () => true)).toBe(false);
  expect(values.has(key)).toBe(true);
  let allowed = true;
  const changed: FileStorage = { ...result, async getItem(key) { allowed = false; return result.getItem(key); } };
  expect(await clearStoredFile(changed, key, operation, () => allowed)).toBe(false);
  expect(values.has(key)).toBe(true);
  expect(await clearStoredFile(result, key, operation, () => true)).toBe(true);
  expect(values.has(key)).toBe(false);
});

it("bounds native storage observation without pretending its delayed operation was cancelled", async () => {
  let completed = false;
  const work = new Promise<number>(resolve => setTimeout(() => { completed = true; resolve(1); }, 30));
  const observed = await beforeFileDeadline(work, Date.now() + 5);
  expect(observed.expired).toBe(true);
  expect(completed).toBe(false);
  await work;
  expect(completed).toBe(true);
});
