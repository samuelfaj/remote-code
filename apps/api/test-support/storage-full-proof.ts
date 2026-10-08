import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { createApi } from "../src/app";

const root = process.env.RC_STORAGE_PROOF_MOUNT!;
const proofRoot = process.env.RC_STORAGE_PROOF_WORK_DIR!;
if (!root || !realpathSync(root).startsWith(`${realpathSync(proofRoot)}/full-volume.`)
  || !root.endsWith("/mnt") || existsSync(`${root}/filler.bin`) || existsSync(`${root}/host.sqlite`)) {
  throw new Error("A fresh owned mounted database and filler path are required");
}
const path = `${root}/host.sqlite`;
const password = "rc020-local-full-volume-passphrase";
const app = createApi(path, undefined, { password, webOrigin: "http://localhost:5173" }).listen({ hostname: "127.0.0.1", port: 0 });
let current = app;
let filler: number | undefined;
let fillerRemoved = false;
const fillerPath = `${root}/filler.bin`;
const origin = () => `http://127.0.0.1:${current.server!.port}`;
const post = (route: string, body: object, cookie = "") => fetch(`${origin()}${route}`, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
});
const read = (route: string, cookie = "") => fetch(`${origin()}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(12000) });
try {
  const login = await post("/api/auth/login", { password });
  if (login.status !== 200) throw Error(`Baseline login ${login.status}`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const baselineId = crypto.randomUUID();
  const baseline = await post("/api/actions", { action: "baseline before full volume", requestId: baselineId }, cookie);
  if (baseline.status !== 201) throw Error(`Baseline action ${baseline.status}`);
  const baselineReceipt = await baseline.json();
  const baselineLookup = await read(`/api/actions/receipts/${baselineId}`, cookie);
  if (baselineLookup.status !== 200) throw Error(`Baseline receipt ${baselineLookup.status}`);
  const canonicalBaseline = await baselineLookup.json() as { id?: string; action?: string };
  if (baselineReceipt.id !== canonicalBaseline.id || canonicalBaseline.action !== "baseline before full volume") throw Error("Baseline action receipt mismatch");
  console.log(JSON.stringify({ phase: "baseline", id: baselineId, actionId: baselineReceipt.id, receipt: canonicalBaseline }));

  filler = openSync(fillerPath, "wx");
  const chunk = Buffer.alloc(4096, 0x61);
  let written = 0;
  let sawFull = false;
  for (; written <= 134217728; written += chunk.length) {
    try { writeSync(filler, chunk); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOSPC") { sawFull = true; break; }
      throw error;
    }
  }
  if (!sawFull) throw Error("A bounded 128 MiB fill did not reach ENOSPC; volume proof unverified");
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
  unlinkSync(fillerPath); fillerRemoved = true;
  await current.stop(true);
  current = createApi(path, undefined, { password, webOrigin: "http://localhost:5173" }).listen({ hostname: "127.0.0.1", port: 0 });
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
  console.log(JSON.stringify({ phase: "reconcile_after_restart", ready: recoveredReady.status, baseline: baselineAfter.status, baselineReceipt: observedBaseline, previous, baselineMapping, attempted: attemptedAfter.status, attemptedReceipt: observedAttempt, counts, attempts, integrity }));
  if (recoveredReady.status !== 200 || observedBaseline?.id !== canonicalBaseline.id || observedBaseline?.action !== canonicalBaseline.action
    || previous?.id !== baselineReceipt.id || previous?.action !== canonicalBaseline.action || baselineMapping?.action_id !== baselineReceipt.id
    || counts.n < 1 || integrity.length !== 1 || (integrity[0] as { quick_check?: string }).quick_check !== "ok") {
    throw Error("Prior action, receipt or readiness did not recover");
  }
  if (counts.n !== 1 + attempts.length) throw Error("Unexpected action without a matching operation receipt");
  if (outcome.status === 201) {
    const accepted = JSON.parse(outcome.body) as { id?: string; action?: string };
    const mappedId = (attempts[0] as { action_id?: string } | undefined)?.action_id;
    const canonical = observedAttempt as { id?: string; action?: string } | null;
    if (attempts.length !== 1 || !mappedId || accepted.id !== mappedId || canonical?.id !== mappedId
      || canonical.action !== "must not be falsely confirmed") throw Error("Accepted write lacks its exact durable result and receipt");
  }
  if (outcome.status !== 201 && attempts.length > 0) throw Error("Unknown outcome: effect committed despite non-successful response");
  if (outcome.status === 0) throw Error("Transport outcome unknown; no retry permitted");
  const fresh = await post("/api/actions", { action: "after capacity restored", requestId: crypto.randomUUID() }, cookie);
  console.log(JSON.stringify({ phase: "safe_distinct_write", status: fresh.status }));
  if (fresh.status !== 201) throw Error("Distinct write not accepted after recovery");
  if (ready.status !== 503 || outcome.status === 201) throw Error("Volume exhaustion behavior does not satisfy RC-020 degraded-state proof");
} finally {
  if (filler !== undefined) {
    try { closeSync(filler); } catch (error) { console.error("Filler handle cleanup failed", error); }
  }
  if (!fillerRemoved) { try { unlinkSync(fillerPath); } catch (error) { console.error("Filler file cleanup failed", error); } }
  await current.stop(true);
}
