import { createHash } from "node:crypto";
import { constants, readdirSync, readSync, statSync } from "node:fs";
import { Elysia, t } from "elysia";
import { sessionUserId } from "./auth";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";

// ponytail: UTF-8 reads cap at 1 MiB; add streaming reads for larger or binary files.
const maxContentBytes = 1024 * 1024;
const maxDirectoryEntries = 1000;
const directoryFlags = constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000;
const markerName = ".remotecode-workspace";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Entry = { name: string; type: "file" | "directory"; size: number };
type FileContent = { path: string; content: string; version: string };
type DirectoryListing = { path: string; entries: Entry[] };
type ReadResult<T> = { status: number; body: T | { error: string } };

function relativeComponents(path: string | undefined, required: boolean): string[] | null {
  if (path === undefined) return required ? null : [];
  if (path.length === 0 || path.includes("\0") || path.startsWith("/")) return null;
  const components = path.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === ".." || component === markerName)) return null;
  return components;
}

function openDirectoryPath(
  folderFd: number,
  components: string[],
  openAt: (parentFd: number, name: string, flags: number) => number,
  close: (fd: number) => void,
): number {
  let current = folderFd;
  for (const component of components) {
    const next = openAt(current, component, directoryFlags);
    if (next < 0) {
      if (current !== folderFd) close(current);
      return -1;
    }
    if (current !== folderFd) close(current);
    current = next;
  }
  return current;
}

function readContent(
  folderFd: number,
  components: string[],
  openAt: (parentFd: number, name: string, flags: number) => number,
  close: (fd: number) => void,
): ReadResult<FileContent> {
  const parent = openDirectoryPath(folderFd, components.slice(0, -1), openAt, close);
  if (parent < 0) return { status: 404, body: { error: "file_not_found" } };
  const fileFd = openAt(parent, components.at(-1)!, fileFlags);
  if (parent !== folderFd) close(parent);
  if (fileFd < 0) return { status: 404, body: { error: "file_not_found" } };
  try {
    const info = statSync(`/proc/self/fd/${fileFd}`);
    if (!info.isFile()) return { status: 415, body: { error: "unsupported_file_type" } };
    if (info.size > maxContentBytes) return { status: 413, body: { error: "file_too_large" } };
    const bytes = Buffer.alloc(maxContentBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fileFd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxContentBytes) return { status: 413, body: { error: "file_too_large" } };
    const contentBytes = bytes.subarray(0, length);
    if (contentBytes.includes(0)) return { status: 415, body: { error: "unsupported_file_type" } };
    let content: string;
    try {
      content = utf8.decode(contentBytes);
    } catch {
      return { status: 415, body: { error: "unsupported_text_encoding" } };
    }
    return {
      status: 200,
      body: { path: components.join("/"), content, version: createHash("sha256").update(contentBytes).digest("hex") },
    };
  } finally {
    close(fileFd);
  }
}

function listDirectory(
  folderFd: number,
  components: string[],
  openAt: (parentFd: number, name: string, flags: number) => number,
  close: (fd: number) => void,
): ReadResult<DirectoryListing> {
  const directoryFd = openDirectoryPath(folderFd, components, openAt, close);
  if (directoryFd < 0) return { status: 404, body: { error: "directory_not_found" } };
  try {
    const names = readdirSync(`/proc/self/fd/${directoryFd}`);
    if (names.length > maxDirectoryEntries) return { status: 413, body: { error: "directory_too_large" } };
    const entries: Entry[] = [];
    for (const name of names) {
      if (name === markerName) continue;
      const fd = openAt(directoryFd, name, fileFlags);
      if (fd < 0) continue;
      try {
        const info = statSync(`/proc/self/fd/${fd}`);
        if (info.isDirectory()) entries.push({ name, type: "directory", size: 0 });
        else if (info.isFile()) entries.push({ name, type: "file", size: info.size });
      } finally {
        close(fd);
      }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { status: 200, body: { path: components.join("/"), entries } };
  } finally {
    if (directoryFd !== folderFd) close(directoryFd);
  }
}

export function workspaceFilesFeature(databasePath: string) {
  return new Elysia().get("/api/workspaces/:workspaceId/files", ({ params, query, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) {
      set.status = 401;
      return { error: "unauthorized" as const };
    }
    const components = relativeComponents(query.path, false);
    if (components === null) {
      set.status = 400;
      return { error: "invalid_path" as const };
    }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
      (folderFd, openAt, close) => listDirectory(folderFd, components, openAt, close));
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_files_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    query: t.Object({ path: t.Optional(t.String({ maxLength: 4096 })) }),
  }).get("/api/workspaces/:workspaceId/files/content", ({ params, query, request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) {
      set.status = 401;
      return { error: "unauthorized" as const };
    }
    const components = relativeComponents(query.path, true);
    if (!components) {
      set.status = 400;
      return { error: "invalid_path" as const };
    }
    const result = withProvisionedWorkspaceFolder(databasePath, userId, params.workspaceId,
      (folderFd, openAt, close) => readContent(folderFd, components, openAt, close));
    if (result.kind !== "opened") {
      set.status = result.kind === "not_found" ? 404 : process.platform === "linux" ? 503 : 501;
      return { error: result.kind === "not_found" ? "not_found" : process.platform === "linux" ? "workspace_folder_unavailable" : "workspace_files_require_linux" };
    }
    set.status = result.value.status;
    return result.value.body;
  }, {
    params: t.Object({ workspaceId: t.String({ format: "uuid", minLength: 36, maxLength: 36 }) }),
    query: t.Object({ path: t.Optional(t.String({ maxLength: 4096 })) }),
  });
}
