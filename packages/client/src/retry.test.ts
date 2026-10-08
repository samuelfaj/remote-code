import { describe, expect, it } from "bun:test";
import { retryAllowed, retryDelayMs, type RetryPlan } from "./retry";

const plan: RetryPlan = { maxAttempts: 3, baseDelayMs: 1_500, maxDelayMs: 2_000 };

describe("bounded jittered retry", () => {
  it("never waits before the first attempt and grows the ceiling afterwards", () => {
    expect(retryDelayMs(plan, 0, () => 1)).toBe(0);
    expect(retryDelayMs(plan, 1, () => 1)).toBe(1_500);
    expect(retryDelayMs(plan, 2, () => 1)).toBe(2_000); // 3000 capped at maxDelayMs
    expect(retryDelayMs(plan, 9, () => 1)).toBe(2_000);
  });

  it("jitters inside the ceiling so two callers do not wait alike", () => {
    const draws = [0, 0.25, 0.5, 0.999];
    const waits = draws.map((value) => retryDelayMs(plan, 1, () => value));
    expect(waits).toEqual([0, 375, 750, 1498]);
    expect(new Set(waits).size).toBe(draws.length);
  });

  it("treats a broken random source as no jitter rather than an unbounded wait", () => {
    expect(retryDelayMs(plan, 1, () => Number.NaN)).toBe(0);
    expect(retryDelayMs(plan, 1, () => -5)).toBe(0);
    expect(retryDelayMs(plan, 1, () => 5)).toBe(1_500);
  });

  it("limits the number of safe attempts", () => {
    expect(retryAllowed(plan, 0)).toBe(true);
    expect(retryAllowed(plan, 2)).toBe(true);
    expect(retryAllowed(plan, 3)).toBe(false);
    expect(retryAllowed(plan, -1)).toBe(false);
    expect(retryAllowed(plan, 1.5)).toBe(false);
  });
});