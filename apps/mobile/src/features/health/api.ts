import { getHealth } from "@remotecode/client";

export async function getMobileHealth(origin: string): Promise<"ready" | "not_ready" | undefined> {
  return getHealth(origin);
}
