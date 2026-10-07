#!/usr/bin/env node
// Minimal ACP stdio agent used by runs tests. It is NOT a substitute for the
// shipped Distill binary; it only makes supervisor state transitions
// deterministic. Real Distill is exercised by scripts/rc009/run-runs-proof.sh.
import process from "node:process";

let buffer = "";
let sessionId = "stub-session";
let promptId = null;
let cancelled = false;

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk" } } });
    if (text.includes("SLOW")) return; // wait for session/cancel
    setTimeout(() => send({ id: promptId, result: { stopReason: "end_turn" } }), 60);
    return;
  }
  if (message.method === "session/cancel") {
    cancelled = true;
    if (promptId !== null) send({ id: promptId, result: { stopReason: "cancelled" } });
    return;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Ignore malformed input.
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(cancelled ? 0 : 0));