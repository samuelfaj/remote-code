import { createApiClient, type ApiClientOptions } from "./index";

export type Schedule = {
  id: string;
  kind: string;
  workspaceId: string | null;
  botId: string | null;
  prompt: string;
  localTime: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextOccurrence: { plannedAt: string; decision: string } | null;
};

export async function listSchedules(
  origin: string,
  options?: ApiClientOptions,
): Promise<Schedule[]> {
  const { data, error } = await createApiClient(origin, options).api.schedules.get();
  if (error) throw error;
  if (!data) return [];
  return (data as { schedules: Schedule[] }).schedules;
}

export async function createSchedule(
  kind: string,
  workspaceId: string | undefined,
  botId: string | undefined,
  prompt: string,
  localTime: string,
  timezone: string,
  origin: string,
  options?: ApiClientOptions,
): Promise<Schedule> {
  const { data, error } = await createApiClient(origin, options)
    .api.schedules.post({ kind, workspaceId, botId, prompt, localTime, timezone });
  if (error) throw error;
  if (!data) throw new Error("Missing schedule creation result");
  return data as Schedule;
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
  origin: string,
  options?: ApiClientOptions,
): Promise<Schedule> {
  const { data, error } = await createApiClient(origin, options)
    .api.schedules({ id })
    .patch({ enabled });
  if (error) throw error;
  if (!data) throw new Error("Missing schedule update result");
  return data as Schedule;
}
