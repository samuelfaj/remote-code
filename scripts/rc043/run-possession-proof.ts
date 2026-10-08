// RC-043 proof orchestration. Starts a real Linux host with X11 (Xvfb +
// Openbox + Chromium on a test login page), runs the shipped API on that
// display, then executes the takeover journey inside the account container —
// where the real client sits — so `import` and `xdotool` are the real tools and
// the API is reached over the container's own loopback.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
if (process.env.RC043_INSIDE) {
  await (await import("./inside-journey.ts")).runInside();
  process.exit(process.exitCode ?? 0);
}
const output = process.env.RC043_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC043_IMAGE ?? "remotecode/computer:rc043";
const run = `rc043-proof-${randomUUID().slice(0, 8)}`;
// Long enough that a connected client that heartbeats keeps the screen,
// short enough that a dropped connection loses it inside the proof.
const possessionMs = 8_000;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const record: any = { result: "unverified", scope: "RC-043 two clients, expiry, disconnection, resumption" };

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function mustDocker(...args: string[]) {
  const result = docker(...args);
  if (result.code !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.err.slice(0, 400)}`);
  return result.out;
}

const inContainer = (script: string, timeout = 120_000) => docker("exec", run, "bash", "-lc", script);

try {
  // Always rebuild: the image must contain the tree under test.
  mustDocker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = { reference: image, id: mustDocker("image", "inspect", "-f", "{{.Id}}", image).trim().slice(0, 19) };

  docker("rm", "-f", run);
  mustDocker("run", "-d", "--name", run, image, "sleep", "infinity");
  // The image carries the app and the rc023 helper scripts; the takeover
  // journey is copied in so the container runs the tree under test.
  mustDocker("cp", resolve(repo, "scripts/rc043"), `${run}:/workspace/scripts/rc043`);

  const desktop = inContainer(`mkdir -p /var/www/rc043 && cat > /var/www/rc043/index.html <<'HTML'
<!doctype html><html><head><title>RC043 login</title></head><body style="margin:0;font:16px sans-serif">
<input id="user" style="position:absolute;inset:0;width:100%;height:100%;font-size:22px;border:0;outline:none"
  oninput="document.title='RC043 user='+this.value"
  onkeydown="if(event.key==='Enter'){document.title='RC043 authed'}">
</body></html>
HTML
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1024x700x24 -ac -nolisten tcp >/var/log/rc043-xvfb.log 2>&1 &
sleep 1
DISPLAY=:99 openbox --sm-disable >/var/log/rc043-openbox.log 2>&1 &
DISPLAY=:99 python3 -m http.server 8081 --directory /var/www/rc043 >/var/log/rc043-http.log 2>&1 &
sleep 1
DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run \\
  --user-data-dir=/var/lib/rc043 --app=http://127.0.0.1:8081/ --window-size=900,600 \\
  >/var/log/rc043-chromium.log 2>&1 &
sleep 6
DISPLAY=:99 wmctrl -l`);
  if (desktop.code !== 0) throw Error(`desktop_start_failed_${desktop.err.slice(0, 200)}`);
  if (!desktop.out.includes("RC043")) throw Error(`no_rc043_window_${desktop.out.slice(0, 200)}`);

  inContainer(
    `cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc043.sqlite ` +
    `REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_SCREEN_POSSESSION_MS=${possessionMs} ` +
    `bun apps/api/src/index.ts >/var/log/rc043-api.log 2>&1 & echo started`, 20_000);

  let apiUp = false;
  const readyEnd = Date.now() + 90_000;
  while (Date.now() < readyEnd) {
    const probe = inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready", 20_000);
    if (probe.out.trim() === "200") { apiUp = true; break; }
    await delay(500);
  }
  if (!apiUp) throw Error(`api_never_became_ready_${inContainer("tail -5 /var/log/rc043-api.log").out.slice(0, 300)}`);

  const journey = inContainer(
    `cd /workspace && RC043_INSIDE=1 DISPLAY=:99 RC043_API=http://127.0.0.1:3000 ` +
    `RC043_AUTH_PASSWORD=${password} RC043_POSSESSION_MS=${possessionMs} ` +
    `bun scripts/rc043/run-possession-proof.ts`, 300_000);
  const line = journey.out.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1) ?? "";
  if (!line) throw Error(`journey_produced_no_result_${journey.err.slice(-400)}`);
  const result = JSON.parse(line);
  record.journey = result.journey;
  if (result.result !== "two_clients_never_shared_the_screen_displaced_client_was_told_and_recovered_passed") {
    throw Error(`journey_${result.error ?? "unknown"}`);
  }

  record.result = "two_clients_never_shared_the_screen_displaced_client_was_told_and_recovered_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
} finally {
  if (!process.env.RC043_KEEP) {
    const removed = docker("rm", "-f", run);
    record.cleanup = { container: removed.code === 0 };
  }
}
