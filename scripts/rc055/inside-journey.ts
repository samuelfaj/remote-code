// RC-055 proof, inside a real Linux account container: a task is sent as a run,
// the run's own Inbox destination is pushed through the shipped dispatcher to a
// provider stand-in, and the payload the provider actually received is fed to
// the shipped mobile router. What is asserted is where the mobile app would land
// — the thread that records the run, and not the other thread in the same
// workspace.
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { listThreadMessages, listThreads } from "../../packages/client/src/messages";
import { mapNotificationToDestination } from "../../apps/mobile/src/navigation/notification-routing";

const base = process.env.RC055_API ?? "http://127.0.0.1:3000";
const password = process.env.RC055_AUTH_PASSWORD ?? "";
const pushLog = process.env.RC055_PUSH_LOG ?? "/var/log/rc055-push.log";
const recordPath = process.env.RC055_RECORD ?? "/var/log/rc055-record.json";
const record: Record<string, unknown> = { result: "unverified", scope: "RC-055 the push for a run returns to the thread that records it" };
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

function finish(result: string, detail: Record<string, unknown>) {
  record.result = result;
  Object.assign(record, detail);
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
  process.exit(result === "verified" ? 0 : 1);
}

async function fail(step: string, detail: Record<string, unknown> = {}) {
  finish("failed", { step, ...detail });
}

async function login() {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (response.status !== 200) throw Error(`login_${response.status}`);
  const header = response.headers.get("set-cookie");
  if (!header) throw Error("login_without_cookie");
  cookie = header.split(";")[0];
}

try {
  await login();

  const workspaceName = `RC055 routing ${crypto.randomUUID().slice(0, 8)}`;
  const created = await api("/api/workspaces", "POST", { name: workspaceName });
  if (created.status !== 201 && created.status !== 200) await fail("workspace_create", { status: created.status, body: created.body });
  const workspaceId = created.body.id as string;

  const withRun = await api(`/api/workspaces/${workspaceId}/threads`, "POST", { title: "Thread that records the run" });
  if (withRun.status !== 201 && withRun.status !== 200) await fail("thread_create", { status: withRun.status, body: withRun.body });
  const other = await api(`/api/workspaces/${workspaceId}/threads`, "POST", { title: "Thread without the run" });
  if (other.status !== 201 && other.status !== 200) await fail("other_thread_create", { status: other.status, body: other.body });

  const run = await api("/api/runs", "POST", { workspaceId, prompt: "RC055 routing proof" });
  if (run.status !== 201 && run.status !== 200) await fail("run_create", { status: run.status, body: run.body });
  const runId = run.body.id as string;

  let state = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const current = await api(`/api/runs/${runId}`);
    state = current.body?.state ?? "";
    if (["completed", "interrupted", "failed"].includes(state)) break;
    await delay(400);
  }
  if (!["completed", "interrupted", "failed"].includes(state)) await fail("run_never_settled", { state });
  record.run = { id: runId, state };

  const message = await api(`/api/threads/${withRun.body.id}/messages`, "POST", { body: "the run writes here", runId });
  if (message.status !== 201 && message.status !== 200) await fail("message_with_run", { status: message.status, body: message.body });

  // The run's own Inbox item is the thing a push stands for.
  let item: any = null;
  for (let attempt = 0; attempt < 60 && !item; attempt += 1) {
    const inbox = await api("/api/inbox");
    item = (inbox.body?.items ?? []).find((entry: any) => entry.runId === runId) ?? null;
    if (!item) await delay(400);
  }
  if (!item) await fail("no_inbox_item_for_run");
  record.inboxItem = { id: item.id, kind: item.kind, destination: item.destination };

  const device = await api("/api/push/devices", "POST", {
    deviceId: "rc055-proof-device", platform: "ios", token: "rc055-stand-in-token", permission: "granted",
  });
  if (device.status !== 201 && device.status !== 200) await fail("device_register", { status: device.status, body: device.body });

  const notified = await api(`/api/inbox/${item.id}/notify`, "POST");
  if (notified.status !== 200) await fail("notify", { status: notified.status, body: notified.body });

  let received: any = null;
  for (let attempt = 0; attempt < 60 && !received; attempt += 1) {
    const lines = readFileSync(pushLog, "utf8").split("\n").filter(Boolean);
    received = lines.map((line) => JSON.parse(line)).filter((entry) => entry.status === 200).at(-1) ?? null;
    if (!received) await delay(400);
  }
  if (!received) await fail("provider_received_nothing");
  const deepLink = received.request?.data?.deepLink ?? received.request?.deepLink ?? null;
  if (!deepLink) await fail("push_without_destination", { received: received.request });
  record.pushPayload = { deepLink, token: received.request?.token };

  const destination = mapNotificationToDestination(deepLink);
  record.routed = destination;
  if (!destination || destination.screen !== "Threads" || destination.params.focusRunId !== runId) {
    await fail("router_did_not_focus_the_run", { destination });
  }

  // What the app does next: find the thread whose messages record that run.
  const threads = await listThreads(workspaceId, base, { headers: { cookie } });
  if (threads.length !== 2) await fail("unexpected_thread_count", { threads: threads.map((thread) => thread.id) });
  const holders: string[] = [];
  for (const thread of threads) {
    const messages = await listThreadMessages(workspaceId, thread.id, base, { headers: { cookie } });
    if (messages.messages.some((entry) => entry.runId === runId)) holders.push(thread.id);
  }
  record.threadThatRecordsTheRun = holders;
  record.otherThread = other.body.id;
  if (holders.length !== 1 || holders[0] !== withRun.body.id) {
    await fail("not_exactly_the_thread_that_records_the_run", { holders, expected: withRun.body.id });
  }

  finish("verified", {
    workspaceId,
    threadId: withRun.body.id,
    checkedAt: new Date().toISOString(),
  });
} catch (error) {
  await fail("exception", { message: error instanceof Error ? error.message : String(error) });
}