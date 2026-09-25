import { createApiClient } from "@remotecode/client";

export async function getWebHealth(origin: string): Promise<"ready" | "not_ready" | undefined> {
  const { data } = await createApiClient(origin).api.health.ready.get();
  const status: "ready" | "not_ready" | undefined = data?.status;
  return status;
}
