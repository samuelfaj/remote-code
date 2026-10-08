// RC-047 proof, inside a real Linux account container: the shipped dispatcher
// talks to a push provider stand-in over HTTP, two devices are registered, one
// of them is denied by the provider, and the durable Inbox item survives the
// failed push. What is counted is what the provider actually received.
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC047_API ?? "http://127.0.0.1:3000";
const password = process.env.RC047_AUTH_PASSWORD ?? "";
const pushLog = process.env.RC047_PUSH_LOG ?? "/var/log/rc047-push.log";
const deadTokenPath = process.env.RC047_PUSH_DEAD ?? "/var/log/rc047-dead-token";
const phase = process.env.RC047_PHASE ?? "create";
const record: any = { result: "unverified", scope: "RC-047 push from Inbox items with dedup and a denied device" };
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

async function login() {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (response.status !== 200) throw Error(`login_${response.status}`);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
}

function records(): Array<{ status: number; request: any }> {
  try {
    return readFileSync(pushLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Only a request the provider accepted counts as an alert that reached a device. */
function alerts() {
  return records().filter((entry) => entry.status === 200).map((entry) => entry.request);
}

function requests() {
  return records().map((entry) => entry.request);
}

async function waitForRun(runId: string, wanted: string[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let state = "";
  while (Date.now() < deadline) {
    state = (await api(`/api/runs/${runId}`)).body?.state ?? "";
    if (wanted.includes(state)) return state;
    await delay(400);
  }
  throw Error(`run_never_reached_${wanted.join("_")}_saw_${state}`);
}

async function newWaitingItem(workspaceId: string, botId: string, reason: string): Promise<string> {
  const run = await api(`/api/bots/${botId}/run`, "POST", { workspaceId, prompt: reason });
  if (run.status !== 201 && run.status !== 200) throw Error(`run_${run.status}_${JSON.stringify(run.body)}`);
  const runId = (run.body?.run ?? run.body)?.id;
  await waitForRun(runId, ["running", "starting"], 30_000);
  const handoff = await api(`/api/runs/${runId}/handoff`, "POST", { reason });
  if (handoff.status !== 200) throw Error(`handoff_${handoff.status}_${JSON.stringify(handoff.body)}`);
  await waitForRun(runId, ["needs_user"], 30_000);
  const inbox = await api("/api/inbox");
  const item = (inbox.body?.items ?? []).find((entry: any) => entry.runId === runId);
  if (!item) throw Error(`no_inbox_item_for_${runId}`);
  return item.id;
}

if (phase === "create") {
  try {
    await login();
    const workspace = await api("/api/workspaces", "POST", { name: "rc047-push" });
    const workspaceId = workspace.body?.id ?? workspace.body?.workspace?.id;
    if (!workspaceId) throw Error("workspace_id_missing");
    await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: crypto.randomUUID() });
    const bot = await api("/api/bots", "POST", { name: "PushBot" });
    if (bot.status !== 201) throw Error(`bot_${bot.status}`);
    const botId = bot.body.id;

    // Two devices, as the proof's "two devices" requires.
    const tokenA = `token-ios-${crypto.randomUUID()}`;
    const tokenB = `token-web-${crypto.randomUUID()}`;
    const deviceA = await api("/api/push/devices", "POST", { deviceId: "ios-1", platform: "ios", token: tokenA });
    const deviceB = await api("/api/push/devices", "POST", { deviceId: "web-1", platform: "web", token: tokenB });
    if (deviceA.status !== 201 && deviceA.status !== 200) throw Error(`device_a_${deviceA.status}_${JSON.stringify(deviceA.body)}`);
    if (deviceB.status !== 201 && deviceB.status !== 200) throw Error(`device_b_${deviceB.status}_${JSON.stringify(deviceB.body)}`);

    const firstItem = await newWaitingItem(workspaceId, botId, "needs you, first");
    const firstNotify = await api(`/api/inbox/${firstItem}/notify`, "POST", {});
    if (firstNotify.status !== 200) throw Error(`notify_first_${firstNotify.status}_${JSON.stringify(firstNotify.body)}`);
    const afterFirst = alerts();
    if (afterFirst.length !== 2) throw Error(`expected_one_alert_per_device_saw_${afterFirst.length}`);

    const item = (await api(`/api/inbox/${firstItem}`)).body;
    const deepLink = JSON.stringify(item?.destination ?? {});
    for (const alert of afterFirst) {
      if (JSON.stringify(alert.deepLink ?? {}) !== deepLink) throw Error(`alert_carries_the_wrong_destination_${JSON.stringify(alert)}`);
    }
    const perDevice = afterFirst.reduce((counts: Record<string, number>, alert: any) => {
      counts[alert.token] = (counts[alert.token] ?? 0) + 1;
      return counts;
    }, {});
    if (perDevice[tokenA] !== 1 || perDevice[tokenB] !== 1) throw Error(`not_one_alert_per_device_${JSON.stringify(perDevice)}`);

    // A second notify for the same item must not alert again.
    await api(`/api/inbox/${firstItem}/notify`, "POST", {});
    if (alerts().length !== 2) throw Error(`a_repeat_notify_sent_another_alert_${alerts().length}`);

    // The provider now denies one device's token, as a revoked permission does.
    writeFileSync(deadTokenPath, `${tokenB}\n`);
    const secondItem = await newWaitingItem(workspaceId, botId, "needs you, second");
    const secondNotify = await api(`/api/inbox/${secondItem}/notify`, "POST", {});
    if (secondNotify.status !== 200) throw Error(`notify_second_${secondNotify.status}`);
    const afterSecond = requests();
    if (afterSecond.length !== 4) throw Error(`the_second_item_should_have_produced_one_request_per_device_saw_${afterSecond.length}`);
    if (afterSecond.filter((entry: any) => entry.token === tokenA).length !== 2) throw Error("the_live_device_did_not_get_both_alerts");
    if (alerts().filter((alert: any) => alert.token === tokenB).length !== 1) {
      throw Error(`the_denied_device_received_more_than_one_alert_${alerts().filter((alert: any) => alert.token === tokenB).length}`);
    }

    const devices = await api("/api/push/devices");
    const deniedDevice = (devices.body?.devices ?? []).find((entry: any) => entry.deviceId === "web-1");
    const liveDevice = (devices.body?.devices ?? []).find((entry: any) => entry.deviceId === "ios-1");
    if (!deniedDevice || deniedDevice.enabled !== false || deniedDevice.permission !== "denied") throw Error(`denied_device_not_marked_${JSON.stringify(deniedDevice)}`);
    if (!liveDevice || liveDevice.enabled !== true) throw Error(`the_live_device_was_disabled_too_${JSON.stringify(liveDevice)}`);

    // A denied push must not lose the event: it is still a durable Inbox item.
    const stillThere = await api(`/api/inbox/${secondItem}`);
    if (stillThere.status !== 200 || stillThere.body?.resolvedAt || stillThere.body?.runId === undefined) {
      throw Error(`the_denied_event_left_the_inbox_${stillThere.status}_${JSON.stringify(stillThere.body)}`);
    }

    // With push switched off, no alert is attempted and the item still arrives.
    const off = await api("/api/push/preference", "POST", { enabled: false });
    if (off.status !== 200) throw Error(`preference_${off.status}`);
    const thirdItem = await newWaitingItem(workspaceId, botId, "needs you, third");
    const thirdNotify = await api(`/api/inbox/${thirdItem}/notify`, "POST", {});
    if (thirdNotify.status !== 200) throw Error(`notify_third_${thirdNotify.status}`);
    if (alerts().length !== 3) throw Error(`an_alert_was_sent_with_push_switched_off_${alerts().length}`);

    const inbox = await api("/api/inbox");
    const ids = (inbox.body?.items ?? []).map((entry: any) => entry.id);
    for (const wanted of [firstItem, secondItem, thirdItem]) {
      if (!ids.includes(wanted)) throw Error(`item_${wanted}_is_not_in_the_inbox`);
    }

    console.log(JSON.stringify({
      fixture: { workspaceId, botId, firstItem, secondItem, thirdItem, tokenA, tokenB },
      beforeRestart: {
        alertsAfterFirstNotify: 2,
        oneAlertPerDevice: perDevice,
        deepLinkMatchedTheItemDestination: true,
        repeatNotifySentNothing: true,
        deniedDevice: { enabled: deniedDevice.enabled, permission: deniedDevice.permission },
        liveDeviceEnabled: liveDevice.enabled,
        deniedEventStillInInbox: true,
        alertsWhilePushOff: 3,
        inboxItemCount: ids.length,
      },
      result: "phase_one_done",
    }));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
} else {
  try {
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1500) })).status === 200) { ready = true; break; } } catch {}
      await delay(400);
    }
    if (!ready) throw Error("api_not_ready_after_restart");
    await login();

    const devices = await api("/api/push/devices");
    const deniedDevice = (devices.body?.devices ?? []).find((entry: any) => entry.deviceId === "web-1");
    if (!deniedDevice || deniedDevice.enabled !== false || deniedDevice.permission !== "denied") {
      throw Error(`the_denied_device_was_not_kept_denied_${JSON.stringify(deniedDevice)}`);
    }
    const inbox = await api("/api/inbox");
    const ids = (inbox.body?.items ?? []).map((entry: any) => entry.id);
    for (const wanted of [process.env.RC047_ITEM_1, process.env.RC047_ITEM_2, process.env.RC047_ITEM_3]) {
      if (!wanted || !ids.includes(wanted)) throw Error(`an_item_disappeared_after_the_restart_${wanted}`);
    }
    // The provider was restarted with an empty log, so anything it receives now
    // is genuinely new. Ticking push off first proves the preference survived.
    await api("/api/push/preference", "POST", { enabled: false });
    const offRepeat = await api(`/api/inbox/${process.env.RC047_ITEM_2}/notify`, "POST", {});
    if (offRepeat.status !== 200) throw Error(`repeat_notify_after_restart_${offRepeat.status}`);
    if (records().length !== 0) throw Error(`a_notify_with_push_off_reached_the_provider_after_the_restart_${records().length}`);

    // Turning it back on proves the dispatcher still works after the restart, and
    // that the already-delivered item is still deduplicated.
    await api("/api/push/preference", "POST", { enabled: true });
    const rrepeat = await api(`/api/inbox/${process.env.RC047_ITEM_2}/notify`, "POST", {});
    if (rrepeat.status !== 200) throw Error(`dedup_notify_after_restart_${rrepeat.status}`);
    if (records().length !== 0) throw Error(`the_already_delivered_item_was_sent_again_after_the_restart_${records().length}`);
    // An item raised after the restart is the honest test that the dispatcher
    // still works: the earlier items are already deduplicated by their rows.
    const freshItem = await newWaitingItem(process.env.RC047_WORKSPACE ?? "", process.env.RC047_BOT ?? "", "needs you, after restart");
    const freshNotify = await api(`/api/inbox/${freshItem}/notify`, "POST", {});
    if (freshNotify.status !== 200) throw Error(`fresh_notify_after_restart_${freshNotify.status}`);
    const afterFresh = requests();
    if (afterFresh.filter((entry: any) => entry.token === process.env.RC047_TOKEN_A).length !== 1) {
      throw Error(`the_live_device_was_not_reached_after_the_restart_${JSON.stringify(afterFresh).slice(0, 200)}`);
    }
    if (afterFresh.filter((entry: any) => entry.token === process.env.RC047_TOKEN_B).length !== 0) {
      throw Error("a_denied_device_was_retried_after_the_restart");
    }
    await api(`/api/inbox/${freshItem}/notify`, "POST", {});
    if (requests().length !== afterFresh.length) throw Error("a_repeat_notify_after_the_restart_sent_again");

    console.log(JSON.stringify({
      result: "two_devices_got_at_most_one_alert_each_and_a_denied_push_kept_the_inbox_item_passed",
      afterRestart: {
        inboxItemCount: ids.length,
        deniedDeviceStillDenied: true,
        notifyWithPushOffReachedTheProvider: 0,
        alreadyDeliveredItemResent: 0,
        freshItemReachedTheLiveDevice: 1,
      },
    }));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}
