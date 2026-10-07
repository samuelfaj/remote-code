import { expect, it } from "bun:test";
import { runMutation } from "./offline";

it("returns committed when a response arrives after the deadline and the receipt says applied", async () => {
  let sendCount = 0;
  const outcome = await runMutation({
    send: (_signal) => {
      sendCount++;
      return new Promise((resolve) => {
        setTimeout(() => resolve("late-result"), 150);
      });
    },
    deadlineMs: 50,
    receipt: async () => ({ applied: true }),
    onLateResult: () => {},
  });
  expect(sendCount).toBe(1);
  expect(outcome.status).toBe("committed");
  if (outcome.status !== "committed") throw new Error("Expected committed");
  expect(outcome.result).toBe("late-result");
});

it("returns not_committed when the deadline passes and the receipt says not applied", async () => {
  let sendCount = 0;
  const outcome = await runMutation({
    send: (_signal) => {
      sendCount++;
      return new Promise((resolve) => {
        setTimeout(() => resolve("result"), 200);
      });
    },
    deadlineMs: 50,
    receipt: async () => ({ applied: false }),
    onLateResult: () => {},
  });
  expect(sendCount).toBe(1);
  expect(outcome).toEqual({ status: "not_committed" });
});

it("returns unknown when the deadline passes and the receipt is unreadable", async () => {
  let sendCount = 0;
  const outcome = await runMutation({
    send: (_signal) => {
      sendCount++;
      return new Promise((resolve) => {
        setTimeout(() => resolve("result"), 200);
      });
    },
    deadlineMs: 50,
    receipt: async () => null,
    onLateResult: () => {},
  });
  expect(sendCount).toBe(1);
  expect(outcome).toEqual({ status: "unknown" });
});

it("calls send exactly once when the response arrives on time", async () => {
  let sendCount = 0;
  const outcome = await runMutation({
    send: (_signal) => {
      sendCount++;
      return Promise.resolve("ok");
    },
    deadlineMs: 500,
    receipt: async () => ({ applied: true }),
    onLateResult: () => {},
  });
  expect(sendCount).toBe(1);
  expect(outcome.status).toBe("committed");
  if (outcome.status !== "committed") throw new Error("Expected committed");
  expect(outcome.result).toBe("ok");
});
