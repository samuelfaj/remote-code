import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createApi } from "./app";
import type { machineFeature } from "./features/machine";

const testPassword = "local-test-password";

function tempDb(label: string) {
  return join(mkdtempSync(join(tmpdir(), `rc-machine-${label}-`)), "remotecode.sqlite");
}

function openSocket(url: string, cookie: string) {
  const BunWebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new BunWebSocketWithHeaders(url, { headers: { cookie, origin: "http://localhost:5173" } });
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.close();
  });
}

async function stopTestServer(stopServer: (force?: boolean) => Promise<unknown>, port: number) {
  let stopped = false;
  const stop = stopServer(true).then(() => { stopped = true; });
  await Promise.race([stop, new Promise((resolve) => setTimeout(resolve, 500))]);
  if (stopped) return;
  let reachable = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(500) });
    reachable = true;
  } catch {
    // The listener is expected to refuse requests after forced shutdown.
  }
  if (reachable) throw new Error("Elysia listener remained open after forced shutdown");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no ephemeral port allocated"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function api(path: string, machineConfig?: Parameters<typeof machineFeature>[1]) {
  const app = createApi(
    path,
    undefined,
    { password: testPassword },
    undefined,
    undefined,
    undefined,
    undefined,
    machineConfig,
  );
  const response = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: testPassword }),
  }));
  if (response.status !== 200) throw new Error("login failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("cookie missing");
  return { app, cookie };
}

describe("RC machine desktop", () => {
  it("reports the desktop unavailable and names the display when the VNC probe refuses", async () => {
    const { app, cookie } = await api(tempDb("closed"), { probe: async () => false });
    const response = await app.handle(new Request("https://localhost/api/machine", { headers: { cookie } }));

    expect(response.status).toBe(200);
    const report = await response.json() as Record<string, unknown>;
    expect(report.available).toBe(false);
    expect(report.vncListening).toBe(false);
    expect(report.display).toBe(":99");
    expect(report.vncPort).toBe(5900);
    expect(report.detail).toBe("No VNC server is listening on :99; this host image has no machine desktop.");
  });

  it("reports the desktop available when the VNC probe accepts a connection", async () => {
    const { app, cookie } = await api(tempDb("open"), { probe: async () => true });
    const response = await app.handle(new Request("https://localhost/api/machine", { headers: { cookie } }));

    expect(response.status).toBe(200);
    const report = await response.json() as Record<string, unknown>;
    expect(report.available).toBe(true);
    expect(report.vncListening).toBe(true);
    expect(report.detail).toBe("");
  });

  it("starts the configured terminal on the desktop display", async () => {
    const calls: Array<{ display: string; command: string }> = [];
    const { app, cookie } = await api(tempDb("terminal"), {
      display: ":42",
      terminalCommand: "myterm",
      spawnTerminal: (display, command) => { calls.push({ display, command }); },
    });

    const response = await app.handle(new Request("https://localhost/api/machine/terminal", {
      method: "POST",
      headers: { cookie },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ started: true });
    expect(calls).toEqual([{ display: ":42", command: "myterm" }]);
  });

  it("answers an honest failure when the terminal spawn throws", async () => {
    const { app, cookie } = await api(tempDb("terminal-fail"), {
      spawnTerminal: () => { throw new Error("xterm not installed"); },
    });

    const response = await app.handle(new Request("https://localhost/api/machine/terminal", {
      method: "POST",
      headers: { cookie },
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { started: boolean; detail: string };
    expect(body.started).toBe(false);
    expect(body.detail).toContain("xterm not installed");
  });

  it("requires a session on the machine routes", async () => {
    const { app } = await api(tempDb("unauthorized"));
    const state = await app.handle(new Request("https://localhost/api/machine"));
    const terminal = await app.handle(new Request("https://localhost/api/machine/terminal", { method: "POST" }));

    expect(state.status).toBe(401);
    expect(await state.json()).toEqual({ error: "unauthorized" });
    expect(terminal.status).toBe(401);
    expect(await terminal.json()).toEqual({ error: "unauthorized" });
  });

  it("closes the VNC socket with 1011 when the loopback port is unreachable", async () => {
    const closedPort = await freePort();
    const { app, cookie } = await api(tempDb("vnc"), { vncPort: closedPort });
    const server = app.listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral port");
    const socket = openSocket(`ws://127.0.0.1:${port}/api/machine/vnc`, cookie);

    try {
      const event = await new Promise<CloseEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("VNC socket stayed open")), 5_000);
        socket.addEventListener("close", (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      expect(event.code).toBe(1011);
      expect(event.reason).toBe("machine desktop unavailable");
    } finally {
      await closeSocket(socket);
      await stopTestServer(server.stop.bind(server), port);
    }
  });
});
