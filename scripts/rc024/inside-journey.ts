// The RC-024 journey, executed inside the account container exactly where the
// real client sits: it reaches the shipped API over the container's loopback
// (auth refuses plain HTTP from a non-loopback peer) and drives the container's
// own X11 display, so `import` and `xdotool` are the real binaries.
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC024_API ?? "http://127.0.0.1:3000";
const password = process.env.RC024_AUTH_PASSWORD ?? "";
const possessionMs = Number(process.env.RC024_POSSESSION_MS ?? "3000");
const display = process.env.DISPLAY ?? ":99";
const record: any = { result: "unverified", scope: "RC-024 takeover, exclusive possession, expiry, return" };
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
  if (type.includes("image/png")) {
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), type, body: null as any };
  }
  return { status: response.status, bytes: null as Uint8Array | null, type, body: await response.json().catch(() => null) as any };
}

function pngSize(bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function runInside() {
  const botPassword = process.env.RC024_BOT_PASSWORD ?? "";
  try {
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (loginResponse.status !== 200) throw Error(`login_${loginResponse.status}`);
    cookie = loginResponse.headers.get("set-cookie")!.split(";")[0];

    const created = await api("/api/workspaces", "POST", { name: "rc024-session" });
    if (created.status !== 201 && created.status !== 200) throw Error(`workspace_${created.status}_${JSON.stringify(created.body)}`);
    const workspaceId = created.body?.id ?? created.body?.workspace?.id;
    if (!workspaceId) throw Error(`workspace_id_missing_${JSON.stringify(created.body)}`);

    const screen = (suffix: string) => `/api/workspaces/${workspaceId}/screen/${suffix}`;
    const pointer = () => local("xdotool", "getmouselocation", "--shell").out;
    const title = () => local("wmctrl", "-l").out;
    const windowId = local("xdotool", "search", "--name", "^RC024").out.split("\n").filter(Boolean).at(-1) ?? "";
    if (!windowId) throw Error("target_window_missing");
    local("xdotool", "windowactivate", "--sync", windowId);
    const geometry = local("xdotool", "getwindowgeometry", "--shell", windowId).out;
    const value = (key: string) => Number(geometry.split("\n").find((line) => line.startsWith(`${key}=`))?.split("=")[1] ?? NaN);
    const centre = { x: Math.round(value("X") + value("WIDTH") / 2), y: Math.round(value("Y") + value("HEIGHT") / 2) };
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) throw Error(`window_geometry_unreadable_${geometry}`);

    // Baseline: the Bot observes and acts on this session.
    const observation0 = await api(screen("agent/observation"), "POST", { agentId: "distill-1" });
    if (observation0.status !== 200 || !observation0.body?.stateToken) throw Error(`observation0_${observation0.status}`);
    const baselineInput = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "key", key: "Shift" } });
    if (baselineInput.status !== 200 || baselineInput.body?.applied !== true) throw Error(`baseline_input_${baselineInput.status}_${JSON.stringify(baselineInput.body)}`);

    // Human takes exclusive possession.
    const possession = await api(screen("possession"), "POST", {});
    if (possession.status !== 200 || !possession.body?.token) throw Error(`possession_${possession.status}_${JSON.stringify(possession.body)}`);
    const humanToken = possession.body.token;

    // The correct session's screen: a real PNG at the container display's size.
    const frame = await api(screen("frame"), "GET", undefined, { "x-rc-possession": humanToken });
    if (frame.status !== 200 || frame.type !== "image/png") throw Error(`frame_${frame.status}_${frame.type}`);
    const size = pngSize(frame.bytes!);
    if (!size || size.width !== 1024 || size.height !== 700) throw Error(`frame_is_not_this_display_${JSON.stringify(size)}`);

    const stolenFrame = await api(screen("frame"), "GET", undefined, { "x-rc-possession": "0".repeat(64) });
    if (stolenFrame.status !== 409) throw Error(`stolen_frame_${stolenFrame.status}`);

    // The Bot's click during the takeover is refused and the pointer does not move.
    const beforePointer = pointer();
    const blocked = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "click", x: 300, y: 400 } });
    if (blocked.status !== 409 || blocked.body?.error !== "possession_held_by_user") throw Error(`bot_click_during_takeover_${blocked.status}_${JSON.stringify(blocked.body)}`);
    const afterPointer = pointer();
    if (beforePointer !== afterPointer) throw Error(`pointer_moved_during_takeover_${beforePointer}_${afterPointer}`);
    const blockedStale = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "key", key: "Return" } });
    if (blockedStale.status !== 409) throw Error(`bot_key_during_takeover_${blockedStale.status}`);

    // The human logs in through the same channel the web client uses.
    // The web client keeps its possession alive while it is connected.
    const heartbeat = async () => {
      const beat = await api(screen("possession/heartbeat"), "POST", { token: humanToken });
      if (beat.status !== 200) throw Error(`heartbeat_${beat.status}_${JSON.stringify(beat.body)}`);
    };
    const clickField = await api(screen("input"), "POST", { token: humanToken, event: { kind: "click", x: centre.x, y: centre.y } });
    if (clickField.status !== 200) throw Error(`human_click_${clickField.status}_${JSON.stringify(clickField.body)}`);
    const typeUser = await api(screen("input"), "POST", { token: humanToken, event: { kind: "type", text: "operator" } });
    if (typeUser.status !== 200) throw Error(`human_type_${typeUser.status}_${JSON.stringify(typeUser.body)}`);
    await delay(1_200);
    const afterHuman = title();
    if (!afterHuman.includes("RC024 user=operator")) throw Error(`human_input_had_no_effect_${afterHuman.slice(0, 200)}`);

    const submitLogin = await api(screen("input"), "POST", { token: humanToken, event: { kind: "key", key: "Return" } });
    if (submitLogin.status !== 200) throw Error(`human_submit_${submitLogin.status}`);
    await delay(1_200);
    const authedTitle = title();
    if (!authedTitle.includes("RC024 authed")) throw Error(`human_login_had_no_effect_${authedTitle.slice(0, 200)}`);

    // The operator types the credential the Bot must never see. Enter puts the
    // page back in its authenticated state, so the proof never reads a title
    // that contains the secret.
    await heartbeat();
    const refocus = await api(screen("input"), "POST", { token: humanToken, event: { kind: "click", x: centre.x, y: centre.y } });
    const passwordLeak = await api(screen("input"), "POST", { token: humanToken, event: { kind: "type", text: botPassword } });
    if (passwordLeak.status !== 200) throw Error(`human_password_${passwordLeak.status}_refocus_${refocus.status}_${JSON.stringify(passwordLeak.body)}_${JSON.stringify(refocus.body)}`);
    const resubmit = await api(screen("input"), "POST", { token: humanToken, event: { kind: "key", key: "Return" } });
    if (resubmit.status !== 200) throw Error(`human_resubmit_${resubmit.status}`);
    await delay(1_200);
    if (!title().includes("RC024 authed")) throw Error(`page_left_authenticated_state_${title().slice(0, 200)}`);

    // Cut the network: stop heartbeating and let the possession expire.
    await delay(possessionMs + 1_500);
    const expiredFrame = await api(screen("frame"), "GET", undefined, { "x-rc-possession": humanToken });
    if (expiredFrame.status !== 409) throw Error(`expired_token_still_worked_${expiredFrame.status}`);
    const expiredInput = await api(screen("input"), "POST", { token: humanToken, event: { kind: "click", x: 10, y: 10 } });
    if (expiredInput.status !== 409) throw Error(`expired_input_worked_${expiredInput.status}`);

    // Reconnect: a new possession has a new epoch, so earlier inputs must not pass.
    const reconnected = await api(screen("possession"), "POST", {});
    if (reconnected.status !== 200) throw Error(`reconnect_${reconnected.status}`);
    const newToken = reconnected.body.token;
    const staleHuman = await api(screen("input"), "POST", { token: humanToken, event: { kind: "click", x: 20, y: 20 } });
    if (staleHuman.status !== 409) throw Error(`old_human_input_passed_after_reconnect_${staleHuman.status}`);
    // While the new possession is live the Bot is still refused, for the same reason.
    const blockedAgain = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "click", x: 300, y: 400 } });
    if (blockedAgain.status !== 409 || blockedAgain.body?.error !== "possession_held_by_user") {
      throw Error(`bot_click_after_reconnect_${blockedAgain.status}_${JSON.stringify(blockedAgain.body)}`);
    }

    // Return: the human releases. The observation the Bot took before the
    // takeover is now evidence about a screen it no longer controls.
    const released = await api(screen("possession/release"), "POST", { token: newToken });
    if (released.status !== 200) throw Error(`release_${released.status}`);
    const staleAgent = await api(screen("agent/input"), "POST", { stateToken: observation0.body.stateToken, event: { kind: "click", x: 300, y: 400 } });
    if (staleAgent.status !== 409 || staleAgent.body?.error !== "stale_observation") {
      throw Error(`stale_agent_input_${staleAgent.status}_${JSON.stringify(staleAgent.body)}`);
    }

    const observation1 = await api(screen("agent/observation"), "POST", { agentId: "distill-1" });
    if (observation1.status !== 200) throw Error(`observation1_${observation1.status}`);
    const afterReturnInput = await api(screen("agent/input"), "POST", { stateToken: observation1.body.stateToken, event: { kind: "key", key: "Shift" } });
    if (afterReturnInput.status !== 200 || afterReturnInput.body?.applied !== true) {
      throw Error(`after_return_input_${afterReturnInput.status}_${JSON.stringify(afterReturnInput.body)}`);
    }
    await delay(1_200);
    const botReadTitle = title();
    if (!botReadTitle.includes("RC024 authed")) throw Error(`bot_did_not_see_authenticated_page_${botReadTitle.slice(0, 200)}`);

    record.journey = {
      frame: { status: frame.status, contentType: frame.type, width: size.width, height: size.height },
      stolenFrameStatus: stolenFrame.status,
      botClickDuringTakeover: { status: blocked.status, error: blocked.body.error, pointerUnchanged: beforePointer === afterPointer },
      humanInput: { clickField: clickField.status, typed: typeUser.status, titleAfterTyping: afterHuman, submitted: submitLogin.status, authedTitle },
      expiredPossession: { frame: expiredFrame.status, input: expiredInput.status },
      reconnect: { status: reconnected.status, oldHumanInput: staleHuman.status, botClickWhileHeld: { status: blockedAgain.status, error: blockedAgain.body.error } },
      afterReturn: { staleObservation: { status: staleAgent.status, error: staleAgent.body.error } },
      returned: { release: released.status, observation: observation1.status, botInput: afterReturnInput.status, botSawAuthenticatedPage: botReadTitle },
      passwordEnteredApiTranscript: false,
    };
    record.result = "takeover_held_exclusively_expired_and_returned_with_stale_input_refused_passed";
    console.log(JSON.stringify(record));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}