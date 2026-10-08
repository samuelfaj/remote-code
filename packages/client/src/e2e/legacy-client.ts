// Frozen API client source from 80b93534778d623fe9b51e6f62218ccf354282fc; no version header existed then.
import { treaty } from "@elysiajs/eden";
import type { App } from "@remotecode/api";

export type ApiClientOptions = {
  timeoutMs?: number;
  headers?: HeadersInit;
};

export type UnknownOutcomeError = { status: 503; value: { error: "request_outcome_unknown" } };

export function isUnknownOutcomeError(error: unknown): error is UnknownOutcomeError {
  if (typeof error !== "object" || error === null || !("value" in error) || !("status" in error)) return false;
  const value = error.value;
  return error.status === 503 && typeof value === "object" && value !== null
    && "error" in value && value.error === "request_outcome_unknown";
}

export class ApiClientError extends Error {
  readonly status = 503;
  readonly value = { error: "request_outcome_unknown" };

  constructor(cause: unknown) {
    super("The request outcome is unknown", { cause });
    this.name = "ApiClientError";
  }
}

function unknownOutcomeResponse() {
  return new Response(JSON.stringify({ error: "request_outcome_unknown" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function createRequestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function streamWithTimeoutError(response: Response, signal: AbortSignal, cleanup: () => void) {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        cleanup();
        controller.error(signal.aborted ? new ApiClientError(error) : error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        cleanup();
      }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createLegacyApiClient(origin: string, options: ApiClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    new Headers(options.headers).forEach((value, name) => headers.set(name, value));
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abortFromCaller();
    else init?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(input, { ...init, credentials: "include", headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", abortFromCaller);
      if (controller.signal.aborted) return unknownOutcomeResponse();
      throw error;
    }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    const streamingText = contentType?.startsWith("text/")
      && response.headers.get("transfer-encoding") === "chunked"
      && !response.headers.has("content-length");
    if (contentType === "text/event-stream" || streamingText) {
      return streamWithTimeoutError(response, controller.signal, () => {
        clearTimeout(timeout);
        init?.signal?.removeEventListener("abort", abortFromCaller);
      });
    }
    try {
      await response.clone().arrayBuffer();
    } catch (error) {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", abortFromCaller);
      if (controller.signal.aborted) return unknownOutcomeResponse();
      throw error;
    }
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abortFromCaller);
    return response;
  }, { preconnect: fetch.preconnect });
  return treaty<App>(origin, { fetcher });
}

type LegacyReceipt = { id: string; action: string; createdAt: string };
type LegacyEventState = { cursor: number | null; actions: LegacyReceipt[]; needsSnapshot: boolean };
type LegacyEventResult = { state: LegacyEventState; requestSnapshot: boolean; snapshotApplied: boolean; validMessage: boolean };

export function emptyLegacyEventState(): LegacyEventState {
  return { cursor: null, actions: [], needsSnapshot: false };
}

function isLegacyReceipt(value: unknown): value is LegacyReceipt {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
    && "action" in value && typeof value.action === "string"
    && "createdAt" in value && typeof value.createdAt === "string";
}

export function applyLegacyEvent(state: LegacyEventState, input: unknown): LegacyEventResult {
  if (typeof input !== "object" || input === null || !("type" in input)) {
    return { state, requestSnapshot: false, snapshotApplied: false, validMessage: false };
  }
  if (input.type === "snapshot") {
    if (!("cursor" in input) || typeof input.cursor !== "number" || !Number.isSafeInteger(input.cursor) || input.cursor < 0
      || !("actions" in input) || !Array.isArray(input.actions) || !input.actions.every(isLegacyReceipt)
      || new Set(input.actions.map((receipt) => receipt.id)).size !== input.actions.length) {
      return { state, requestSnapshot: false, snapshotApplied: false, validMessage: false };
    }
    return { state: { cursor: input.cursor, actions: input.actions, needsSnapshot: false }, requestSnapshot: false, snapshotApplied: true, validMessage: true };
  }
  if (input.type !== "action.created" || !("cursor" in input) || typeof input.cursor !== "number"
    || !Number.isSafeInteger(input.cursor) || input.cursor < 1 || !("receipt" in input) || !isLegacyReceipt(input.receipt)) {
    return { state, requestSnapshot: false, snapshotApplied: false, validMessage: false };
  }
  if (state.needsSnapshot) return { state, requestSnapshot: false, snapshotApplied: false, validMessage: true };
  if (state.cursor === null || input.cursor > state.cursor + 1) {
    return { state: { ...state, needsSnapshot: true }, requestSnapshot: true, snapshotApplied: false, validMessage: true };
  }
  if (input.cursor <= state.cursor) return { state, requestSnapshot: false, snapshotApplied: false, validMessage: true };
  const eventReceipt = input.receipt;
  return {
    state: { cursor: input.cursor, needsSnapshot: false, actions: [eventReceipt, ...state.actions.filter((item) => item.id !== eventReceipt.id)] },
    requestSnapshot: false,
    snapshotApplied: false,
    validMessage: true,
  };
}

const api = createLegacyApiClient(window.location.origin);
const status = document.querySelector<HTMLElement>("#status")!;
const error = document.querySelector<HTMLElement>("#error")!;
const receipt = document.querySelector<HTMLElement>("#receipt")!;
const actionInput = document.querySelector<HTMLInputElement>("#action")!;
const writeButton = document.querySelector<HTMLButtonElement>("#write")!;
let socket: WebSocket | undefined;
let eventState = emptyLegacyEventState();

document.querySelector<HTMLButtonElement>("#sign-in")!.addEventListener("click", async () => {
  const { data, error: loginError } = await api.api.auth.login.post({
    password: document.querySelector<HTMLInputElement>("#passphrase")!.value,
  });
  if (loginError || !data || "error" in data) {
    error.textContent = "The previous client could not sign in.";
    return;
  }
  status.textContent = "Synchronizing";
  socket = new WebSocket(new URL("/api/events", window.location.href));
  socket.onmessage = (message) => {
    let payload: unknown;
    try { payload = JSON.parse(String(message.data)); } catch { return; }
    const result = applyLegacyEvent(eventState, payload);
    if (!result.validMessage) return;
    eventState = result.state;
    if (result.snapshotApplied) {
      status.textContent = `Legacy client connected at cursor ${eventState.cursor}`;
      writeButton.disabled = false;
    }
    receipt.textContent = eventState.actions[0]?.action ?? "";
    if (payload && typeof payload === "object" && "type" in payload && payload.type === "action.created") {
      status.textContent = result.requestSnapshot
        ? `Legacy client repairing snapshot after cursor ${eventState.cursor}`
        : `Legacy event received at cursor ${eventState.cursor}`;
    }
    if (result.requestSnapshot) socket?.send(JSON.stringify({ type: "sync" }));
  };
  socket.onclose = () => {
    status.textContent = "Legacy client disconnected";
    writeButton.disabled = true;
  };
});

writeButton.addEventListener("click", async () => {
  const { data, error: writeError } = await api.api.actions.post({ action: actionInput.value });
  if (writeError || !data || "error" in data) {
    error.textContent = "The previous client write failed.";
    return;
  }
  receipt.textContent = data.action;
  socket?.send(JSON.stringify({ type: "sync" }));
});
