import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";

const root = "/var/lib/remotecode";
const path = `${root}/remotecode.sqlite`;
const apiPort = 39231;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const apiScript = "/workspace/apps/api/test-support/storage-linux-api.ts";
const password = "rc020-local-full-volume-passphrase";
if (process.env.DATABASE_PATH !== path) throw Error("Expected isolated database path");
const mounts = (await Bun.file("/proc/mounts").text()).split("\n");
if (!mounts.some((line) => line.split(" ")[1] === root && line.split(" ")[2] === "tmpfs")) throw Error("Database directory is not a dedicated tmpfs");
const fillerPath = `${root}/filler.bin`;
if (existsSync(fillerPath) || existsSync(path) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw Error("Expected fresh database and filler paths");
console.log(JSON.stringify({ phase: "environment", platform: process.platform, arch: process.arch, databaseFilesystem: "tmpfs", limit: "48MiB" }));

let filler: number | undefined;
let fillerRemoved = false;
let apiProcess: ReturnType<typeof spawn> | undefined;
let spawnError: Error | undefined;

function startApiProcess() {
  spawnError = undefined;
  const child = spawn(process.execPath, [apiScript], {
    cwd: "/workspace",
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      DATABASE_PATH: path,
      REMOTECODE_AUTH_PASSWORD: password,
      REMOTECODE_WEB_ORIGIN: "http://localhost:5173",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (error) => { spawnError = error; });
  console.log(JSON.stringify({ phase: "api_process_started", pid: child.pid, databasePath: path }));
  return child;
}

async function waitForApi(child: ReturnType<typeof spawn>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`API process exited before readiness: ${child.exitCode}/${child.signalCode}`);
    try {
      const response = await fetch(`${apiOrigin}/api/health/live`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw Error("API process did not become live");
}

async function stopApi(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const exited = await Promise.race([exit.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) {
      const forceExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      if (!await Promise.race([forceExit.then(() => true), Bun.sleep(5000).then(() => false)])) {
        throw Error(`API process ${child.pid} did not stop after SIGKILL`);
      }
    }
  }
  if (child.exitCode !== 0) throw Error(`API process ${child.pid} exited unexpectedly: ${child.exitCode}/${child.signalCode}`);
  console.log(JSON.stringify({ phase: "api_process_stopped", pid: child.pid, exitCode: child.exitCode }));
}

const post = (route: string, body: object, cookie = "") => fetch(`${apiOrigin}${route}`, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
});
const read = (route: string, cookie = "") => fetch(`${apiOrigin}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(12000) });

try {
  apiProcess = startApiProcess();
  await waitForApi(apiProcess);
  const initialApiPid = apiProcess.pid;
  const login = await post("/api/auth/login", { password });
  if (login.status !== 200) throw Error(`Baseline login ${login.status}`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const baselineId = crypto.randomUUID();
  const baseline = await post("/api/actions", { action: "baseline before full volume", requestId: baselineId }, cookie);
  if (baseline.status !== 201) throw Error(`Baseline action ${baseline.status}`);
  const baselineReceipt = await baseline.json() as { id?: string; action?: string };
  const baselineLookup = await read(`/api/actions/receipts/${baselineId}`, cookie);
  if (baselineLookup.status !== 200) throw Error(`Baseline receipt ${baselineLookup.status}`);
  const canonicalBaseline = await baselineLookup.json() as { id?: string; action?: string };
  if (!baselineReceipt.id || baselineReceipt.id !== canonicalBaseline.id || canonicalBaseline.action !== "baseline before full volume") throw Error("Baseline action receipt mismatch");
  console.log(JSON.stringify({ phase: "baseline", pid: initialApiPid, id: baselineId, actionId: baselineReceipt.id, receipt: canonicalBaseline }));

  filler = openSync(fillerPath, "wx");
  const chunk = Buffer.alloc(4096, 0x61);
  let written = 0;
  let sawFull = false;
  for (; written < 60 * 1024 * 1024; written += chunk.length) {
    try { writeSync(filler, chunk); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOSPC") { sawFull = true; break; }
      throw error;
    }
  }
  if (!sawFull) throw Error("A bounded 60 MiB fill did not reach ENOSPC; volume proof unverified");
  try { fsyncSync(filler); } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOSPC") throw error;
  }
  console.log(JSON.stringify({ phase: "full", observed: "ENOSPC", fillerBytes: written }));
  const ready = await read("/api/health/ready");
  console.log(JSON.stringify({ phase: "readiness_while_full", status: ready.status, body: await ready.text() }));
  const attemptedId = crypto.randomUUID();
  let outcome: { status: number; body: string };
  try {
    const attempted = await post("/api/actions", { action: "must not be falsely confirmed", requestId: attemptedId }, cookie);
    outcome = { status: attempted.status, body: await attempted.text() };
  } catch (error) {
    outcome = { status: 0, body: error instanceof Error ? error.name : "unknown_transport_error" };
  }
  console.log(JSON.stringify({ phase: "attempt_while_full", requestId: attemptedId, outcome }));
  closeSync(filler); filler = undefined;
  await stopApi(apiProcess);
  apiProcess = undefined;
  unlinkSync(fillerPath); fillerRemoved = true;

  apiProcess = startApiProcess();
  if (apiProcess.pid === initialApiPid) throw Error("API restart reused the original process ID");
  await waitForApi(apiProcess);
  console.log(JSON.stringify({ phase: "api_process_restarted", previousPid: initialApiPid, currentPid: apiProcess.pid }));
  const recoveredReady = await read("/api/health/ready");
  const baselineAfter = await read(`/api/actions/receipts/${baselineId}`, cookie);
  const observedBaseline = baselineAfter.status === 200 ? await baselineAfter.json() as { id?: string; action?: string } : null;
  const attemptedAfter = await read(`/api/actions/receipts/${attemptedId}`, cookie);
  const observedAttempt = attemptedAfter.status === 200 ? await attemptedAfter.json() : null;
  const database = new Database(path, { readonly: true, create: false });
  const counts = database.query("SELECT COUNT(*) AS n FROM actions").get() as { n: number };
  const previous = database.query("SELECT id, action FROM actions WHERE id = ?").get(baselineReceipt.id) as { id: string; action: string } | null;
  const baselineMapping = database.query("SELECT action_id FROM action_requests WHERE request_id = ?").get(baselineId) as { action_id: string } | null;
  const attempts = database.query("SELECT request_id, action_id FROM action_requests WHERE request_id = ?").all(attemptedId);
  const integrity = database.query("PRAGMA quick_check").all();
  database.close();
  console.log(JSON.stringify({ phase: "reconcile_after_process_restart", ready: recoveredReady.status, baseline: baselineAfter.status, baselineReceipt: observedBaseline, previous, baselineMapping, attempted: attemptedAfter.status, attemptedReceipt: observedAttempt, counts, attempts, integrity }));
  if (recoveredReady.status !== 200 || observedBaseline?.id !== canonicalBaseline.id || observedBaseline?.action !== canonicalBaseline.action
    || previous?.id !== baselineReceipt.id || previous?.action !== canonicalBaseline.action || baselineMapping?.action_id !== baselineReceipt.id
    || counts.n < 1 || integrity.length !== 1 || (integrity[0] as { quick_check?: string }).quick_check !== "ok") {
    throw Error("Prior action, receipt or readiness did not recover after API process restart");
  }
  if (counts.n !== 1 + attempts.length) throw Error("Unexpected action without a matching operation receipt");
  if (outcome.status === 201) {
    const accepted = JSON.parse(outcome.body) as { id?: string; action?: string };
    const mappedId = (attempts[0] as { action_id?: string } | undefined)?.action_id;
    const canonical = observedAttempt as { id?: string; action?: string } | null;
    if (attempts.length !== 1 || !mappedId || accepted.id !== mappedId || canonical?.id !== mappedId
      || canonical.action !== "must not be falsely confirmed") throw Error("Accepted write lacks its exact durable result and receipt");
  }
  if (outcome.status !== 201 && (attempts.length > 0 || attemptedAfter.status !== 404)) throw Error("Rejected write has an unresolved receipt or effect");
  if (outcome.status === 0) throw Error("Transport outcome unknown; no retry permitted");
  if (ready.status !== 503 || outcome.status !== 503 || outcome.body !== '{"error":"storage_unavailable"}') throw Error("Full-volume readiness or write did not fail closed");
  const freshId = crypto.randomUUID();
  const fresh = await post("/api/actions", { action: "after capacity restored", requestId: freshId }, cookie);
  const freshBody = await fresh.json() as { id?: string; action?: string };
  if (fresh.status !== 201 || !freshBody.id) throw Error("Distinct write not accepted after recovery");
  const freshLookup = await read(`/api/actions/receipts/${freshId}`, cookie);
  const freshReceipt = freshLookup.status === 200 ? await freshLookup.json() as { id?: string; action?: string } : null;
  const freshDb = new Database(path, { readonly: true, create: false });
  const freshRow = freshDb.query("SELECT id, action FROM actions WHERE id = ?").get(freshBody.id) as { id: string; action: string } | null;
  const freshMapping = freshDb.query("SELECT action_id FROM action_requests WHERE request_id = ?").get(freshId) as { action_id: string } | null;
  freshDb.close();
  console.log(JSON.stringify({ phase: "safe_distinct_write", status: fresh.status, lookup: freshLookup.status, receipt: freshReceipt, readback: freshRow, mapping: freshMapping }));
  if (!freshBody.id || freshRow?.id !== freshBody.id || freshRow?.action !== "after capacity restored"
    || freshLookup.status !== 200 || freshReceipt?.id !== freshBody.id || freshMapping?.action_id !== freshBody.id) throw Error("Post-recovery write did not persist");
} finally {
  if (filler !== undefined) {
    try { closeSync(filler); } catch (error) { console.error("Filler handle cleanup failed", error); }
  }
  if (!fillerRemoved && existsSync(fillerPath)) { try { unlinkSync(fillerPath); } catch (error) { console.error("Filler file cleanup failed", error); } }
  if (apiProcess) await stopApi(apiProcess);
}
