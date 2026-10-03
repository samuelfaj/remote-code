import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../../apps/api/src/app";
import { createApiClient, fileMissingPath, fileReceiptFromValue, fileTargetExists, fileFolderStateFromValue, pendingFolderFromValue, pendingFolderMatches, pendingFileFromValue, pendingFileValueMatches, workspaceErrorStatus, type PendingFile } from "./index";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const workspaceId = "123e4567-e89b-42d3-a456-426614174001";
const version = "ab".repeat(32);
const createdAt = "2026-10-01T00:00:00.000Z";
const pending: PendingFile = { kind: "create", requestId, workspaceId, path: createdAt, resultSha256: version };
const receipt = { kind: "create", requestId, workspaceId, path: createdAt, version, createdAt };

it("binds folder recovery to exact workspace and original request ID and preserves malformed identities as invalid", () => {
  const folder = { workspaceId, requestId };
  expect(pendingFolderFromValue(folder)).toEqual(folder);
  expect(pendingFolderMatches(JSON.stringify(folder), folder)).toBe(true);
  expect(pendingFolderMatches({ ...folder, requestId: crypto.randomUUID() }, folder)).toBe(false);
  expect(pendingFolderFromValue({ ...folder, content: "must not be stored" })).toBeNull();
  expect(pendingFolderFromValue({ workspaceId, requestId: "bad" })).toBeNull();
  expect(fileFolderStateFromValue({ workspaceId, state: "provisioned", requestId }, workspaceId, requestId)).toBe("provisioned");
  expect(fileFolderStateFromValue({ workspaceId, state: "provisioned", requestId: crypto.randomUUID() }, workspaceId, requestId)).toBeNull();
  expect(fileFolderStateFromValue({ workspaceId, state: "unknown", requestId }, workspaceId, requestId)).toBe("unknown");
  expect(fileFolderStateFromValue({ workspaceId, state: "not_provisioned" }, workspaceId, requestId)).toBe("not_provisioned");
});

it("clears only exact known no-effect CREATE/MOVE refusals, never generic or enriched errors", () => {
  expect(fileTargetExists({ status: 409, value: { error: "target_exists" } })).toBe(true);
  expect(fileTargetExists({ status: 400, value: { error: "target_exists" } })).toBe(false);
  expect(fileTargetExists({ status: 409, value: { error: "target_exists", requestId } })).toBe(false);
  expect(fileMissingPath({ status: 404, value: { error: "parent_directory_not_found" } }, "create")).toBe(true);
  expect(fileMissingPath({ status: 404, value: { error: "file_not_found" } }, "create")).toBe(false);
  expect(fileMissingPath({ status: 404, value: { error: "file_not_found" } }, "move")).toBe(true);
  expect(fileMissingPath({ status: 404, value: { error: "file_not_found", path: "file.txt" } }, "move")).toBe(false);
  expect(fileMissingPath({ status: 503, value: { error: "file_not_found" } }, "move")).toBe(false);
});

it("confirms only exact file receipts bound to the current request, workspace, path and result bytes", () => {
  for (const kind of ["create", "save"] as const) {
    const identity = { ...pending, kind };
    expect(fileReceiptFromValue({ ...receipt, kind }, identity, workspaceId)).toEqual({ ...receipt, kind });
    expect(fileReceiptFromValue({ ...receipt, kind, createdAt: new Date(createdAt) }, identity)).toEqual({ ...receipt, kind });
    for (const changed of [
      { requestId: crypto.randomUUID() }, { requestId: requestId.toUpperCase() }, { workspaceId: crypto.randomUUID() },
      { kind: kind === "create" ? "save" : "create" }, { path: "another.txt" }, { version: "0".repeat(64) },
      { version: version.toUpperCase() }, { extra: true }, { sourcePath: createdAt },
      { createdAt: "2026-10-01" }, { createdAt: "2026-10-01T00:00:00Z" },
      { createdAt: "2026-10-01T01:00:00.000+01:00" }, { createdAt: "2026-02-30T00:00:00.000Z" },
      { createdAt: new Date(NaN) },
    ]) expect(fileReceiptFromValue({ ...receipt, kind, ...changed }, identity)).toBeNull();
    expect(fileReceiptFromValue({ ...receipt, kind }, identity, crypto.randomUUID())).toBeNull();
  }
  expect(fileReceiptFromValue({ ...receipt, requestId: "bad" }, { ...pending, requestId: "bad" })).toBeNull();
  expect(fileReceiptFromValue(null, pending)).toBeNull();
});

it("binds MOVE to its source, destination and unchanged expected version, not just the pending ID", () => {
  const move: PendingFile = { kind: "move", requestId, workspaceId, sourcePath: createdAt, destinationPath: "moved.txt", expectedVersion: version };
  const moved = { ...receipt, kind: "move" as const, sourcePath: createdAt, path: move.destinationPath };
  expect(fileReceiptFromValue(moved, move)).toEqual(moved);
  for (const changed of [{ sourcePath: "other.txt" }, { path: createdAt }, { version: "0".repeat(64) }, { kind: "save" }, { destinationPath: move.destinationPath }]) {
    expect(fileReceiptFromValue({ ...moved, ...changed }, move)).toBeNull();
  }
  const { sourcePath, ...missingSource } = moved;
  expect(fileReceiptFromValue(missingSource, move)).toBeNull();
  expect(pendingFileValueMatches(JSON.stringify(move), move)).toBe(true);
  expect(pendingFileValueMatches({ ...move, expectedVersion: "0".repeat(64) }, move)).toBe(false);
  expect(pendingFileValueMatches({ ...move, sourcePath: "other.txt" }, move)).toBe(false);
  expect(pendingFileValueMatches({ ...move, destinationPath: "other.txt" }, move)).toBe(false);
});

it("keeps pending identities minimal, canonical and safe to compare before clearing persisted IDs", () => {
  expect(pendingFileFromValue(pending)).toEqual(pending);
  expect(pendingFileValueMatches(JSON.stringify(pending), pending)).toBe(true);
  expect(pendingFileValueMatches("not JSON", pending)).toBe(false);
  for (const changed of [
    { requestId: "bad" }, { requestId: requestId.toUpperCase() }, { workspaceId: "bad" }, { kind: "open" },
    { resultSha256: version.toUpperCase() }, { resultSha256: "0" }, { resultSha256: "0".repeat(64) },
    { content: "not an identity" }, { expectedVersion: version }, { path: "other.txt" },
  ]) expect(pendingFileValueMatches({ ...pending, ...changed }, pending)).toBe(false);
  for (const path of ["", "/absolute", "a//b", "a/../b", "./a", "a/", "a\0b", "\ud800", "\udfff", "a".repeat(4097), ".remotecode-workspace", "dir/.remotecode-stage-private"]) {
    expect(pendingFileFromValue({ ...pending, path })).toBeNull();
  }
  expect(pendingFileFromValue({ ...pending, path: "\uFEFF🌍.txt" })?.kind).toBe("create");
  const move = { kind: "move", requestId, workspaceId, sourcePath: "same.txt", destinationPath: "same.txt", expectedVersion: version };
  expect(pendingFileFromValue(move)).toBeNull();
  expect(pendingFileFromValue({ ...move, destinationPath: "next.txt", expectedVersion: version.toUpperCase() })).toBeNull();
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function digest(content: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

it.skipIf(process.platform !== "linux")("confirms real CREATE, SAVE and POST MOVE receipts and manual GETs through the one Eden TCP client", async () => {
  const directory = mkdtempSync(join(process.env.RC029_TEST_WORK_DIR ?? tmpdir(), "rc029-file-client-"));
  directories.push(directory);
  const app = createApi(join(directory, "host.sqlite"), undefined, { password: "file-client-test-password" });
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "file-client-test-password" }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test login cookie missing");
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = app.server?.port;
  if (!port) throw new Error("File client API did not bind");
  const client = createApiClient(`http://127.0.0.1:${port}`, { headers: { cookie } });
  try {
    const createdWorkspace = await client.api.workspaces.post({ name: "files", requestId: crypto.randomUUID() });
    if (createdWorkspace.error || !createdWorkspace.data || !("id" in createdWorkspace.data)) throw new Error("Workspace unavailable");
    const workspaceId = createdWorkspace.data.id;
    const folderId = crypto.randomUUID();
    const routes = client.api.workspaces({ workspaceId });
    expect((await routes.folder.get()).data).toEqual({ workspaceId, state: "not_provisioned" });
    expect((await routes.folder.post({ requestId: folderId.toUpperCase() })).data).toEqual({ workspaceId, state: "provisioned" });
    expect((await routes.folder.get()).data).toEqual({ workspaceId, state: "provisioned", requestId: folderId });
    const content = "\uFEFF2026-10-01T00:00:00.000Z\n🌍";
    const create: PendingFile = { kind: "create", workspaceId, requestId: crypto.randomUUID(), path: createdAt, resultSha256: await digest(content) };
    const created = await routes.files.post({ requestId: create.requestId, path: create.path, content });
    expect(created.error).toBeNull();
    const confirmed = fileReceiptFromValue(created.data, create);
    expect(confirmed?.version).toBe(create.resultSha256);
    expect(confirmed?.path).toBe(createdAt);
    expect(typeof confirmed?.createdAt).toBe("string");
    expect(fileReceiptFromValue((await routes.files.receipts({ requestId: create.requestId }).get()).data, create)).toEqual(confirmed);
    const opened = await routes.files.content.get({ query: { path: createdAt } });
    expect(opened.data).toEqual({ path: createdAt, content, version: create.resultSha256 });
    const changedContent = "\uFEFFsaved exact bytes\n";
    const save: PendingFile = { kind: "save", requestId: crypto.randomUUID(), workspaceId, path: createdAt, resultSha256: await digest(changedContent) };
    const saved = await routes.files.content.put({ requestId: save.requestId, path: save.path, content: changedContent, expectedVersion: create.resultSha256 });
    expect(saved.error).toBeNull();
    const savedReceipt = fileReceiptFromValue(saved.data, save);
    expect(savedReceipt?.version).toBe(save.resultSha256);
    const stale = await routes.files.content.put({ requestId: crypto.randomUUID(), path: save.path, content: "stale", expectedVersion: create.resultSha256 });
    expect(workspaceErrorStatus(stale.error)).toBe(409);
    expect(fileReceiptFromValue(stale.data, save)).toBeNull();
    const move: PendingFile = { kind: "move", requestId: crypto.randomUUID(), workspaceId, sourcePath: createdAt, destinationPath: "moved.txt", expectedVersion: save.resultSha256 };
    const moved = await routes.files.move.post({ requestId: move.requestId, sourcePath: move.sourcePath, destinationPath: move.destinationPath, expectedVersion: move.expectedVersion });
    expect(moved.error).toBeNull();
    const movedReceipt = fileReceiptFromValue(moved.data, move);
    expect(movedReceipt?.kind).toBe("move");
    expect(movedReceipt?.path).toBe(move.destinationPath);
    expect(fileReceiptFromValue((await routes.files.receipts({ requestId: move.requestId }).get()).data, move)).toEqual(movedReceipt);
    expect(fileReceiptFromValue((await routes.files.receipts({ requestId: save.requestId }).get()).data, save)).toEqual(savedReceipt);
    expect(readFileSync(join(directory, "workspaces", workspaceId, "moved.txt"), "utf8")).toBe(changedContent);
  } finally { await app.stop(true); }
});
