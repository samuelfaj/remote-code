import { Database } from "bun:sqlite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { fstatSync, lstatSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, type Socket } from "node:net";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { isDeepStrictEqual } from "node:util";
import { Elysia, t } from "elysia";
import { sessionExpiresAt, sessionTokenHash, sessionUserId } from "./auth";
import { withProvisionedWorkspaceFolder } from "./workspace-folders";

type TerminalConfig = { volumeName: string; image: string };
type Identity = { userId: string; tokenHash: string; expiresAt: number };
type Witness = { device: string; inode: string };
type TerminalRow = {
  terminal_id: string; user_id: string; token_hash: string; expires_at: number;
  request_id: string; workspace_id: string; cols: number; rows: number;
  volume_name: string; image: string; nonce: string; folder_device: string; folder_inode: string;
  container_id: string | null; state: string; start_sent: number; stop_sent: number; remove_sent: number;
  exit_code: number | null; cleanup: string; current_cols: number; current_rows: number;
  resize_state: string; input_sequence: number; input_digest: string | null; input_state: string | null;
};
type TerminalContext = {
  row: TerminalRow; socket?: Socket; closing: boolean; launching: boolean; allocationAttempted: boolean;
  output: Buffer; offset: number; outputAvailable: boolean; backpressured: boolean; inputPending: boolean;
  droppedBytes: number; polledOffset: number;
  readyBytes: Buffer; ready: boolean; resolveReady?: () => void; rejectReady?: (error: Error) => void;
  launch?: Promise<void>; stop?: Promise<void>; watching: boolean;
  watch?: ReturnType<typeof setInterval>; expiry?: ReturnType<typeof setTimeout>;
};
// Docker control belongs only to the trusted private host, never the terminal.
const dockerSocket = "/var/run/docker.sock";
const dockerApi = "/v1.47";
const dockerDeadlineMs = 4000;
const readyDeadlineMs = 5000;
const maxActive = 4;
const maxRetained = 16;
const outputLimit = 64 * 1024;
const pollLimit = 16 * 1024;
const inputLimit = 4096;
const actor = Object.freeze({ uid: 65534, gid: 65534 } as const);
const terminalEnv = [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TERM=xterm-256color",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "BUN_INSTALL_BIN=/usr/local/bin",
];
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = t.Transform(t.String({ format: "uuid", minLength: 36, maxLength: 36 }))
  .Decode((value) => value.toLowerCase()).Encode((value) => value.toLowerCase());
const dimensionsSchema = t.Object({ cols: t.Integer({ minimum: 2, maximum: 300 }), rows: t.Integer({ minimum: 2, maximum: 200 }) });
const rowStates = ["reserved", "starting", "running", "closing", "unknown", "exited", "not_started"];

class TerminalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function validConfig(config: TerminalConfig | undefined): config is TerminalConfig {
  return !!config && typeof config.volumeName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.volumeName) &&
    typeof config.image === "string" && /^sha256:[0-9a-f]{64}$/.test(config.image);
}

function hostReady() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) return false;
  try {
    const info = lstatSync(dockerSocket);
    return info.isSocket() && info.uid === 0 && (info.mode & 0o002) === 0;
  } catch { return false; }
}

function terminalName(row: TerminalRow) { return `remotecode-terminal-${row.terminal_id}`; }
function terminalPath(row: TerminalRow) { return `/containers/${row.container_id ?? terminalName(row)}`; }
function finished(row: TerminalRow) { return row.state === "exited" || row.state === "not_started"; }

function appendOutput(context: TerminalContext, bytes: Buffer) {
  if (context.offset + bytes.length > Number.MAX_SAFE_INTEGER) throw new TerminalError(503, "terminal_offset_exhausted");
  context.offset += bytes.length;
  // Bounded ring: the producer never blocks; retained bytes stay readable and the dropped count stays observable.
  const retained = context.output.length + bytes.length > outputLimit
    ? context.output.length + bytes.length - outputLimit : 0;
  if (retained > 0) context.droppedBytes += retained;
  context.output = bytes.length >= outputLimit ? Buffer.from(bytes.subarray(bytes.length - outputLimit)) :
    Buffer.concat([context.output.subarray(Math.max(0, context.output.length + bytes.length - outputLimit)), bytes]);
}

function outputSnapshot(context: TerminalContext | undefined, offset: number) {
  const end = context?.offset ?? 0;
  const base = end - (context?.output.length ?? 0);
  if (offset > end) throw new TerminalError(409, "terminal_offset_ahead");
  if (context) context.polledOffset = Math.max(context.polledOffset, Math.min(end, Math.max(offset, base) + pollLimit));
  const from = Math.max(offset, base);
  const next = Math.min(end, from + pollLimit);
  return {
    baseOffset: base, offset: from, nextOffset: next, endOffset: end, gap: offset < base,
    // Retained bytes, cumulative producer total, dropped total, and highest delivered offset make flow visible.
    retainedBytes: context?.output.length ?? 0, totalBytes: end, droppedBytes: context?.droppedBytes ?? 0,
    outputBase64: context?.output.subarray(from - base, next - base).toString("base64") ?? "",
    outputAvailable: context !== undefined,
  };
}

function publicImageEnvironment(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) return false;
  const paths = [terminalEnv[0], `${terminalEnv[0]}:/usr/local/bun-node-fallback-bin`];
  return new Set(value.map((entry) => entry.split("=", 1)[0])).size === value.length &&
    value.some((entry) => paths.includes(entry)) && value.every((entry) => paths.includes(entry) || terminalEnv.slice(1).includes(entry));
}

function inputBytes(text: string) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0 || bytes.length > inputLimit || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== text) {
    throw new TerminalError(422, "invalid_terminal_input");
  }
  return bytes;
}

function bootstrap(row: TerminalRow) {
  if (!/^\d+$/.test(row.folder_device) || !/^\d+$/.test(row.folder_inode) || !/^[0-9a-f]{64}$/.test(row.nonce)) {
    throw new TerminalError(503, "terminal_witness_invalid");
  }
  return `set -eu; [ "$(id -u)" = 65534 ]; [ "$(id -g)" = 65534 ]; ` +
    `[ "$(stat -c '%d:%i:%u:%g' .)" = '${row.folder_device}:${row.folder_inode}:65534:65534' ]; ` +
    `printf '\\036REMOTECODE:${row.nonce}:65534:65534:${row.folder_device}:${row.folder_inode}\\037\\n'; exec /bin/sh -i`;
}

function containerSpec(row: TerminalRow) {
  return {
    Image: row.image, User: "65534:65534", WorkingDir: "/workspace",
    Entrypoint: ["/bin/sh"], Cmd: ["-c", bootstrap(row)], Env: terminalEnv,
    Tty: true, OpenStdin: true, StdinOnce: false, AttachStdin: true, AttachStdout: true, AttachStderr: true,
    Healthcheck: { Test: ["NONE"] },
    Labels: { "remotecode.terminal": row.terminal_id, "remotecode.nonce": row.nonce },
    HostConfig: {
      ConsoleSize: [row.rows, row.cols],
      Mounts: [{ Type: "volume", Source: row.volume_name, Target: "/workspace", ReadOnly: false,
        VolumeOptions: { NoCopy: true, Subpath: `workspaces/${row.workspace_id}` } }],
      ReadonlyRootfs: true, NetworkMode: "none", CapDrop: ["ALL"], CapAdd: [],
      SecurityOpt: ["no-new-privileges"], PidMode: "", IpcMode: "private", CgroupnsMode: "private",
      Privileged: false, AutoRemove: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024, PidsLimit: 64, NanoCpus: 1000000000,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=65534,gid=65534" },
      LogConfig: { Type: "none", Config: {} }, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }],
    },
  };
}

// Inspect is untrusted engine data; ownership and isolation must match the reservation.
function ownedContainer(value: unknown, row: TerminalRow) {
  const spec = containerSpec(row);
  const data = value as {
    Id?: string; Name?: string; Image?: string; Config?: typeof spec & { Volumes?: Record<string, unknown> };
    HostConfig?: typeof spec.HostConfig & {
      Binds?: unknown[]; Devices?: unknown[]; DeviceRequests?: unknown[]; GroupAdd?: unknown[];
      VolumesFrom?: unknown[]; Links?: unknown[]; PortBindings?: Record<string, unknown>;
    };
    Mounts?: { Type: string; Name: string; Destination: string; RW: boolean }[];
    State?: { Running?: boolean; Status?: string; ExitCode?: number; Paused?: boolean; Restarting?: boolean };
  };
  const config = data?.Config;
  const host = data?.HostConfig;
  const equal = isDeepStrictEqual;
  const mount = host?.Mounts?.[0];
  const expectedMount = spec.HostConfig.Mounts[0];
  const mountMatches = host?.Mounts?.length === 1 && mount?.Type === expectedMount.Type &&
    mount.Source === expectedMount.Source && mount.Target === expectedMount.Target && !mount.ReadOnly &&
    mount.VolumeOptions?.NoCopy === true && mount.VolumeOptions.Subpath === expectedMount.VolumeOptions.Subpath &&
    Object.keys(mount).every((key) => ["Type", "Source", "Target", "ReadOnly", "Consistency", "VolumeOptions"].includes(key)) &&
    Object.keys(mount.VolumeOptions).every((key) => ["NoCopy", "Subpath"].includes(key));
  const envMatches = Array.isArray(config?.Env) && config.Env.length === terminalEnv.length &&
    terminalEnv.every((entry) => config.Env.includes(entry));
  const labelsMatch = config?.Labels?.["remotecode.terminal"] === row.terminal_id && config.Labels["remotecode.nonce"] === row.nonce &&
    Object.keys(config.Labels).every((key) => Object.hasOwn(spec.Labels, key) || key.startsWith("org.opencontainers.image."));
  if (!data || typeof data.Id !== "string" || !/^[0-9a-f]{64}$/.test(data.Id) ||
    (row.container_id !== null && row.container_id !== data.Id) || data.Name !== `/${terminalName(row)}` || data.Image !== row.image ||
    !config || !host || config.Image !== row.image || config.User !== spec.User || config.WorkingDir !== spec.WorkingDir ||
    !equal(config.Entrypoint, spec.Entrypoint) || !equal(config.Cmd, spec.Cmd) || !envMatches ||
    !config.Tty || !config.OpenStdin || config.StdinOnce || !labelsMatch ||
    Object.keys(config.Volumes ?? {}).length !== 0 || !equal(config.Healthcheck?.Test, ["NONE"]) ||
    !mountMatches || !host.ReadonlyRootfs || host.NetworkMode !== "none" ||
    !equal(host.CapDrop, ["ALL"]) || (host.CapAdd?.length ?? 0) !== 0 || !equal(host.SecurityOpt, ["no-new-privileges"]) ||
    host.PidMode !== "" || host.IpcMode !== "private" || host.CgroupnsMode !== "private" || host.Privileged || host.AutoRemove ||
    !equal(host.RestartPolicy, spec.HostConfig.RestartPolicy) || host.Memory !== spec.HostConfig.Memory ||
    host.MemorySwap !== spec.HostConfig.MemorySwap || host.PidsLimit !== 64 || host.NanoCpus !== spec.HostConfig.NanoCpus ||
    !equal(host.Tmpfs, spec.HostConfig.Tmpfs) || !equal(host.LogConfig, spec.HostConfig.LogConfig) ||
    !equal(host.Ulimits, spec.HostConfig.Ulimits) ||
    [host.Binds, host.Devices, host.DeviceRequests, host.GroupAdd, host.VolumesFrom, host.Links].some((items) => (items?.length ?? 0) !== 0) ||
    Object.keys(host.PortBindings ?? {}).length !== 0 || data.Mounts?.length !== 1 ||
    data.Mounts[0].Type !== "volume" || data.Mounts[0].Name !== row.volume_name ||
    data.Mounts[0].Destination !== "/workspace" || data.Mounts[0].RW !== true ||
    typeof data.State?.Running !== "boolean" || typeof data.State.Status !== "string" ||
    !Number.isInteger(data.State.ExitCode) || data.State.Paused || data.State.Restarting) {
    throw new TerminalError(503, "terminal_container_identity_unverified");
  }
  return { id: data.Id, running: data.State.Running, status: data.State.Status, exitCode: data.State.ExitCode! };
}

function docker(method: string, path: string, body?: unknown): Promise<{ status: number; value: unknown }> {
  if (!hostReady()) return Promise.reject(new TerminalError(503, "terminal_host_unavailable"));
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let settled = false;
    const finish = (error?: Error, result?: { status: number; value: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const request = httpRequest({ socketPath: dockerSocket, path: `${dockerApi}${path}`, method,
      agent: false, headers: bytes ? { "content-type": "application/json", "content-length": bytes.length } : {} }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024) { finish(new TerminalError(503, "terminal_engine_response_invalid")); request.destroy(); }
        else chunks.push(chunk);
      });
      response.on("error", () => finish(new TerminalError(503, "terminal_engine_unknown")));
      response.on("aborted", () => finish(new TerminalError(503, "terminal_engine_unknown")));
      response.on("end", () => {
        try {
          const content = Buffer.concat(chunks).toString("utf8");
          finish(undefined, { status: response.statusCode ?? 0, value: content.length ? JSON.parse(content) : null });
        } catch { finish(new TerminalError(503, "terminal_engine_response_invalid")); }
      });
    });
    const timer = setTimeout(() => { finish(new TerminalError(503, "terminal_engine_unknown")); request.destroy(); }, dockerDeadlineMs);
    request.on("error", () => finish(new TerminalError(503, "terminal_engine_unknown")));
    request.end(bytes);
  });
}

function attach(row: TerminalRow, accept: (socket: Socket, head: Buffer) => void): Promise<void> {
  if (!hostReady()) return Promise.reject(new TerminalError(503, "terminal_host_unavailable"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    // Bun 1.3.13 node:http reports Docker's 101 as a response, not a usable upgrade.
    const socket = createConnection(dockerSocket);
    let buffered = Buffer.alloc(0);
    const fail = (message: string) => { finish(new TerminalError(503, message)); socket.destroy(); };
    const timer = setTimeout(() => fail("terminal_attach_unknown"), dockerDeadlineMs);
    const streamError = () => fail("terminal_attach_unknown");
    const handshake = (bytes: Buffer) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, bytes]);
      const end = buffered.indexOf("\r\n\r\n");
      if ((end === -1 ? buffered.length : end + 4) > 16 * 1024) { fail("terminal_attach_unavailable"); return; }
      if (end === -1) return;
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const headers = new Map<string, string>();
      if (!/^HTTP\/1\.[01] 101(?: [^\r\n]*)?$/.test(lines.shift()!)) { fail("terminal_attach_unavailable"); return; }
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*)$/.exec(line);
        const name = match?.[1]?.toLowerCase();
        if (!name || headers.has(name)) { fail("terminal_attach_unavailable"); return; }
        headers.set(name, match![2]!.trim().toLowerCase());
      }
      if (headers.get("upgrade") !== "tcp" || !headers.get("connection")?.split(",").some((value) => value.trim() === "upgrade") ||
        headers.get("content-type") !== "application/vnd.docker.raw-stream") { fail("terminal_attach_unavailable"); return; }
      socket.pause();
      socket.off("data", handshake);
      socket.off("error", streamError);
      socket.off("close", streamError);
      try { accept(socket, buffered.subarray(end + 4)); finish(); socket.resume(); }
      catch { fail("terminal_attach_unavailable"); }
    };
    socket.on("data", handshake);
    socket.on("error", streamError);
    socket.on("close", streamError);
    socket.on("connect", () => socket.write(
      `POST ${dockerApi}${terminalPath(row)}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n` +
      "Host: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n",
    ));
  });
}

export function terminalsFeature(databasePath: string, config?: TerminalConfig) {
  const cfg = validConfig(config) ? { ...config } : undefined;
  const contexts = new Map<string, TerminalContext>();
  const inputKey = randomBytes(32);
  let schemaReady = false;
  let shuttingDown = false;

  function database<T>(callback: (db: Database) => T): T {
    const db = new Database(databasePath, { readwrite: true, create: false });
    try {
      db.exec("PRAGMA busy_timeout = 250; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
      return callback(db);
    } finally { db.close(); }
  }

  if (cfg && hostReady()) {
    try {
      database((db) => {
        db.exec(`CREATE TABLE IF NOT EXISTS terminal_sessions (
          terminal_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          cols INTEGER NOT NULL CHECK (cols BETWEEN 2 AND 300), rows INTEGER NOT NULL CHECK (rows BETWEEN 2 AND 200),
          volume_name TEXT NOT NULL, image TEXT NOT NULL, nonce TEXT NOT NULL,
          folder_device TEXT NOT NULL, folder_inode TEXT NOT NULL, container_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('reserved','starting','running','closing','unknown','exited','not_started')),
          start_sent INTEGER NOT NULL DEFAULT 0 CHECK (start_sent IN (0,1)),
          stop_sent INTEGER NOT NULL DEFAULT 0 CHECK (stop_sent IN (0,1)),
          remove_sent INTEGER NOT NULL DEFAULT 0 CHECK (remove_sent IN (0,1)), exit_code INTEGER,
          cleanup TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup IN ('pending','unknown','removed')),
          current_cols INTEGER NOT NULL, current_rows INTEGER NOT NULL,
          resize_state TEXT NOT NULL DEFAULT 'idle' CHECK (resize_state IN ('idle','unknown','applied')),
          input_sequence INTEGER NOT NULL DEFAULT 0, input_digest TEXT,
          input_state TEXT CHECK (input_state IN ('unknown','queued','written')),
          UNIQUE(user_id, request_id)
        )`);
        db.query("SELECT * FROM terminal_sessions LIMIT 0").all();
        // A new module has no old PTY handle. Never restart or attach an old process.
        db.exec("UPDATE terminal_sessions SET state = 'unknown' WHERE state NOT IN ('exited','not_started')");
      });
      schemaReady = true;
    } catch { schemaReady = false; }
  }

  function available() {
    if (!cfg || !schemaReady || !hostReady()) throw new TerminalError(503, "terminals_unavailable");
  }

  function identity(request: Request): Identity {
    const userId = sessionUserId(databasePath, request);
    const tokenHash = sessionTokenHash(request);
    const expiresAt = sessionExpiresAt(databasePath, request);
    if (!userId || !tokenHash || !expiresAt) throw new TerminalError(401, "unauthorized");
    const result = { userId, tokenHash, expiresAt };
    assertSession(result);
    return result;
  }

  function assertSession(owner: Identity) {
    const live = database((db) => db.query<{ expires_at: number }, [string, string]>(
      "SELECT expires_at FROM sessions WHERE user_id = ? AND token_hash = ?",
    ).get(owner.userId, owner.tokenHash));
    if (!live || live.expires_at !== owner.expiresAt || live.expires_at <= Date.now()) throw new TerminalError(401, "unauthorized");
  }

  function ownerOf(row: TerminalRow): Identity { return { userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at }; }

  function workspace(owner: Identity, workspaceId: string, requireActive = true) {
    const result = database((db) => db.query<{ archived: number }, [string, string]>(
      "SELECT archived FROM workspaces WHERE id = ? AND user_id = ?",
    ).get(workspaceId, owner.userId));
    if (!result) throw new TerminalError(404, "not_found");
    if (requireActive && result.archived !== 0) throw new TerminalError(409, "workspace_archived");
  }

  function folder(owner: Identity, workspaceId: string): Witness {
    const result = withProvisionedWorkspaceFolder(databasePath, owner.userId, workspaceId, (fd, _openAt, _close, actorIdentity) => {
      const info = fstatSync(fd, { bigint: true });
      return { uid: actorIdentity.uid, gid: actorIdentity.gid, actualUid: Number(info.uid), actualGid: Number(info.gid),
        device: String(info.dev), inode: String(info.ino) };
    });
    if (result.kind !== "opened") throw new TerminalError(result.kind === "not_found" ? 404 : 503, "workspace_folder_unavailable");
    if (result.value.uid !== actor.uid || result.value.gid !== actor.gid || result.value.actualUid !== actor.uid || result.value.actualGid !== actor.gid) {
      throw new TerminalError(409, "terminal_workspace_identity_required");
    }
    return { device: result.value.device, inode: result.value.inode };
  }

  function readRow(id: string): TerminalRow | null {
    return database((db) => db.query<TerminalRow, [string]>("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(id));
  }

  function checkedRow(row: TerminalRow) {
    if (!canonicalUuid.test(row.terminal_id) || !canonicalUuid.test(row.workspace_id) || !canonicalUuid.test(row.request_id) ||
      !/^[0-9a-f]{64}$/.test(row.token_hash) || !/^[0-9a-f]{64}$/.test(row.nonce) || !rowStates.includes(row.state) ||
      !validConfig({ volumeName: row.volume_name, image: row.image }) || !/^\d+$/.test(row.folder_device) || !/^\d+$/.test(row.folder_inode) ||
      (row.container_id !== null && !/^[0-9a-f]{64}$/.test(row.container_id)) ||
      !Number.isSafeInteger(row.expires_at) || row.expires_at <= 0 ||
      ![row.cols, row.current_cols].every((value) => Number.isInteger(value) && value >= 2 && value <= 300) ||
      ![row.rows, row.current_rows].every((value) => Number.isInteger(value) && value >= 2 && value <= 200) ||
      ![row.start_sent, row.stop_sent, row.remove_sent].every((value) => value === 0 || value === 1) ||
      !Number.isSafeInteger(row.input_sequence) || row.input_sequence < 0 ||
      (row.input_sequence === 0 ? row.input_digest !== null || row.input_state !== null :
        !row.input_digest || !/^[0-9a-f]{64}$/.test(row.input_digest) || !["unknown", "queued", "written"].includes(row.input_state ?? "")) ||
      !["pending", "unknown", "removed"].includes(row.cleanup) || !["idle", "unknown", "applied"].includes(row.resize_state) ||
      (row.state === "exited" ? !Number.isInteger(row.exit_code) : row.exit_code !== null) ||
      (row.cleanup === "removed" && !finished(row))) throw new TerminalError(503, "terminal_receipt_invalid");
    return row;
  }

  function ownedRow(owner: Identity, id: string) {
    const row = readRow(id);
    if (!row || row.user_id !== owner.userId || row.token_hash !== owner.tokenHash || row.expires_at !== owner.expiresAt) {
      throw new TerminalError(404, "not_found");
    }
    workspace(owner, row.workspace_id, false);
    return checkedRow(row);
  }

  function update(context: TerminalContext, values: Partial<TerminalRow>) {
    const allowed = ["container_id", "state", "start_sent", "stop_sent", "remove_sent", "exit_code", "cleanup", "current_cols", "current_rows", "resize_state", "input_sequence", "input_digest", "input_state"];
    const keys = Object.keys(values) as (keyof TerminalRow)[];
    if (keys.some((key) => !allowed.includes(key))) throw new TerminalError(503, "terminal_receipt_invalid");
    database((db) => {
      const result = db.query(`UPDATE terminal_sessions SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE terminal_id = ?`)
        .run(...keys.map((key) => values[key]!), context.row.terminal_id);
      if (result.changes !== 1) throw new TerminalError(503, "terminal_receipt_unknown");
      const stored = db.query<TerminalRow, [string]>("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(context.row.terminal_id);
      if (!stored || keys.some((key) => stored[key] !== values[key])) throw new TerminalError(503, "terminal_receipt_unknown");
      context.row = checkedRow(stored);
    });
  }

  function makeContext(row: TerminalRow, launching = false) {
    for (const [id, context] of contexts) {
      if (contexts.size < maxRetained) break;
      if (finished(context.row) && !context.launching && !context.stop) { closeHandle(context); contexts.delete(id); }
    }
    if (contexts.size >= maxRetained) throw new TerminalError(503, "terminal_capacity");
    const context: TerminalContext = { row, closing: !launching, launching, allocationAttempted: !launching,
      output: Buffer.alloc(0), offset: 0, outputAvailable: launching, backpressured: false, inputPending: false,
      droppedBytes: 0, polledOffset: 0,
      readyBytes: Buffer.alloc(0), ready: false, watching: false };
    contexts.set(row.terminal_id, context);
    return context;
  }

  function guard(context: TerminalContext) {
    try {
      available();
      if (context.closing || shuttingDown) throw new TerminalError(409, "terminal_closing");
      const owner = ownerOf(context.row);
      assertSession(owner);
      workspace(owner, context.row.workspace_id);
      const witness = folder(owner, context.row.workspace_id);
      if (witness.device !== context.row.folder_device || witness.inode !== context.row.folder_inode) throw new TerminalError(409, "terminal_workspace_changed");
      const current = readRow(context.row.terminal_id);
      if (!current || current.token_hash !== context.row.token_hash || current.expires_at !== context.row.expires_at ||
        current.nonce !== context.row.nonce || current.container_id !== context.row.container_id ||
        current.state === "closing" || current.state === "unknown" || finished(current)) throw new TerminalError(409, "terminal_unavailable");
    } catch (error) { fenceFailure(context); throw error; }
  }

  function receipt(row: TerminalRow) {
    const context = contexts.get(row.terminal_id);
    return { terminalId: row.terminal_id, requestId: row.request_id, workspaceId: row.workspace_id,
      state: !context && !finished(row) ? "unknown" : row.state,
      cols: row.current_cols, rows: row.current_rows, initialCols: row.cols, initialRows: row.rows,
      exitCode: row.exit_code, cleanup: row.cleanup,
      resizeState: row.resize_state, inputSequence: row.input_sequence, inputState: row.input_state,
      flow: context ? { totalBytes: context.offset, retainedBytes: context.output.length,
        droppedBytes: context.droppedBytes, polledOffset: context.polledOffset } : undefined };
  }

  async function inspect(context: TerminalContext) {
    available();
    const result = await docker("GET", `${terminalPath(context.row)}/json`);
    if (result.status !== 200) throw new TerminalError(503, "terminal_engine_unknown");
    const actual = ownedContainer(result.value, context.row);
    if (!context.row.container_id) update(context, { container_id: actual.id });
    return actual;
  }

  function closeHandle(context: TerminalContext) {
    if (context.watch) clearInterval(context.watch);
    if (context.expiry) clearTimeout(context.expiry);
    context.watch = undefined;
    context.expiry = undefined;
    context.rejectReady?.(new TerminalError(503, "terminal_not_ready"));
    context.socket?.destroy();
    context.socket = undefined;
  }

  function markClosing(context: TerminalContext) {
    context.closing = true;
    context.rejectReady?.(new TerminalError(409, "terminal_closing"));
    try { if (!finished(context.row)) update(context, { state: "closing" }); }
    catch { /* The in-memory fence still denies input if SQLite cannot record it. */ }
  }

  async function cleanup(context: TerminalContext) {
    try {
      available();
      if (!context.allocationAttempted) {
        update(context, { state: "not_started", cleanup: "removed" });
        closeHandle(context);
        return;
      }
      if (context.row.remove_sent === 1) {
        const absent = await docker("GET", `${terminalPath(context.row)}/json`);
        if (absent.status === 404 && finished(context.row)) {
          update(context, { cleanup: "removed" });
          closeHandle(context);
          return;
        }
        throw new TerminalError(503, "terminal_cleanup_unknown");
      }
      let actual = await inspect(context);
      if (actual.running) {
        if (context.row.stop_sent === 0) {
          update(context, { stop_sent: 1 });
          // A stop with a lost response is never sent again. Inspect resolves its effect.
          try { await docker("POST", `${terminalPath(context.row)}/stop?t=1`); } catch { /* Readback, not response, decides exit. */ }
        }
        actual = await inspect(context);
      }
      if (actual.running || (actual.status !== "exited" && !(actual.status === "created" && context.row.start_sent === 0))) {
        throw new TerminalError(503, "terminal_exit_unknown");
      }
      update(context, { state: actual.status === "exited" ? "exited" : "not_started",
        exit_code: actual.status === "exited" ? actual.exitCode : null });
      const verified = await inspect(context);
      if (verified.running || verified.status !== actual.status || verified.exitCode !== actual.exitCode) throw new TerminalError(503, "terminal_exit_unknown");
      update(context, { remove_sent: 1 });
      const removed = await docker("DELETE", `${terminalPath(context.row)}?force=0&v=0`);
      if (removed.status !== 204) throw new TerminalError(503, "terminal_cleanup_unknown");
      const absent = await docker("GET", `${terminalPath(context.row)}/json`);
      if (absent.status !== 404) throw new TerminalError(503, "terminal_cleanup_unknown");
      update(context, { cleanup: "removed" });
      closeHandle(context);
    } catch {
      try { update(context, { ...(finished(context.row) ? {} : { state: "unknown" }), cleanup: "unknown" }); } catch { /* Keep CID and ownership in memory. */ }
      // Keep draining uncertain live contexts; a stream close is not process exit.
    }
  }

  function stopContext(context: TerminalContext): Promise<void> {
    markClosing(context);
    if (context.stop) return context.stop;
    const run = async () => {
      if (context.launching && context.launch) { try { await context.launch; } catch { /* Cleanup owns the same reservation. */ } }
      if (context.row.cleanup !== "removed") await cleanup(context);
    };
    context.stop = run().finally(() => { context.stop = undefined; });
    return context.stop;
  }

  function fenceFailure(context: TerminalContext) {
    markClosing(context);
    void stopContext(context);
  }

  function receive(context: TerminalContext, bytes: Buffer) {
    try {
      appendOutput(context, bytes);
      if (!context.ready && !context.closing) {
        context.readyBytes = Buffer.concat([context.readyBytes, bytes.subarray(0, 4097 - context.readyBytes.length)]);
        const expected = Buffer.from(`\x1eREMOTECODE:${context.row.nonce}:65534:65534:${context.row.folder_device}:${context.row.folder_inode}\x1f`);
        if (context.readyBytes.includes(expected)) {
          context.ready = true;
          context.readyBytes = Buffer.alloc(0);
          context.resolveReady?.();
        } else if (context.readyBytes.length > 4096) {
          context.rejectReady?.(new TerminalError(503, "terminal_bootstrap_invalid"));
          fenceFailure(context);
        }
      }
    } catch { fenceFailure(context); }
  }

  function scheduleExpiry(context: TerminalContext) {
    const remaining = context.row.expires_at - Date.now();
    if (remaining <= 0) { fenceFailure(context); return; }
    context.expiry = setTimeout(() => scheduleExpiry(context), Math.min(remaining, 0x7fffffff));
  }

  function watch(context: TerminalContext) {
    scheduleExpiry(context);
    context.watch = setInterval(() => {
      if (context.watching || context.launching || finished(context.row)) return;
      context.watching = true;
      void (async () => {
        try {
          if (!context.closing) guard(context);
          if (context.closing) { await stopContext(context); return; }
          const actual = await inspect(context);
          if (!context.closing) guard(context);
          if (!actual.running) await stopContext(context);
        } catch { fenceFailure(context); }
        finally { context.watching = false; }
      })();
    }, 1000);
  }

  async function launch(context: TerminalContext) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      guard(context);
      const image = await docker("GET", `/images/${context.row.image}/json`);
      guard(context);
      const imageData = image.value as { Id?: string; Config?: { Env?: unknown; Volumes?: Record<string, unknown> } };
      if (image.status !== 200 || imageData?.Id !== context.row.image || !imageData.Config ||
        !publicImageEnvironment(imageData.Config.Env) || Object.keys(imageData.Config.Volumes ?? {}).length !== 0) {
        throw new TerminalError(503, "terminal_image_not_public");
      }
      guard(context);
      context.allocationAttempted = true;
      const created = await docker("POST", `/containers/create?name=${terminalName(context.row)}`, containerSpec(context.row));
      if (created.status !== 201) throw new TerminalError(503, "terminal_allocation_unknown");
      const cid = (created.value as { Id?: string })?.Id;
      if (!cid || !/^[0-9a-f]{64}$/.test(cid)) throw new TerminalError(503, "terminal_allocation_unknown");
      update(context, { container_id: cid });
      guard(context);
      const actual = await inspect(context);
      guard(context);
      if (actual.running || actual.status !== "created") throw new TerminalError(503, "terminal_initial_state_invalid");
      const ready = new Promise<void>((resolve, reject) => { context.resolveReady = resolve; context.rejectReady = reject; });
      // Attach and readiness can fail while start is pending; always observe rejection.
      void ready.catch(() => {});
      timer = setTimeout(() => context.rejectReady?.(new TerminalError(503, "terminal_ready_unknown")), readyDeadlineMs);
      guard(context);
      await attach(context.row, (socket, head) => {
        guard(context);
        context.socket = socket;
        socket.on("data", (bytes: Buffer) => receive(context, bytes));
        socket.on("drain", () => { context.backpressured = false; });
        socket.on("error", () => { context.rejectReady?.(new TerminalError(503, "terminal_stream_unknown")); fenceFailure(context); });
        socket.on("close", () => { context.rejectReady?.(new TerminalError(503, "terminal_stream_unknown")); fenceFailure(context); });
        if (head.length) receive(context, head);
      });
      guard(context);
      const beforeStart = await inspect(context);
      guard(context);
      if (beforeStart.running || beforeStart.status !== "created") throw new TerminalError(503, "terminal_initial_state_invalid");
      update(context, { state: "starting", start_sent: 1 });
      guard(context);
      const started = await docker("POST", `${terminalPath(context.row)}/start`);
      guard(context);
      if (started.status !== 204) throw new TerminalError(503, "terminal_start_unknown");
      await ready;
      guard(context);
      const running = await inspect(context);
      guard(context);
      if (!running.running || !context.ready || context.socket?.destroyed) throw new TerminalError(503, "terminal_ready_unknown");
      update(context, { state: "running" });
      guard(context);
    } catch (error) {
      markClosing(context);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      context.resolveReady = undefined;
      context.rejectReady = undefined;
      context.launching = false;
    }
  }

  function routeError(error: unknown, set: { status?: number | string }) {
    set.status = error instanceof TerminalError ? error.status : 503;
    return { error: error instanceof TerminalError ? error.message : "terminal_storage_unavailable" };
  }

  async function refreshed(owner: Identity, id: string) {
    const row = ownedRow(owner, id);
    const context = contexts.get(id);
    if (context && !finished(context.row)) {
      try {
        if (!context.closing) guard(context);
        if (!context.launching && !context.closing) {
          const actual = await inspect(context);
          assertSession(owner);
          if (!context.closing) guard(context);
          if (!actual.running) await stopContext(context);
        }
      } catch (error) {
        fenceFailure(context);
        if (error instanceof TerminalError && error.status === 401) throw error;
      }
    }
    assertSession(owner);
    return ownedRow(owner, id);
  }

  function liveContext(owner: Identity, id: string) {
    const row = ownedRow(owner, id);
    const context = contexts.get(id);
    if (!context || !context.socket || context.socket.destroyed || !context.ready || row.state !== "running") {
      throw new TerminalError(409, "terminal_unavailable");
    }
    try { guard(context); } catch (error) { fenceFailure(context); throw error; }
    return context;
  }

  const routes = new Elysia()
    .onBeforeHandle(({ set }) => { set.headers["cache-control"] = "no-store"; })
    .onError(({ code, set }) => {
      if (code === "VALIDATION") { set.status = 422; return { error: "invalid_terminal_request" }; }
    })
    .get("/api/workspaces/:workspaceId/terminals", ({ request, params, set }) => {
      try {
        const owner = identity(request);
        workspace(owner, params.workspaceId, false);
        available();
        const rows = database((db) => db.query<TerminalRow, [string, string, number, string]>(
          `SELECT * FROM terminal_sessions WHERE user_id = ? AND token_hash = ? AND expires_at = ? AND workspace_id = ?
           ORDER BY rowid DESC LIMIT 32`,
        ).all(owner.userId, owner.tokenHash, owner.expiresAt, params.workspaceId));
        assertSession(owner);
        return { terminals: rows.map((row) => receipt(checkedRow(row))) };
      } catch (error) { return routeError(error, set); }
    }, { params: t.Object({ workspaceId: uuidSchema }) })
    .post("/api/workspaces/:workspaceId/terminals", async ({ request, params, body, set }) => {
      let context: TerminalContext | undefined;
      try {
        const owner = identity(request);
        workspace(owner, params.workspaceId, false);
        available();
        const existing = database((db) => db.query<TerminalRow, [string, string]>(
          "SELECT * FROM terminal_sessions WHERE user_id = ? AND request_id = ?",
        ).get(owner.userId, body.requestId));
        if (existing) {
          if (existing.token_hash !== owner.tokenHash || existing.expires_at !== owner.expiresAt || existing.workspace_id !== params.workspaceId) {
            throw new TerminalError(404, "not_found");
          }
          if (existing.cols !== body.cols || existing.rows !== body.rows) throw new TerminalError(409, "request_id_conflict");
          const row = await refreshed(owner, existing.terminal_id);
          return receipt(row);
        }
        if (shuttingDown) throw new TerminalError(503, "terminals_closing");
        workspace(owner, params.workspaceId);
        const witness = folder(owner, params.workspaceId);
        const terminalId = randomUUID();
        const nonce = randomBytes(32).toString("hex");
        const reserved = database((db) => db.transaction(() => {
          assertSession(owner);
          workspace(owner, params.workspaceId);
          const current = folder(owner, params.workspaceId);
          if (current.device !== witness.device || current.inode !== witness.inode) throw new TerminalError(409, "terminal_workspace_changed");
          const count = db.query<{ count: number }, []>(
            "SELECT count(*) AS count FROM terminal_sessions WHERE cleanup != 'removed'",
          ).get()!.count;
          if (count >= maxActive) throw new TerminalError(503, "terminal_capacity");
          db.query(`INSERT INTO terminal_sessions
            (terminal_id,user_id,token_hash,expires_at,request_id,workspace_id,cols,rows,volume_name,image,nonce,
             folder_device,folder_inode,state,current_cols,current_rows)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(terminalId, owner.userId, owner.tokenHash, owner.expiresAt,
            body.requestId, params.workspaceId, body.cols, body.rows, cfg!.volumeName, cfg!.image, nonce, witness.device, witness.inode, body.cols, body.rows);
          return db.query<TerminalRow, [string]>("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(terminalId)!;
        }).immediate());
        context = makeContext(checkedRow(reserved), true);
        watch(context);
        context.launch = launch(context);
        await context.launch;
        guard(context);
        set.status = 201;
        return receipt(context.row);
      } catch (error) {
        if (context) {
          markClosing(context);
          await stopContext(context);
          const result = routeError(error, set);
          if (error instanceof TerminalError && (error.status === 401 || error.status === 404)) return result;
          return { ...result, receipt: receipt(context.row) };
        }
        return routeError(error, set);
      }
    }, { params: t.Object({ workspaceId: uuidSchema }), body: t.Object({ requestId: uuidSchema, ...dimensionsSchema.properties }) })
    .get("/api/workspaces/:workspaceId/terminals/receipts/:requestId", async ({ request, params, set }) => {
      try {
        const owner = identity(request);
        workspace(owner, params.workspaceId, false);
        available();
        const row = database((db) => db.query<TerminalRow, [string, string, number, string, string]>(
          "SELECT * FROM terminal_sessions WHERE user_id = ? AND token_hash = ? AND expires_at = ? AND workspace_id = ? AND request_id = ?",
        ).get(owner.userId, owner.tokenHash, owner.expiresAt, params.workspaceId, params.requestId));
        if (!row) throw new TerminalError(404, "not_found");
        return receipt(await refreshed(owner, row.terminal_id));
      } catch (error) { return routeError(error, set); }
    }, { params: t.Object({ workspaceId: uuidSchema, requestId: uuidSchema }) })
    .get("/api/terminals/:terminalId", async ({ request, params, query, set }) => {
      try {
        const owner = identity(request);
        ownedRow(owner, params.terminalId);
        available();
        const row = await refreshed(owner, params.terminalId);
        const offset = query.offset === undefined ? 0 : Number(query.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TerminalError(422, "invalid_terminal_offset");
        const context = contexts.get(params.terminalId);
        assertSession(owner);
        return context?.outputAvailable ? { ...receipt(row), ...outputSnapshot(context, offset) } :
          { ...receipt(row), outputAvailable: false, gap: true };
      } catch (error) { return routeError(error, set); }
    }, { params: t.Object({ terminalId: uuidSchema }), query: t.Object({ offset: t.Optional(t.String({ pattern: "^(0|[1-9][0-9]{0,15})$", maxLength: 16 })) }) })
    .post("/api/terminals/:terminalId/input", ({ request, params, body, set }) => {
      let context: TerminalContext | undefined;
      try {
        const owner = identity(request);
        const row = ownedRow(owner, params.terminalId);
        available();
        const bytes = inputBytes(body.text);
        // A process-local key avoids persisting a reusable password fingerprint.
        const digest = createHmac("sha256", inputKey).update(bytes).digest("hex");
        if (row.input_sequence > 0 && !contexts.get(row.terminal_id)?.ready) throw new TerminalError(409, "terminal_input_unknown");
        if (body.sequence === row.input_sequence && row.input_digest === digest) {
          assertSession(owner);
          return { terminalId: row.terminal_id, sequence: row.input_sequence, state: row.input_state };
        }
        if (body.sequence !== row.input_sequence + 1) throw new TerminalError(409, "terminal_input_sequence_conflict");
        context = liveContext(owner, params.terminalId);
        if (context.backpressured || context.inputPending || row.input_state === "unknown") throw new TerminalError(409, "terminal_input_pending");
        guard(context);
        update(context, { input_sequence: body.sequence, input_digest: digest, input_state: "unknown" });
        guard(context);
        context.inputPending = true;
        const target = context;
        // false means buffered/queued, never unsent. No automatic replay.
        const writable = target.socket!.write(bytes, (error?: Error | null) => {
          target.inputPending = false;
          if (error) {
            try { update(target, { input_state: "unknown" }); } catch { /* The original sequence remains reserved. */ }
            fenceFailure(target);
            return;
          }
          try {
            if (target.row.input_sequence === body.sequence && target.row.input_digest === digest) update(target, { input_state: "written" });
          } catch { fenceFailure(target); }
        });
        target.backpressured = !writable;
        if (target.inputPending) update(target, { input_state: "queued" });
        assertSession(owner);
        return { terminalId: target.row.terminal_id, sequence: body.sequence, state: "queued" };
      } catch (error) {
        if (context && (!(error instanceof TerminalError) || error.status >= 500 || error.status === 401)) fenceFailure(context);
        return routeError(error, set);
      }
    }, { params: t.Object({ terminalId: uuidSchema }), body: t.Object({ sequence: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), text: t.String({ minLength: 1, maxLength: inputLimit }) }) })
    .post("/api/terminals/:terminalId/resize", async ({ request, params, body, set }) => {
      let context: TerminalContext | undefined;
      try {
        const owner = identity(request);
        ownedRow(owner, params.terminalId);
        available();
        context = liveContext(owner, params.terminalId);
        if (context.row.resize_state === "unknown") throw new TerminalError(409, "terminal_resize_unknown");
        const actual = await inspect(context);
        guard(context);
        if (!actual.running) { fenceFailure(context); throw new TerminalError(409, "terminal_not_running"); }
        if (context.row.resize_state === "unknown") throw new TerminalError(409, "terminal_resize_unknown");
        update(context, { resize_state: "unknown" });
        guard(context);
        const result = await docker("POST", `${terminalPath(context.row)}/resize?h=${body.rows}&w=${body.cols}`);
        guard(context);
        if (result.status !== 200) throw new TerminalError(503, "terminal_resize_unknown");
        update(context, { current_cols: body.cols, current_rows: body.rows, resize_state: "applied" });
        guard(context);
        return receipt(context.row);
      } catch (error) {
        if (context && (!(error instanceof TerminalError) || error.status !== 409)) fenceFailure(context);
        return routeError(error, set);
      }
    }, { params: t.Object({ terminalId: uuidSchema }), body: dimensionsSchema })
    .post("/api/terminals/:terminalId/stop", async ({ request, params, set }) => {
      try {
        const owner = identity(request);
        const row = ownedRow(owner, params.terminalId);
        available();
        const context = contexts.get(params.terminalId) ?? makeContext(row);
        await stopContext(context);
        assertSession(owner);
        const current = ownedRow(owner, params.terminalId);
        if (!finished(current) || current.cleanup !== "removed") set.status = 503;
        return receipt(current);
      } catch (error) { return routeError(error, set); }
    }, { params: t.Object({ terminalId: uuidSchema }) });

  function revokeSessions(userId: string, tokenHash?: string): void {
    const targets: TerminalContext[] = [];
    for (const context of contexts.values()) {
      if (context.row.user_id === userId && (tokenHash === undefined || context.row.token_hash === tokenHash) && context.row.cleanup !== "removed") {
        markClosing(context);
        targets.push(context);
      }
    }
    try {
      if (schemaReady) {
        const rows = database((db) => db.query<TerminalRow, [string]>(
          "SELECT * FROM terminal_sessions WHERE user_id = ? AND cleanup != 'removed'",
        ).all(userId));
        for (const row of rows) {
          if ((tokenHash !== undefined && row.token_hash !== tokenHash) || contexts.has(row.terminal_id)) continue;
          const context = makeContext(checkedRow(row));
          markClosing(context);
          targets.push(context);
        }
      }
    } catch { /* Existing contexts stay synchronously fenced; durable unknowns never respawn. */ }
    for (const context of targets) void stopContext(context);
  }

  async function stopAll(): Promise<void> {
    shuttingDown = true;
    const targets = [...contexts.values()];
    for (const context of targets) markClosing(context);
    if (schemaReady) {
      const rows = database((db) => db.query<TerminalRow, []>("SELECT * FROM terminal_sessions WHERE cleanup != 'removed'").all());
      for (const row of rows) {
        if (contexts.has(row.terminal_id)) continue;
        const context = makeContext(checkedRow(row));
        markClosing(context);
        targets.push(context);
      }
    }
    await Promise.all(targets.map(stopContext));
    if (targets.some((context) => !finished(context.row) || context.row.cleanup !== "removed")) {
      throw new TerminalError(503, "terminal_shutdown_unknown");
    }
  }

  if (schemaReady) {
    try {
      const rows = database((db) => db.query<TerminalRow, []>("SELECT * FROM terminal_sessions WHERE cleanup != 'removed'").all());
      for (const row of rows) watch(makeContext(checkedRow(row)));
    } catch { schemaReady = false; }
  }

  return { routes, workspaceIdentity: cfg && schemaReady && hostReady() ? actor : undefined, revokeSessions, stopAll };
}

// Runnable local invariant check; no engine, service or process allocation.
if (import.meta.main) {
  const context = { output: Buffer.alloc(0), offset: 0, droppedBytes: 0, polledOffset: 0 } as TerminalContext;
  appendOutput(context, Buffer.alloc(outputLimit + 17, 0x61));
  appendOutput(context, Buffer.from("end"));
  const snapshot = outputSnapshot(context, 0);
  if (context.output.length !== outputLimit || snapshot.baseOffset !== 20 || !snapshot.gap ||
    snapshot.nextOffset - snapshot.offset !== pollLimit || Buffer.from(snapshot.outputBase64, "base64").length !== pollLimit ||
    context.offset !== outputLimit + 20 || context.output.subarray(-3).toString("utf8") !== "end" ||
    snapshot.retainedBytes !== outputLimit || snapshot.totalBytes !== outputLimit + 20 ||
    snapshot.droppedBytes !== 20 || context.polledOffset !== snapshot.nextOffset) throw new Error("terminal_ring_check_failed");
  for (const text of ["", "a".repeat(inputLimit + 1), "\ud800", "é".repeat(inputLimit / 2 + 1)]) {
    let rejected = false;
    try { inputBytes(text); } catch { rejected = true; }
    if (!rejected) throw new Error("terminal_input_check_failed");
  }
  if (inputBytes("é".repeat(inputLimit / 2)).length !== inputLimit || validConfig({ volumeName: "../host", image: `sha256:${"0".repeat(64)}` })) {
    throw new Error("terminal_boundary_check_failed");
  }
  if (!publicImageEnvironment(terminalEnv.filter((entry) => !entry.startsWith("TERM="))) ||
    [[], [terminalEnv[0], terminalEnv[0]], ["PATH=/private"], [terminalEnv[0], "BACKEND_SECRET=private"]].some(publicImageEnvironment)) {
    throw new Error("terminal_public_image_check_failed");
  }
  const row = { terminal_id: randomUUID(), workspace_id: randomUUID(), cols: 80, rows: 24,
    volume_name: "terminal-check", image: `sha256:${"0".repeat(64)}`, nonce: "1".repeat(64),
    folder_device: "1", folder_inode: "2", container_id: null } as TerminalRow;
  const spec = containerSpec(row);
  if (spec.Env.length !== 4 || !spec.Env.includes("BUN_RUNTIME_TRANSPILER_CACHE_PATH=0") ||
    !spec.Env.includes("BUN_INSTALL_BIN=/usr/local/bin")) throw new Error("terminal_public_env_check_failed");
  const inspection = { Id: "2".repeat(64), Name: `/${terminalName(row)}`, Image: row.image,
    Config: { ...spec, Env: [...terminalEnv].reverse(), Labels: { "remotecode.nonce": row.nonce, "remotecode.terminal": row.terminal_id } },
    HostConfig: spec.HostConfig,
    Mounts: [{ Type: "volume", Name: row.volume_name, Destination: "/workspace", RW: true }],
    State: { Running: false, Status: "created", ExitCode: 0 } };
  ownedContainer(inspection, row);
  for (const changed of [
    { ...inspection, Config: { ...inspection.Config, User: "0:0" } },
    { ...inspection, Config: { ...inspection.Config, Env: [...terminalEnv, "BACKEND_SECRET=denied"] } },
    { ...inspection, Config: { ...inspection.Config, Env: [...terminalEnv.slice(0, 3), "BACKEND_SECRET=denied"] } },
    { ...inspection, Config: { ...inspection.Config, Env: [...terminalEnv.slice(0, 3), "BUN_INSTALL_BIN=/private"] } },
    { ...inspection, HostConfig: { ...inspection.HostConfig, NetworkMode: "host" } },
    { ...inspection, HostConfig: { ...inspection.HostConfig, CapDrop: [] } },
    { ...inspection, HostConfig: { ...inspection.HostConfig, Mounts: [{ ...spec.HostConfig.Mounts[0],
      VolumeOptions: { NoCopy: true, Subpath: "workspaces/foreign" } }] } },
  ]) {
    let rejected = false;
    try { ownedContainer(changed, row); } catch { rejected = true; }
    if (!rejected) throw new Error("terminal_isolation_check_failed");
  }
  console.log("Terminal ring, UTF-8 byte limit, configuration and isolation readback checks passed.");
}
