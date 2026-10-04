import { describe, expect, it } from "bun:test";
import { terminalReceiptFromValue } from "@remotecode/client";

const base = {
  terminalId: "123e4567-e89b-42d3-a456-426614174001",
  requestId: "123e4567-e89b-42d3-a456-426614174002",
  workspaceId: "123e4567-e89b-42d3-a456-426614174003",
  state: "running",
  cols: 80,
  rows: 24,
  initialCols: 80,
  initialRows: 24,
  exitCode: null,
  cleanup: "pending",
  resizeState: "idle",
  inputSequence: 1,
};

const start = { requestId: base.requestId, workspaceId: base.workspaceId, cols: 80, rows: 24 };

describe("queued-input backpressure signal", () => {
  it("keeps queued distinct from written so UI can tell user to wait", () => {
    const queued = terminalReceiptFromValue({ ...base, inputState: "queued" }, start);
    const written = terminalReceiptFromValue({ ...base, inputState: "written" }, start);
    expect(queued?.inputState).toBe("queued");
    expect(written?.inputState).toBe("written");
    expect(queued?.inputState === "queued").toBe(true);
    expect(written?.inputState === "queued").toBe(false);
  });

  it("rejects unknown input states instead of treating them as queued", () => {
    expect(terminalReceiptFromValue({ ...base, inputState: "buffered" }, start)).toBeNull();
  });
});
