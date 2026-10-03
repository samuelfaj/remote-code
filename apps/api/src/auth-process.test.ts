import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "../../../packages/client/src";

it("preserves login and revocation outcomes across real API process restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rc018-auth-process-"));
  const path = join(directory, "host.sqlite");
  const password = `process-test-${crypto.randomUUID()}`;
  async function start() {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
    const port = probe.port;
    await probe.stop(true);
    if (!port) throw new Error("Could not allocate test port");
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./index.ts", import.meta.url))], {
      env: { ...process.env, DATABASE_PATH: path, API_PORT: String(port), REMOTECODE_AUTH_PASSWORD: password, REMOTECODE_AUTH_SESSION_TTL_MS: "60000" },
      stdout: "pipe", stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          let output = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("API process exited before startup");
            output += new TextDecoder().decode(chunk.value);
            if (output.includes(`Elysia API listening on ${port}`)) return;
            if (output.length > 10_000) throw new Error("Unexpected API startup output");
          }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("API startup timed out")), 3000); }),
      ]);
      const client = createApiClient(`http://127.0.0.1:${port}`, { timeoutMs: 1000 });
      const ready = await client.api.health.ready.get();
      expect(ready.data).toEqual({ status: "ready" });
      return { child, client };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
  try {
    const loginId = crypto.randomUUID();
    const revokeId = crypto.randomUUID();
    const first = await start();
    try {
      const accepted = await first.client.api.auth.login.post({ password, requestId: loginId });
      expect(accepted.error).toBeNull();
      expect(accepted.data).toMatchObject({ receipt: { requestId: loginId, outcome: "session_created" } });
    } finally { first.child.kill(); await first.child.exited; }
    const second = await start();
    try {
      const original = await second.client.api.auth.receipts({ requestId: loginId }).lookup.post({ password });
      expect(original.data).toMatchObject({ receipt: { requestId: loginId, outcome: "session_created" }, sessionStatus: "active" });
      const revoked = await second.client.api.auth.login({ loginRequestId: loginId }).revoke.post({ password, requestId: revokeId });
      expect(revoked.error).toBeNull();
      expect(revoked.data).toMatchObject({ requestId: revokeId, outcome: "login_revoked" });
    } finally { second.child.kill(); await second.child.exited; }
    const third = await start();
    try {
      const receipt = await third.client.api.auth.receipts({ requestId: revokeId }).lookup.post({ password });
      expect(receipt.data).toMatchObject({ receipt: { requestId: revokeId, outcome: "login_revoked" } });
      const replay = await third.client.api.auth.login.post({ password, requestId: loginId });
      expect(replay.data).toMatchObject({ receipt: { requestId: loginId, outcome: "session_created" } });
      const database = new Database(path, { readonly: true });
      try {
        expect(database.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
        expect(database.query("SELECT count(*) AS count FROM auth_requests").get()).toEqual({ count: 2 });
      } finally { database.close(); }
    } finally { third.child.kill(); await third.child.exited; }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 10_000);
