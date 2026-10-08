import { getHealth } from "@remotecode/client";

export async function getWebHealth(origin: string): Promise<"ready" | "not_ready" | undefined> {
  return getHealth(origin);
}
