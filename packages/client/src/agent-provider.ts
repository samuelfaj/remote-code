import { createApiClient, type ApiClientOptions } from "./index";

/** What the host reports about the agent's provider. Never carries a credential. */
export type AgentProvider = {
  configured: boolean;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  credentialVariable: string | null;
  credentialPresent: boolean;
  state: "connected" | "unauthenticated" | "unavailable" | "unconfigured";
  models: string[];
  detail: string;
};

export async function getAgentProvider(
  origin: string,
  options?: ApiClientOptions,
): Promise<AgentProvider> {
  const { data, error } = await createApiClient(origin, options).api.agent.provider.get();
  if (error) throw error;
  if (!data) throw new Error("Missing agent provider report");
  return data as AgentProvider;
}
