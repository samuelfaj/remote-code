// RC-065 phase 3: the swapped-window stream proof journey.
// Runs inside the account container, where the real client sits,
// against the shipped API on the container's loopback.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC065_API ?? "http://127.0.0.1:3000";
const password = process.env.RC065_AUTH_PASSWORD ?? "";
const workspaceId = process.env.RC065_WORKSPACE ?? "";
const bots = JSON.parse(process.env.RC065_BOTS ?? "{}") as Record<string, string>;
const displayA = process.env.RC065_DISPLAY_A ?? ":99";
const displayB = process.env.RC065_DISPLAY_B ?? ":98";
const previewMs = Number(process.env.RC065_PREVIEW_MS ?? "12000");

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const steps: Record<string, any> = {};
let cookie = "";
let resultStatus = "unverified";

async function login() {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (response.status !== 200) throw Error(`login_${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0];
}

async function preview(botId: string) {
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/screen/preview`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ botId }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as any;
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body,
    cookie: setCookie ? `rc_screen_preview=${setCookie.split("rc_screen_preview=")[1].split(";")[0]}` : "",
    setCookie: setCookie ?? "",
  };
}

async function frame(botId: string, previewCookie: string) {
  const response = await fetch(
    `${base}/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`,
    {
      headers: { cookie: previewCookie ? `${cookie}; ${previewCookie}` : cookie },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("image/png")) {
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), body: null as any };
  }
  return { status: response.status, bytes: null, body: await response.json().catch(() => null) as any };
}

function referenceFrame(display: string) {
  const result = Bun.spawnSync(["import", "-window", "root", "png:-"], {
    env: { ...process.env, DISPLAY: display, SOURCE_DATE_EPOCH: "0" },
    stdout: "pipe", stderr: "pipe", timeout: 20_000,
  });
  if (result.exitCode !== 0) throw Error(`reference_capture_${display}_${result.stderr.toString().slice(0, 200)}`);
  return new Uint8Array(result.stdout);
}

function wmctrlList(display: string) {
  const result = Bun.spawnSync(["bash", "-lc", `DISPLAY=${display} wmctrl -lG`], {
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  return result.stdout.toString();
}

function closeDisplayWindow(display: string) {
  // Close all windows on this display and kill the chromium process on it.
  Bun.spawnSync(["bash", "-lc",
    `DISPLAY=${display} xdotool search --name "RC065" windowkill 2>/dev/null; ` +
    `sleep 1; ` +
    `DISPLAY=${display} wmctrl -c "RC065" 2>/dev/null; ` +
    `sleep 2`,
  ], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
}

function startChromium(display: string, url: string, userDataDir: string, logFile: string) {
  Bun.spawnSync(["bash", "-lc",
    `DISPLAY=${display} chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --user-data-dir=${userDataDir} --app=${url} --window-size=1024,700 >${logFile} 2>&1 &`,
  ], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
}

const resultPath = "/tmp/rc065-result.json";

function writeResult(result: object) {
  try {
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
  } catch {}
}

try {
  cookie = await login();
  const botA = bots.PreviewA;
  const botB = bots.PreviewB;
  if (!workspaceId || !botA || !botB) throw Error("fixture_missing");

  // Phase 1: assert each bot's frame matches its own display (same as rc042).
  const refA = sha(referenceFrame(displayA));
  const refB = sha(referenceFrame(displayB));
  if (refA === refB) throw Error("fixture_displays_identical");
  steps.referenceFrames = { shaA: refA.slice(0, 16), shaB: refB.slice(0, 16) };

  const openedA = await preview(botA);
  if (openedA.status !== 200 || !openedA.cookie) throw Error(`preview_a_${openedA.status}_${JSON.stringify(openedA.body)}`);
  const frameA1 = await frame(botA, openedA.cookie);
  if (frameA1.status !== 200) throw Error(`frame_a1_${frameA1.status}_${JSON.stringify(frameA1.body)}`);
  if (sha(frameA1.bytes!) !== refA) throw Error("preview_a_showed_the_wrong_screen_before_swap");

  const openedB = await preview(botB);
  if (openedB.status !== 200 || !openedB.cookie) throw Error(`preview_b_${openedB.status}`);
  const frameB1 = await frame(botB, openedB.cookie);
  if (frameB1.status !== 200) throw Error(`frame_b1_${frameB1.status}`);
  if (sha(frameB1.bytes!) !== refB) throw Error("preview_b_showed_the_wrong_screen_before_swap");

  // Cross-read: A's cookie must not read B's screen.
  const crossed = await frame(botB, openedA.cookie);
  if (crossed.status !== 409 || crossed.body?.error !== "preview_required") {
    throw Error(`bot_a_read_bot_b_${crossed.status}_${JSON.stringify(crossed.body)}`);
  }
  steps.beforeSwap = { frameA: frameA1.status, frameB: frameB1.status, crossRead: crossed.status };

  // Phase 2: swap the visible window mid-stream on one Bot's display only.
  // Close Chromium on display A and open a different page (page C) on that same display.
  // Leave display B untouched.
  const wmctrlBeforeSwap = { a: wmctrlList(displayA), b: wmctrlList(displayB) };
  steps.wmctrlBeforeSwap = wmctrlBeforeSwap;

  closeDisplayWindow(displayA);
  startChromium(displayA, "file:///var/www/rc065/c.html", "/var/lib/rc065-a-swap", "/var/log/rc065-c99-swap.log");
  await delay(6_000);

  const wmctrlAfterSwap = { a: wmctrlList(displayA), b: wmctrlList(displayB) };
  steps.wmctrlAfterSwap = wmctrlAfterSwap;

  if (!wmctrlAfterSwap.a.includes("RC065 C") || !wmctrlAfterSwap.b.includes("RC065 B")) {
    throw Error(`swap_not_verified_by_wmctrl_a="${wmctrlAfterSwap.a.slice(0, 300)}" b="${wmctrlAfterSwap.b.slice(0, 300)}"`);
  }
  steps.swap = "windows_swapped_on_display_a_only";

  // Capture the new reference frame for display A (now showing page C).
  const refC = sha(referenceFrame(displayA));
  steps.afterSwapReference = { shaC: refC.slice(0, 16), shaB_unchanged: refB.slice(0, 16) };

  // Phase 3: assert post-swap frames.
  // Bot A's frame must show the new page C (differs from pre-swap frame A).
  // Bot B's frame must still show page B.
  // Neither Bot's frame must contain the other Bot's marker.
  let frameErrors = 0;
  for (let i = 0; i < 5; i++) {
    const fa = await frame(botA, openedA.cookie);
    if (fa.status === 200) {
      const faSha = sha(fa.bytes!);
      if (faSha === refC) {
        // Bot A now shows page C — correct.
      } else if (faSha === refA) {
        // Bot A still shows old page A — stale, not swapped.
        frameErrors += 1;
      } else {
        // Some other content — unexpected.
        frameErrors += 1;
      }
      // Check that Bot A's frame does not contain Bot B's marker.
      if (faSha === refB) throw Error("bot_a_frame_contains_bot_b_marker_after_swap");
    } else if (fa.status !== 409) {
      frameErrors += 1;
    }

    const fb = await frame(botB, openedB.cookie);
    if (fb.status === 200) {
      const fbSha = sha(fb.bytes!);
      if (fbSha !== refB) frameErrors += 1;
      // Check that Bot B's frame does not contain Bot A's marker (page A or C).
      if (fbSha === refA || fbSha === refC) throw Error("bot_b_frame_contains_bot_a_marker_after_swap");
    } else if (fb.status !== 409) {
      frameErrors += 1;
    }

    await delay(500);
  }
  steps.afterSwapFrames = { checks: 10, errors: frameErrors };
  if (frameErrors > 0) throw Error(`frame_requests_failed_after_swap_${frameErrors}`);

  // Phase 4: assert no limit-freeze.
  // Kill the Chromium window on display A entirely and request Bot A's frame.
  // The API must return a documented error status, not a stale PNG or fabricated success.
  closeDisplayWindow(displayA);
  await delay(2_000);
  const noWindowFrame = await frame(botA, openedA.cookie);
  steps.noWindow = { status: noWindowFrame.status, hasBytes: noWindowFrame.bytes !== null };
  if (noWindowFrame.status === 200 && noWindowFrame.bytes !== null) {
    throw Error(`fabricated_stale_frame_when_no_window_status_200_sha=${sha(noWindowFrame.bytes!).slice(0, 16)}`);
  }
  if (noWindowFrame.status === 200) {
    throw Error(`fabricated_success_when_no_window_status_200_body=${JSON.stringify(noWindowFrame.body)}`);
  }
  // A documented error status (409, 404, 503, etc.) is a pass.
  steps.noWindowConclusion = "error_status_not_fabricated";

  // Phase 5: success.
  resultStatus = "swapped_window_frame_identity_passed";
  console.log(JSON.stringify({ result: resultStatus, scope: "RC-065 swapped-window frame identity", steps }));
  writeResult({ result: resultStatus, scope: "RC-065 swapped-window frame identity", steps });
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  resultStatus = "failed";
  const result = { result: "failed", scope: "RC-065 swapped-window frame identity", steps, error: msg };
  console.log(JSON.stringify(result));
  writeResult(result);
  process.exitCode = 1;
}
