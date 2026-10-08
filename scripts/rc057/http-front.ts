// A plain-HTTP front for the Linux host's TLS API, for a device the host would
// otherwise refuse (the API requires TLS from any peer that is not loopback).
// The device talks to 127.0.0.1 through `adb reverse`; this proxy is that
// loopback peer and speaks TLS to the host. It relays the event WebSocket too,
// because the app's connection state comes from that channel.
//
// Usage: bun scripts/rc057/http-front.ts <listenPort> <httpsTargetPort>
const [, , listenPortArg, targetPortArg] = Bun.argv;
const listenPort = Number(listenPortArg);
const targetPort = Number(targetPortArg);
if (!Number.isSafeInteger(listenPort) || !Number.isSafeInteger(targetPort)) {
  console.error("usage: http-front.ts <listenPort> <httpsTargetPort>");
  process.exit(2);
}

const targetBase = `https://127.0.0.1:${targetPort}`;
const targetSocket = `wss://127.0.0.1:${targetPort}`;

const server = Bun.serve({
  port: listenPort,
  hostname: "127.0.0.1",
  async fetch(request, self) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // The client's own path and query carry the channel (clientVersion among
      // them), and its session cookie is what lets the host accept the upgrade,
      // so both are handed to the relay rather than assumed or dropped.
      const forwarded: Record<string, string> = {};
      for (const name of ["cookie", "origin", "x-remotecode-client-version"]) {
        const value = request.headers.get(name);
        if (value) forwarded[name] = value;
      }
      if (self.upgrade(request, { data: { path: url.pathname + url.search, headers: forwarded } })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    try {
      const upstream = await fetch(targetBase + url.pathname + url.search, {
        method: request.method,
        headers,
        body,
        // The certificate is the host's own self-signed one; this proxy is the
        // only hop that has to accept it, and only on loopback.
        tls: { rejectUnauthorized: false },
      });
      const out = new Headers(upstream.headers);
      const setCookie = upstream.headers.getSetCookie?.() ?? [];
      if (setCookie.length) {
        out.delete("set-cookie");
        // The API marks the session cookie Secure, and a phone never sends a
        // Secure cookie over plain HTTP — not even to its own loopback. This
        // hop is the device's loopback and the hop to the host is TLS, so the
        // attribute is dropped here and nowhere else.
        for (const cookie of setCookie) out.append("set-cookie", cookie.replace(/;\s*Secure\b/i, ""));
      }
      console.log(`${request.method} ${url.pathname} -> ${upstream.status}`);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (error) {
      return new Response(JSON.stringify({ error: "front_failed", detail: String(error) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
  websocket: {
    data: {} as { path: string; headers: Record<string, string>; upstream: WebSocket | null },
    open(ws) {
      const upstream = new WebSocket(targetSocket + ws.data.path, {
        headers: ws.data.headers,
        tls: { rejectUnauthorized: false },
      } as never);
      ws.data.upstream = upstream;
      upstream.addEventListener("open", () => console.log(`ws upstream open ${ws.data.path}`));
      upstream.addEventListener("message", (event) => ws.send(event.data as string));
      upstream.addEventListener("close", (event) => {
        console.log(`ws upstream close ${(event as CloseEvent).code}`);
        ws.close();
      });
      upstream.addEventListener("error", (event) => {
        console.log(`ws upstream error ${String((event as ErrorEvent).message ?? event)}`);
        ws.close();
      });
    },
    message(ws, message) {
      ws.data.upstream?.send(typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer));
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`http front on 127.0.0.1:${server.port} -> ${targetBase}`);
