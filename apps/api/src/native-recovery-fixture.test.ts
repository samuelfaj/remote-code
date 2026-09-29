import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, isUnknownOutcomeError } from "../../../packages/client/src";
import { createNativeRecoveryTestApi } from "../test-support/native-recovery";

it("injects native response loss only after the real action commits and preserves canonical recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rc018-native-fixture-"));
  const password = "native-fixture-password";
  const app = createNativeRecoveryTestApi(join(directory, "host.sqlite"), password);
  const login = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing authenticated native test session");
  const server = app.listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("Native fixture did not listen");
  const origin = `http://127.0.0.1:${port}`;
  const requestId = crypto.randomUUID();
  const client = createApiClient(origin, { timeoutMs: 100, headers: { cookie } });
  try {
    expect((await fetch(`${origin}/__test__/lose-action-response`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${origin}/__test__/lose-action-response`, { method: "POST", headers: { cookie } })).status).toBe(200);
    const write = await client.api.actions.post({ requestId, action: "native response loss proof" });
    expect(isUnknownOutcomeError(write.error)).toBe(true);
    const history = await client.api.actions.get();
    if (!history.data || !("actions" in history.data) || !Array.isArray(history.data.actions)) throw new Error("Missing real history");
    expect(history.data.actions).toHaveLength(1);
    expect((await client.api.actions.receipts({ requestId }).get()).status).toBe(503);
    const recovered = await client.api.actions.receipts({ requestId }).get();
    expect(recovered.error).toBeNull();
    expect(recovered.data).toEqual(history.data.actions[0]!);
    const diagnostics = await fetch(`${origin}/__test__/response-loss`, { headers: { cookie } });
    const values = await diagnostics.json() as {
      lostResponse: boolean;
      failedRead: boolean;
      receiptReads: number;
      receiptReadAtMs: number[];
      actionPosts: number;
      requestId: string;
    };
    expect(values).toMatchObject({ lostResponse: true, failedRead: true, receiptReads: 2, actionPosts: 1, requestId });
    expect(values.receiptReadAtMs).toHaveLength(2);
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
