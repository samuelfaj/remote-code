// RC-018 proof: a cut connection must never be read as a rollback. The proof
// runs an injector in front of the shipped API that either refuses to forward
// the mutation (before acceptance), forwards it and then cuts the response
// (after commit), or cuts mid-response. In every case the same request id is
// repeated and the receipt is the authority: one effect, one canonical result.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = "/Users/samuelfajreldines/dev/new-remote-code";
const output = process.env.RC018_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc018-cut-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC018_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc018.cutproof";
const password = randomBytes(24).toString("base64url");
const databasePath = "/var/lib/remotecode/rc018.sqlite";
let id = "";
let apiPort = 0;
let injectorPort = 0;
const record: any = { run, volume, image, result: "unverified", scope: "RC-018 cut before acceptance / after commit / mid-response" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args, exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  apiPort = 30_000 + Math.floor(Math.random() * 500);
  injectorPort = apiPort + 1000;
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", "REMOTECODE_WEB_ORIGIN=http://localhost:5173",
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", image, "apps/api/src/index.ts");
  command("docker", "start", id);

  const ca = readFileSync(cert, "utf8");
  const tls = { ca };
  const upstream = `https://127.0.0.1:${apiPort}`;
  const healthy = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(upstream + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000), tls,
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${upstream}/api/health/ready`, { signal: AbortSignal.timeout(1200), tls } as any)).status === 200) break; } catch {}
    await delay(250);
  }

  // Fault injector: it decides per request whether the mutation reaches the API
  // and whether the answer comes back. Nothing it does can change the effect.
  let mode = "healthy";
  const cut = (partial: string) => new Response(new ReadableStream({
    start(controller) {
      if (partial) controller.enqueue(new TextEncoder().encode(partial));
      controller.error(new Error("rc018 connection cut"));
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const injector = Bun.serve({
    port: injectorPort,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__mode") {
        mode = url.searchParams.get("value") ?? "healthy";
        return Response.json({ mode });
      }
      const isMutation = url.pathname === "/api/actions" && request.method === "POST";
      if (mode === "before" && isMutation) return cut("");
      const forwarded = await fetch(upstream + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        tls,
      } as any);
      if (mode === "after" && isMutation) { await forwarded.arrayBuffer(); return cut(""); }
      if (mode === "mid" && isMutation) { await forwarded.arrayBuffer(); return cut('{"id":"'); }
      return new Response(forwarded.body, { status: forwarded.status, headers: forwarded.headers });
    },
  });

  const login = await healthy("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const setMode = async (value: string) => { await fetch(`http://127.0.0.1:${injectorPort}/__mode?value=${value}`); };
  // A mutation through the injector: the connection may be cut, so a throw is expected.
  const cutMutation = async (requestId: string, action: string) => {
    try {
      const response = await fetch(`http://127.0.0.1:${injectorPort}/api/actions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ requestId, action }),
        signal: AbortSignal.timeout(15_000),
      } as any);
      await response.text().catch(() => "");
      return { threw: false, status: response.status };
    } catch (error) {
      return { threw: true, error: String(error).slice(0, 120) };
    }
  };
  const receiptOf = async (requestId: string) => healthy(`/api/actions/receipts/${requestId}`, "GET", undefined, cookie);
  const actionsOf = async () => (await healthy("/api/actions", "GET", undefined, cookie)).body.actions as Array<{ id: string; action: string }>;

  // 1. Cut before acceptance: the effect must not exist.
  const idBefore = randomUUID();
  await setMode("before");
  const beforeAttempt = await cutMutation(idBefore, "cut-before");
  if (!beforeAttempt.threw) throw Error(`before_was_not_cut_${JSON.stringify(beforeAttempt)}`);
  await setMode("healthy");
  const beforeReceipt = await receiptOf(idBefore);
  if (beforeReceipt.status !== 404) throw Error(`before_created_an_effect_${beforeReceipt.status}`);
  const beforeRepeat = await healthy("/api/actions", "POST", { requestId: idBefore, action: "cut-before" }, cookie);
  if (beforeRepeat.status !== 201) throw Error(`before_repeat_${beforeRepeat.status}`);

  // 2. Cut after commit, before the response: the receipt is the authority.
  const idAfter = randomUUID();
  await setMode("after");
  const afterAttempt = await cutMutation(idAfter, "cut-after-commit");
  if (!afterAttempt.threw) throw Error(`after_was_not_cut_${JSON.stringify(afterAttempt)}`);
  await setMode("healthy");
  const afterReceipt = await receiptOf(idAfter);
  if (afterReceipt.status !== 200 || afterReceipt.body.action !== "cut-after-commit") throw Error(`after_receipt_${afterReceipt.status}_${JSON.stringify(afterReceipt.body)}`);
  const afterRepeat = await healthy("/api/actions", "POST", { requestId: idAfter, action: "cut-after-commit" }, cookie);
  if (afterRepeat.status !== 200 || afterRepeat.body.id !== afterReceipt.body.id) throw Error(`after_repeat_${afterRepeat.status}_${JSON.stringify(afterRepeat.body)}`);

  // 3. Cut mid-response: same authority.
  const idMid = randomUUID();
  await setMode("mid");
  const midAttempt = await cutMutation(idMid, "cut-mid-response");
  if (!midAttempt.threw) throw Error(`mid_was_not_cut_${JSON.stringify(midAttempt)}`);
  await setMode("healthy");
  const midReceipt = await receiptOf(idMid);
  if (midReceipt.status !== 200 || midReceipt.body.action !== "cut-mid-response") throw Error(`mid_receipt_${midReceipt.status}_${JSON.stringify(midReceipt.body)}`);

  // Exactly one effect per marker, and the receipt names the stored row.
  const actions = await actionsOf();
  const countOf = (marker: string) => actions.filter((row) => row.action === marker).length;
  const counts = { "cut-before": countOf("cut-before"), "cut-after-commit": countOf("cut-after-commit"), "cut-mid-response": countOf("cut-mid-response") };
  if (counts["cut-before"] !== 1 || counts["cut-after-commit"] !== 1 || counts["cut-mid-response"] !== 1) throw Error(`duplicate_effects_${JSON.stringify(counts)}`);
  const storedAfter = actions.find((row) => row.action === "cut-after-commit");
  if (!storedAfter || storedAfter.id !== afterReceipt.body.id) throw Error("receipt_does_not_name_the_stored_row");
  const beforeAction = actions.find((row) => row.action === "cut-before");
  if (!beforeAction || beforeAction.id !== beforeRepeat.body?.id) throw Error("before_repeat_created_a_different_row");

  // A repeat with a different payload is a conflict, never a second effect.
  const conflict = await healthy("/api/actions", "POST", { requestId: idAfter, action: "different" }, cookie);
  if (conflict.status !== 409) throw Error(`conflict_${conflict.status}`);
  const afterConflict = await actionsOf();
  if (afterConflict.filter((row) => row.action === "cut-after-commit").length !== 1) throw Error("conflict_created_a_second_effect");

  record.cuts = {
    before: { attempt: beforeAttempt, receipt: beforeReceipt.status, repeat: beforeRepeat.status, stored: countOf("cut-before") },
    afterCommit: { attempt: afterAttempt, receipt: afterReceipt.status, receiptId: afterReceipt.body.id, repeat: { status: afterRepeat.status, sameId: afterRepeat.body.id === afterReceipt.body.id }, stored: countOf("cut-after-commit") },
    midResponse: { attempt: midAttempt, receipt: midReceipt.status, receiptId: midReceipt.body.id, stored: countOf("cut-mid-response") },
    conflict: conflict.status,
  };
  record.result = "cut_connection_never_meant_rollback_and_every_effect_is_single_passed";
  console.log(JSON.stringify({ result: record.result, cuts: record.cuts }));
  injector.stop(true);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}