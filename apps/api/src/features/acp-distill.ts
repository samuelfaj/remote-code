import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export type AcpProgress = { kind: string; at: string; detail?: string };

export type AcpSessionHandle = {
  /** Resolves when the prompt finishes (or the process ends). */
  done: Promise<{ stopReason: string | null; sessionId: string | null }>;
  /** Ask the agent to cancel the current prompt (session/cancel). */
  cancel: () => void;
  /** Hard-stop the agent process. */
  kill: () => void;
  sessionId: () => string | null;
};

type Options = {
  command: string;
  args?: string[];
  cwd: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (progress: AcpProgress) => void;
  onSessionId?: (sessionId: string) => void;
};

/**
 * Drive the main Distill project over its existing ACP stdio interface.
 * The client answers every agent request it must (permission, fs, terminal) so
 * a prompt cannot stall waiting on the client, and it never replays the prompt.
 */
export function startAcpPrompt(options: Options): AcpSessionHandle {
  const child = spawn(options.command, options.args ?? ["agent", "stdio"], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let sessionId: string | null = null;
  let settled = false;
  let buffered = "";
  const pending = new Map<string, (message: Record<string, unknown>) => void>();

  const send = (message: Record<string, unknown>) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  };

  const respond = (id: unknown, result: unknown) => send({ id, result });

  const onLine = (line: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method === "session/update") {
      const update = (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
      options.onProgress?.({ kind: update?.sessionUpdate ?? "update", at: new Date().toISOString() });
      return;
    }
    if (method && message.id !== undefined) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (method === "session/request_permission") {
        const choices = (params.options as Array<{ optionId?: string; kind?: string }> | undefined) ?? [];
        const chosen = choices.find((option) => option.kind === "allow_always") ??
          choices.find((option) => option.kind === "allow_once") ??
          choices.find((option) => (option.optionId ?? "").includes("allow")) ?? choices[0];
        respond(message.id, chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } });
      } else if (method === "fs/read_text_file") {
        try {
          respond(message.id, { content: readFileSync(String(params.path), "utf8") });
        } catch (error) {
          send({ id: message.id, error: { code: -32603, message: String(error) } });
        }
      } else if (method === "fs/write_text_file") {
        try {
          writeFileSync(String(params.path), String(params.content ?? ""));
          respond(message.id, {});
        } catch (error) {
          send({ id: message.id, error: { code: -32603, message: String(error) } });
        }
      } else {
        // Unknown client methods must be answered so the agent never blocks.
        send({ id: message.id, error: { code: -32601, message: `unsupported client method: ${method}` } });
      }
      return;
    }
    if (message.id !== undefined) {
      const waiter = pending.get(String(message.id));
      if (waiter) {
        pending.delete(String(message.id));
        waiter(message);
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
      index = buffered.indexOf("\n");
    }
  });

  const request = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `client timeout after ${timeoutMs}ms` } });
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ id, method, params });
    });

  const done = (async () => {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "remotecode-run-supervisor", version: "1" },
    }, 30_000);
    const created = await request("session/new", { cwd: options.cwd, mcpServers: [] }, 120_000);
    const result = created.result as { sessionId?: string } | undefined;
    sessionId = result?.sessionId ?? null;
    if (sessionId) options.onSessionId?.(sessionId);
    const answer = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: options.prompt }],
    }, 30 * 60_000);
    settled = true;
    const promptResult = answer.result as { stopReason?: string } | undefined;
    return { stopReason: promptResult?.stopReason ?? null, sessionId };
  })().catch(() => ({ stopReason: null, sessionId }));

  child.on("exit", () => {
    if (!settled) settled = true;
  });

  return {
    done,
    cancel: () => send({ method: "session/cancel", params: { sessionId } }),
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
    sessionId: () => sessionId,
  };
}