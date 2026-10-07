// RC-043 journey, executed inside the account container exactly where the real
// client sits: two clients take the screen in turn, the displaced one is told so
// explicitly, a dropped connection expires, and resumption takes a new epoch.
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC043_API ?? "http://127.0.0.1:3000";
const password = process.env.RC043_AUTH_PASSWORD ?? "";
const possessionMs = Number(process.env.RC043_POSSESSION_MS ?? "8000");
const display = process.env.DISPLAY ?? ":99";
const record: any = { result: "unverified", scope: "RC-043 two clients, expiry, disconnection, resumption" };
let cookie = "";

function local(...args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, DISPLAY: display } });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

async function api(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const type = response.headers.get("content-type") ?? "";
  const setCookie = response.headers.get("set-cookie") ?? "";
  if (type.includes("image/png")) {
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), type, body: null as any, setCookie };
  }
  return { status: response.status, bytes: null as Uint8Array | null, type, body: await response.json().catch(() => null) as any, setCookie };
}

export async function runInside() {
  try {
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (loginResponse.status !== 200) throw Error(`login_${loginResponse.status}`);
    cookie = loginResponse.headers.get("set-cookie")!.split(";")[0];

    const created = await api("/api/workspaces", "POST", { name: "rc043-possession" });
    if (created.status !== 201 && created.status !== 200) throw Error(`workspace_${created.status}_${JSON.stringify(created.body)}`);
    const workspaceId = created.body?.id ?? created.body?.workspace?.id;
    if (!workspaceId) throw Error(`workspace_id_missing_${JSON.stringify(created.body)}`);

    const screen = (suffix: string) => `/api/workspaces/${workspaceId}/screen/${suffix}`;
    const pointer = () => local("xdotool", "getmouselocation", "--shell").out;
    const possessionCookie = (response: { setCookie: string }) => {
      const value = response.setCookie.split("rc_screen_possession=")[1]?.split(";")[0];
      return value ? `rc_screen_possession=${value}` : "";
    };

    // Baseline: the Bot observes and acts.
    const observation0 = await api(screen("agent/observation"), "POST", { agentId: "distill-1" });
    if (observation0.status !== 200) throw Error(`observation0_${observation0.status}`);
    const baseline = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "key", key: "Shift" } });
    if (baseline.status !== 200) throw Error(`baseline_${baseline.status}`);

    // Client 1 takes the screen.
    const client1 = await api(screen("possession"), "POST", {});
    if (client1.status !== 200 || !client1.body?.token) throw Error(`client1_${client1.status}_${JSON.stringify(client1.body)}`);
    const token1 = client1.body.token;
    const cookie1 = possessionCookie(client1);
    if (!cookie1) throw Error("client1_has_no_possession_cookie");
    const frame1 = await api(screen("frame"), "GET", undefined, { "x-rc-possession": token1 });
    if (frame1.status !== 200) throw Error(`client1_frame_${frame1.status}`);

    // The Bot must not act while client 1 controls the screen.
    const beforePointer = pointer();
    const blocked1 = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "click", x: 300, y: 400 } });
    if (blocked1.status !== 409 || blocked1.body?.error !== "possession_held_by_user") throw Error(`bot_during_client1_${blocked1.status}_${JSON.stringify(blocked1.body)}`);
    if (pointer() !== beforePointer) throw Error("pointer_moved_on_a_refused_bot_click");

    // Client 2 takes the screen. Only one of them may hold it from now on.
    const client2 = await api(screen("possession"), "POST", {});
    if (client2.status !== 200 || !client2.body?.token) throw Error(`client2_${client2.status}`);
    const token2 = client2.body.token;
    const cookie2 = possessionCookie(client2);
    if (token1 === token2) throw Error("takeover_reissued_the_same_token");
    if (client2.body.epoch <= client1.body.epoch) throw Error(`epoch_did_not_advance_${client1.body.epoch}_${client2.body.epoch}`);

    const displaced = {
      frame: await api(screen("frame"), "GET", undefined, { "x-rc-possession": token1 }),
      heartbeat: await api(screen("possession/heartbeat"), "POST", { token: token1 }),
      input: await api(screen("input"), "POST", { token: token1, event: { kind: "click", x: 20, y: 20 } }),
    };
    for (const [name, response] of Object.entries(displaced)) {
      if (response.status !== 409 || response.body?.error !== "possession_superseded") {
        throw Error(`displaced_client_${name}_${response.status}_${JSON.stringify(response.body)}`);
      }
    }

    const beforeClient2Pointer = pointer();
    const holderFrame = await api(screen("frame"), "GET", undefined, { "x-rc-possession": token2 });
    if (holderFrame.status !== 200 || holderFrame.type !== "image/png") throw Error(`client2_frame_${holderFrame.status}`);
    const holderInput = await api(screen("input"), "POST", { token: token2, event: { kind: "click", x: 400, y: 400 } });
    if (holderInput.status !== 200) throw Error(`client2_input_${holderInput.status}`);
    if (pointer() === beforeClient2Pointer) throw Error("the_holder_input_did_not_move_the_pointer");

    // The explicit state each client reads back.
    const state1 = await api(screen("possession"), "GET", undefined, { cookie: `${cookie}; ${cookie1}` });
    const state2 = await api(screen("possession"), "GET", undefined, { cookie: `${cookie}; ${cookie2}` });
    if (state1.body?.state !== "superseded") throw Error(`client1_state_${JSON.stringify(state1.body)}`);
    if (state2.body?.state !== "holder") throw Error(`client2_state_${JSON.stringify(state2.body)}`);

    // The Bot is still refused while a client holds the screen.
    const blocked2 = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "key", key: "Return" } });
    if (blocked2.status !== 409 || blocked2.body?.error !== "possession_held_by_user") throw Error(`bot_during_client2_${blocked2.status}`);

    // Drop the connection: stop heartbeating and let the window close.
    await delay(possessionMs + 1_500);
    const lostFrame = await api(screen("frame"), "GET", undefined, { "x-rc-possession": token2 });
    if (lostFrame.status !== 409 || lostFrame.body?.error !== "possession_lost") throw Error(`disconnected_client_${lostFrame.status}_${JSON.stringify(lostFrame.body)}`);
    const state2After = await api(screen("possession"), "GET", undefined, { cookie: `${cookie}; ${cookie2}` });
    if (state2After.body?.state !== "expired") throw Error(`disconnected_state_${JSON.stringify(state2After.body)}`);

    // Resumption: the displaced client comes back and gets a new epoch.
    const resumed = await api(screen("possession"), "POST", {});
    if (resumed.status !== 200) throw Error(`resume_${resumed.status}`);
    if (resumed.body.epoch <= client2.body.epoch) throw Error(`resume_epoch_not_greater_${resumed.body.epoch}`);
    // While the resumed client holds the screen the Bot is refused for that
    // reason; the pre-takeover observation is only judged stale once the screen
    // is free again.
    const resumedBotAttempt = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "click", x: 300, y: 400 } });
    if (resumedBotAttempt.status !== 409 || resumedBotAttempt.body?.error !== "possession_held_by_user") {
      throw Error(`bot_during_resumed_client_${resumedBotAttempt.status}_${JSON.stringify(resumedBotAttempt.body)}`);
    }
    const released = await api(screen("possession/release"), "POST", { token: resumed.body.token });
    if (released.status !== 200) throw Error(`release_${released.status}`);
    const staleObservation = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "click", x: 300, y: 400 } });
    if (staleObservation.status !== 409 || staleObservation.body?.error !== "stale_observation") {
      throw Error(`pre_takeover_observation_after_resume_${staleObservation.status}_${JSON.stringify(staleObservation.body)}`);
    }
    const observation1 = await api(screen("agent/observation"), "POST", { agentId: "distill-1" });
    if (observation1.status !== 200) throw Error(`observation1_${observation1.status}`);
    const botAfterReturn = await api(screen("agent/input"), "POST", { stateToken: observation1.body.stateToken, event: { kind: "key", key: "Shift" } });
    if (botAfterReturn.status !== 200 || botAfterReturn.body?.applied !== true) throw Error(`bot_after_return_${botAfterReturn.status}`);

    record.journey = {
      firstClient: { possession: client1.status, frame: frame1.status, epoch: client1.body.epoch },
      botDuringFirstClient: { status: blocked1.status, error: blocked1.body.error, pointerUnchanged: true },
      secondClient: { possession: client2.status, epoch: client2.body.epoch, frame: holderFrame.status, input: holderInput.status },
      displacedClient: {
        frame: { status: displaced.frame.status, error: displaced.frame.body?.error },
        heartbeat: { status: displaced.heartbeat.status, error: displaced.heartbeat.body?.error },
        input: { status: displaced.input.status, error: displaced.input.body?.error },
      },
      explicitState: { displaced: state1.body?.state, holder: state2.body?.state },
      botDuringSecondClient: { status: blocked2.status, error: blocked2.body?.error },
      disconnection: { frame: { status: lostFrame.status, error: lostFrame.body?.error }, state: state2After.body?.state },
      resumption: {
        status: resumed.status,
        epoch: resumed.body.epoch,
        preTakeoverObservation: { status: staleObservation.status, error: staleObservation.body?.error },
        botAfterReturn: botAfterReturn.status,
        botDuringResumedClient: { status: resumedBotAttempt.status, error: resumedBotAttempt.body?.error },
      },
    };
    record.result = "two_clients_never_shared_the_screen_displaced_client_was_told_and_recovered_passed";
    console.log(JSON.stringify(record));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}