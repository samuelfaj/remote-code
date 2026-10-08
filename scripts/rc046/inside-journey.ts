// RC-046 proof, inside a real Linux account container with a durable data root:
// a finished run and a run waiting for the human each land in the Inbox with
// their own Bot and run, survive a host restart, and a waiting item refuses to
// be resolved while the action it stands for has not happened.
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC046_API ?? "http://127.0.0.1:3000";
const password = process.env.RC046_AUTH_PASSWORD ?? "";
const phase = process.env.RC046_PHASE ?? "create";
const record: any = { result: "unverified", scope: "RC-046 durable Inbox across a restart" };
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

async function waitForRunState(runId: string, wanted: string[], timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let state = "";
  while (Date.now() < deadline) {
    state = (await api(`/api/runs/${runId}`)).body?.state ?? "";
    if (wanted.includes(state)) return state;
    await delay(500);
  }
  throw Error(`run_never_reached_${wanted.join("_")}_saw_${state}`);
}

async function session() {
  return (await api("/api/auth/session")).body ?? {};
}

if (phase === "create") {
  try {
    await login();
    const users = await session();
    if (typeof users.userId !== "string") throw Error("no_user_id");

    const made: Record<string, any> = {};
    for (const [key, name] of [["a", "InboxA"], ["b", "InboxB"]] as const) {
      const workspace = await api("/api/workspaces", "POST", { name: `rc046-${name}` });
      if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${key}_${workspace.status}`);
      const workspaceId = workspace.body?.id ?? workspace.body?.workspace?.id;
      const folder = await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: crypto.randomUUID() });
      if (folder.status !== 200) throw Error(`folder_${key}_${folder.status}_${JSON.stringify(folder.body)}`);
      const bot = await api("/api/bots", "POST", { name });
      if (bot.status !== 201) throw Error(`bot_${key}_${bot.status}_${JSON.stringify(bot.body)}`);
      made[key] = { workspaceId, botId: bot.body.id };
    }

    // Run A finishes, so its item stands for a completed result.
    const runA = await api("/api/bots/" + made.a.botId + "/run", "POST", { workspaceId: made.a.workspaceId, prompt: "finish and report" });
    if (runA.status !== 201 && runA.status !== 200) throw Error(`run_a_${runA.status}_${JSON.stringify(runA.body)}`);
    const runAId = (runA.body?.run ?? runA.body)?.id;
    const runAState = await waitForRunState(runAId, ["completed", "failed", "interrupted"]);

    // Run B is handed to the human, so its item stands for an action still owed.
    const runB = await api("/api/bots/" + made.b.botId + "/run", "POST", { workspaceId: made.b.workspaceId, prompt: "ask before continuing" });
    if (runB.status !== 201 && runB.status !== 200) throw Error(`run_b_${runB.status}`);
    const runBId = (runB.body?.run ?? runB.body)?.id;
    // Hand it over while it is still going: this is the real "Needs you" moment.
    await waitForRunState(runBId, ["running", "starting"], 30_000);
    const handoff = await api(`/api/runs/${runBId}/handoff`, "POST", { reason: "Waiting for the human to sign in" });
    if (handoff.status !== 200) throw Error(`handoff_${handoff.status}_${JSON.stringify(handoff.body)}`);
    const runBState = await waitForRunState(runBId, ["needs_user"], 30_000);

    const inbox = await api("/api/inbox");
    if (inbox.status !== 200) throw Error(`inbox_${inbox.status}`);
    const items = inbox.body?.items ?? [];
    const itemA = items.find((item: any) => item.runId === runAId);
    const itemB = items.find((item: any) => item.runId === runBId);
    if (!itemA || !itemB) throw Error(`inbox_missing_an_item_${JSON.stringify(items).slice(0, 300)}`);
    if (itemA.botId !== made.a.botId || itemB.botId !== made.b.botId) throw Error(`item_points_at_the_wrong_bot_${JSON.stringify([itemA, itemB]).slice(0, 300)}`);
    if (itemA.destination?.botId !== made.a.botId || itemB.destination?.botId !== made.b.botId) throw Error("destination_points_at_the_wrong_bot");
    if (itemB.kind !== "needs_you" || itemB.destination?.runId !== runBId) throw Error(`waiting_item_is_wrong_${JSON.stringify(itemB).slice(0, 200)}`);

    const readB = await api(`/api/inbox/${itemB.id}/read`, "POST", {});
    if (readB.status !== 200 || readB.body?.read !== true || readB.body?.resolvedAt) throw Error(`read_b_${readB.status}_${JSON.stringify(readB.body)}`);

    // The action is still owed, so this must refuse and leave the item unresolved.
    const resolveB = await api(`/api/inbox/${itemB.id}/resolve`, "POST", {});
    if (resolveB.status !== 409 || resolveB.body?.error !== "action_required") throw Error(`resolved_without_the_action_${resolveB.status}_${JSON.stringify(resolveB.body)}`);
    const afterRefusal = await api(`/api/inbox/${itemB.id}`);
    if (afterRefusal.body?.resolvedAt) throw Error("a refused resolve still marked the item resolved");

    const resolveA = await api(`/api/inbox/${itemA.id}/resolve`, "POST", {});
    if (resolveA.status !== 200 || !resolveA.body?.resolvedAt) throw Error(`resolve_a_${resolveA.status}_${JSON.stringify(resolveA.body)}`);
    const resolveAgain = await api(`/api/inbox/${itemA.id}/resolve`, "POST", {});
    if (resolveAgain.status !== 200 || !resolveAgain.body?.resolvedAt) throw Error(`resolve_a_not_idempotent_${resolveAgain.status}`);

    console.log(JSON.stringify({
      fixture: {
        itemA: itemA.id, runA: runAId, runAState,
        itemB: itemB.id, runB: runBId, runBState,
        botA: made.a.botId, botB: made.b.botId,
        workspaceA: made.a.workspaceId, workspaceB: made.b.workspaceId,
      },
      beforeRestart: {
        itemCount: items.length,
        itemAKind: itemA.kind, itemBKind: itemB.kind,
        destinationsCarryTheirOwnBot: true,
        readB: readB.body.read,
        resolveWhileOwed: { status: resolveB.status, error: resolveB.body.error },
        itemBStillUnresolved: true,
        itemAResolved: resolveA.body.resolvedAt !== null,
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

    const inbox = await api("/api/inbox");
    const items = inbox.body?.items ?? [];
    const itemA = items.find((item: any) => item.id === process.env.RC046_ITEM_A);
    const itemB = items.find((item: any) => item.id === process.env.RC046_ITEM_B);
    if (!itemA || !itemB) throw Error(`an_item_disappeared_after_the_restart_${JSON.stringify(items).slice(0, 300)}`);
    if (itemA.botId !== process.env.RC046_BOT_A || itemB.botId !== process.env.RC046_BOT_B) throw Error("an_item_points_at_the_wrong_bot_after_the_restart");
    if (itemB.destination?.botId !== process.env.RC046_BOT_B || itemB.destination?.runId !== process.env.RC046_RUN_B) throw Error("a_destination_changed_after_the_restart");
    if (!itemA.resolvedAt) throw Error("the resolved item lost its resolution across the restart");
    if (itemB.resolvedAt) throw Error("the waiting item became resolved across the restart");

    // Opening the waiting item leads to its own Bot and run, and the action is
    // still owed after the restart.
    const opened = await api(`/api/inbox/${itemB.id}`);
    if (opened.status !== 200) throw Error(`open_${opened.status}`);
    if (opened.body?.destination?.screen !== "run" || opened.body?.destination?.runId !== process.env.RC046_RUN_B) throw Error(`opens_the_wrong_screen_${JSON.stringify(opened.body?.destination)}`);
    const runAfterRestart = await api(`/api/runs/${process.env.RC046_RUN_B}`);
    if (runAfterRestart.body?.state !== "needs_user") throw Error(`run_state_changed_after_restart_${runAfterRestart.body?.state}`);
    const resolveStillRefused = await api(`/api/inbox/${itemB.id}/resolve`, "POST", {});
    if (resolveStillRefused.status !== 409 || resolveStillRefused.body?.error !== "action_required") {
      throw Error(`resolve_after_restart_${resolveStillRefused.status}_${JSON.stringify(resolveStillRefused.body)}`);
    }

    console.log(JSON.stringify({
      result: "inbox_item_type_bot_run_read_state_and_destination_survived_a_host_restart_and_a_waiting_item_refused_resolution_passed",
      afterRestart: {
        itemCount: items.length,
        itemAResolved: true,
        itemBWaiting: true,
        destination: opened.body.destination,
        runState: runAfterRestart.body.state,
        resolveStatus: resolveStillRefused.status,
        resolveError: resolveStillRefused.body?.error,
      },
    }));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}
