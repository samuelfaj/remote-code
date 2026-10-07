import { describe, expect, it } from "bun:test";
import { createGateway } from "./index";

function startFakeUpstream(
  onRequest: (request: Request) => { body?: string; headers?: Record<string, string> },
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const result = onRequest(request);
      return new Response(result.body ?? "ok", {
        headers: {
          "content-type": "text/plain",
          ...result.headers,
        },
      });
    },
  });
  return { server, port: server.port };
}

describe("gateway", () => {
  it("GET /healthz returns 200 without a token", async () => {
    const gateway = createGateway({
      routes: { tokA: "http://127.0.0.1:9999" },
      upstreamTimeoutMs: 3000,
    });
    const response = await gateway.handler(
      new Request("http://localhost/healthz"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("request without a token returns 401 and never calls upstream", async () => {
    let upstreamHits = 0;
    const { server } = startFakeUpstream(() => {
      upstreamHits++;
      return { body: "hit" };
    });
    try {
      const gateway = createGateway({
        routes: { tokA: `http://127.0.0.1:${server.port}` },
        upstreamTimeoutMs: 3000,
      });
      const response = await gateway.handler(
        new Request(`http://localhost/api/test`),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(upstreamHits).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  it("valid token forwards to the correct upstream and strips gateway headers", async () => {
    const upstreamHeadersA: Record<string, string[]> = {};
    const upstreamHeadersB: Record<string, string[]> = {};

    const upstreamA = startFakeUpstream((request) => {
      for (const [key, value] of request.headers) {
        upstreamHeadersA[key] = upstreamHeadersA[key] ?? [];
        upstreamHeadersA[key].push(value);
      }
      return { body: "upstream-a" };
    });

    const upstreamB = startFakeUpstream((request) => {
      for (const [key, value] of request.headers) {
        upstreamHeadersB[key] = upstreamHeadersB[key] ?? [];
        upstreamHeadersB[key].push(value);
      }
      return { body: "upstream-b" };
    });

    try {
      const gateway = createGateway({
        routes: {
          tokA: `http://127.0.0.1:${upstreamA.port}`,
          tokB: `http://127.0.0.1:${upstreamB.port}`,
        },
        upstreamTimeoutMs: 3000,
      });

      const resA = await gateway.handler(
        new Request(`http://localhost/api/test`, {
          headers: { "x-rc-gateway-token": "tokA" },
        }),
      );
      expect(resA.status).toBe(200);
      expect(await resA.text()).toBe("upstream-a");
      expect(resA.headers.get("x-rc-gateway")).toBe("1");

      const resB = await gateway.handler(
        new Request(`http://localhost/api/test`, {
          headers: { "x-rc-gateway-token": "tokB" },
        }),
      );
      expect(resB.status).toBe(200);
      expect(await resB.text()).toBe("upstream-b");
      expect(resB.headers.get("x-rc-gateway")).toBe("1");

      // Neither upstream sees the gateway token or route headers
      for (const headers of [upstreamHeadersA, upstreamHeadersB]) {
        expect(headers["x-rc-gateway-token"]).toBeUndefined();
        const routeKeys = Object.keys(headers).filter((k) =>
          k.startsWith("x-rc-route"),
        );
        expect(routeKeys).toHaveLength(0);
      }
    } finally {
      upstreamA.server.stop(true);
      upstreamB.server.stop(true);
    }
  });

  it("unreachable upstream returns 503 within the configured timeout", async () => {
    const gateway = createGateway({
      routes: { tokA: "http://127.0.0.1:1" },
      upstreamTimeoutMs: 300,
    });

    const start = Date.now();
    const response = await gateway.handler(
      new Request("http://localhost/api/test", {
        headers: { "x-rc-gateway-token": "tokA" },
      }),
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    expect(elapsed).toBeLessThan(2000);
  });

  it("two different tokens map to two different upstreams and neither sees the other request", async () => {
    const upstreamAHits: string[] = [];
    const upstreamBHits: string[] = [];

    const upstreamA = startFakeUpstream((request) => {
      upstreamAHits.push(request.headers.get("x-rc-gateway-token") ?? "missing");
      return { body: "a" };
    });

    const upstreamB = startFakeUpstream((request) => {
      upstreamBHits.push(request.headers.get("x-rc-gateway-token") ?? "missing");
      return { body: "b" };
    });

    try {
      const gateway = createGateway({
        routes: {
          tokA: `http://127.0.0.1:${upstreamA.port}`,
          tokB: `http://127.0.0.1:${upstreamB.port}`,
        },
        upstreamTimeoutMs: 3000,
      });

      const resA = await gateway.handler(
        new Request(`http://localhost/api/test`, {
          headers: { "x-rc-gateway-token": "tokA" },
        }),
      );
      expect(await resA.text()).toBe("a");

      const resB = await gateway.handler(
        new Request(`http://localhost/api/test`, {
          headers: { "x-rc-gateway-token": "tokB" },
        }),
      );
      expect(await resB.text()).toBe("b");

      // Each upstream only received its own token's request
      expect(upstreamAHits).toHaveLength(1);
      expect(upstreamBHits).toHaveLength(1);

      // Neither upstream sees the gateway token header (it is stripped)
      expect(upstreamAHits[0]).toBe("missing");
      expect(upstreamBHits[0]).toBe("missing");
    } finally {
      upstreamA.server.stop(true);
      upstreamB.server.stop(true);
    }
  });
});
