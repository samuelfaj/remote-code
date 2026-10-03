import { expect, it } from "bun:test";
import {
  pendingTerminalStartFromValue, terminalReferenceFromValue, terminalReceiptFromValue,
  terminalPollFromValue, terminalInputAckFromValue,
  type PendingTerminalStart, type TerminalReference, type TerminalReceipt, type TerminalPoll,
} from "./index";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const workspaceId = "123e4567-e89b-42d3-a456-426614174001";
const terminalId = "123e4567-e89b-42d3-a456-426614174002";
const otherId = "123e4567-e89b-42d3-a456-426614174003";
const start: PendingTerminalStart = { requestId, workspaceId, cols: 80, rows: 24 };
const reference: TerminalReference = { start, terminalId, inputUncertain: false, stopRequested: false, resizeUncertain: false };
const receipt: TerminalReceipt = { terminalId, requestId, workspaceId, state: "running", cols: 80, rows: 24,
  initialCols: 80, initialRows: 24, exitCode: null, cleanup: "pending", resizeState: "idle", inputSequence: 0, inputState: null };
const poll = { ...receipt, outputAvailable: true, baseOffset: 0, offset: 0, nextOffset: 4, endOffset: 4,
  gap: false, outputBase64: "8J+MjQ==" } satisfies TerminalPoll;

it("keeps persisted references limited to canonical start identity and exact boolean flags", () => {
  expect(pendingTerminalStartFromValue(start)).toEqual(start);
  expect(pendingTerminalStartFromValue({ ...start, cols: 2, rows: 2 })).toEqual({ ...start, cols: 2, rows: 2 });
  expect(pendingTerminalStartFromValue({ ...start, cols: 300, rows: 200 })).toEqual({ ...start, cols: 300, rows: 200 });
  for (const changed of [
    { requestId: "bad" }, { requestId: requestId.toUpperCase() }, { requestId: `${requestId}\n` },
    { workspaceId: "bad" }, { workspaceId: `${workspaceId}\n` },
    { cols: 1 }, { cols: 301 }, { cols: 2.5 }, { cols: "80" }, { cols: NaN },
    { rows: 1 }, { rows: 201 }, { rows: Infinity }, { input: "secret" },
  ]) expect(pendingTerminalStartFromValue({ ...start, ...changed })).toBeNull();
  for (const terminalId of [null, reference.terminalId]) {
    for (const inputUncertain of [false, true]) {
      for (const stopRequested of [false, true]) {
        for (const resizeUncertain of [false, true]) {
          const stored = { ...reference, terminalId, inputUncertain, stopRequested, resizeUncertain };
          const parsed = terminalReferenceFromValue(JSON.parse(JSON.stringify(stored)));
          expect(parsed).toEqual(stored);
          expect(parsed).not.toBe(stored);
          expect(parsed?.start).not.toBe(stored.start);
        }
      }
    }
  }
  for (const changed of [
    { terminalId: "bad" }, { terminalId: terminalId.toUpperCase() }, { terminalId: `${terminalId}\n` }, { terminalId: undefined },
    { inputUncertain: "false" }, { stopRequested: 0 }, { input: "secret" }, { output: "secret" },
    { credential: "secret" }, { start: { ...start, text: "secret" } },
    { resizeUncertain: "false" }, { resizeUncertain: 0 }, { resizeUncertain: null }, { resizeUncertain: undefined },
  ]) expect(terminalReferenceFromValue({ ...reference, ...changed })).toBeNull();
  for (const value of [null, [], "{}", 1]) {
    expect(pendingTerminalStartFromValue(value)).toBeNull();
    expect(terminalReferenceFromValue(value)).toBeNull();
  }
});

it("reads a legacy four-field reference as resize-certain and writes only the canonical five fields", () => {
  const { resizeUncertain: _omitted, ...legacy } = reference;
  expect(terminalReferenceFromValue(legacy)).toEqual(reference);
  expect(Object.keys(terminalReferenceFromValue({ ...legacy, inputUncertain: true })!).sort())
    .toEqual(["inputUncertain", "resizeUncertain", "start", "stopRequested", "terminalId"]);
  // A legacy shape with any other key, or a five-field shape missing another key, is not a reference.
  expect(terminalReferenceFromValue({ ...legacy, extra: true })).toBeNull();
  expect(terminalReferenceFromValue({ ...legacy, resizeUncertain: undefined })).toBeNull();
  const { stopRequested: _stop, ...missing } = reference;
  expect(terminalReferenceFromValue(missing)).toBeNull();
});

it("binds receipts to original request, workspace, initial dimensions and known terminal", () => {
  expect(terminalReceiptFromValue(receipt, start)).toEqual(receipt);
  expect(terminalReceiptFromValue(receipt, start, null)).toEqual(receipt);
  expect(terminalReceiptFromValue(receipt, start, terminalId)).toEqual(receipt);
  expect(terminalReceiptFromValue(receipt, start, otherId)).toBeNull();
  expect(terminalReceiptFromValue(receipt, { ...start, workspaceId: otherId })).toBeNull();
  expect(terminalReceiptFromValue(receipt, { ...start, cols: 81 })).toBeNull();
  expect(terminalReceiptFromValue(receipt, { ...start, requestId: "bad" })).toBeNull();
  for (const changed of [
    { requestId: otherId }, { workspaceId: otherId }, { initialCols: 81 }, { initialRows: 25 },
    { terminalId: "bad" }, { terminalId: terminalId.toUpperCase() }, { terminalId: `${terminalId}\n` }, { cols: 301 }, { rows: 201 },
    { cols: 80.5 }, { rows: "24" }, { initialCols: "80" }, { state: "completed" }, { cleanup: "done" },
    { resizeState: "resized" }, { inputSequence: -1 }, { inputSequence: 0.5 },
    { inputSequence: Number.MAX_SAFE_INTEGER + 1 }, { inputState: "sent" }, { extra: true },
  ]) expect(terminalReceiptFromValue({ ...receipt, ...changed }, start, terminalId)).toBeNull();
  for (const key of Object.keys(receipt)) {
    const missing = { ...receipt } as Record<string, unknown>;
    delete missing[key];
    expect(terminalReceiptFromValue(missing, start)).toBeNull();
  }
  expect(terminalReceiptFromValue({ ...receipt, cols: 120, rows: 40, resizeState: "applied" }, start)?.cols).toBe(120);
  expect(terminalReceiptFromValue({ ...receipt, cols: 120, rows: 40, resizeState: "unknown" }, start)?.resizeState).toBe("unknown");
  expect(terminalReceiptFromValue({ ...receipt, cols: 120 }, start)).toBeNull();
});

it("preserves backend uncertainty and rejects contradictory exit, cleanup and input states", () => {
  for (const state of ["reserved", "starting", "running", "closing", "unknown", "not_started"] as const) {
    expect(terminalReceiptFromValue({ ...receipt, state }, start)?.state).toBe(state);
    expect(terminalReceiptFromValue({ ...receipt, state, exitCode: 0 }, start)).toBeNull();
  }
  expect(terminalReceiptFromValue({ ...receipt, state: "exited", exitCode: 0, cleanup: "removed" }, start)?.exitCode).toBe(0);
  expect(terminalReceiptFromValue({ ...receipt, state: "not_started", cleanup: "removed" }, start)?.state).toBe("not_started");
  for (const exitCode of [null, NaN, Infinity, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    expect(terminalReceiptFromValue({ ...receipt, state: "exited", exitCode }, start)).toBeNull();
  }
  expect(terminalReceiptFromValue({ ...receipt, cleanup: "removed" }, start)).toBeNull();
  for (const state of ["unknown", "queued", "written"] as const) {
    expect(terminalReceiptFromValue({ ...receipt, inputSequence: 1, inputState: state }, start)?.inputState).toBe(state);
    expect(terminalReceiptFromValue({ ...receipt, inputState: state }, start)).toBeNull();
  }
  expect(terminalReceiptFromValue({ ...receipt, inputSequence: 1 }, start)).toBeNull();
  expect(terminalReceiptFromValue({ ...receipt, state: "unknown", cleanup: "unknown", inputSequence: 1, inputState: "unknown" }, start)?.inputState).toBe("unknown");
});

it("binds polling to known terminal and requested byte cursor, never character counts", () => {
  expect(terminalPollFromValue(poll, reference, 0)).toEqual(poll);
  expect(terminalPollFromValue({ ...poll, nextOffset: 1, endOffset: 1 }, reference, 0)).toBeNull();
  const gap = { ...poll, baseOffset: 10, offset: 10, nextOffset: 14, endOffset: 14, gap: true };
  expect(terminalPollFromValue(gap, reference, 3)).toEqual(gap);
  expect(terminalPollFromValue({ ...gap, gap: false }, reference, 3)).toBeNull();
  expect(terminalPollFromValue({ ...gap, gap: false }, reference, 10)?.gap).toBe(false);
  const empty = { ...poll, offset: 4, nextOffset: 4, outputBase64: "" };
  expect(terminalPollFromValue(empty, reference, 4)).toEqual(empty);
  expect(terminalPollFromValue(empty, reference, 5)).toBeNull();
  expect(terminalPollFromValue(poll, { ...reference, terminalId: null }, 0)).toBeNull();
  expect(terminalPollFromValue(poll, { ...reference, terminalId: otherId }, 0)).toBeNull();
  expect(terminalPollFromValue(poll, { ...reference, start: { ...start, requestId: otherId } }, 0)).toBeNull();
  expect(terminalPollFromValue(poll, { ...reference, start: { ...start, workspaceId: otherId } }, 0)).toBeNull();
  expect(terminalPollFromValue(poll, { ...reference, start: { ...start, rows: 25 } }, 0)).toBeNull();
  for (const changed of [
    { baseOffset: 1 }, { offset: 1 }, { nextOffset: 5 }, { endOffset: 3 }, { endOffset: 5 },
    { baseOffset: -1 }, { offset: 0.5 }, { nextOffset: "4" }, { endOffset: Number.MAX_SAFE_INTEGER + 1 },
    { endOffset: 65537 }, { gap: true }, { gap: "false" }, { outputAvailable: "true" }, { extra: 1 },
  ]) expect(terminalPollFromValue({ ...poll, ...changed }, reference, 0)).toBeNull();
  for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(terminalPollFromValue(poll, reference, cursor)).toBeNull();
  }
  const end = Number.MAX_SAFE_INTEGER;
  const high = { ...poll, baseOffset: end - 4, offset: end - 4, nextOffset: end, endOffset: end };
  expect(terminalPollFromValue(high, reference, end - 4)).toEqual(high);
});

it("accepts canonical binary base64 up to 16 KiB and rejects noncanonical padding or hidden bytes", () => {
  for (const text of ["", "\xff", "\x00\xff", "\x00\x80\xff", "a".repeat(16384)]) {
    const outputBase64 = btoa(text);
    const snapshot = { ...poll, outputBase64, nextOffset: text.length, endOffset: text.length };
    expect(terminalPollFromValue(snapshot, reference, 0)).toEqual(snapshot);
  }
  for (const outputBase64 of ["Zg", "Zg=", "Zg===", "Zh==", "Zm9=", " Zg==", "Zg==\n", "_w==", "-w==", "!!!!", 1, null]) {
    expect(terminalPollFromValue({ ...poll, outputBase64 }, reference, 0)).toBeNull();
  }
  expect(terminalPollFromValue({ ...poll, outputBase64: "Zh==", nextOffset: 1, endOffset: 1 }, reference, 0)).toBeNull();
  expect(terminalPollFromValue({ ...poll, outputBase64: "Zm9=", nextOffset: 2, endOffset: 2 }, reference, 0)).toBeNull();
  const outputBase64 = btoa("a".repeat(16385));
  expect(terminalPollFromValue({ ...poll, outputBase64, nextOffset: 16385, endOffset: 16385 }, reference, 0)).toBeNull();
  const page = { ...poll, outputBase64: btoa("a".repeat(16384)), nextOffset: 16384, endOffset: 20000 };
  expect(terminalPollFromValue(page, reference, 0)).toEqual(page);
  expect(terminalPollFromValue({ ...poll, endOffset: 20000 }, reference, 0)).toBeNull();
});

it("represents unavailable output without fabricated cursors, bytes or recoverability", () => {
  const unavailable = { ...receipt, state: "unknown", outputAvailable: false, gap: true } satisfies TerminalPoll;
  expect(terminalPollFromValue(unavailable, reference, 300)).toEqual(unavailable);
  for (const changed of [
    { gap: false }, { gap: undefined }, { offset: 0 }, { baseOffset: 0 }, { nextOffset: 0 },
    { endOffset: 0 }, { outputBase64: "" }, { terminalId: otherId }, { extra: true },
  ]) expect(terminalPollFromValue({ ...unavailable, ...changed }, reference, 300)).toBeNull();
  expect(terminalPollFromValue({ ...poll, outputAvailable: false, gap: true }, reference, 0)).toBeNull();
  for (const key of Object.keys(poll)) {
    const missing = { ...poll } as Record<string, unknown>;
    delete missing[key];
    expect(terminalPollFromValue(missing, reference, 0)).toBeNull();
  }
});

it("confirms only the exact terminal and sequence ack and never upgrades unknown or queued to written", () => {
  for (const state of ["unknown", "queued", "written"] as const) {
    const ack = { terminalId, sequence: 1, state };
    expect(terminalInputAckFromValue(ack, terminalId, 1)).toEqual(ack);
  }
  const ack = { terminalId, sequence: 1, state: "written" };
  for (const changed of [
    { terminalId: otherId }, { terminalId: terminalId.toUpperCase() }, { sequence: 2 }, { sequence: "1" },
    { sequence: 0 }, { sequence: 0.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { state: "sent" },
    { state: null }, { extra: true }, { text: "secret" }, { error: "terminal_input_unknown" },
  ]) expect(terminalInputAckFromValue({ ...ack, ...changed }, terminalId, 1)).toBeNull();
  expect(terminalInputAckFromValue(ack, otherId, 1)).toBeNull();
  expect(terminalInputAckFromValue({ ...ack, terminalId: "bad" }, "bad", 1)).toBeNull();
  for (const sequence of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(terminalInputAckFromValue({ ...ack, sequence }, terminalId, sequence)).toBeNull();
  }
  expect(terminalInputAckFromValue({ ...ack, sequence: Number.MAX_SAFE_INTEGER }, terminalId, Number.MAX_SAFE_INTEGER)?.state).toBe("written");
  for (const value of [null, [], "{}", { status: 503, value: { error: "request_outcome_unknown" } }]) {
    expect(terminalInputAckFromValue(value, terminalId, 1)).toBeNull();
    expect(terminalReceiptFromValue(value, start)).toBeNull();
    expect(terminalPollFromValue(value, reference, 0)).toBeNull();
  }
  for (const key of Object.keys(ack)) {
    const missing = { ...ack } as Record<string, unknown>;
    delete missing[key];
    expect(terminalInputAckFromValue(missing, terminalId, 1)).toBeNull();
  }
});
