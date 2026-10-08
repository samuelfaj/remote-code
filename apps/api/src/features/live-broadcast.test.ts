import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { actionsFeature } from "./actions";

const allowedOrigin = "http://localhost:5173";
const token = "a".repeat(64);
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "rc-live-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  return { path, feature: actionsFeature(path, allowedOrigin) };
}

function seedSession(path: string) {
  const database = new Database(path, { create: true });
  try {
    database.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    database.query("INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
      createHash("sha256").update(token).digest("hex"), "local", Date.now() + 60_000,
    );
  } finally { database.close(); }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await delay(10);
  }
}

it("delivers per-user events with a monotonic seq and no undefined keys", async () => {
  const { path, feature } = setup();
  seedSession(path);
  const server = new Elysia().use(feature.routes).listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("API did not bind");
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`ws://127.0.0.1:${port}/api/events`, { headers: { cookie: `remotecode_session=${token}`, origin: allowedOrigin } });
  const messages: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  try {
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.type).toBe("snapshot");
    feature.broadcastToUser("local", { type: "run.updated", run: { id: "first" } });
    feature.broadcastToUser("local", { type: "run.updated", run: { id: "second" } });
    await waitFor(() => messages.length === 3);
    expect(messages[1]).toMatchObject({ type: "run.updated", seq: 1, run: { id: "first" } });
    expect(messages[2]).toMatchObject({ type: "run.updated", seq: 2, run: { id: "second" } });
    expect(messages[1]).not.toHaveProperty("workspaceId");
  } finally {
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(resolve, 500);
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.close();
    });
    await Promise.race([server.stop(true), delay(500)]);
  }
});

it("coalesces terminal.changed per user and workspace and sends one trailing notice", async () => {
  const { path, feature } = setup();
  seedSession(path);
  const server = new Elysia().use(feature.routes).listen(0);
  const port = server.server?.port;
  if (!port) throw new Error("API did not bind");
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`ws://127.0.0.1:${port}/api/events`, { headers: { cookie: `remotecode_session=${token}`, origin: allowedOrigin } });
  const messages: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  const changed = () => messages.filter((message) => message.type === "terminal.changed");
  try {
    await waitFor(() => messages.length === 1);
    feature.broadcastToUser("local", { type: "terminal.changed", workspaceId: "w1" });
    feature.broadcastToUser("local", { type: "terminal.changed", workspaceId: "w1" });
    feature.broadcastToUser("local", { type: "terminal.changed", workspaceId: "w1" });
    await delay(150);
    expect(changed().length).toBe(1);
    await waitFor(() => changed().length === 2);
    expect(changed()[1]).toMatchObject({ type: "terminal.changed", seq: 2, workspaceId: "w1" });
  } finally {
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(resolve, 500);
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.close();
    });
    await Promise.race([server.stop(true), delay(500)]);
  }
});
