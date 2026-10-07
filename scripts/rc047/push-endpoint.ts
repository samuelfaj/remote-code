// The push provider stand-in the RC-047 proof points the shipped dispatcher at.
// It records every request it receives, so "at most one alert per item per
// device" is counted from the provider's side rather than the sender's, and it
// answers 410 for a token that has been marked dead, which is how a real
// provider reports a revoked or denied permission.
import { appendFileSync, writeFileSync } from "node:fs";

const port = Number(process.env.RC047_PUSH_PORT ?? "8099");
const logPath = process.env.RC047_PUSH_LOG ?? "/var/log/rc047-push.log";
const deadPath = process.env.RC047_PUSH_DEAD ?? "/var/log/rc047-dead-token";
writeFileSync(logPath, "");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const body = await request.text();
    let dead = "";
    try { dead = await Bun.file(deadPath).text(); } catch { dead = ""; }
    const token = (JSON.parse(body || "{}") as { token?: string }).token ?? "";
    const denied = Boolean(dead.trim()) && token === dead.trim();
    // The outcome is recorded with the request, so "one alert per device" and
    // "one request per device" can be counted separately.
    appendFileSync(logPath, `${JSON.stringify({ status: denied ? 410 : 200, request: JSON.parse(body || "{}") })}\n`);
    if (denied) {
      return Response.json({ error: "unregistered" }, { status: 410 });
    }
    return Response.json({ ok: true });
  },
});
console.log(`push provider stand-in listening on ${port}`);
