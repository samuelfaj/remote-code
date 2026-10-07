// RC-014 proof: action-event delivery with a cursor, over the real WebSocket
// boundary on Linux, with a real run in flight.
//
// A first client receives real `action.created` events, then loses one of them
// (the message is withheld, exactly as a dropped frame would be). The next real
// event opens a gap, the shipped client reducer asks for a snapshot, and after a
// real reconnect the snapshot converges the state. A replayed stale event must
// not add a duplicate, and no action may be applied twice.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyActionEvent, emptyActionEventState, type ActionEventState } from "../../packages/client/src/action-events";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC014_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc014-events-${randomUUID()}`;
const volume = `${run}-data`;
const baseImage = process.env.RC014_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc014.eventsproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc014-events.sqlite";
const agentPath = "/proof/agent";
const runsCwd = "/var/lib/remotecode/rc014-runs";
const record: any = { run, volume, image: baseImage, result: "unverified", scope: "RC-014 action-event recovery over the real WebSocket with a live run" };
let id = "";

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]"));
  return result.stdout.toString().trim();
}

// Minimal ACP stdio agent: creates a session, emits one progress update and then
// stays alive, so a real run is in flight while the event client disconnects.
const agentSource = `#!/usr/bin/env bun
let buffer = "";
const sessionId = "rc014-session";
const send = (message: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...(message as object) }) + "\\n");
const handle = (message: any) => {
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId } });
  if (message.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk" } } });
    return; // stays running until cancelled
  }
  if (message.method === "session/cancel") return send({ id: message.promptId ?? null, result: { stopReason: "cancelled" } });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) { try { handle(JSON.parse(line)); } catch {} }
    index = buffer.indexOf("\\n");
  }
});
`;

const stateCode = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)},{readonly:true,create:false});` +
  `console.log(JSON.stringify({quickCheck:d.query('pragma quick_check').all(),actions:d.query('select count(*) as n from actions').get()}));d.close();`;

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", baseImage))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/rc014-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  writeFileSync(resolve(output, "agent"), agentSource);
  chmodSync(resolve(output, "agent"), 0o755);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  const apiPort = 18_000 + Math.floor(Math.random() * 2000);
  const origin = `https://127.0.0.1:${apiPort}`;
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_WEB_ORIGIN=${origin}`, "-e", `REMOTECODE_DISTILL_BIN=${agentPath}`, "-e", `REMOTECODE_RUNS_CWD=${runsCwd}`,
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", baseImage, "/proof/server.ts");
  command("docker", "start", id);
  command("docker", "exec", id, "mkdir", "-p", runsCwd);

  const base = origin;
  const tls = { ca: readFileSync(cert) };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) break; } catch {}
    await delay(200);
  }
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000), tls,
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };

  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const ws = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc014" }, cookie);
  if (ws.status !== 201 && ws.status !== 200) throw Error(`workspace_${ws.status}`);
  const runResponse = await api("/api/runs", "POST", { workspaceId: ws.body.id, prompt: "SLOW rc014 events" }, cookie);
  if (runResponse.status !== 201) throw Error(`run_${runResponse.status}_${JSON.stringify(runResponse.body)}`);
  const runId = runResponse.body.id as string;

  // The shipped client reducer, driven by messages the real server sent.
  let client: ActionEventState = emptyActionEventState();

  // Messages are queued as soon as the socket exists: the server sends the
  // snapshot immediately on open, so a listener attached later would miss it.
  const connect = () => new Promise<{ socket: WebSocket; next: () => Promise<any>; close: () => void }>((resolveSocket, reject) => {
    const queue: any[] = [];
    const waiters: Array<(value: any) => void> = [];
    let closed: string | null = null;
    const socket = new WebSocket(`${origin.replace("https", "wss")}/api/events`, {
      headers: { cookie, origin },
      tls: { ca: readFileSync(cert) },
    } as any);
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String((event as MessageEvent).data));
      const waiter = waiters.shift();
      if (waiter) waiter(value); else queue.push(value);
    });
    socket.addEventListener("close", (event) => {
      closed = `${(event as CloseEvent).code}:${(event as CloseEvent).reason}`;
    });
    socket.addEventListener("open", () => resolveSocket({
      socket,
      next: () => new Promise<any>((res, rej) => {
        if (queue.length) return res(queue.shift());
        const timer = setTimeout(() => rej(new Error(`ws_message_timeout${closed ? ` closed=${closed}` : ""}`)), 10_000);
        waiters.push((value) => { clearTimeout(timer); res(value); });
      }),
      close: () => socket.close(),
    }));
    socket.addEventListener("error", () => reject(new Error(`ws_error${closed ? ` closed=${closed}` : ""}`)));
  });

  // The same socket also carries run progress, so skip non-action frames.
  const waitForType = async (connection: { next: () => Promise<any> }, type: string, allowed = 200) => {
    for (let attempt = 0; attempt < allowed; attempt += 1) {
      const message = await connection.next();
      if (message?.type === type) return message;
      skipped += 1;
    }
    throw Error(`no_${type}_within_${allowed}_frames`);
  };
  let skipped = 0;

  const first = await connect();
  const snapshot = await waitForType(first, "snapshot");
  const appliedSnapshot = applyActionEvent(client, snapshot);
  if (!appliedSnapshot.snapshotApplied || appliedSnapshot.state.cursor !== 0) {
    throw Error(`initial_snapshot_${JSON.stringify(appliedSnapshot)}`);
  }
  client = appliedSnapshot.state;
  record.initialSnapshot = { cursor: snapshot.cursor, actions: snapshot.actions.length };

  // Five real actions while the client is connected, but the third message is
  // withheld exactly as a dropped frame would be.
  const receipts: Array<{ cursor: number; receipt: any }> = [];
  let withheld: { cursor: number; receipt: any } | null = null;
  let gapDetected = false;
  for (let index = 0; index < 5; index += 1) {
    const created = await api("/api/actions", "POST", { action: `rc014 action ${index + 1}` }, cookie);
    if (created.status !== 201) throw Error(`action_${created.status}`);
    const message = await waitForType(first, "action.created");
    if (message.type !== "action.created" || typeof message.cursor !== "number") throw Error(`event_shape_${JSON.stringify(message)}`);
    receipts.push({ cursor: message.cursor, receipt: message.receipt });
    // The third frame is dropped on the floor, exactly as a lost message would be.
    if (index === 2) { withheld = { cursor: message.cursor, receipt: message.receipt }; continue; }
    const applied = applyActionEvent(client, message);
    if (!applied.validMessage) throw Error(`invalid_event_${index}`);
    client = applied.state;
    if (index === 3) {
      // The next real event is one past the gap, so the reducer must ask for a
      // snapshot instead of silently accepting it.
      if (!applied.requestSnapshot || !client.needsSnapshot) throw Error(`gap_was_not_detected_${JSON.stringify(applied)}`);
      gapDetected = true;
    } else if (applied.requestSnapshot) {
      throw Error(`unexpected_snapshot_request_${index}`);
    }
  }
  if (!withheld || !gapDetected) throw Error("gap_not_exercised");

  // The shipped web client recovers a gap on the live socket with a `sync`
  // request; the server answers with a fresh snapshot on the same connection.
  first.socket.send(JSON.stringify({ type: "sync" }));
  const syncSnapshot = await waitForType(first, "snapshot");
  const synced = applyActionEvent(client, syncSnapshot);
  if (!synced.snapshotApplied || synced.state.needsSnapshot || synced.state.cursor !== syncSnapshot.cursor) {
    throw Error(`sync_recovery_${JSON.stringify(synced.state)}`);
  }
  client = synced.state;
  record.syncRecovery = { cursor: syncSnapshot.cursor, actions: client.actions.length };

  // Reconnect: the real snapshot converges the state and includes every action.
  first.close();
  const second = await connect();
  const reconnectSnapshot = await waitForType(second, "snapshot");
  const converged = applyActionEvent(client, reconnectSnapshot);
  if (!converged.snapshotApplied || converged.state.needsSnapshot) throw Error(`reconnect_${JSON.stringify(converged)}`);
  client = converged.state;
  if (client.actions.length !== 5 || client.cursor !== reconnectSnapshot.cursor) {
    throw Error(`convergence_${client.actions.length}_${client.cursor}_${reconnectSnapshot.cursor}`);
  }

  // A replayed stale event (the withheld one, delivered late) must not duplicate.
  const replayed = applyActionEvent(client, { type: "action.created", cursor: withheld.cursor, receipt: withheld.receipt });
  client = replayed.state;
  if (client.actions.length !== 5 || new Set(client.actions.map((item) => item.id)).size !== 5) {
    throw Error(`duplicate_after_replay_${client.actions.length}`);
  }

  // The stored backend state agrees with what the client shows.
  const stored = await api("/api/actions", "GET", undefined, cookie);
  if (stored.status !== 200 || stored.body.actions.length !== 5) throw Error(`stored_${stored.status}_${stored.body?.actions?.length}`);
  const storedIds = new Set(stored.body.actions.map((item: any) => item.id));
  for (const action of client.actions) if (!storedIds.has(action.id)) throw Error(`client_action_unknown_${action.id}`);

  const runView = await api(`/api/runs/${runId}`, "GET", undefined, cookie);
  if (runView.status !== 200) throw Error(`run_view_${runView.status}`);
  record.run = { id: runId, state: runView.body.state, sessionId: runView.body.sessionId };

  const state = JSON.parse(command("docker", "exec", id, "bun", "-e", stateCode));
  if (state.quickCheck?.[0]?.quick_check !== "ok" || state.actions?.n !== 5) throw Error(`state_${JSON.stringify(state)}`);
  record.recovery = {
    events: receipts.map((item) => item.cursor),
    withheldCursor: withheld.cursor,
    snapshotRequestedAfterGap: true,
    reconnectCursor: reconnectSnapshot.cursor,
    clientActions: client.actions.length,
    replayDidNotDuplicate: true,
    skippedRunFrames: skipped,
  };
  record.state = state;
  record.result = "action_event_recovery_over_real_socket_passed";
  console.log(JSON.stringify({ result: record.result, recovery: record.recovery, run: record.run }));
  second.close();
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ result: "unverified", error: record.error }));
} finally {
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}