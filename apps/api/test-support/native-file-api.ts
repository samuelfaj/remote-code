import { lstatSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createApi } from "../src/app";
import { sessionUserId } from "../src/features/auth";
import { fileFolderStateFromValue, validFilePath } from "../../../packages/client/src/files";

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
type Gate = { userId: string; nonce: string; workspaceId: string; kind: "create" | "save" | "move"; phase: "mutation" | "preflight"; preflightGets: number; path: string; sourcePath: string | null; requestId: string | null; mutationPosts: number; savePosts: number; receiptGets: number; release: (() => void) | null; held: boolean };
let gate: Gate | null = null;
const api = createApi(databasePath, undefined, { password, webOrigin: process.env.REMOTECODE_WEB_ORIGIN ?? "https://localhost" });
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
        const kind = body.kind === undefined ? "save" : body.kind;
        const phase = body.phase === undefined ? "mutation" : body.phase;
        const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : null;
        const baseKeys = kind === "move" ? "kind,nonce,path,sourcePath,workspaceId" : body.kind === undefined ? "nonce,path,workspaceId" : "kind,nonce,path,workspaceId";
        const keys = body.phase === undefined ? baseKeys : [...baseKeys.split(","), "phase"].sort().join(",");
        if ((phase !== "mutation" && phase !== "preflight") || (phase === "preflight" && kind !== "move") || (kind !== "save" && kind !== "create" && kind !== "move") || !uuid.test(nonce) || !uuid.test(workspaceId) || !validFilePath(body.path) || Object.keys(body).sort().join(",") !== keys || (kind === "move" && (!validFilePath(sourcePath) || sourcePath === body.path))) return Response.json({ error: "invalid_gate" }, { status: 400 });
        const database = new Database(databasePath, { readonly: true, create: false });
        try {
          if (!database.query("SELECT id FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId)) return Response.json({ error: "not_found" }, { status: 404 });
        } finally { database.close(); }
        gate = { userId, nonce, workspaceId, kind, phase, preflightGets: 0, path: body.path, sourcePath, requestId: null, mutationPosts: 0, savePosts: 0, receiptGets: 0, release: null, held: false };
        return Response.json({ armed: true, nonce });
      }
      if (!gate || gate.userId !== userId) return Response.json({ error: "not_found" }, { status: 404 });
      if (url.pathname === "/__test__/file-save-loss-diagnostics" && request.method === "GET") return Response.json({ kind: gate.kind, phase: gate.phase, preflightGets: gate.preflightGets, held: gate.held, requestId: gate.requestId, mutationPosts: gate.mutationPosts, savePosts: gate.savePosts, receiptGets: gate.receiptGets });
      if (url.pathname === "/__test__/file-save-loss-release" && request.method === "POST") {
        if (!gate.release) return Response.json({ error: "not_held" }, { status: 409 });
        gate.release();
        return Response.json({ released: true, requestId: gate.requestId });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const currentGate = gate;
    let mutationInput: Record<string, unknown> | null = null;
    const suffix = currentGate?.kind === "save" ? "/content" : currentGate?.kind === "move" ? "/move" : "";
    const filesPath = currentGate && `/api/workspaces/${currentGate.workspaceId}/files`;
    if (currentGate?.phase === "preflight" && (request.method === "POST" && (url.pathname === filesPath || url.pathname === `${filesPath}/move`) || request.method === "PUT" && url.pathname === `${filesPath}/content`)) {
      currentGate.mutationPosts++;
      if (request.method === "PUT") currentGate.savePosts++;
    }
    if (currentGate && request.method === (currentGate.kind === "save" ? "PUT" : "POST") && url.pathname === `/api/workspaces/${currentGate.workspaceId}/files${suffix}` && sessionUserId(databasePath, request) === currentGate.userId) {
      const body = await request.clone().json() as Record<string, unknown>;
      if ((currentGate.kind === "move" ? body.destinationPath === currentGate.path && body.sourcePath === currentGate.sourcePath : body.path === currentGate.path)) {
        mutationInput = body;
        if (currentGate.phase === "mutation") {
          currentGate.mutationPosts++;
          if (currentGate.kind === "save") currentGate.savePosts++;
        }
      }
    }
    if (currentGate && request.method === "GET" && currentGate.requestId && url.pathname === `/api/workspaces/${currentGate.workspaceId}/files/receipts/${currentGate.requestId}` && sessionUserId(databasePath, request) === currentGate.userId) currentGate.receiptGets++;
    const response = await handler(request);
    const preflight = currentGate?.phase === "preflight" && request.method === "GET" && url.pathname === `/api/workspaces/${currentGate.workspaceId}/folder` && sessionUserId(databasePath, request) === currentGate.userId && currentGate.preflightGets === 0;
    const committed = currentGate?.phase === "mutation" && mutationInput && response instanceof Response && response.status === 201 && currentGate.requestId === null;
    if (currentGate && response instanceof Response && (committed || preflight && response.status === 200)) {
      if (preflight) currentGate.preflightGets++;
      const value = await response.clone().json() as Record<string, unknown>;
      if (preflight) {
        if (fileFolderStateFromValue(value, currentGate.workspaceId) !== "provisioned") throw new Error("Preflight fixture requires the actual provisioned folder result");
      } else {
        if (!mutationInput || typeof mutationInput.requestId !== "string" || value.requestId !== mutationInput.requestId || value.workspaceId !== currentGate.workspaceId || value.path !== currentGate.path || value.kind !== currentGate.kind || (currentGate.kind === "move" && value.sourcePath !== currentGate.sourcePath)) throw new Error("Committed fixture receipt is not bound to the scoped request");
        currentGate.requestId = mutationInput.requestId;
      }
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
