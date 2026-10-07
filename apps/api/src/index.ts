// The database holds session and account secrets, and in a hosted account the
// supervising agent runs in the same container as an unprivileged user, so
// anything this process creates must not be world-readable.
process.umask(0o077);

import { app, registerTerminalsShutdown, terminalsShutdown } from "./app";

const port = Number(process.env.API_PORT ?? 3000);
const certPath = process.env.REMOTECODE_TLS_CERT;
const keyPath = process.env.REMOTECODE_TLS_KEY;
const listener = certPath && keyPath
  ? app.listen({ hostname: "0.0.0.0", port, tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) } })
  : app.listen({ hostname: "0.0.0.0", port });
console.log(`Elysia API listening on ${port}`);

// Normal production shutdown: SIGTERM settles live PTY actors through the
// same stopAll used by the stop route, then stops the listener and exits.
// Elysia's stop() only fires onStop when app.server is set; call the
// terminal shutdown directly so a SIGTERM racing server reload still settles.
let stopping = false;
process.once("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    try { await terminalsShutdown(); } catch {}
    try { await app.stop(); } catch {}
    process.exit(0);
  })();
});

void listener;
