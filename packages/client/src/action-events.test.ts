import { describe, expect, it } from "bun:test";
import { applyActionEvent, emptyActionEventState } from "./action-events";

const receipt = (id: string) => ({ id, action: id, createdAt: "2026-09-26T00:00:00.000Z" });
const snapshot = (cursor: number, ...actions: ReturnType<typeof receipt>[]) => ({ type: "snapshot", cursor, actions });
const created = (cursor: number, id: string) => ({ type: "action.created", cursor, receipt: receipt(id) });

describe("action event reconciliation", () => {
  it("replaces stale history with the authoritative snapshot", () => {
    const result = applyActionEvent({ cursor: 1, actions: [receipt("stale")], needsSnapshot: false }, snapshot(3, receipt("first"), receipt("second")));
    expect(result.snapshotApplied).toBe(true);
    expect(result.state).toEqual({ cursor: 3, actions: [receipt("first"), receipt("second")], needsSnapshot: false });
  });

  it("applies each next durable event once and ignores duplicates without changing the latest receipt", () => {
    const start = applyActionEvent(emptyActionEventState(), snapshot(4, receipt("prior"))).state;
    const first = applyActionEvent(start, created(5, "new"));
    const duplicate = applyActionEvent(first.state, created(5, "new"));
    expect(first.state.cursor).toBe(5);
    expect(first.state.actions).toEqual([receipt("new"), receipt("prior")]);
    expect(duplicate.state).toBe(first.state);
    expect(duplicate.requestSnapshot).toBe(false);
  });

  it("requests one snapshot on a cursor gap and accepts its authoritative replacement", () => {
    const start = applyActionEvent(emptyActionEventState(), snapshot(2, receipt("known"))).state;
    const gap = applyActionEvent(start, created(4, "after-gap"));
    const ignored = applyActionEvent(gap.state, created(5, "later"));
    const recovered = applyActionEvent(ignored.state, snapshot(5, receipt("later"), receipt("after-gap"), receipt("known")));
    expect(gap.requestSnapshot).toBe(true);
    expect(ignored.requestSnapshot).toBe(false);
    expect(ignored.state.cursor).toBe(2);
    expect(recovered.state.cursor).toBe(5);
    expect(recovered.state.actions.map((item) => item.id)).toEqual(["later", "after-gap", "known"]);
  });

  it("leaves state unchanged for malformed snapshots or events", () => {
    const start = applyActionEvent(emptyActionEventState(), snapshot(1, receipt("known"))).state;
    expect(applyActionEvent(start, { type: "snapshot", cursor: -1, actions: [] }).state).toBe(start);
    expect(applyActionEvent(start, { type: "action.created", cursor: 2, receipt: { id: "incomplete" } }).state).toBe(start);
  });
});
