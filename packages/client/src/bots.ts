import { createApiClient, type ApiClientOptions } from "./index";

export type Bot = {
  id: string;
  name: string;
  instructions: string;
  context: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  skills: string[];
};

export async function listBots(
  origin: string,
  options?: ApiClientOptions,
): Promise<Bot[]> {
  const { data, error } = await createApiClient(origin, options).api.bots.get();
  if (error) throw error;
  if (!data) return [];
  return (data as { bots: Bot[] }).bots;
}

export async function createBot(
  name: string,
  instructions: string | undefined,
  context: string | undefined,
  origin: string,
  options?: ApiClientOptions,
): Promise<Bot> {
  const { data, error } = await createApiClient(origin, options)
    .api.bots.post({ name, instructions, context });
  if (error) throw error;
  if (!data) throw new Error("Missing bot creation result");
  return data as Bot;
}

export async function readBot(
  id: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<Bot> {
  const { data, error } = await createApiClient(origin, options)
    .api.bots({ id })
    .get();
  if (error) throw error;
  if (!data) throw new Error("Missing bot result");
  return data as Bot;
}
