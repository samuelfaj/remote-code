import { describe, expect, it } from "bun:test";
import { createApi } from "./app";

function waitForEvent(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 3000);
    const listener = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (event.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(event);
    };
    socket.addEventListener("message", listener);
  });
}

describe("Elysia action receipt", () => {
  it("records a UI action once and returns that same receipt from the backend", async () => {
    const app = createApi();
    const created = await app.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "browser proof" }),
      }),
    );

    expect(created.status).toBe(201);
    const receipt = await created.json();
    const readBack = await app.handle(new Request("http://localhost/api/actions"));
    const state = await readBack.json();

    expect(state.actions).toContainEqual(receipt);
  });

  it("broadcasts each confirmed receipt to connected browser clients", async () => {
    const server = createApi().listen(0);
    const port = server.server?.port;
    if (!port) throw new Error("Elysia did not bind an ephemeral port");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    const snapshotPromise = waitForEvent(socket, "snapshot");

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WebSocket did not open")), 3000);
        socket.onopen = () => { clearTimeout(timeout); resolve(); };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); };
      });
      const snapshot = await snapshotPromise;
      const actionEventPromise = waitForEvent(socket, "action.created");

      const response = await fetch(`http://127.0.0.1:${port}/api/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "broadcast proof" }),
      });
      const receipt = await response.json();
      const actionEvent = await actionEventPromise;

      expect(response.status).toBe(201);
      expect(snapshot).toEqual({ type: "snapshot", actions: [] });
      expect(actionEvent).toEqual({ type: "action.created", receipt });
    } finally {
      socket.close();
      await server.stop(true);
    }
  });

  it("rejects an empty action before recording a receipt", async () => {
    const app = createApi();
    const rejected = await app.handle(
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "" }),
      }),
    );

    expect(rejected.status).toBe(422);
    const readBack = await app.handle(new Request("http://localhost/api/actions"));
    expect((await readBack.json()).actions).toHaveLength(0);
  });
});
