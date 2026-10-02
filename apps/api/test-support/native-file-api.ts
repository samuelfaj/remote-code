import { lstatSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createApi } from "../src/app";
import { sessionUserId } from "../src/features/auth";

const port = Number(process.env.API_PORT);
const databasePath = process.env.DATABASE_PATH;
const certPath = process.env.RC_NATIVE_TEST_TLS_CERT;
const keyPath = process.env.RC_NATIVE_TEST_TLS_KEY;
const password = process.env.REMOTECODE_AUTH_PASSWORD;
if (process.platform !== "linux" || process.arch !== "arm64") throw new Error("Native file proof requires pinned ARM64 Linux");
if (!databasePath || !certPath || !keyPath || !password || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Native file proof environment is incomplete");
for (const path of [certPath, keyPath]) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("Native file proof TLS material is not a private regular file");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Gate = { userId: string; nonce: string; workspaceId: string; path: string; requestId: string | null; savePosts: number; receiptGets: number; release: (() => void) | null; held: boolean };
let gate: Gate | null = null;
const api = createApi(databasePath, undefined, { password, webOrigin: "https://localhost" });
api.wrap(handler => async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test__/file-save-loss-")) {
      const userId = sessionUserId(databasePath, request);
      if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/__test__/file-save-loss-arm" && request.method === "POST") {
        if (gate?.held) return Response.json({ error: "gate_busy" }, { status: 409 });
        const body = await request.json() as Record<string, unknown>;
        const nonce = typeof body.nonce === "string" ? body.nonce.toLowerCase() : "";
        const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
        if (!uuid.test(nonce) || !uuid.test(workspaceId) || typeof body.path !== "string" || !body.path || Object.keys(body).sort().join(",") !== "nonce,path,workspaceId") return Response.json({ error: "invalid_gate" }, { status: 400 });
        const database = new Database(databasePath, { readonly: true, create: false });
        try {
          if (!database.query("SELECT id FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId)) return Response.json({ error: "not_found" }, { status: 404 });
        } finally { database.close(); }
        gate = { userId, nonce, workspaceId, path: body.path, requestId: null, savePosts: 0, receiptGets: 0, release: null, held: false };
        return Response.json({ armed: true, nonce });
      }
      if (!gate || gate.userId !== userId) return Response.json({ error: "not_found" }, { status: 404 });
      if (url.pathname === "/__test__/file-save-loss-diagnostics" && request.method === "GET") return Response.json({ held: gate.held, requestId: gate.requestId, savePosts: gate.savePosts, receiptGets: gate.receiptGets });
      if (url.pathname === "/__test__/file-save-loss-release" && request.method === "POST") {
        if (!gate.release) return Response.json({ error: "not_held" }, { status: 409 });
        gate.release();
        return Response.json({ released: true, requestId: gate.requestId });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const currentGate = gate;
    let saveInput: Record<string, unknown> | null = null;
    if (currentGate && request.method === "PUT" && url.pathname === `/api/workspaces/${currentGate.workspaceId}/files/content` && sessionUserId(databasePath, request) === currentGate.userId) {
      const body = await request.clone().json() as Record<string, unknown>;
      if (body.path === currentGate.path) { saveInput = body; currentGate.savePosts++; }
    }
    if (currentGate && request.method === "GET" && currentGate.requestId && url.pathname === `/api/workspaces/${currentGate.workspaceId}/files/receipts/${currentGate.requestId}` && sessionUserId(databasePath, request) === currentGate.userId) currentGate.receiptGets++;
    const response = await handler(request);
    if (currentGate && saveInput && response instanceof Response && response.status === 201 && currentGate.requestId === null) {
      const receipt = await response.clone().json() as Record<string, unknown>;
      if (typeof saveInput.requestId !== "string" || receipt.requestId !== saveInput.requestId || receipt.workspaceId !== currentGate.workspaceId || receipt.path !== currentGate.path || receipt.kind !== "save") throw new Error("Committed fixture receipt is not bound to the scoped request");
      currentGate.requestId = saveInput.requestId;
      currentGate.held = true;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { currentGate.release = null; currentGate.held = false; resolve(); }, 35_000);
        currentGate.release = () => { clearTimeout(timer); currentGate.release = null; currentGate.held = false; resolve(); };
      });
    }
    return response;
});
api.listen({ hostname: "0.0.0.0", port, tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) } });
console.log(`Native file proof API process ${process.pid} listening on ${port} with TLS`);
process.once("SIGTERM", () => { gate?.release?.(); void api.stop(true).then(() => process.exit(0), () => process.exit(1)); });
