export { applyActionEvent, emptyActionEventState } from "./action-events";
export type { ActionEventState, ActionReceipt } from "./action-events";

import { treaty } from "@elysiajs/eden";
import type { App } from "@remotecode/api";

export const CLIENT_VERSION = 1;

export type ApiClientOptions = {
  timeoutMs?: number;
  headers?: HeadersInit;
};

export type UnknownOutcomeError = {
  status: 503;
  value: { error: "request_outcome_unknown" };
};

export function isUnknownOutcomeError(error: unknown): error is UnknownOutcomeError {
  if (typeof error !== "object" || error === null || !("value" in error) || !("status" in error)) {
    return false;
  }
  const value = error.value;
  return error.status === 503
    && typeof value === "object"
    && value !== null
    && "error" in value
    && value.error === "request_outcome_unknown";
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
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createApiClient(origin: string, options: ApiClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    new Headers(options.headers).forEach((value, name) => headers.set(name, value));
    headers.set("x-remotecode-client-version", String(CLIENT_VERSION));
    const timedSignal = createRequestSignal(init?.signal ?? undefined, timeoutMs);
    const { signal } = timedSignal;
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        credentials: "include",
        headers,
        signal,
      });
    } catch (error) {
      timedSignal.cleanup();
      if (signal.aborted) return unknownOutcomeResponse();
      throw error;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0];
    const streamingText = contentType?.startsWith("text/")
      && response.headers.get("transfer-encoding") === "chunked"
      && !response.headers.has("content-length");
    if (contentType === "text/event-stream" || streamingText) {
      return streamWithTimeoutError(response, signal, timedSignal.cleanup);
    }

    try {
      await response.clone().arrayBuffer();
    } catch (error) {
      timedSignal.cleanup();
      if (signal.aborted) return unknownOutcomeResponse();
      throw error;
    }
    timedSignal.cleanup();
    return response;
  }, { preconnect: fetch.preconnect });
  return treaty<App>(origin, { fetcher });
}

export async function getHealth(origin: string, options?: ApiClientOptions) {
  const { data, error } = await createApiClient(origin, options).api.health.ready.get();
  if (error) throw error;
  return data?.status;
}
