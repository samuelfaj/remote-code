import { readFileSync } from "node:fs";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function stripGatewayHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (key === "x-rc-gateway-token") continue;
    if (key.startsWith("x-rc-route")) continue;
    out.set(key, value);
  }
  return out;
}

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  return out;
}

export function createGateway(config: {
  routes: Record<string, string>;
  upstreamTimeoutMs: number;
  /** PEM of the CA that signs the account containers' certificates. */
  upstreamCa?: string;
}): {
  handler(request: Request, server?: Bun.Server<{ targetUrl: string; headers?: Record<string, string> }>): Promise<Response>;
  routes: Record<string, string>;
} {
  const { routes, upstreamTimeoutMs, upstreamCa } = config;

  const handler = async (
    request: Request,
    server?: Bun.Server<{ targetUrl: string; headers?: Record<string, string> }>,
  ): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true });
    }

    const token = request.headers.get("x-rc-gateway-token");
    if (!token || !(token in routes)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const targetBase = routes[token];
    const targetUrl = new URL(url.pathname + url.search, targetBase);

    if (url.pathname === "/api/events" && request.method === "GET") {
      if (!server) {
        return new Response(null, { status: 503 });
      }
      // The event socket needs the caller's own session, so the handshake
      // headers are carried over (the gateway token is not).
      const forward: Record<string, string> = {};
      for (const name of ["cookie", "origin", "user-agent", "accept-language", "x-remotecode-client-version"]) {
        const value = request.headers.get(name);
        if (value !== null) forward[name] = value;
      }
      const upgraded = server.upgrade(request, {
        data: { targetUrl: targetUrl.toString(), headers: forward },
      });
      if (!upgraded) {
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      upstreamTimeoutMs,
    );

    try {
      const response = await fetch(targetUrl.toString(), {
        ...(upstreamCa ? { tls: { ca: upstreamCa } } : {}),
        method: request.method,
        headers: stripGatewayHeaders(request.headers),
        body: request.body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const filteredHeaders = stripHopByHop(response.headers);
      filteredHeaders.set("x-rc-gateway", "1");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: filteredHeaders,
      });
    } catch {
      clearTimeout(timeoutId);
      return Response.json(
        { error: "upstream_unavailable" },
        { status: 503 },
      );
    }
  };

  return { handler, routes };
}

export function main(): void {
  const routesJson = process.env.RC011_ROUTES;
  if (!routesJson) {
    throw new Error("RC011_ROUTES environment variable is required");
  }

  const routes = JSON.parse(routesJson);
  if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
    throw new Error("RC011_ROUTES must be a JSON object");
  }

  const port = Number(process.env.RC011_PORT ?? 8080);
  const upstreamCa = process.env.RC011_UPSTREAM_CA ? readFileSync(process.env.RC011_UPSTREAM_CA, "utf8") : undefined;
  const upstreamTimeoutMs = Number(
    process.env.RC011_UPSTREAM_TIMEOUT_MS ?? 3000,
  );

  const { handler, routes: resolvedRoutes } = createGateway({
    routes,
    upstreamTimeoutMs,
    ...(upstreamCa ? { upstreamCa } : {}),
  });

  const upstreams = new Map<
    Bun.ServerWebSocket<{ targetUrl: string; headers?: Record<string, string> }>,
    WebSocket
  >();

  Bun.serve<{ targetUrl: string; headers?: Record<string, string> }>({
    port,
    fetch: handler,
    websocket: {
      open(ws) {
        const targetUrl = ws.data.targetUrl as string | undefined;
        if (!targetUrl) {
          ws.close(1011);
          return;
        }

        let upstream: WebSocket;
        try {
          upstream = new WebSocket(targetUrl, {
            ...(ws.data.headers ? { headers: ws.data.headers } : {}),
            ...(upstreamCa ? { tls: { ca: upstreamCa } } : {}),
          } as any);
        } catch {
          ws.close(1011);
          return;
        }

        upstreams.set(ws, upstream);

        upstream.onmessage = (event) => {
          try {
            ws.send(event.data);
          } catch {
            upstream.close();
          }
        };
        upstream.onclose = () => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        };
        upstream.onerror = () => {
          upstream.close();
        };
      },
      message(ws, message) {
        const upstream = upstreams.get(ws);
        if (!upstream) return;
        try {
          upstream.send(message);
        } catch {
          ws.close();
        }
      },
      close(ws, code, reason) {
        const upstream = upstreams.get(ws);
        if (upstream) {
          upstreams.delete(ws);
          try {
            upstream.close(code, reason);
          } catch {
            /* already closed */
          }
        }
      },
    },
  });

  console.log(`Gateway listening on port ${port}`);
}

if (import.meta.main) {
  main();
}
