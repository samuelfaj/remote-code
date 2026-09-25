import { createApiClient } from "@remotecode/client";

export async function getWebHealth(origin: string): Promise<"ready" | undefined> {
  const { data } = await createApiClient(origin).api.health.get();
  const status: "ready" | undefined = data?.status;
  return status;
}
