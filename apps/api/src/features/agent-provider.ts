import { spawn } from "node:child_process";
import { Elysia } from "elysia";
import { sessionUserId } from "./auth";

/**
 * What the host can tell the client about the agent's provider, without ever
 * handing out the credential: the configured model, and whether the agent can
 * actually use it (asked from the agent itself, not assumed).
 */
export type AgentProviderState = "connected" | "unauthenticated" | "unavailable" | "unconfigured";

export type AgentProviderReport = {
  configured: boolean;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  credentialVariable: string | null;
  credentialPresent: boolean;
  state: AgentProviderState;
  models: string[];
  detail: string;
};

type Options = {
  command?: string;
  agentUser?: string;
  agentHome?: string;
  model?: string;
  baseUrl?: string;
  credentialVariable?: string;
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
  cacheMs?: number;
};

const maxProbeBytes = 64 * 1024;

/** The provider a base URL belongs to, for a familiar name in the card. */
export function providerNameFor(baseUrl: string | undefined): string {
  if (!baseUrl) return "unknown";
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    if (host.includes("openrouter")) return "OpenRouter";
    if (host.includes("openai")) return "OpenAI";
    if (host.includes("anthropic")) return "Anthropic";
    if (host.includes("x.ai")) return "Grok";
    return host;
  } catch {
    return "unknown";
  }
}

/** The model names a `distill models` listing offers, without its markers. */
export function parseModels(output: string): string[] {
  const models: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("* ") && !line.startsWith("- ")) continue;
    const name = line.slice(2).replace(/\s*\(default\)\s*$/, "").trim();
    if (name && !models.includes(name)) models.push(name);
  }
  return models.slice(0, 20);
}

function firstLine(output: string): string {
  return output.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

/**
 * Turn one probe result into the state the card shows. Pure, so the mapping from
 * the agent's own words to "connected" is testable without spawning anything.
 */
export function classifyProviderProbe(input: {
  configured: boolean;
  credentialPresent: boolean;
  credentialVariable: string | null;
  output: string;
  failed: boolean;
}): { state: AgentProviderState; models: string[]; detail: string } {
  const models = parseModels(input.output);
  const named = input.credentialVariable ? `${input.credentialVariable} is not set on this host.` : "";
  if (!input.configured) {
    return { state: "unconfigured", models, detail: "No agent model is configured on this host." };
  }
  if (/not authenticated/i.test(input.output)) {
    return { state: "unauthenticated", models, detail: named || "The agent is not authenticated on this host." };
  }
  if (!input.credentialPresent) {
    return { state: "unauthenticated", models, detail: named || "The agent has no provider credential." };
  }
  if (input.failed) {
    return { state: "unavailable", models, detail: firstLine(input.output) || "The agent could not be asked." };
  }
  if (models.length === 0) {
    return { state: "unavailable", models, detail: firstLine(input.output) || "The agent listed no models." };
  }
  return { state: "connected", models, detail: "" };
}

export function agentProviderFeature(databasePath: string, options: Options = {}) {
  const configuredModel = options.model ?? process.env.REMOTECODE_AGENT_MODEL;
  const baseUrl = options.baseUrl ?? process.env.REMOTECODE_AGENT_MODEL_BASE_URL;
  const credentialVariable = options.credentialVariable ?? process.env.REMOTECODE_AGENT_MODEL_ENV_KEY ?? null;
  const command = options.command ?? process.env.REMOTECODE_DISTILL_BIN ?? "distill";
  const agentUser = options.agentUser ?? process.env.REMOTECODE_AGENT_USER;
  const agentHome = options.agentHome ?? process.env.REMOTECODE_AGENT_HOME ?? (agentUser ? `/home/${agentUser}` : process.env.HOME);
  const timeoutMs = options.probeTimeoutMs ?? 10_000;
  const cacheMs = options.cacheMs ?? 10_000;
  // Same rule the run supervisor follows: the agent never inherits the host's
  // own secrets, only the environment it needs to reach its model.
  const sourceEnv = options.env ?? process.env;
  const probeEnv = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => !key.startsWith("REMOTECODE_")),
  ) as NodeJS.ProcessEnv;
  if (agentHome) probeEnv.HOME = agentHome;

  let cachedProbe: { at: number; output: string; failed: boolean } | null = null;

  function askAgent(): Promise<{ output: string; failed: boolean }> {
    if (cachedProbe && Date.now() - cachedProbe.at < cacheMs) {
      return Promise.resolve({ output: cachedProbe.output, failed: cachedProbe.failed });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { output: string; failed: boolean }) => {
        if (settled) return;
        settled = true;
        cachedProbe = { at: Date.now(), ...value };
        resolve(value);
      };
      const wrapped = agentUser
        ? { command: "runuser", args: ["-u", agentUser, "--", command, "models"] }
        : { command, args: ["models"] };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(wrapped.command, wrapped.args, { env: probeEnv, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish({ output: String(error), failed: true });
        return;
      }
      let output = "";
      const collect = (chunk: Buffer | string) => {
        if (output.length >= maxProbeBytes) return;
        output += String(chunk).slice(0, maxProbeBytes - output.length);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish({ output: output || "timed out asking the agent for its models", failed: true });
      }, timeoutMs);
      child.on("error", (error: Error) => { clearTimeout(timer); finish({ output: String(error), failed: true }); });
      child.on("close", () => { clearTimeout(timer); finish({ output, failed: false }); });
    });
  }

  return new Elysia().get("/api/agent/provider", async ({ request, set }) => {
    const userId = sessionUserId(databasePath, request);
    if (!userId) {
      set.status = 401;
      return { error: "unauthorized" as const };
    }
    const probe = await askAgent();
    const credentialPresent = Boolean(credentialVariable && probeEnv[credentialVariable]);
    const classified = classifyProviderProbe({
      configured: Boolean(configuredModel),
      credentialPresent,
      credentialVariable,
      output: probe.output,
      failed: probe.failed,
    });
    const report: AgentProviderReport = {
      configured: Boolean(configuredModel),
      provider: providerNameFor(baseUrl),
      model: configuredModel ?? null,
      baseUrl: baseUrl ?? null,
      credentialVariable,
      credentialPresent,
      state: classified.state,
      models: classified.models,
      detail: classified.detail,
    };
    return report;
  });
}
