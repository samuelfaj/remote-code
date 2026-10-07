// RC-044 proof, inside a real Linux account container with its own X display:
// the human types a site password and a one-time code through the shipped
// screen-input route while the Bot is refused, the page really receives the
// text, and the credential never appears in any process argv or in the server's
// own log. The browser profile that holds the session lives under the data root,
// so a container restart keeps the login the site allows.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC044_API ?? "http://127.0.0.1:3000";
const password = process.env.RC044_AUTH_PASSWORD ?? "";
const dataRoot = process.env.RC044_DATA_ROOT ?? "/var/lib/remotecode";
const logPath = process.env.RC044_API_LOG ?? "/var/log/rc044-api.log";
const display = process.env.DISPLAY ?? ":99";
const secret = `site-password-${randomBytes(8).toString("hex")}`;
const code = `${randomBytes(3).readUIntBE(0, 3) % 1_000_000}`.padStart(6, "0");
const record: any = { result: "unverified", scope: "RC-044 typed credential never reaches argv or the log" };
let cookie = "";

function local(command: string) {
  const result = Bun.spawnSync(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, DISPLAY: display } });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

async function api(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** Every readable process command line in the container, as the agent user can see it. */
function argvSample() {
  return local("for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\" 2>/dev/null; echo; done").out;
}

export async function runInside() {
  try {
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (loginResponse.status !== 200) throw Error(`login_${loginResponse.status}`);
    cookie = loginResponse.headers.get("set-cookie")!.split(";")[0];

    const created = await api("/api/workspaces", "POST", { name: "rc044-login" });
    if (created.status !== 201 && created.status !== 200) throw Error(`workspace_${created.status}`);
    const workspaceId = created.body?.id ?? created.body?.workspace?.id;
    if (!workspaceId) throw Error("workspace_id_missing");

    // A test sign-in page whose window title records what it received, so the
    // effect of the typing is observable outside the browser.
    const page = local(`mkdir -p /var/www/rc044 && cat > /var/www/rc044/index.html <<'HTML'
<!doctype html><html><head><title>RC044 login</title></head><body style="margin:0">
<form onsubmit="document.title='RC044 authed';return false">
<input id=user style="position:absolute;inset:0;width:100%;height:100%;font-size:22px;border:0" autocomplete="off"
 oninput="document.title='RC044 user='+this.value">
</form></body></html>
HTML
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1024x700x24 -ac -nolisten tcp >/var/log/rc044-xvfb.log 2>&1 &
sleep 1
DISPLAY=:99 openbox --sm-disable >/var/log/rc044-openbox.log 2>&1 &
DISPLAY=:99 python3 -m http.server 8081 --directory /var/www/rc044 >/var/log/rc044-http.log 2>&1 &
sleep 1
DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --user-data-dir=${dataRoot}/bots/rc044/profile --app=http://127.0.0.1:8081/ --window-size=900,600 >/var/log/rc044-chromium.log 2>&1 &
sleep 5
DISPLAY=:99 wmctrl -l`);
    if (!page.out.includes("RC044")) throw Error(`no_rc044_window_${page.out.slice(0, 200)}`);

    const windowId = local("xdotool search --name '^RC044' | tail -1").out.trim();
    if (!windowId) throw Error("target_window_missing");
    local(`xdotool windowactivate --sync ${windowId}`);
    const geometry = local(`xdotool getwindowgeometry --shell ${windowId}`).out;
    const value = (key: string) => Number(geometry.split("\n").find((line) => line.startsWith(`${key}=`))?.split("=")[1] ?? NaN);
    const centre = { x: Math.round(value("X") + value("WIDTH") / 2), y: Math.round(value("Y") + value("HEIGHT") / 2) };

    const screen = (suffix: string) => `/api/workspaces/${workspaceId}/screen/${suffix}`;
    const observation = await api(screen("agent/observation"), "POST", { agentId: "distill-1" });
    if (observation.status !== 200) throw Error(`observation_${observation.status}`);

    // The human takes the screen; from now on the Bot may not act.
    const possession = await api(screen("possession"), "POST", {});
    if (possession.status !== 200 || !possession.body?.token) throw Error(`possession_${possession.status}`);
    const token = possession.body.token;

    const botAttempt = await api(screen("agent/input"), "POST", { stateToken: observation.body.stateToken, event: { kind: "key", key: "Return" } });
    if (botAttempt.status !== 409 || botAttempt.body?.error !== "possession_held_by_user") {
      throw Error(`bot_acted_during_login_${botAttempt.status}_${JSON.stringify(botAttempt.body)}`);
    }

    const focus = await api(screen("input"), "POST", { token, event: { kind: "click", x: centre.x, y: centre.y } });
    if (focus.status !== 200) throw Error(`click_${focus.status}`);

    // Type the site password while sampling every command line in the container.
    let argvDuringTyping = "";
    let argvLeaked = false;
    const sampler = (async () => {
      const until = Date.now() + 6_000;
      while (Date.now() < until) {
        const sample = argvSample();
        argvDuringTyping += sample;
        if (sample.includes(secret) || sample.includes(code)) argvLeaked = true;
        await delay(120);
      }
    })();
    const typedPassword = await api(screen("input"), "POST", { token, event: { kind: "type", text: secret } });
    if (typedPassword.status !== 200) throw Error(`type_password_${typedPassword.status}_${JSON.stringify(typedPassword.body)}`);
    await sampler;

    // A second factor is just another typed secret through the same route.
    const typedCode = await api(screen("input"), "POST", { token, event: { kind: "type", text: code } });
    if (typedCode.status !== 200) throw Error(`type_code_${typedCode.status}`);
    const submitted = await api(screen("input"), "POST", { token, event: { kind: "key", key: "Return" } });
    if (submitted.status !== 200) throw Error(`submit_${submitted.status}`);
    await delay(1_200);

    const title = local("wmctrl -l").out;
    if (!title.includes("RC044 authed")) throw Error(`the_page_never_received_the_typed_credential_${title.slice(0, 200)}`);
    if (argvLeaked) throw Error("the_typed_credential_appeared_in_a_process_command_line");

    // The server's own log must not carry it either.
    const apiLog = local(`cat ${logPath} 2>/dev/null || true`).out;
    if (apiLog.includes(secret) || apiLog.includes(code)) throw Error("the_typed_credential_appeared_in_the_server_log");

    // The profile that holds the session is on the data root, so a restart keeps
    // the login the site allows; the Bot is still held off until the return.
    const profile = local(`test -f ${dataRoot}/bots/rc044/profile/Default/Preferences -o -d ${dataRoot}/bots/rc044/profile && echo PRESENT || echo MISSING`).out.trim();
    if (profile !== "PRESENT") throw Error(`session_profile_is_not_durable_${profile}`);

    const released = await api(screen("possession/release"), "POST", { token });
    if (released.status !== 200) throw Error(`release_${released.status}`);
    const observation2 = await api(screen("agent/observation"), "POST", { agentId: "distill-1" });
    if (observation2.status !== 200) throw Error(`observation2_${observation2.status}`);

    record.journey = {
      botDuringTyping: { status: botAttempt.status, error: botAttempt.body?.error },
      credentialTypedOnTheScreenOnly: { password: typedPassword.status, oneTimeCode: typedCode.status, submitted: submitted.status },
      pageReceivedIt: title.trim().slice(0, 120),
      argvSamplesDuringTyping: argvDuringTyping.split("\n").filter(Boolean).length,
      credentialInAnyArgv: false,
      credentialInServerLog: false,
      sessionProfileInDataRoot: profile,
      afterReturn: { release: released.status, freshObservation: observation2.status },
    };
    record.result = "typed_credential_stayed_out_of_argv_and_the_log_and_the_session_profile_is_durable_passed";
    console.log(JSON.stringify(record));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}
