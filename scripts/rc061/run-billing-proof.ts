// RC-061 proof: a subscription checkout enables hosting, a cancel keeps the
// account's data under a retention policy, and a provider that repeats,
// reorders or loses the response to its own webhooks never applies a second
// transition. The provider is a test plan: signed HTTP webhooks (there is no
// live payment-provider credential on this host), so the boundary under test is
// the real signed route, not a mocked function.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC061_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const record: any = { result: "unverified", scope: "RC-061 checkout, cancel, repeated and reversed webhooks, lost response" };
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const webhookSecret = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const retentionDays = 30;
const apiPort = 27_000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${apiPort}`;

let controlApi: ReturnType<typeof Bun.spawn> | undefined;

function sign(body: string) {
  return createHmac("sha256", webhookSecret).update(body).digest("hex");
}

async function deliver(event: Record<string, unknown>, options: { loseResponse?: boolean } = {}) {
  const body = JSON.stringify(event);
  if (options.loseResponse) {
    // The provider gave up on the response. The server still processes the
    // event; only the caller's knowledge is missing.
    const controller = new AbortController();
    const request = fetch(`${base}/api/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": sign(body) },
      body,
      signal: controller.signal,
    }).catch(() => null);
    controller.abort();
    await request;
    return { status: 0, body: null as any };
  }
  const response = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rc-signature": sign(body) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

try {
  controlApi = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: repo, stdout: "ignore", stderr: "ignore",
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      DATABASE_PATH: resolve(output, "billing.sqlite"),
      REMOTECODE_AUTH_PASSWORD: password,
      REMOTECODE_BILLING_WEBHOOK_SECRET: webhookSecret,
      REMOTECODE_BILLING_RETENTION_DAYS: String(retentionDays),
    },
  });
  const readyEnd = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < readyEnd) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).status === 200) { ready = true; break; } } catch {}
    await delay(300);
  }
  if (!ready) throw Error("api_never_became_ready");

  const loginResponse = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (loginResponse.status !== 200) throw Error(`login_${loginResponse.status}`);
  const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0];
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json() as any;
  const owner = typeof session?.userId === "string" ? session.userId : "";
  if (!owner) throw Error(`session_user_missing_${JSON.stringify(session)}`);

  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  // Data that a cancellation must not delete.
  const bot = await api("/api/bots", "POST", { name: "BillingRetention" });
  if (bot.status !== 201) throw Error(`bot_create_${bot.status}`);

  const subscription = async () => (await api("/api/billing/subscription")).body;
  const receipt = async (eventId: string) => (await api(`/api/billing/receipt/${eventId}`)).body;

  if ((await subscription()).state !== "inactive") throw Error("initial_state_not_inactive");

  // 1. Test checkout.
  const checkout = { eventId: randomUUID(), kind: "checkout.completed", sequence: 1, userId: owner, plan: "hosted-basic", hostedAccountId: randomUUID(), occurredAt: new Date().toISOString() };
  const checkoutResult = await deliver(checkout);
  if (checkoutResult.status !== 200 || checkoutResult.body?.applied !== true) throw Error(`checkout_${checkoutResult.status}_${JSON.stringify(checkoutResult.body)}`);
  const afterCheckout = await subscription();
  if (afterCheckout.state !== "active" || afterCheckout.plan !== "hosted-basic") throw Error(`checkout_state_${JSON.stringify(afterCheckout)}`);

  // 2. The provider repeats the same event (its own retry). One transition only.
  const repeat = await deliver(checkout);
  if (repeat.status !== 200 || repeat.body?.reason !== "duplicate") throw Error(`repeat_${repeat.status}_${JSON.stringify(repeat.body)}`);
  const afterRepeat = await subscription();
  if (afterRepeat.updatedAt !== afterCheckout.updatedAt || afterRepeat.lastEventSequence !== afterCheckout.lastEventSequence) {
    throw Error(`duplicate_changed_state_${JSON.stringify(afterRepeat)}`);
  }

  // 3. Cancel: hosting off, data kept under the retention policy.
  const cancel = { eventId: randomUUID(), kind: "subscription.canceled", sequence: 5, userId: owner, occurredAt: new Date().toISOString() };
  const cancelResult = await deliver(cancel);
  if (cancelResult.status !== 200 || cancelResult.body?.applied !== true) throw Error(`cancel_${cancelResult.status}_${JSON.stringify(cancelResult.body)}`);
  const afterCancel = await subscription();
  if (afterCancel.state !== "canceled") throw Error(`cancel_state_${afterCancel.state}`);
  if (!afterCancel.dataPurgeAfter || Date.parse(afterCancel.dataPurgeAfter) <= Date.now()) throw Error(`no_retention_window_${afterCancel.dataPurgeAfter}`);
  const retainedDays = (Date.parse(afterCancel.dataPurgeAfter) - Date.now()) / 86_400_000;
  if (retainedDays < retentionDays - 1 || retainedDays > retentionDays + 1) throw Error(`retention_window_${retainedDays.toFixed(2)}`);
  const botsAfterCancel = await api("/api/bots");
  if (!(botsAfterCancel.body?.bots ?? []).some((entry: any) => entry.name === "BillingRetention")) throw Error("cancellation_deleted_data");

  // 4. Reversed order: an older event must not move the state backwards.
  const stale = { eventId: randomUUID(), kind: "checkout.completed", sequence: 3, userId: owner, plan: "hosted-basic", occurredAt: new Date().toISOString() };
  const staleResult = await deliver(stale);
  if (staleResult.status !== 200 || staleResult.body?.reason !== "out_of_order") throw Error(`stale_${staleResult.status}_${JSON.stringify(staleResult.body)}`);
  const afterStale = await subscription();
  if (afterStale.state !== "canceled" || afterStale.lastEventSequence !== 5) throw Error(`stale_regressed_state_${JSON.stringify(afterStale)}`);

  // 5. Lost response: the caller never learns the outcome, so it asks the
  //    receipt instead of charging again.
  const recovered = { eventId: randomUUID(), kind: "checkout.completed", sequence: 9, userId: owner, plan: "hosted-pro", occurredAt: new Date().toISOString() };
  await deliver(recovered, { loseResponse: true });
  const recoveredReceipt = await receipt(recovered.eventId);
  if (recoveredReceipt?.found !== true) throw Error(`receipt_missing_${JSON.stringify(recoveredReceipt)}`);
  if (recoveredReceipt.applied !== true) throw Error(`receipt_not_applied_${JSON.stringify(recoveredReceipt)}`);
  const afterRecovery = await subscription();
  if (afterRecovery.state !== "active" || afterRecovery.lastEventSequence !== 9 || afterRecovery.plan !== "hosted-pro") {
    throw Error(`recovery_state_${JSON.stringify(afterRecovery)}`);
  }
  const replayAfterRecovery = await deliver(recovered);
  if (replayAfterRecovery.body?.reason !== "duplicate") throw Error(`replay_${JSON.stringify(replayAfterRecovery.body)}`);
  const stillActive = await subscription();
  if (stillActive.updatedAt !== afterRecovery.updatedAt || stillActive.lastEventSequence !== 9) throw Error(`replay_changed_state_${JSON.stringify(stillActive)}`);

  // 6. Signature is the only credential: no session, wrong signature -> 401.
  const unsigned = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...recovered, eventId: randomUUID() }),
  });
  const forged = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rc-signature": "0".repeat(64) },
    body: JSON.stringify({ ...recovered, eventId: randomUUID() }),
  });
  if (unsigned.status !== 401 || forged.status !== 401) throw Error(`signature_boundary_${unsigned.status}_${forged.status}`);

  // 7. Exactly one valid transition per confirmed event: three confirmed
  //    events applied, four others refused, and the sequence cursor is the
  //    highest applied one.
  const receipts = await Promise.all([receipt(checkout.eventId), receipt(cancel.eventId), receipt(stale.eventId), receipt(recovered.eventId)]);
  const appliedCount = receipts.filter((entry) => entry?.applied === true).length;
  if (appliedCount !== 3) throw Error(`applied_count_${appliedCount}`);
  const checkoutReceipt = await receipt(checkout.eventId);
  if (checkoutReceipt.applied !== true || checkoutReceipt.appliedAt === null) throw Error(`checkout_receipt_${JSON.stringify(checkoutReceipt)}`);
  const refusedReceipt = await receipt(stale.eventId);
  if (refusedReceipt.applied !== false || refusedReceipt.reason !== "out_of_order") throw Error(`refused_receipt_${JSON.stringify(refusedReceipt)}`);

  record.events = {
    checkout: { status: checkoutResult.status, applied: checkoutResult.body.applied },
    repeated: { status: repeat.status, reason: repeat.body.reason, stateUnchanged: true },
    canceled: { status: cancelResult.status, state: afterCancel.state, dataPurgeAfter: afterCancel.dataPurgeAfter, dataRetained: true },
    reversed: { status: staleResult.status, reason: staleResult.body.reason, state: afterStale.state, lastEventSequence: afterStale.lastEventSequence },
    lostResponse: { receiptFound: recoveredReceipt.found, receiptApplied: recoveredReceipt.applied, state: afterRecovery.state, plan: afterRecovery.plan, replayReason: replayAfterRecovery.body.reason },
    signatureBoundary: { unsigned: unsigned.status, forged: forged.status },
    appliedEvents: appliedCount,
    finalState: stillActive.state,
  };
  record.result = "checkout_cancel_repeated_reversed_and_lost_webhooks_applied_one_transition_each_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  try { controlApi?.kill(); } catch {}
  try { await controlApi?.exited; } catch {}
}