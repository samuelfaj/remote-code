export type MutationOutcome<T = unknown> =
  | { status: "committed"; result: T }
  | { status: "not_committed" }
  | { status: "unknown" };

export async function runMutation<T = unknown>({
  send,
  deadlineMs,
  receipt,
  onLateResult,
}: {
  send: (signal: AbortSignal) => Promise<T>;
  deadlineMs: number;
  receipt: () => Promise<{ applied: boolean } | null>;
  onLateResult: (result: T) => void;
}): Promise<MutationOutcome<T>> {
  const deadline = Date.now() + deadlineMs;
  let sendCompleted = false;
  let sendResult: T | null = null;
  let sendError: unknown = null;

  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);

  // send is called exactly once; the AbortController is shared so the
  // caller can cancel the in-flight request when the deadline expires.
  const sendPromise = (async () => {
    try {
      sendResult = await send(controller.signal);
    } catch (error) {
      sendError = error;
    } finally {
      sendCompleted = true;
    }
  })();

  // Wait for send to settle, then clear the deadline timer.
  await sendPromise;
  clearTimeout(deadlineTimer);

  // Response arrived before the deadline and without an error → committed.
  if (sendCompleted && sendError === null && Date.now() < deadline) {
    return { status: "committed", result: sendResult! };
  }

  // Response arrived after the deadline: report it as late, then check receipt.
  if (sendCompleted && sendResult !== null && Date.now() >= deadline) {
    onLateResult(sendResult);
  }

  // Deadline passed or send failed — consult the authoritative receipt.
  const receiptResult = await receipt();
  if (receiptResult?.applied) return { status: "committed", result: sendResult! };
  if (receiptResult !== null) return { status: "not_committed" };
  return { status: "unknown" };
}
