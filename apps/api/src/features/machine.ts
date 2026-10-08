import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { Elysia } from "elysia";
import { isAuthenticated } from "./auth";

/**
 * The dev host's graphical desktop. The container runs its own X display and,
 * when the image supports it, an `x11vnc` server bound to loopback. The VNC
 * port is only reachable inside the host, so the browser speaks raw RFB over a
 * WebSocket bridged to that loopback TCP port; no extra port is published.
 */
export type MachineReport = {
  available: boolean;
  display: string;
  width: number;
  height: number;
  vncPort: number;
  vncListening: boolean;
  terminalCommand: string;
  detail: string;
};

type Options = {
  allowedOrigin?: string;
  display?: string;
  width?: number;
  height?: number;
  vncPort?: number;
  terminalCommand?: string;
  probeTimeoutMs?: number;
  probe?: (port: number, timeoutMs: number) => Promise<boolean>;
  spawnTerminal?: (display: string, command: string) => void;
};

type VncClient = {
  // The socket data Elysia carries across `open`, `message` and `close`; the
  // bridge to the desktop lives here because the wrapper objects differ.
  data: { bridge?: import("node:net").Socket } & Record<string, unknown>;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * One TCP probe of the loopback VNC port. Resolves whether the port accepted a
 * connection and destroys the socket immediately; a refusal or timeout is a
 * plain `false`, never a throw.
 */
export function probeVncPort(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function defaultSpawnTerminal(display: string, command: string) {
  const child = spawn(command, { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: display } });
  child.unref();
}

function messageBytes(message: unknown): Uint8Array | undefined {
  if (typeof message === "string") return Buffer.from(message, "utf8");
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return undefined;
}

export function machineFeature(databasePath: string, options: Options = {}) {
  const allowedOrigin = options.allowedOrigin ?? process.env.REMOTECODE_WEB_ORIGIN ?? "http://localhost:5173";
  const display = options.display ?? process.env.REMOTECODE_DISPLAY ?? ":99";
  const width = options.width ?? envNumber("REMOTECODE_MACHINE_WIDTH", 1280);
  const height = options.height ?? envNumber("REMOTECODE_MACHINE_HEIGHT", 900);
  const vncPort = options.vncPort ?? envNumber("REMOTECODE_MACHINE_VNC_PORT", 5900);
  const terminalCommand = options.terminalCommand ?? process.env.REMOTECODE_MACHINE_TERMINAL ?? "xterm";
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000;
  const probe = options.probe ?? probeVncPort;
  const spawnTerminal = options.spawnTerminal ?? defaultSpawnTerminal;

  const unavailableDetail = `No VNC server is listening on ${display}; this host image has no machine desktop.`;

  // One live TCP bridge per WebSocket client. It is carried on the socket's own
  // `data` rather than in a Map: the wrapper object Elysia hands to `message`
  // and `close` is not the one `open` received, so a Map keyed by it dropped
  // every client frame.
  const bridgeOf = (client: VncClient): Socket | undefined => client.data?.bridge;
  const setBridge = (client: VncClient, socket: Socket | undefined) => {
    if (client.data) client.data.bridge = socket;
  };

  return new Elysia()
    .get("/api/machine", async ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      const listening = await probe(vncPort, probeTimeoutMs);
      const report: MachineReport = {
        available: listening,
        display,
        width,
        height,
        vncPort,
        vncListening: listening,
        terminalCommand,
        detail: listening ? "" : unavailableDetail,
      };
      return report;
    })
    .post("/api/machine/terminal", ({ request, set }) => {
      if (!isAuthenticated(databasePath, request)) {
        set.status = 401;
        return { error: "unauthorized" as const };
      }
      try {
        spawnTerminal(display, terminalCommand);
        return { started: true };
      } catch (error) {
        return { started: false, detail: error instanceof Error ? error.message : String(error) };
      }
    })
    .ws("/api/machine/vnc", {
      beforeHandle({ request, set }) {
        if (request.headers.get("origin") !== allowedOrigin) {
          set.status = 403;
          return { error: "origin_not_allowed" as const };
        }
        if (!isAuthenticated(databasePath, request)) {
          set.status = 401;
          return { error: "unauthorized" as const };
        }
      },
      open(client) {
        bridgeOf(client)?.destroy();
        const tcp = connect({ host: "127.0.0.1", port: vncPort });
        setBridge(client, tcp);
        let ended = false;
        const end = (code: number, reason: string) => {
          if (ended) return;
          ended = true;
          tcp.destroy();
          setBridge(client, undefined);
          try {
            client.close(code, reason);
          } catch {
            // The connection is already unavailable.
          }
        };
        tcp.on("data", (chunk: Buffer) => {
          try {
            client.send(chunk);
          } catch {
            end(1011, "machine desktop unavailable");
          }
        });
        tcp.on("error", () => end(1011, "machine desktop unavailable"));
        tcp.on("close", () => end(1000, "machine desktop closed"));
      },
      message(client, message) {
        const tcp = bridgeOf(client);
        if (!tcp) return;
        const bytes = messageBytes(message);
        if (!bytes) return;
        try {
          tcp.write(bytes);
        } catch {
          setBridge(client, undefined);
          tcp.destroy();
        }
      },
      close(client) {
        const tcp = bridgeOf(client);
        setBridge(client, undefined);
        tcp?.destroy();
      },
    });
}
