// Bounded retry policy for post-timeout receipt reads: a limited number of
// attempts, each waiting an exponentially increasing ceiling, jittered so that
// two clients that hit the same deadline do not retry in lockstep.
export type RetryPlan = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export function retryAllowed(plan: RetryPlan, attempt: number): boolean {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < plan.maxAttempts;
}

/**
 * Wait before `attempt` (0-based). Attempt 0 waits nothing: the caller has just
 * finished the first read. Later attempts use `base * 2^(attempt-1)` capped at
 * `maxDelayMs`, then jittered into `[0, ceiling]`.
 */
export function retryDelayMs(plan: RetryPlan, attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt <= 0) return 0;
  const step = Math.min(Math.max(0, attempt - 1), 8);
  const ceiling = Math.max(0, Math.min(plan.maxDelayMs, plan.baseDelayMs * 2 ** step));
  const value = random();
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  return Math.floor(normalized * ceiling);
}