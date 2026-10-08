import { describe, expect, it } from "bun:test";
import {
  ALL_LIVE_RESOURCES,
  applyLiveEvent,
  emptyLiveEventState,
  resourcesForEvent,
  type LiveEventState,
  type LiveResource,
} from "./live-events";

const at = (seq: number): LiveEventState => ({ seq });

describe("live event classification", () => {
  it("tolerates an unknown type instead of reporting it invalid", () => {
    const result = applyLiveEvent(emptyLiveEventState(), { type: "future.thing", seq: 1 });
    expect(result.handled).toBe(true);
    expect(result.validMessage).toBe(true);
    expect(result.invalidate).toEqual([]);
    expect(result.resync).toBe(false);
    expect(result.state).toEqual({ seq: 1 });
  });

  it("treats a non-object or missing type as an invalid, unhandled message", () => {
    for (const input of [null, 42, "nope", {}, { type: 7 }]) {
      const result = applyLiveEvent(emptyLiveEventState(), input);
      expect(result).toEqual({ state: { seq: null }, invalidate: [], resync: false, handled: false, validMessage: false });
    }
  });

  it("passes snapshot and action.created back to the action reducer untouched", () => {
    for (const type of ["snapshot", "action.created"]) {
      const start = at(5);
      const result = applyLiveEvent(start, { type, seq: 9 });
      expect(result.state).toEqual(start);
      expect(result.handled).toBe(false);
      expect(result.validMessage).toBe(true);
      expect(result.invalidate).toEqual([]);
      expect(result.resync).toBe(false);
    }
  });

  it("maps run.updated to runs and inbox", () => {
    const result = applyLiveEvent(emptyLiveEventState(), { type: "run.updated", seq: 1 });
    expect(result.handled).toBe(true);
    expect(result.invalidate).toEqual(["runs", "inbox"]);
  });

  const changed: Array<[string, LiveResource[]]> = [
    ["workspace.changed", ["workspaces", "files"]],
    ["bot.changed", ["bots"]],
    ["thread.changed", ["threads"]],
    ["message.changed", ["messages", "inbox"]],
    ["inbox.changed", ["inbox"]],
    ["schedule.changed", ["schedules"]],
    ["terminal.changed", ["terminal"]],
    ["screen.changed", ["screen"]],
    ["files.changed", ["files"]],
  ];

  it.each(changed)("maps %s to its resources", (type, resources) => {
    expect(resourcesForEvent(type)).toEqual(resources);
    const result = applyLiveEvent(emptyLiveEventState(), { type, seq: 1 });
    expect(result.handled).toBe(true);
    expect(result.invalidate).toEqual(resources);
  });

  it("reports an unknown .changed type as handled and valid with no invalidation", () => {
    expect(resourcesForEvent("mystery.changed")).toBeNull();
    const result = applyLiveEvent(emptyLiveEventState(), { type: "mystery.changed", seq: 1 });
    expect(result.handled).toBe(true);
    expect(result.validMessage).toBe(true);
    expect(result.invalidate).toEqual([]);
  });
});

describe("live event cursor", () => {
  it("accepts the first event and adopts its seq", () => {
    const result = applyLiveEvent(emptyLiveEventState(), { type: "bus.changed", seq: 4 });
    expect(result.state).toEqual({ seq: 4 });
    expect(result.resync).toBe(false);
  });

  it("accepts each next seq and keeps the invalidation", () => {
    const result = applyLiveEvent(at(4), { type: "inbox.changed", seq: 5 });
    expect(result.state).toEqual({ seq: 5 });
    expect(result.invalidate).toEqual(["inbox"]);
    expect(result.resync).toBe(false);
  });

  it("drops a duplicate seq without invalidating or moving state", () => {
    const start = at(4);
    for (const seq of [4, 3]) {
      const result = applyLiveEvent(start, { type: "inbox.changed", seq });
      expect(result.state).toBe(start);
      expect(result.invalidate).toEqual([]);
      expect(result.handled).toBe(true);
      expect(result.resync).toBe(false);
    }
  });

  it("requests a full resync on a gap and moves the cursor forward", () => {
    const result = applyLiveEvent(at(4), { type: "inbox.changed", seq: 9 });
    expect(result.resync).toBe(true);
    expect(result.invalidate).toEqual(ALL_LIVE_RESOURCES);
    expect(result.state).toEqual({ seq: 9 });
  });

  it("still applies invalidation but keeps the cursor when seq is not a safe integer", () => {
    for (const seq of [undefined, 0, -1, 1.5, Number.NaN, "3"]) {
      const start = at(4);
      const result = applyLiveEvent(start, { type: "run.updated", seq });
      expect(result.state).toBe(start);
      expect(result.invalidate).toEqual(["runs", "inbox"]);
      expect(result.resync).toBe(false);
      expect(result.handled).toBe(true);
      expect(result.validMessage).toBe(true);
    }
  });
});
