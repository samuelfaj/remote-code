import type { NotificationDestination, Screen } from "./types";

// The API writes each Inbox item's destination as a flat object — for a run it
// is `{ screen: "run", runId, workspaceId, botId }` (apps/api/src/features/runs.ts) —
// and the push payload carries that same object as its `deepLink`, so this maps
// that shape rather than a nested route.
export function mapNotificationToDestination(
  deepLink: Record<string, unknown> | undefined,
): NotificationDestination | null {
  if (!deepLink || typeof deepLink !== "object") return null;

  const screen = typeof deepLink.screen === "string" ? deepLink.screen : null;
  const workspaceId = typeof deepLink.workspaceId === "string" ? deepLink.workspaceId : null;
  const runId = typeof deepLink.runId === "string" ? deepLink.runId : null;
  const threadId = typeof deepLink.threadId === "string" ? deepLink.threadId : null;

  if (threadId && workspaceId) {
    return { screen: "ThreadMessages", params: { workspaceId, threadId, threadTitle: "" } };
  }
  if (screen === "run" && workspaceId) {
    // A run's destination names the run, never its thread, and runs carry no
    // thread id on the API: the thread is resolved from the message that
    // records the run, so the client opens the workspace's threads focused on
    // that run.
    return { screen: "Threads", params: { workspaceId, workspaceName: "", ...(runId ? { focusRunId: runId } : {}) } };
  }
  if (workspaceId) return { screen: "Threads", params: { workspaceId, workspaceName: "" } };
  return { screen: "Inbox", params: {} };
}

export function inboxItemDestination(
  itemId: string,
  workspaceId: string | null,
  threadId: string | null,
  runId: string | null,
): NotificationDestination {
  if (threadId && workspaceId) {
    return {
      screen: "ThreadMessages",
      params: { workspaceId, threadId, threadTitle: "" },
    };
  }
  if (workspaceId) {
    return {
      screen: "Threads",
      params: { workspaceId, workspaceName: "", ...(runId ? { focusRunId: runId } : {}) },
    };
  }
  if (runId) {
    return {
      screen: "Actions",
      params: {},
    };
  }
  return {
    screen: "Inbox",
    params: {},
  };
}

export function isKnownScreen(screen: string): screen is Screen {
  return ["Workspaces", "Bots", "BotRoutines", "Threads", "ThreadMessages", "Inbox", "Actions"].includes(screen);
}