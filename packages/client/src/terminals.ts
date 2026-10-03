export type PendingTerminalStart = { requestId: string; workspaceId: string; cols: number; rows: number };
export type TerminalReference = {
  start: PendingTerminalStart;
  terminalId: string | null;
  inputUncertain: boolean;
  stopRequested: boolean;
  resizeUncertain: boolean;
};
export type TerminalState = "reserved" | "starting" | "running" | "closing" | "unknown" | "exited" | "not_started";
export type TerminalInputState = "unknown" | "queued" | "written";
export type TerminalReceipt = {
  terminalId: string;
  requestId: string;
  workspaceId: string;
  state: TerminalState;
  cols: number;
  rows: number;
  initialCols: number;
  initialRows: number;
  exitCode: number | null;
  cleanup: "pending" | "unknown" | "removed";
  resizeState: "idle" | "unknown" | "applied";
  inputSequence: number;
  inputState: TerminalInputState | null;
  flow?: { totalBytes: number; retainedBytes: number; droppedBytes: number; polledOffset: number };
};
export type TerminalPoll = TerminalReceipt & (
  | { outputAvailable: true; baseOffset: number; offset: number; nextOffset: number; endOffset: number; gap: boolean; outputBase64: string; retainedBytes: number; totalBytes: number; droppedBytes: number }
  | { outputAvailable: false; gap: true }
);
export type TerminalInputAck = { terminalId: string; sequence: number; state: TerminalInputState };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const referenceKeys = "inputUncertain,start,stopRequested,terminalId";
const receiptKeys = "cleanup,cols,exitCode,initialCols,initialRows,inputSequence,inputState,requestId,resizeState,rows,state,terminalId,workspaceId";

function terminalRow(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function terminalUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && uuid.test(value);
}

function dimension(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 2 && value <= maximum;
}

function offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function inputState(value: unknown): value is TerminalInputState {
  return value === "unknown" || value === "queued" || value === "written";
}

export function pendingTerminalStartFromValue(value: unknown): PendingTerminalStart | null {
  const row = terminalRow(value);
  if (!row || Object.keys(row).sort().join(",") !== "cols,requestId,rows,workspaceId" ||
    !terminalUuid(row.requestId) ||
    !terminalUuid(row.workspaceId) ||
    !dimension(row.cols, 300) || !dimension(row.rows, 200)) return null;
  return { requestId: row.requestId, workspaceId: row.workspaceId, cols: row.cols, rows: row.rows };
}

// Legacy persisted references have no resizeUncertain key and mean false.
export function terminalReferenceFromValue(value: unknown): TerminalReference | null {
  const row = terminalRow(value);
  const keys = row ? Object.keys(row).sort().join(",") : "";
  if (!row || (keys !== referenceKeys && keys !== "inputUncertain,resizeUncertain,start,stopRequested,terminalId") ||
    (row.terminalId !== null && !terminalUuid(row.terminalId)) ||
    typeof row.inputUncertain !== "boolean" || typeof row.stopRequested !== "boolean" ||
    (keys !== referenceKeys && typeof row.resizeUncertain !== "boolean")) return null;
  const start = pendingTerminalStartFromValue(row.start);
  if (!start) return null;
  return { start, terminalId: row.terminalId, inputUncertain: row.inputUncertain, stopRequested: row.stopRequested,
    resizeUncertain: keys === referenceKeys ? false : row.resizeUncertain as boolean };
}

export function terminalReceiptFromValue(value: unknown, pending: PendingTerminalStart, expectedTerminalId?: string | null): TerminalReceipt | null {
  const start = pendingTerminalStartFromValue(pending);
  const row = terminalRow(value);
  const { flow: flowValue, ...rest } = row ?? {};
  const parsedFlow = flow(flowValue);
  if (!start || !row || parsedFlow === null ||
    Object.keys(rest).sort().join(",") !== receiptKeys ||
    !terminalUuid(row.terminalId) ||
    (expectedTerminalId !== undefined && expectedTerminalId !== null && row.terminalId !== expectedTerminalId) ||
    row.requestId !== start.requestId || row.workspaceId !== start.workspaceId ||
    row.initialCols !== start.cols || row.initialRows !== start.rows ||
    !dimension(row.cols, 300) || !dimension(row.rows, 200) ||
    (row.state !== "reserved" && row.state !== "starting" && row.state !== "running" && row.state !== "closing" &&
      row.state !== "unknown" && row.state !== "exited" && row.state !== "not_started") ||
    (row.cleanup !== "pending" && row.cleanup !== "unknown" && row.cleanup !== "removed") ||
    (row.resizeState !== "idle" && row.resizeState !== "unknown" && row.resizeState !== "applied") ||
    !offset(row.inputSequence) || (row.inputSequence === 0 ? row.inputState !== null : !inputState(row.inputState)) ||
    (row.state === "exited" ? typeof row.exitCode !== "number" || !Number.isSafeInteger(row.exitCode) : row.exitCode !== null) ||
    (row.cleanup === "removed" && row.state !== "exited" && row.state !== "not_started") ||
    (row.resizeState === "idle" && (row.cols !== start.cols || row.rows !== start.rows))) return null;
  return { terminalId: row.terminalId, requestId: start.requestId, workspaceId: start.workspaceId,
    state: row.state, cols: row.cols, rows: row.rows, initialCols: start.cols, initialRows: start.rows,
    exitCode: row.exitCode as number | null, cleanup: row.cleanup, resizeState: row.resizeState,
    inputSequence: row.inputSequence, inputState: row.inputState as TerminalInputState | null,
    ...(parsedFlow === undefined ? {} : { flow: parsedFlow }) };
}

function flow(value: unknown): TerminalReceipt["flow"] | null | undefined {
  if (value === undefined) return undefined;
  const row = terminalRow(value);
  if (!row || Object.keys(row).sort().join(",") !== "droppedBytes,polledOffset,retainedBytes,totalBytes" ||
    !offset(row.totalBytes) || !offset(row.retainedBytes) || !offset(row.droppedBytes) || !offset(row.polledOffset) ||
    row.retainedBytes > 64 * 1024 || row.totalBytes - row.retainedBytes !== row.droppedBytes ||
    row.polledOffset > row.totalBytes) return null;
  return { totalBytes: row.totalBytes, retainedBytes: row.retainedBytes,
    droppedBytes: row.droppedBytes, polledOffset: row.polledOffset };
}

function base64ByteLength(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 21848 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (padding && (alphabet.indexOf(value[value.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0) return null;
  const length = value.length / 4 * 3 - padding;
  return length <= 16 * 1024 ? length : null;
}

export function terminalPollFromValue(value: unknown, expected: TerminalReference, requestedOffset: number): TerminalPoll | null {
  const reference = terminalReferenceFromValue(expected);
  const row = terminalRow(value);
  if (!reference?.terminalId || !row || !offset(requestedOffset)) return null;
  const { baseOffset, offset: from, nextOffset, endOffset, gap, outputBase64, outputAvailable,
    retainedBytes, totalBytes, droppedBytes, ...receiptValue } = row;
  const receipt = terminalReceiptFromValue(receiptValue, reference.start, reference.terminalId);
  if (!receipt) return null;
  if (outputAvailable === false) {
    if (Object.keys(row).sort().join(",") !== `${receiptKeys},gap,outputAvailable`.split(",").sort().join(",") || gap !== true) return null;
    return { ...receipt, outputAvailable: false, gap: true };
  }
  if (outputAvailable !== true || Object.keys(row).sort().join(",") !==
    `${receiptKeys},baseOffset,droppedBytes,endOffset,gap,nextOffset,offset,outputAvailable,outputBase64,retainedBytes,totalBytes`.split(",").sort().join(",") ||
    !offset(baseOffset) || !offset(from) || !offset(nextOffset) || !offset(endOffset) ||
    !offset(retainedBytes) || !offset(totalBytes) || !offset(droppedBytes) ||
    baseOffset > from || from > nextOffset || nextOffset > endOffset || endOffset - baseOffset > 64 * 1024 ||
    endOffset !== totalBytes || retainedBytes !== endOffset - baseOffset || droppedBytes !== baseOffset ||
    requestedOffset > endOffset || from !== Math.max(requestedOffset, baseOffset) || gap !== (requestedOffset < baseOffset)) return null;
  const length = base64ByteLength(outputBase64);
  if (length === null || nextOffset - from !== length || length !== Math.min(endOffset - from, 16 * 1024)) return null;
  return { ...receipt, outputAvailable: true, baseOffset, offset: from, nextOffset, endOffset,
    gap, outputBase64: outputBase64 as string, retainedBytes, totalBytes, droppedBytes };
}

export function terminalInputAckFromValue(value: unknown, expectedTerminalId: string, expectedSequence: number): TerminalInputAck | null {
  const row = terminalRow(value);
  if (!terminalUuid(expectedTerminalId) || !offset(expectedSequence) || expectedSequence === 0 ||
    !row || Object.keys(row).sort().join(",") !== "sequence,state,terminalId" ||
    row.terminalId !== expectedTerminalId || row.sequence !== expectedSequence || !inputState(row.state)) return null;
  return { terminalId: expectedTerminalId, sequence: expectedSequence, state: row.state };
}
