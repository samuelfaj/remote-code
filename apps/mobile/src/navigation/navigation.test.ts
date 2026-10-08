import { describe, expect, it } from "bun:test";
import { navigationReducer } from "./useNavigation";
import { inboxItemDestination, mapNotificationToDestination } from "./notification-routing";
import type { NavigationState } from "./types";

const initial: NavigationState = { current: "Workspaces", params: undefined, history: [] };

describe("navigation state machine", () => {
  it("keeps a history entry for every navigation so Back returns to the previous screen", () => {
    const first = navigationReducer(initial, { type: "NAVIGATE", screen: "Bots" });
    const second = navigationReducer(first, { type: "NAVIGATE", screen: "Inbox" });
    expect(second.current).toBe("Inbox");
    const back = navigationReducer(second, { type: "GO_BACK" });
    expect(back.current).toBe("Bots");
    expect(back.history).toHaveLength(1);
  });

  it("carries the parameters a screen needs", () => {
    const state = navigationReducer(initial, {
      type: "NAVIGATE",
      screen: "ThreadMessages",
      params: { workspaceId: "ws-1", threadId: "th-1", threadTitle: "One" },
    });
    expect(state.params).toEqual({ workspaceId: "ws-1", threadId: "th-1", threadTitle: "One" });
  });

  it("ignores Back when there is nothing to go back to", () => {
    expect(navigationReducer(initial, { type: "GO_BACK" })).toEqual(initial);
  });

  it("drops the history on reset, so a signed-out screen cannot be returned to", () => {
    const deep = navigationReducer(navigationReducer(initial, { type: "NAVIGATE", screen: "Bots" }), {
      type: "NAVIGATE",
      screen: "Inbox",
    });
    expect(navigationReducer(deep, { type: "RESET", screen: "Workspaces" })).toEqual(initial);
  });
});

describe("push destination routing", () => {
  it("routes a run's own destination to that workspace's threads, focused on the run", () => {
    // The exact shape runs.ts writes as the Inbox destination and the push payload.
    const result = mapNotificationToDestination({
      screen: "run",
      runId: "7e0a4d3e-6c2b-4a1f-9a6d-3b0d8f9a1c22",
      workspaceId: "3ff0d1f4-6a2a-4a34-8f5f-4a0d1c2b3e44",
      botId: null,
    });
    expect(result).toEqual({
      screen: "Threads",
      params: { workspaceId: "3ff0d1f4-6a2a-4a34-8f5f-4a0d1c2b3e44", workspaceName: "", focusRunId: "7e0a4d3e-6c2b-4a1f-9a6d-3b0d8f9a1c22" },
    });
  });

  it("opens the thread directly when the destination names one", () => {
    expect(mapNotificationToDestination({ screen: "run", workspaceId: "ws-1", threadId: "th-1" }))
      .toEqual({ screen: "ThreadMessages", params: { workspaceId: "ws-1", threadId: "th-1", threadTitle: "" } });
  });

  it("falls back to the Inbox for a destination it cannot place", () => {
    expect(mapNotificationToDestination({ screen: "run" })).toEqual({ screen: "Inbox", params: {} });
    expect(mapNotificationToDestination(undefined)).toBeNull();
  });

  it("places an Inbox item by its thread, workspace or run", () => {
    expect(inboxItemDestination("item-1", "ws-1", "th-1", "run-1")).toEqual({
      screen: "ThreadMessages", params: { workspaceId: "ws-1", threadId: "th-1", threadTitle: "" },
    });
    expect(inboxItemDestination("item-2", "ws-1", null, "run-1")).toEqual({
      screen: "Threads", params: { workspaceId: "ws-1", workspaceName: "", focusRunId: "run-1" },
    });
    expect(inboxItemDestination("item-3", null, null, "run-1")).toEqual({ screen: "Actions", params: {} });
    expect(inboxItemDestination("item-4", null, null, null)).toEqual({ screen: "Inbox", params: {} });
  });
});