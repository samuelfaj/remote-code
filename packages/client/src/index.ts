import { treaty } from "@elysiajs/eden";
import type { App } from "@remotecode/api";

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
  return Response.json({ error: "request_outcome_unknown" }, { status: 503 });
}

function streamWithTimeoutError(response: Response, signal: AbortSignal) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(signal.aborted ? new ApiClientError(error) : error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
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
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        credentials: "include",
        headers,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return unknownOutcomeResponse();
      throw error;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0];
    const streamingText = contentType?.startsWith("text/")
      && response.headers.get("transfer-encoding") === "chunked"
      && !response.headers.has("content-length");
    if (contentType === "text/event-stream" || streamingText) {
      return streamWithTimeoutError(response, signal);
    }

    try {
      await response.clone().arrayBuffer();
    } catch (error) {
      if (signal.aborted) return unknownOutcomeResponse();
      throw error;
    }
    return response;
  }, { preconnect: fetch.preconnect });
  return treaty<App>(origin, { fetcher });
}

export async function getHealth(origin: string, options?: ApiClientOptions) {
  const { data, error } = await createApiClient(origin, options).api.health.ready.get();
  if (error) throw error;
  return data?.status;
}
