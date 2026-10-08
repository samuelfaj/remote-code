export type LiveResource =
  | "workspaces"
  | "bots"
  | "runs"
  | "threads"
  | "messages"
  | "inbox"
  | "schedules"
  | "terminal"
  | "screen"
  | "files";

export const ALL_LIVE_RESOURCES: LiveResource[] = [
  "workspaces", "bots", "runs", "threads", "messages", "inbox", "schedules", "terminal", "screen", "files",
];

export type LiveEventState = { seq: number | null };

export type LiveEventResult = {
  state: LiveEventState;
  invalidate: LiveResource[];
  resync: boolean;
  /** true when this message belongs to the live-event protocol (so the caller must not treat it as a malformed action event) */
  handled: boolean;
  validMessage: boolean;
};

// Resources a `.changed` event invalidates; null when the type is not a known change event.
const CHANGED_RESOURCES: Record<string, LiveResource[]> = {
  "workspace.changed": ["workspaces", "files"],
  "bot.changed": ["bots"],
  "thread.changed": ["threads"],
  "message.changed": ["messages", "inbox"],
  "inbox.changed": ["inbox"],
  "schedule.changed": ["schedules"],
  "terminal.changed": ["terminal"],
  "screen.changed": ["screen"],
  "files.changed": ["files"],
};

export function emptyLiveEventState(): LiveEventState {
  return { seq: null };
}

export function resourcesForEvent(type: string): LiveResource[] | null {
  return CHANGED_RESOURCES[type] ?? null;
}

export function applyLiveEvent(state: LiveEventState, input: unknown): LiveEventResult {
  if (typeof input !== "object" || input === null || !("type" in input) || typeof input.type !== "string") {
    return { state, invalidate: [], resync: false, handled: false, validMessage: false };
  }

  const type = input.type;
  // Snapshot and action events are owned by the action reducer, not the live-event protocol.
  if (type === "snapshot" || type === "action.created") {
    return { state, invalidate: [], resync: false, handled: false, validMessage: true };
  }

  let invalidate: LiveResource[];
  if (type === "run.updated") invalidate = ["runs", "inbox"];
  else if (type.endsWith(".changed")) invalidate = resourcesForEvent(type) ?? [];
  else invalidate = [];

  const seq = "seq" in input ? input.seq : undefined;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return { state, invalidate, resync: false, handled: true, validMessage: true };
  }
  if (state.seq === null) {
    return { state: { seq }, invalidate, resync: false, handled: true, validMessage: true };
  }
  if (seq <= state.seq) {
    return { state, invalidate: [], resync: false, handled: true, validMessage: true };
  }
  if (seq > state.seq + 1) {
    return { state: { seq }, invalidate: ALL_LIVE_RESOURCES, resync: true, handled: true, validMessage: true };
  }
  return { state: { seq }, invalidate, resync: false, handled: true, validMessage: true };
}
