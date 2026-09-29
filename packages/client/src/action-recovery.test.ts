import { expect, it } from "bun:test";
import { actionReceiptFromResponse, isDefinitiveActionRejection } from "./action-recovery";

const receipt = { id: "canonical-id", action: "record once", createdAt: "2026-09-27T00:00:00.000Z" };

it("normalizes a confirmed receipt from either raw JSON or Eden's date revival", () => {
  for (const createdAt of [receipt.createdAt, new Date(receipt.createdAt)]) {
    expect(actionReceiptFromResponse({ status: 200, error: null, data: { ...receipt, createdAt } })).toEqual(receipt);
  }
});

it("never confirms a failed response or malformed receipt even when it contains an ID", () => {
  expect(actionReceiptFromResponse({ status: 503, error: null, data: receipt })).toBeNull();
  expect(actionReceiptFromResponse({ status: 200, error: { value: "unknown" }, data: receipt })).toBeNull();
  for (const data of [
    null,
    { id: "only-an-id" },
    { ...receipt, id: "" },
    { ...receipt, createdAt: new Date(NaN) },
    { ...receipt, createdAt: "not-a-date" },
    { ...receipt, createdAt: "September 29, 2026" },
  ]) {
    expect(actionReceiptFromResponse({ status: 200, error: null, data })).toBeNull();
  }
});

it("keeps timeout, conflict and server failure uncertain instead of treating them as no effect", () => {
  for (const status of [408, 409, 429, 500, 502, 503, 504]) {
    expect(isDefinitiveActionRejection({ status, error: { status }, data: null })).toBe(false);
  }
  for (const status of [401, 403, 422, 426]) {
    expect(isDefinitiveActionRejection({ status, error: { status }, data: null })).toBe(true);
  }
  expect(isDefinitiveActionRejection({ status: 201, error: null, data: receipt })).toBe(false);
});
