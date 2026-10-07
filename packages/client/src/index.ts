export { actionReceiptFromResponse, isDefinitiveActionRejection } from "./action-recovery";
export { applyActionEvent, emptyActionEventState } from "./action-events";
export { pendingWorkspaceFromValue, pendingWorkspaceValueMatches, workspaceDeadlineIsOpen, workspaceErrorStatus, workspaceFromValue, workspaceListFromValue, workspaceReceiptFromValue, workspacePanelUserId } from "./workspaces";
export type { PendingWorkspace, Workspace, WorkspaceKind } from "./workspaces";
export { fileReceiptFromValue, pendingFileFromValue, pendingFileValueMatches, pendingFolderFromValue, pendingFolderMatches, validFilePath, validFileText, fileFolderStateFromValue, fileDirectoryFromValue, fileContentFromValue, fileVersionConflict, fileConflictVersion, fileTargetExists, fileMissingPath } from "./files";
export type { FileKind, FileReceipt, PendingFile, PendingFolder, FileEntry, FileContent, FileFolderState } from "./files";
export { pendingTerminalStartFromValue, terminalReferenceFromValue, terminalReceiptFromValue, terminalPollFromValue, terminalInputAckFromValue, terminalInputRejectionIsDefinitive, terminalRejectionMessage, terminalAttachedReceipt } from "./terminals";
export { workspaceLayoutFromValue, workspaceLayoutResponseFromValue } from "./layout";
export type { WorkspaceLayout, LayoutTab, LayoutPane } from "./layout";
export type { PendingTerminalStart, TerminalReference, TerminalState, TerminalInputState, TerminalReceipt, TerminalPoll, TerminalInputAck } from "./terminals";
export type { ActionEventState, ActionReceipt } from "./action-events";
export { retryAllowed, retryDelayMs } from "./retry";
export type { RetryPlan } from "./retry";
export { takeScreenPossession, readScreenPossession, heartbeatScreenPossession,
  releaseScreenPossession, readRun, readRunChanges, readWorkspaceRuns } from "./screen";
export type { ScreenPossessionResult, ScreenPossessionState, RunChange, WorkspaceRun } from "./screen";
export { runMutation } from "./offline";
export type { MutationOutcome } from "./offline";

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

function streamWithUnknownOutcomeError(response: Response, cleanup: () => void) {
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
        controller.error(new ApiClientError(error));
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
    } catch {
      timedSignal.cleanup();
      return unknownOutcomeResponse();
    }

    const contentType = response.headers.get("content-type")?.split(";")[0];
    const streamingText = contentType?.startsWith("text/")
      && response.headers.get("transfer-encoding") === "chunked"
      && !response.headers.has("content-length");
    if (contentType === "text/event-stream" || streamingText) {
      return streamWithUnknownOutcomeError(response, timedSignal.cleanup);
    }

    try {
      await response.clone().arrayBuffer();
    } catch {
      timedSignal.cleanup();
      return unknownOutcomeResponse();
    }
    timedSignal.cleanup();
    return response;
  }, { preconnect: fetch.preconnect });
  return treaty<App>(origin, { fetcher, parseDate: false });
}

export async function getHealth(origin: string, options?: ApiClientOptions) {
  const { data, error } = await createApiClient(origin, options).api.health.ready.get();
  if (error?.status === 503 && typeof error.value === "object" && error.value !== null
    && "status" in error.value && error.value.status === "not_ready") return "not_ready";
  if (error) throw error;
  return data?.status;
}
