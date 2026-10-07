// RC-042 phase 3: the preview journey. Runs inside the account container, where
// the real client sits, against the shipped API on the container's loopback.
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC042_API ?? "http://127.0.0.1:3000";
const password = process.env.RC042_AUTH_PASSWORD ?? "";
const workspaceId = process.env.RC042_WORKSPACE ?? "";
const bots = JSON.parse(process.env.RC042_BOTS ?? "{}") as Record<string, string>;
const displayA = process.env.RC042_DISPLAY_A ?? ":99";
const displayB = process.env.RC042_DISPLAY_B ?? ":98";
const previewMs = Number(process.env.RC042_PREVIEW_MS ?? "12000");
const record: any = { result: "unverified", scope: "RC-042 preview per Bot, reconnect, authorization" };

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function login() {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (response.status !== 200) throw Error(`login_${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0];
}

/** What the display itself shows, straight from ImageMagick — the reference the preview must equal. */
function referenceFrame(display: string) {
  const result = Bun.spawnSync(["import", "-window", "root", "png:-"], {
    env: { ...process.env, DISPLAY: display, SOURCE_DATE_EPOCH: "0" },
    stdout: "pipe", stderr: "pipe", timeout: 20_000,
  });
  if (result.exitCode !== 0) throw Error(`reference_capture_${display}_${result.stderr.toString().slice(0, 200)}`);
  return new Uint8Array(result.stdout);
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
    rawBody: JSON.stringify(body ?? ""),
  };
}

async function frame(botId: string, previewCookie: string) {
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/screen/preview/frame?botId=${botId}`, {
    headers: { cookie: previewCookie ? `${cookie}; ${previewCookie}` : cookie },
    signal: AbortSignal.timeout(30_000),
  });
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("image/png")) {
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), body: null as any };
  }
  return { status: response.status, bytes: null, body: await response.json().catch(() => null) as any };
}

let cookie = "";
try {
  cookie = await login();
  const botA = bots.PreviewA;
  const botB = bots.PreviewB;
  if (!workspaceId || !botA || !botB) throw Error("fixture_missing");

  const refA = sha(referenceFrame(displayA));
  const refB = sha(referenceFrame(displayB));
  if (refA === refB) throw Error("fixture_displays_identical");

  // Open the preview for Bot A while the client navigates.
  const openedA = await preview(botA);
  if (openedA.status !== 200 || !openedA.cookie) throw Error(`preview_a_${openedA.status}_${JSON.stringify(openedA.body)}`);
  const frameA = await frame(botA, openedA.cookie);
  if (frameA.status !== 200) throw Error(`frame_a_${frameA.status}_${JSON.stringify(frameA.body)}`);
  if (sha(frameA.bytes!) !== refA) throw Error("preview_a_showed_the_wrong_screen");

  // The token is never in the body or the URL, only in the httpOnly cookie.
  if (openedA.setCookie === "" || !openedA.setCookie.toLowerCase().includes("httponly")) throw Error(`cookie_not_httponly_${openedA.setCookie}`);
  const tokenValue = openedA.setCookie.split("rc_screen_preview=")[1].split(";")[0];
  if (openedA.rawBody.includes(tokenValue)) throw Error("token_leaked_into_the_response_body");

  // Switch Bot: a different screen, and A's cookie must not read it.
  const openedB = await preview(botB);
  if (openedB.status !== 200 || !openedB.cookie) throw Error(`preview_b_${openedB.status}`);
  const frameB = await frame(botB, openedB.cookie);
  if (frameB.status !== 200) throw Error(`frame_b_${frameB.status}`);
  if (sha(frameB.bytes!) !== refB) throw Error("preview_b_showed_the_wrong_screen");
  const crossed = await frame(botB, openedA.cookie);
  if (crossed.status !== 409 || crossed.body?.error !== "preview_required") throw Error(`bot_a_read_bot_b_${crossed.status}_${JSON.stringify(crossed.body)}`);

  // Back to A: the reconnect path rotates the token and the old one dies.
  const refreshed = await fetch(`${base}/api/workspaces/${workspaceId}/screen/preview/refresh`, {
    method: "POST",
    headers: { cookie: `${cookie}; ${openedA.cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ botId: botA }),
    signal: AbortSignal.timeout(30_000),
  });
  if (refreshed.status !== 200) throw Error(`refresh_${refreshed.status}`);
  const rotatedCookie = `rc_screen_preview=${refreshed.headers.get("set-cookie")!.split("rc_screen_preview=")[1].split(";")[0]}`;
  const oldCookieFrame = await frame(botA, openedA.cookie);
  if (oldCookieFrame.status !== 409) throw Error(`old_preview_cookie_still_worked_${oldCookieFrame.status}`);
  const frameAfterRefresh = await frame(botA, rotatedCookie);
  if (frameAfterRefresh.status !== 200 || sha(frameAfterRefresh.bytes!) !== refA) throw Error("rotated_cookie_did_not_serve_the_same_screen");
  const refreshedBody = await refreshed.json() as any;
  if (refreshedBody.previewId !== openedA.body.previewId) throw Error("refresh_changed_the_preview_identity");

  // A preview that has run out of time stops.
  await delay(previewMs + 1_500);
  const expired = await frame(botA, rotatedCookie);
  if (expired.status !== 409) throw Error(`expired_preview_still_served_${expired.status}`);

  // Another workspace's preview cookie is not this workspace's.
  const otherWorkspace = await fetch(`${base}/api/workspaces`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "rc042-other" }),
  }).then((response) => response.json() as any);
  const foreign = await fetch(`${base}/api/workspaces/${otherWorkspace.id}/screen/preview`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ botId: botA }),
  });
  const foreignBody = await foreign.json().catch(() => null) as any;
  if (foreign.status !== 200 || !foreignBody?.previewId) throw Error(`preview_in_second_workspace_${foreign.status}_${JSON.stringify(foreignBody)}`);
  // A preview belongs to the workspace it was opened for: the cookie from the
  // first workspace must not serve the second workspace's screen.
  const foreignCookie = `rc_screen_preview=${foreign.headers.get("set-cookie")!.split("rc_screen_preview=")[1].split(";")[0]}`;
  const crossWorkspace = await fetch(`${base}/api/workspaces/${otherWorkspace.id}/screen/preview/frame?botId=${botA}`, {
    headers: { cookie: `${cookie}; ${openedA.cookie}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (crossWorkspace.status !== 409) throw Error(`first_workspace_cookie_read_the_second_workspace_${crossWorkspace.status}`);
  const ownWorkspaceFrame = await fetch(`${base}/api/workspaces/${otherWorkspace.id}/screen/preview/frame?botId=${botA}`, {
    headers: { cookie: `${cookie}; ${foreignCookie}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (ownWorkspaceFrame.status !== 200) throw Error(`second_workspace_preview_did_not_serve_${ownWorkspaceFrame.status}`);

  record.journey = {
    displays: { a: displayA, b: displayB, shaA: refA.slice(0, 16), shaB: refB.slice(0, 16) },
    previewA: { status: openedA.status, frame: frameA.status, matchedDisplayA: true },
    previewB: { status: openedB.status, frame: frameB.status, matchedDisplayB: true },
    crossRead: { status: crossed.status, error: crossed.body?.error },
    tokenExposure: { httpOnlyCookie: true, inResponseBody: false },
    reconnect: { refreshStatus: refreshed.status, oldCookieStatus: oldCookieFrame.status, newCookieStatus: frameAfterRefresh.status, samePreviewId: true },
    expiry: { status: expired.status },
    authorization: { secondWorkspacePreview: foreign.status, firstWorkspaceCookieOnSecondWorkspace: crossWorkspace.status, secondWorkspaceOwnCookie: ownWorkspaceFrame.status },
  };
  record.result = "preview_served_each_bots_own_screen_reconnected_and_stayed_authorized_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
}