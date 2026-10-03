import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const volumeName = process.env.RC031_PROOF_VOLUME;
const image = process.env.RC031_PROOF_IMAGE;
const root = process.env.RC031_PROOF_DATA_ROOT;
const supported = process.platform === "linux" && process.getuid?.() === 0 && !!volumeName && !!image && !!root;

it.skipIf(!supported)("reconciles a surviving PTY after a real API process crash without executing start again", async () => {
  const name = `rc031-${randomUUID()}`;
  const path = join(root!, `${name}.sqlite`);
  const password = randomBytes(32).toString("base64url");
  let cookie = "";
  async function request(base: string, route: string, method = "GET", body?: unknown) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  async function start() {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
    const port = probe.port;
    await probe.stop(true);
    if (!port) throw new Error("terminal_test_port_unavailable");
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../index.ts", import.meta.url))], {
      env: { ...process.env, DATABASE_PATH: path, API_PORT: String(port), REMOTECODE_AUTH_PASSWORD: password, REMOTECODE_AUTH_SESSION_TTL_MS: "120000", REMOTECODE_TERMINAL_VOLUME: volumeName!, REMOTECODE_TERMINAL_IMAGE: image! },
      stdout: "pipe", stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          let output = "";
          for (;;) {
            const part = await reader.read();
            if (part.done) throw new Error("terminal_test_api_exited_before_startup");
            output += new TextDecoder().decode(part.value);
            if (output.includes(`Elysia API listening on ${port}`)) return;
            if (output.length > 10000) throw new Error("terminal_test_startup_output_invalid");
          }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("terminal_test_startup_timeout")), 5000); }),
      ]);
      const base = `http://127.0.0.1:${port}`;
      expect((await request(base, "/api/health/ready")).body).toEqual({ status: "ready" });
      return { child, base };
    } catch (error) {
      child.kill(); await child.exited;
      throw error;
    } finally {
      clearTimeout(timer); reader.releaseLock();
    }
  }
  async function inspect(container: string) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const connection = httpRequest({ socketPath: "/var/run/docker.sock", path: `/v1.47/containers/${container}/json`, method: "GET", agent: false }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }); } catch (error) { reject(error); }
        });
      });
      connection.setTimeout(5000, () => connection.destroy(new Error("terminal_test_engine_timeout")));
      connection.on("error", reject); connection.end();
    });
  }
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  let database: Database | undefined;
  let completed = false;
  try {
    first = await start();
    database = new Database(path, { readonly: true, create: false });
    database.exec("PRAGMA busy_timeout = 250");
    const login = await request(first.base, "/api/auth/login", "POST", { password, requestId: randomUUID() });
    expect(login.status).toBe(200); cookie = login.cookie!;
    const workspace = await request(first.base, "/api/workspaces", "POST", { name, requestId: randomUUID() });
    expect(workspace.status).toBe(201);
    const id = workspace.body.id;
    expect((await request(first.base, `/api/workspaces/${id}/folder`, "POST", { requestId: randomUUID() })).status).toBe(200);
    const body = { requestId: randomUUID(), cols: 80, rows: 24 };
    const started = await request(first.base, `/api/workspaces/${id}/terminals`, "POST", body);
    if (started.status !== 201) throw new Error(`terminal_test_start_${started.status}_${started.body.error}`);
    const terminalId = started.body.terminalId;
    expect((await request(first.base, `/api/terminals/${terminalId}/input`, "POST", { sequence: 1, text: "stty -echo; printf ready > restart-ready.txt; while :; do sleep 1; done\n" })).status).toBe(200);
    const ready = join(root!, "workspaces", id, "restart-ready.txt");
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < readyDeadline) await delay(25);
    expect(readFileSync(ready, "utf8")).toBe("ready");
    const original = database.query<any, [string]>("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(terminalId)!;
    expect(original).toMatchObject({ state: "running", start_sent: 1, input_sequence: 1, cleanup: "pending" });
    expect((await inspect(original.container_id)).body.State.Running).toBe(true);
    first.child.kill("SIGKILL");
    expect(await first.child.exited).not.toBe(0);
    const surviving = await inspect(original.container_id);
    expect(surviving.status).toBe(200); expect(surviving.body.State.Running).toBe(true);
    expect(database.query("SELECT state,start_sent,input_sequence FROM terminal_sessions WHERE terminal_id = ?").get(terminalId)).toEqual({ state: "running", start_sent: 1, input_sequence: 1 });
    second = await start();
    expect(second.child.pid).not.toBe(first.child.pid);
    expect((await request(second.base, `/api/terminals/${terminalId}/input`, "POST", { sequence: 2, text: "echo forbidden\n" })).status).toBe(409);
    const deadline = Date.now() + 15000;
    let current: any;
    do {
      current = database.query("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(terminalId);
      if (current.cleanup === "removed") break;
      await delay(50);
    } while (Date.now() < deadline);
    expect(current).toMatchObject({ terminal_id: terminalId, request_id: body.requestId, container_id: original.container_id, state: "exited", start_sent: 1, stop_sent: 1, remove_sent: 1, input_sequence: 1, cleanup: "removed" });
    expect(Number.isInteger(current.exit_code)).toBe(true);
    expect((await inspect(original.container_id)).status).toBe(404);
    const receipt = await request(second.base, `/api/workspaces/${id}/terminals/receipts/${body.requestId}`);
    expect(receipt.status).toBe(200);
    const poll = await request(second.base, `/api/terminals/${terminalId}`);
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ state: "exited", exitCode: current.exit_code, cleanup: "removed", outputAvailable: false, gap: true });
    expect(poll.body).not.toHaveProperty("outputBase64");
    const replay = await request(second.base, `/api/workspaces/${id}/terminals`, "POST", body);
    expect(replay.status).toBe(200); expect(replay.body).toEqual(receipt.body);
    expect(replay.body).toMatchObject({ terminalId, requestId: body.requestId, state: "exited", cleanup: "removed" });
    expect((await request(second.base, `/api/workspaces/${id}/terminals`, "POST", { ...body, cols: 81 })).status).toBe(409);
    expect((await inspect(`remotecode-terminal-${terminalId}`)).status).toBe(404);
    expect(database.query("SELECT count(*) count FROM terminal_sessions").get()).toEqual({ count: 1 });
    expect(database.query("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(terminalId)).toEqual(current);
    expect(readFileSync(ready, "utf8")).toBe("ready");
    expect((await request(second.base, "/api/auth/logout", "POST", { requestId: randomUUID() })).status).toBe(200);
    expect(database.query("SELECT count(*) count FROM sessions").get()).toEqual({ count: 0 });
    expect(database.query("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    console.log(JSON.stringify({ scenario: "terminal-api-process-crash", firstPid: first.child.pid, secondPid: second.child.pid, terminalId, containerId: original.container_id, survivingBeforeRestart: true, sameRequestReceiptOnly: true, state: current.state, cleanup: current.cleanup }));
    completed = true;
  } finally {
    if (first && first.child.exitCode === null) { first.child.kill(); await first.child.exited; }
    if (second && second.child.exitCode === null) { second.child.kill(); await second.child.exited; }
    database?.close();
    if (!completed) {
      const { terminalsFeature } = await import("./terminals");
      await terminalsFeature(path, { volumeName: volumeName!, image: image! }).stopAll();
    }
  }
}, 45000);
