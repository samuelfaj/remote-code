import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../app";

const volumeName = process.env.RC031_PROOF_VOLUME;
const image = process.env.RC031_PROOF_IMAGE;
const dataRoot = process.env.RC031_PROOF_DATA_ROOT;
const supported = process.platform === "linux" && process.getuid?.() === 0 && !!volumeName && !!image && !!dataRoot;

it.skipIf(!supported)("binds real Linux PTY input, output and lifecycle to one login and one protected workspace", async () => {
  const name = `rc031-${randomUUID()}`;
  const databasePath = join(dataRoot!, `${name}.sqlite`);
  const password = randomBytes(32).toString("base64url");
  process.env.RC031_PRIVATE_BACKEND_SENTINEL = randomBytes(32).toString("hex");
  const app = createApi(databasePath, undefined, { password, sessionTtlMs: 120_000 }, { volumeName: volumeName!, image: image! })
    .listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server!.port}`;
  async function call(path: string, cookie = "", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  let cookieA = "", cookieB = "", terminalId = "", workspaceId = "";
  try {
    const loginA = await call("/api/auth/login", "", "POST", { password, requestId: randomUUID() });
    const loginB = await call("/api/auth/login", "", "POST", { password, requestId: randomUUID() });
    expect(loginA.status).toBe(200); expect(loginB.status).toBe(200);
    cookieA = loginA.cookie!; cookieB = loginB.cookie!;
    expect(!!cookieA && !!cookieB && cookieA !== cookieB).toBe(true);
    expect((await call("/api/auth/session", cookieA)).body.userId).toBe((await call("/api/auth/session", cookieB)).body.userId);
    expect((await call("/api/workspaces", cookieA, "POST", { name, requestId: randomUUID() })).status).toBe(201);
    const listed = await call("/api/workspaces", cookieA);
    workspaceId = listed.body.workspaces.find((row: any) => row.name === name).id;
    const workspace = `/api/workspaces/${workspaceId}`;
    expect((await call(`${workspace}/folder`, cookieA, "POST", { requestId: randomUUID() })).status).toBe(200);
    const folder = join(dataRoot!, "workspaces", workspaceId);
    expect(lstatSync(folder).uid).toBe(65534); expect(lstatSync(folder).gid).toBe(65534);
    const seed = `source-${randomUUID()}`;
    expect((await call(`${workspace}/files`, cookieA, "POST", { requestId: randomUUID(), path: "seed.txt", content: seed })).status).toBe(201);
    expect(lstatSync(join(folder, "seed.txt")).uid).toBe(65534);
    const startBody = { requestId: randomUUID(), cols: 80, rows: 24 };
    const started = await call(`${workspace}/terminals`, cookieA, "POST", startBody);
    if (started.status !== 201) throw new Error(`terminal_start_${started.status}_${started.body.error}`);
    terminalId = started.body.terminalId;
    expect(started.body).toMatchObject({ requestId: startBody.requestId, workspaceId, state: "running" });
    const terminal = `/api/terminals/${terminalId}`;
    const db = new Database(databasePath, { readonly: true });
    const reserved = db.query<any, [string]>("SELECT * FROM terminal_sessions WHERE terminal_id = ?").get(terminalId);
    db.close();
    expect(reserved.folder_device).toBe(String(lstatSync(folder).dev)); expect(reserved.folder_inode).toBe(String(lstatSync(folder).ino));
    const replay = await call(`${workspace}/terminals`, cookieA, "POST", startBody);
    expect(replay.status).toBe(200); expect(replay.body.terminalId).toBe(terminalId);
    expect((await call(`${workspace}/terminals`, cookieA, "POST", { ...startBody, cols: 81 })).status).toBe(409);
    expect((await call(`${workspace}/terminals`, cookieB, "POST", startBody)).status).toBe(404);
    for (const [path, method, body] of [[terminal, "GET", undefined], [`${workspace}/terminals/receipts/${startBody.requestId}`, "GET", undefined], [`${terminal}/input`, "POST", { sequence: 1, text: "echo forbidden\n" }], [`${terminal}/resize`, "POST", { cols: 90, rows: 30 }], [`${terminal}/stop`, "POST", undefined]] as const) {
      const rejected = await call(path, cookieB, method, body);
      expect(rejected.status).toBe(404); expect(rejected.body).toEqual({ error: "not_found" });
    }
    expect((await call(`${workspace}/terminals`, cookieB)).body.terminals).toEqual([]);
    expect((await call(terminal)).status).toBe(401);
    let offset = 0, output = "";
    async function until(pattern: RegExp, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      while (!pattern.test(output)) {
        expect(Date.now() < deadline).toBe(true);
        const snapshot = await call(`${terminal}?offset=${offset}`, cookieA);
        expect(snapshot.status).toBe(200); expect(snapshot.body.outputAvailable).toBe(true);
        const bytes = Buffer.from(snapshot.body.outputBase64, "base64");
        expect(bytes.length <= 16 * 1024).toBe(true);
        output += bytes.toString("utf8"); offset = snapshot.body.nextOffset;
        await delay(25);
      }
    }
    let sequence = 0;
    async function input(text: string) {
      const result = await call(`${terminal}/input`, cookieA, "POST", { sequence: ++sequence, text });
      expect(result.status).toBe(200); expect(result.body.sequence).toBe(sequence);
      return { sequence, text };
    }
    const marker = `PTY_${randomUUID().replaceAll("-", "")}`;
    await input(`stty -echo; printf '\\n${marker}:uid=%s,size=%s,pwd=%s\\n' "$(id -u)" "$(stty size)" "$(pwd)"; cat seed.txt; printf '\\n${marker}:ready\\n'\n`);
    await until(new RegExp(`${marker}:ready\\r?\\n`));
    expect(output.includes(`${marker}:uid=65534,size=24 80,pwd=/workspace`)).toBe(true); expect(output.includes(seed)).toBe(true);
    expect((await call(`${terminal}/resize`, cookieA, "POST", { cols: 100, rows: 35 })).status).toBe(200);
    const resizeInput = await input(`stty size; printf '\\n${marker}:resize\\n'\n`);
    await until(new RegExp(`${marker}:resize\\r?\\n`)); expect(output.includes("35 100")).toBe(true);
    expect((await call(`${terminal}/input`, cookieA, "POST", resizeInput)).status).toBe(200);
    expect((await call(`${terminal}/input`, cookieA, "POST", { ...resizeInput, text: "echo different\n" })).status).toBe(409);
    expect((await call(`${terminal}/input`, cookieA, "POST", { sequence: sequence + 2, text: "echo gap\n" })).status).toBe(409);
    const tokenPath = join(dataRoot!, "backend-private-token"); writeFileSync(tokenPath, randomBytes(32), { mode: 0o600 });
    const parentName = process.env.RC031_PROOF_API_CONTAINER!;
    expect(/^[a-zA-Z0-9_.-]+$/.test(parentName)).toBe(true);
    const parentPid = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ socketPath: "/var/run/docker.sock", path: `/v1.47/containers/${parentName}/json` }, (response) => {
        let bytes = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { bytes += chunk; });
        response.on("error", reject); response.on("end", () => {
          try { expect(response.statusCode).toBe(200); resolve(JSON.parse(bytes).State.Pid); } catch (error) { reject(error); }
        });
      });
      request.setTimeout(4000, () => request.destroy(new Error("parent_identity_read_unavailable")));
      request.on("error", reject); request.end();
    });
    expect(Number.isSafeInteger(parentPid) && parentPid > 0).toBe(true);
    await input(`printf '\\n${marker}:security\\n'; env; if cat /proc/${parentPid}/environ >/dev/null 2>&1; then echo ENV_READABLE; else echo ENV_DENIED; fi; if [ -r '${databasePath}' ]; then echo DB_READABLE; else echo DB_DENIED; fi; if [ -r '${tokenPath}' ]; then echo TOKEN_READABLE; else echo TOKEN_DENIED; fi; if [ -S /var/run/docker.sock ]; then echo SOCKET_PRESENT; else echo SOCKET_DENIED; fi; printf '\\n${marker}:security-done\\n'\n`);
    await until(new RegExp(`${marker}:security-done\\r?\\n`));
    expect(output.includes("ENV_DENIED") && output.includes("DB_DENIED") && output.includes("TOKEN_DENIED") && output.includes("SOCKET_DENIED")).toBe(true);
    expect(output.includes("RC031_PRIVATE_BACKEND_SENTINEL=") || output.includes("REMOTECODE_AUTH_PASSWORD=")).toBe(false);
    const appended = `terminal-${randomUUID()}`;
    await input(`printf '%s' '${appended}' >> seed.txt; printf '\\n${marker}:written\\n'\n`);
    await until(new RegExp(`${marker}:written\\r?\\n`));
    const current = await call(`${workspace}/files/content?path=seed.txt`, cookieA);
    expect(current.status).toBe(200); expect(current.body.content).toBe(seed + appended);
    expect(current.body.version).toBe(createHash("sha256").update(seed + appended).digest("hex"));
    expect(readFileSync(join(folder, "seed.txt"), "utf8")).toBe(seed + appended); expect(lstatSync(join(folder, "seed.txt")).uid).toBe(65534);
    await input(`head -c 131072 /dev/zero | tr '\\000' Z; printf '\\n${marker}:noisy-end\\n'\n`);
    await until(new RegExp(`${marker}:noisy-end\\r?\\n`));
    const retained = await call(`${terminal}?offset=0`, cookieA);
    expect(retained.body.gap).toBe(true); expect(retained.body.endOffset - retained.body.baseOffset).toBe(64 * 1024);
    expect((await call("/api/health/live")).status).toBe(200);
    await input("exit 7\n");
    let ended: any;
    const deadline = Date.now() + 10_000;
    do { ended = await call(terminal, cookieA); await delay(50); } while (ended.body.state !== "exited" && Date.now() < deadline);
    expect(ended.status).toBe(200); expect(ended.body).toMatchObject({ state: "exited", exitCode: 7, cleanup: "removed" });
    expect((await call(`${workspace}/terminals`, cookieA, "POST", startBody)).body.terminalId).toBe(terminalId);
    const audit = new Database(databasePath, { readonly: true });
    try {
      expect(audit.query("SELECT count(*) n FROM terminal_sessions").get()).toEqual({ n: 1 });
      expect(audit.query("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    } finally { audit.close(); }
  } finally {
    if (terminalId && cookieA) await call(`/api/terminals/${terminalId}/stop`, cookieA, "POST").catch(() => undefined);
    if (cookieA) await call("/api/auth/logout", cookieA, "POST", { requestId: randomUUID() }).catch(() => undefined);
    await app.stop();
    delete process.env.RC031_PRIVATE_BACKEND_SENTINEL;
  }
}, 60_000);
