import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type AcpProgress = { kind: string; at: string; detail?: string };

export type AcpSessionHandle = {
  /** Resolves when the prompt finishes (or the process ends). */
  done: Promise<{ stopReason: string | null; sessionId: string | null; error?: string | null }>;
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
  /** Wrap every spawn (agent and its terminal commands) in the agent identity. */
  wrapSpawn?: (command: string, args: string[]) => { command: string; args: string[] };
  onProgress?: (progress: AcpProgress) => void;
  onSessionId?: (sessionId: string) => void;
};

/**
 * Drive the main Distill project over its existing ACP stdio interface.
 * The client answers every agent request it must (permission, fs, terminal) so
 * a prompt cannot stall waiting on the client, and it never replays the prompt.
 */
export function startAcpPrompt(options: Options): AcpSessionHandle {
  const spawnAgent = (command: string, args: string[], cwd: string) => {
    const wrapped = options.wrapSpawn ? options.wrapSpawn(command, args) : { command, args };
    return spawn(wrapped.command, wrapped.args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  };
  const child = spawnAgent(options.command, options.args ?? ["agent", "stdio"], options.cwd);

  let sessionId: string | null = null;
  let settled = false;
  let buffered = "";
  const pending = new Map<string, (message: Record<string, unknown>) => void>();
  const terminals = new Map<string, {
    proc: ChildProcessWithoutNullStreams;
    output: string;
    exitCode: number | null;
    waiters: Array<(code: number | null) => void>;
  }>();

  const send = (message: Record<string, unknown>) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
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
      } else if (method === "terminal/create") {
        // ACP normally separates the program from its args, but some agents put
        // a whole shell line in `command` with no `args`; run that through a shell.
        let command = String(params.command);
        let args = Array.isArray(params.args) ? (params.args as string[]) : [];
        if (args.length === 0 && /\s/.test(command) && !existsSync(command)) {
          args = ["-c", command];
          command = "/bin/sh";
        }
        const terminalId = crypto.randomUUID();
        const proc = spawnAgent(
          command,
          args,
          typeof params.cwd === "string" ? params.cwd : options.cwd,
        );
        const entry = { proc, output: "", exitCode: null as number | null, waiters: [] as Array<(code: number | null) => void> };
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => { entry.output += chunk; });
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => { entry.output += chunk; });
        proc.on("exit", (code) => {
          entry.exitCode = code;
          for (const waiter of entry.waiters.splice(0)) waiter(code);
        });
        terminals.set(terminalId, entry);
        respond(message.id, { terminalId });
      } else if (method === "terminal/output") {
        const entry = terminals.get(String(params.terminalId));
        respond(message.id, {
          output: entry?.output ?? "",
          truncated: false,
          ...(entry && entry.exitCode !== null ? { exitStatus: { exitCode: entry.exitCode } } : {}),
        });
      } else if (method === "terminal/wait_for_exit") {
        const entry = terminals.get(String(params.terminalId));
        if (!entry) respond(message.id, { exitCode: 0 });
        else if (entry.exitCode !== null) respond(message.id, { exitCode: entry.exitCode });
        else entry.waiters.push((code) => respond(message.id, { exitCode: code }));
      } else if (method === "terminal/kill") {
        const entry = terminals.get(String(params.terminalId));
        if (entry) { try { entry.proc.kill("SIGTERM"); } catch { /* already gone */ } }
        respond(message.id, {});
      } else if (method === "terminal/release") {
        terminals.delete(String(params.terminalId));
        respond(message.id, {});
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

  // An agent that cannot be spawned (missing binary, missing cwd) reports only
  // through the child's 'error' event. Fail the run with an honest reason
  // instead of leaving the request pending or crashing the API.
  let spawnFailure: string | null = null;
  child.on("error", (error: Error) => {
    spawnFailure = String(error);
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({ error: { message: spawnFailure } });
    }
  });

  const request = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
    new Promise<Record<string, unknown>>((resolve) => {
      if (spawnFailure) {
        resolve({ error: { message: spawnFailure } });
        return;
      }
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
    if (spawnFailure) return { stopReason: "spawn_failed" as string | null, sessionId, error: spawnFailure };
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
    return { stopReason: spawnFailure ? "spawn_failed" : promptResult?.stopReason ?? null, sessionId, error: spawnFailure };
  })().catch(() => ({ stopReason: spawnFailure ? "spawn_failed" : null, sessionId, error: spawnFailure }));

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