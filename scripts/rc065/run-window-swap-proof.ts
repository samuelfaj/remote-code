// RC-065 proof orchestration. Starts a real Linux host with two X11 displays,
// runs the shipped API on that host, then executes the swapped-window journey
// inside the account container — where the real client sits — so `import`
// captures the container's own screens and the API is reached over its loopback.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC065_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const image = process.env.RC065_IMAGE ?? "remotecode/computer:rc065";
const run = `rc065-window-swap-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("base64url").replace(/[/+=]/g, "");
const previewMs = 12_000;
const record: any = { result: "unverified", scope: "RC-065 swapped-window frame identity" };

function mustDocker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  if (result.exitCode !== 0) throw Error(`docker ${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString().trim();
}

function inContainer(script: string, timeout = 300_000) {
  const result = Bun.spawnSync(["docker", "exec", run, "bash", "-lc", script], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function startApi(botDisplays: string) {
  inContainer(`cd /workspace && DISPLAY=:99 API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/rc065.sqlite \
    REMOTECODE_AUTH_PASSWORD=${password} REMOTECODE_SCREEN_PREVIEW_MS=${previewMs} \
    REMOTECODE_BOT_DISPLAYS='${botDisplays}' bun apps/api/src/index.ts >/var/log/rc065-api.log 2>&1 & echo started`, 20_000);
}

function stopApi() {
  inContainer("kill $(pgrep -f 'apps/api/src/index.ts') 2>/dev/null; sleep 1; echo stopped", 20_000);
}

function apiAnswering() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = inContainer("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health/ready");
    if (probe.out.trim() === "200") return true;
    Bun.sleepSync(500);
  }
  return false;
}

try {
  mustDocker("build", "-q", "-t", image, "-f", "prototype/Dockerfile", ".");
  record.image = image;
  mustDocker("rm", "-f", run);
  mustDocker("run", "-d", "--name", run, image, "sleep", "infinity");
  mustDocker("cp", resolve(repo, "scripts/rc065"), `${run}:/workspace/scripts/rc065`);

  // Three displays-ready pages with visually distinct markers/colours.
  const desktop = inContainer(
    `mkdir -p /var/www/rc065
    printf '%s' '<!doctype html><title>RC065 A</title><body style="margin:0;background:#cc0000;height:100vh"><h1 style="color:#fff">RC065-A</h1></body>' > /var/www/rc065/a.html
    printf '%s' '<!doctype html><title>RC065 B</title><body style="margin:0;background:#0000cc;height:100vh"><h1 style="color:#fff">RC065-B</h1></body>' > /var/www/rc065/b.html
    printf '%s' '<!doctype html><title>RC065 C</title><body style="margin:0;background:#008800;height:100vh"><h1 style="color:#fff">RC065-C</h1></body>' > /var/www/rc065/c.html
    rm -f /tmp/.X99-lock /tmp/.X98-lock
    Xvfb :99 -screen 0 1024x700x24 -ac -nolisten tcp >/var/log/rc065-x99.log 2>&1 &
    Xvfb :98 -screen 0 1024x700x24 -ac -nolisten tcp >/var/log/rc065-x98.log 2>&1 &
    sleep 1
    DISPLAY=:99 openbox --sm-disable >/var/log/rc065-o99.log 2>&1 &
    DISPLAY=:98 openbox --sm-disable >/var/log/rc065-o98.log 2>&1 &
    sleep 1
    DISPLAY=:99 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --user-data-dir=/var/lib/rc065-a --app=file:///var/www/rc065/a.html --window-size=1024,700 >/var/log/rc065-c99.log 2>&1 &
    DISPLAY=:98 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --user-data-dir=/var/lib/rc065-b --app=file:///var/www/rc065/b.html --window-size=1024,700 >/var/log/rc065-c98.log 2>&1 &
    sleep 6
    DISPLAY=:99 wmctrl -l; echo "---"; DISPLAY=:98 wmctrl -l`,
    120_000,
  );
  if (!desktop.out.includes("RC065 A") || !desktop.out.includes("RC065 B")) {
    throw Error(`displays_not_ready_${desktop.out.slice(0, 400)}`);
  }

  // Phase 1: create the fixture with the default map, so the Bot ids are known.
  startApi("{}");
  if (!apiAnswering()) throw Error(`api_never_became_ready_${inContainer("tail -5 /var/log/rc065-api.log").out.slice(0, 300)}`);
  const prepared = inContainer(`cd /workspace && RC065_AUTH_PASSWORD=${password} bun scripts/rc065/prepare.ts`, 120_000);
  const fixtureLine = prepared.out.trim().split("\n").filter((line) => line.startsWith("{")).at(-1) ?? "";
  if (!fixtureLine) throw Error(`fixture_failed_${prepared.err.slice(-400)}`);
  const fixture = JSON.parse(fixtureLine) as { workspaceId: string; bots: Record<string, string> };
  record.fixture = { workspaceId: fixture.workspaceId, bots: fixture.bots };

  // Phase 2: restart the API with each Bot's own display.
  stopApi();
  startApi(JSON.stringify({ [fixture.bots.PreviewA]: ":99", [fixture.bots.PreviewB]: ":98" }));
  if (!apiAnswering()) throw Error("api_never_restarted_with_the_bot_map");

  // Phase 3: the journey.
  const journey = inContainer(
    `cd /workspace && RC065_AUTH_PASSWORD=${password} RC065_WORKSPACE=${fixture.workspaceId} ` +
    `RC065_BOTS='${JSON.stringify(fixture.bots)}' RC065_DISPLAY_A=:99 RC065_DISPLAY_B=:98 RC065_PREVIEW_MS=${previewMs} ` +
    `bun scripts/rc065/journey.ts`, 300_000);
  const journeyLine = journey.out.trim().split("\n").filter((line) => line.startsWith("{")).at(-1) ?? "";
  if (!journeyLine) throw Error(`journey_produced_no_result_${journey.err.slice(-500)}`);
  const result = JSON.parse(journeyLine);
  record.journey = result;
  if (result.result !== "swapped_window_frame_identity_passed") {
    console.log(`FAIL rc065-window-swap: journey_${result.error ?? "unknown"}`);
    process.exitCode = 1;
  } else {
    // Copy result.json from the container to the host output directory.
    try {
      mustDocker("cp", `${run}:/tmp/rc065-result.json`, resolve(output, "result.json"));
    } catch {}

    record.result = "swapped_window_frame_identity_passed";
    console.log(`PASS rc065-window-swap: ${JSON.stringify(record)}`);
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  record.error = msg;
  console.log(JSON.stringify(record));
  console.log(`FAIL rc065-window-swap: ${msg}`);
  process.exitCode = 1;
} finally {
  if (!process.env.RC065_KEEP) {
    const removed = Bun.spawnSync(["docker", "rm", "-f", run], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    record.cleanup = { container: removed.exitCode === 0 };
  }
}
