// RC-041 proof: several Bots get their own graphical session in ONE container,
// each with its own window and browser profile, addressed by window id, and the
// sessions and profiles survive a restart.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC041_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc041-botsessions-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC041_IMAGE ?? "remotecode/computer:rc023";
const label = "remotecode.rc041.botsessions";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc041.sqlite";
const sessionRoot = "/var/lib/remotecode/bots";
const sitePort = 24_000 + Math.floor(Math.random() * 500);
const apiPort = sitePort + 1;
let id = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-041 two Bots, two windows, two profiles, one container" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

const site = `#!/usr/bin/env bun
// Serves one page per Bot: its title is the bot marker and it sets a cookie,
// so a profile can be shown to persist.
Bun.serve({ port: Number(process.env.RC041_SITE_PORT), hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  const bot = url.searchParams.get("bot") ?? "none";
  return new Response(\`<!doctype html><html><head><title>\${bot}</title></head>
<body style="margin:0;font:17px sans-serif"><h1 style="margin:8px 0 0 20px;font-size:15px">Bot \${bot}</h1>
<input id="f" style="position:absolute;left:20px;top:100px;width:860px;height:400px;font-size:22px;caret-color:transparent;border:1px solid #999;background:#fff;outline:none" oninput="document.title='\${bot}'">
<script>document.cookie="rc041=" + \${JSON.stringify(bot)} + "; path=/";</script>
</body></html>\`, { headers: { "content-type": "text/html; charset=utf-8" } });
} });
console.log("site-listening");
`;

const driver = `#!/usr/bin/env python3
"""Drive linux-use against two named windows of one X11 display."""
import base64, json, os, subprocess, sys
SERVER = "/opt/linux-use/server.py"
proc = subprocess.Popen([sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
counter = 0
def call(method, params=None):
    global counter
    counter += 1
    message = {"jsonrpc": "2.0", "id": counter, "method": method}
    if params is not None: message["params"] = params
    proc.stdin.write(json.dumps(message) + "\\n"); proc.stdin.flush()
    line = proc.stdout.readline()
    if not line: raise RuntimeError("linux-use closed")
    return json.loads(line)
def tool(name, arguments):
    response = call("tools/call", {"name": name, "arguments": arguments})
    if "error" in response: return {"isError": True, "payload": response["error"]}
    result = response["result"]
    if result.get("isError"):
        return {"isError": True, "payload": {"message": result["content"][-1].get("text", "")}}
    payload = json.loads(result["content"][-1]["text"])
    return {"isError": False, "payload": payload, "image": next((b for b in result["content"] if b.get("type") == "image"), None)}
def park():
    # Keep the pointer off every window so hover state cannot leak between them.
    subprocess.run(["xdotool", "mousemove", "1870", "690"], check=False)

def stable_shot(target, attempts=20):
    """Capture until two consecutive observations match (Chromium keeps painting)."""
    import hashlib, time
    previous = None
    last = None
    for _ in range(attempts):
        park()
        shot = tool("screenshot", target)
        if shot.get("isError"):
            raise SystemExit("stable_screenshot_failed: " + json.dumps(shot.get("payload"))[:200])
        last = shot
        digest = hashlib.sha256(base64.b64decode(shot["image"]["data"])).hexdigest()
        if previous == digest:
            return {"sha": digest[:16], "token": shot["payload"]["state_token"]}
        previous = digest
        time.sleep(0.5)
    return {"sha": (previous or "")[:16], "token": last["payload"]["state_token"]}
call("initialize")
out = {}
for name in ("alpha", "beta"):
    target = {"target_pid": int(os.environ[f"RC041_{name.upper()}_PID"]), "target_window_id": int(os.environ[f"RC041_{name.upper()}_WINDOW"])}
    out[name] = stable_shot(target)
out["beta_before"] = out["beta"]["sha"]
# Act on alpha only: it must change, and beta must not.
alpha = {"target_pid": int(os.environ["RC041_ALPHA_PID"]), "target_window_id": int(os.environ["RC041_ALPHA_WINDOW"])}
park()
clicked = tool("left_click", {**alpha, "expected_state_token": out["alpha"]["token"], "coordinate": [440, 260]})
if clicked.get("isError"): raise SystemExit("alpha_click_refused")
park()
shot2 = tool("screenshot", alpha)
token2 = shot2["payload"]["state_token"]
typed = tool("type", {**alpha, "expected_state_token": token2, "text": "rc041-alpha-note"})
if typed.get("isError"): raise SystemExit("alpha_type_refused")
out["alpha_after"] = stable_shot(alpha)["sha"]
out["beta_after"] = stable_shot({"target_pid": int(os.environ["RC041_BETA_PID"]), "target_window_id": int(os.environ["RC041_BETA_WINDOW"])})["sha"]
out["alpha_changed"] = out["alpha"]["sha"] != out["alpha_after"]
out["beta_unchanged"] = out["beta_before"] == out["beta_after"]
# A window id that is not the target must be refused.
foreign = tool("screenshot", {"target_pid": int(os.environ["RC041_ALPHA_PID"]), "target_window_id": int(os.environ["RC041_BETA_WINDOW"])})
out["foreign_target_refused"] = bool(foreign.get("isError"))
print(json.dumps(out))
`;

async function startServices() {
  command("docker", "exec", id, "sh", "-c",
    "rm -f /tmp/.X99-lock; Xvfb :99 -screen 0 1900x700x24 -ac -nolisten tcp >/var/lib/remotecode/rc041-xvfb.log 2>&1 & sleep 1; " +
    "DISPLAY=:99 openbox --sm-disable >/var/lib/remotecode/rc041-openbox.log 2>&1 & sleep 1; " +
    `DISPLAY=:99 RC041_SITE_PORT=${sitePort} bun /proof/rc041-site > /var/lib/remotecode/rc041-site.log 2>&1 & sleep 1; ` +
    `cd /workspace && API_PORT=3000 DATABASE_PATH=${databasePath} REMOTECODE_AUTH_PASSWORD='${password}' ` +
    `REMOTECODE_BOT_DISPLAY=:99 REMOTECODE_CHROMIUM_BIN=/usr/bin/chromium REMOTECODE_BOT_SESSION_ROOT=${sessionRoot} ` +
    "REMOTECODE_TLS_CERT=/proof/proof-ca.pem REMOTECODE_TLS_KEY=/proof/proof-key.pem " +
    "bun apps/api/src/index.ts > /var/lib/remotecode/rc041-api.log 2>&1 &");
  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(resolve(output, "proof-ca.pem")) };
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) return; } catch {}
    await delay(250);
  }
  throw Error("api_never_became_ready");
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "rc041-site"), site);
  writeFileSync(resolve(output, "rc041-driver.py"), driver);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "--entrypoint", "sleep", image, "infinity");
  command("docker", "start", id);
  await startServices();

  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000), tls,
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };

  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const workspaces = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "rc041" }, cookie);
  if (workspaces.status !== 201 && workspaces.status !== 200) throw Error(`workspace_${workspaces.status}`);
  const alpha = await api("/api/bots", "POST", { name: "Alpha", instructions: "alpha" }, cookie);
  const beta = await api("/api/bots", "POST", { name: "Beta", instructions: "beta" }, cookie);
  if (alpha.status !== 201 || beta.status !== 201) throw Error(`bots_${alpha.status}_${beta.status}`);

  const siteUrl = (marker: string) => `http://127.0.0.1:${sitePort}/rc041?bot=${marker}`;
  const sessionAlpha = await api(`/api/bots/${alpha.body.id}/session`, "POST", { url: siteUrl("alpha") }, cookie);
  if (sessionAlpha.status !== 201) throw Error(`alpha_session_${sessionAlpha.status}_${JSON.stringify(sessionAlpha.body)}`);
  const sessionBeta = await api(`/api/bots/${beta.body.id}/session`, "POST", { url: siteUrl("beta") }, cookie);
  if (sessionBeta.status !== 201) throw Error(`beta_session_${sessionBeta.status}_${JSON.stringify(sessionBeta.body)}`);

  if (sessionAlpha.body.windowId === sessionBeta.body.windowId) throw Error("bots_share_one_window");
  // Side-by-side, non-overlapping: xwd on one window must never capture the other.
  command("docker", "exec", "-e", "DISPLAY=:99", id, "wmctrl", "-i", "-r", `0x${Number(sessionAlpha.body.windowId).toString(16).padStart(8, "0")}`, "-e", "0,0,0,900,600");
  command("docker", "exec", "-e", "DISPLAY=:99", id, "wmctrl", "-i", "-r", `0x${Number(sessionBeta.body.windowId).toString(16).padStart(8, "0")}`, "-e", "0,960,0,900,600");
  const geometry = command("docker", "exec", "-e", "DISPLAY=:99", id, "wmctrl", "-lG");
  const boxOf = (id: number) => {
    const line = geometry.split("\n").find((entry) => entry.startsWith(`0x${id.toString(16).padStart(8, "0")}`));
    if (!line) throw Error(`window_missing_${id}`);
    const parts = line.split(/\s+/);
    return { x: Number(parts[2]), y: Number(parts[3]), w: Number(parts[4]), h: Number(parts[5]) };
  };
  const aBox = boxOf(sessionAlpha.body.windowId), bBox = boxOf(sessionBeta.body.windowId);
  if (aBox.x < bBox.x + bBox.w && bBox.x < aBox.x + aBox.w && aBox.y < bBox.y + bBox.h && bBox.y < aBox.y + aBox.h) {
    throw Error(`bot_windows_overlap_${JSON.stringify({ aBox, bBox })}`);
  }
  record.geometry = { aBox, bBox };
  if (sessionAlpha.body.profileDir === sessionBeta.body.profileDir) throw Error("bots_share_one_profile");
  if (sessionAlpha.body.title !== "alpha" || sessionBeta.body.title !== "beta") throw Error(`titles_${sessionAlpha.body.title}_${sessionBeta.body.title}`);

  // One container serves every Bot.
  const containers = command("docker", "ps", "--filter", `label=${label}=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean);
  if (containers.length !== 1) throw Error(`containers_${JSON.stringify(containers)}`);
  // Each Bot has its own profile on disk with its own cookie store.
  const profiles = command("docker", "exec", id, "sh", "-c",
    `for d in ${sessionAlpha.body.profileDir} ${sessionBeta.body.profileDir}; do echo "$d $(test -f $d/Default/Cookies && stat -c %s $d/Default/Cookies || echo none)"; done`);
  if (!profiles.includes(sessionAlpha.body.profileDir) || profiles.includes("none")) throw Error(`profiles_${profiles}`);

  // linux-use acts on alpha by id and must not move beta.
  const driverOut = JSON.parse(command("docker", "exec", "-e", `RC041_ALPHA_PID=${sessionAlpha.body.pid}`, "-e", `RC041_ALPHA_WINDOW=${sessionAlpha.body.windowId}`,
    "-e", `RC041_BETA_PID=${sessionBeta.body.pid}`, "-e", `RC041_BETA_WINDOW=${sessionBeta.body.windowId}`,
    "-e", "DISPLAY=:99", "-e", "XDG_SESSION_TYPE=x11", id, "python3", "/proof/rc041-driver.py"));
  if (!driverOut.alpha_changed) throw Error("acting_on_alpha_did_not_change_alpha");
  if (!driverOut.beta_unchanged) throw Error("acting_on_alpha_changed_beta");
  if (!driverOut.foreign_target_refused) throw Error("a window id not belonging to the target was accepted");

  // Restart: sessions and profiles persist, and the session is recoverable.
  command("docker", "restart", id);
  await startServices();
  const relogin = await api("/api/auth/login", "POST", { password });
  if (relogin.status !== 200) throw Error(`relogin_${relogin.status}`);
  const cookieAfter = relogin.cookie;
  const alphaAfter = await api(`/api/bots/${alpha.body.id}/session`, "GET", undefined, cookieAfter);
  const betaAfter = await api(`/api/bots/${beta.body.id}/session`, "GET", undefined, cookieAfter);
  if (alphaAfter.body.session?.windowId !== sessionAlpha.body.windowId) throw Error(`alpha_session_lost_${JSON.stringify(alphaAfter.body)}`);
  if (betaAfter.body.session?.windowId !== sessionBeta.body.windowId) throw Error(`beta_session_lost_${JSON.stringify(betaAfter.body)}`);
  const profileAfter = command("docker", "exec", id, "sh", "-c", `test -f ${sessionAlpha.body.profileDir}/Default/Cookies && echo present || echo gone`);
  if (profileAfter !== "present") throw Error("profile_did_not_survive");
  const relaunched = await api(`/api/bots/${alpha.body.id}/session`, "POST", { url: siteUrl("alpha") }, cookieAfter);
  if (relaunched.status !== 201 || relaunched.body.profileDir !== sessionAlpha.body.profileDir) throw Error(`relaunch_${relaunched.status}_${JSON.stringify(relaunched.body)}`);

  record.bots = {
    alpha: { botId: alpha.body.id, windowId: sessionAlpha.body.windowId, pid: sessionAlpha.body.pid, title: sessionAlpha.body.title, profileDir: sessionAlpha.body.profileDir },
    beta: { botId: beta.body.id, windowId: sessionBeta.body.windowId, pid: sessionBeta.body.pid, title: sessionBeta.body.title, profileDir: sessionBeta.body.profileDir },
    containers: containers.length,
    profiles,
  };
  record.isolation = driverOut;
  record.persistence = { alphaWindowAfter: alphaAfter.body.session.windowId, betaWindowAfter: betaAfter.body.session.windowId, profile: profileAfter, relaunchedProfile: relaunched.body.profileDir };
  record.result = "two_bot_sessions_isolated_and_persistent_passed";
  console.log(JSON.stringify({ result: record.result, bots: record.bots, isolation: record.isolation, persistence: record.persistence }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (process.env.RC041_KEEP) { console.log(JSON.stringify({ kept: { name: run, id, apiPort, sitePort } })); }
  else if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem", "rc041-site", "rc041-driver.py"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}