#!/usr/bin/env node
// Minimal ACP stdio agent used by runs tests. It is NOT a substitute for the
// shipped Distill binary; it only makes supervisor state transitions
// deterministic. Real Distill is exercised by scripts/rc009/run-runs-proof.sh.
import process from "node:process";
import { appendFileSync, writeFileSync } from "node:fs";

let buffer = "";
let sessionId = "stub-session";
let promptId = null;
let cancelled = false;
const pendingRequests = new Map();

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function sendRequest(method, params) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingRequests.set(id, resolve);
    send({ id, method, params });
  });
}

function logPrompt() {
  const logFile = process.env.STUB_PROMPT_LOG;
  if (logFile) appendFileSync(logFile, process.argv.join(" ") + "\n");
}

async function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    // STUB_SESSION_NEW_DELAY_MS lets a test act while the run is still starting.
    const delay = Number(process.env.STUB_SESSION_NEW_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(() => send({ id: message.id, result: { sessionId } }), delay);
    else send({ id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    logPrompt();
    const text = message.params?.prompt?.[0]?.text ?? "";
    // EMPTY_REPLY makes the agent answer without a word, so a test can prove an
    // empty reply records no assistant message. Otherwise stream a deterministic
    // reply derived from the prompt so the transcript capture is observable.
    if (!text.includes("EMPTY_REPLY")) {
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `stub reply to: ${text}` } } } });
    }
    if (text.includes("AUTH_EXPIRED")) {
      send({ id: promptId, error: { code: -32001, message: "401 Unauthorized: the provider credential has expired" } });
      return;
    }
    if (text.includes("RATE_LIMITED")) {
      send({ id: promptId, error: { code: -32002, message: "429 Too Many Requests. Retry-After: 30" } });
      return;
    }
    if (text.includes("UNAVAILABLE")) {
      send({ id: promptId, error: { code: -32003, message: "503 Service Unavailable: provider temporarily unavailable" } });
      return;
    }
    if (text.includes("ENVCHECK")) {
      writeFileSync("envcheck.txt", String(process.env.REMOTECODE_GATEWAY_TOKEN ?? "absent"));
    }
    if (text.includes("SLOW")) return; // wait for session/cancel
    if (text.includes("LATEOK")) {
      // Answers long after the watchdog may have ended the run.
      setTimeout(() => send({ id: promptId, result: { stopReason: "end_turn" } }), Number(process.env.STUB_LATE_MS ?? 1500));
      return;
    }
    if (text.includes("PERMISSION_WRITE")) {
      const path = text.replace("PERMISSION_WRITE ", "").trim();
      const permissionResult = await sendRequest("session/request_permission", {
        title: "Write file " + path,
        kind: "edit",
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "deny-once", kind: "reject_once", name: "Deny" },
        ],
        toolCall: { title: "Write file " + path, kind: "edit" },
      });
      const outcome = permissionResult.result?.outcome;
      if (outcome?.outcome === "selected" && outcome.optionId === "allow-once") {
        const logFile = process.env.STUB_WRITE_LOG;
        if (logFile) appendFileSync(logFile, path + "\n");
        writeFileSync(path, "written by stub\n");
        send({ id: promptId, result: { stopReason: "end_turn" } });
      } else if (outcome?.outcome === "cancelled") {
        send({ id: promptId, result: { stopReason: "end_turn" } });
      } else {
        send({ id: promptId, result: { stopReason: "cancelled" } });
      }
      return;
    }
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
        const message = JSON.parse(line);
        if (message.id !== undefined && pendingRequests.has(String(message.id))) {
          const resolve = pendingRequests.get(String(message.id));
          pendingRequests.delete(String(message.id));
          resolve(message);
        } else {
          handle(message);
        }
      } catch {
        // Ignore malformed input.
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(cancelled ? 0 : 0));