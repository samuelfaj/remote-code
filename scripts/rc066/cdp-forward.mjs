// Forwards a listening port to a TCP port behind it: the container's Chromium
// binds DevTools to its own loopback, and the host's API is restarted under a
// proxy that must not see the port close, so both get this in front of them. Bun routes each connection through the handler set
// given at listen time, so the upstream is looked up from a map -- and the
// client's first bytes are held until that upstream exists, or the request that
// arrives during the connect is lost.
const TARGET_PORT = Number(process.env.FORWARD_TARGET_PORT ?? process.env.CDP_TARGET_PORT ?? 9222);
const LISTEN_PORT = Number(process.env.FORWARD_LISTEN_PORT ?? process.env.CDP_LISTEN_PORT ?? 9223);
const upstreams = new Map();
const held = new Map();

Bun.listen({
  hostname: "0.0.0.0",
  port: LISTEN_PORT,
  socket: {
    async open(client) {
      // The guest browser may not be listening yet, and an unhandled failure
      // here ends the whole forwarder, so a refusal is retried for a moment.
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          const upstream = await Bun.connect({
            hostname: "127.0.0.1",
            port: TARGET_PORT,
            socket: {
              data(_s, chunk) { try { client.write(chunk); } catch {} },
              close() { try { client.end(); } catch {} },
              error() { try { client.end(); } catch {} },
            },
          });
          upstreams.set(client, upstream);
          for (const chunk of held.get(client) ?? []) upstream.write(chunk);
          held.delete(client);
          return;
        } catch {
          await Bun.sleep(150);
        }
      }
      try { client.end(); } catch {}
    },
    data(client, chunk) {
      const upstream = upstreams.get(client);
      if (upstream) upstream.write(chunk);
      else held.set(client, [...(held.get(client) ?? []), chunk]);
    },
    close(client) {
      try { upstreams.get(client)?.end(); } catch {}
      upstreams.delete(client);
      held.delete(client);
    },
    error(client) {
      try { upstreams.get(client)?.end(); } catch {}
      upstreams.delete(client);
      held.delete(client);
    },
  },
});
