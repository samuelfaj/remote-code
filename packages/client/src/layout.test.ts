import { expect, it } from "bun:test";
import { workspaceLayoutFromValue, workspaceLayoutResponseFromValue } from "./layout";

const good = {
  tabs: [{ id: "tab-1", kind: "file" as const, targetId: "a.txt" }],
  activeTabId: "tab-1",
  panes: [{ id: "pane-1", tabId: "tab-1", order: 0 }, { id: "pane-2", tabId: "tab-1", order: 1 }],
  activePaneId: "pane-2",
};

it("accepts tabs and dense panes, rejects everything else", () => {
  expect(workspaceLayoutFromValue(JSON.parse(JSON.stringify(good)))).toEqual(good);
  expect(workspaceLayoutFromValue({ tabs: [], activeTabId: null })).toEqual({ tabs: [], activeTabId: null });
  // Server accepts panes without activePaneId; the client reads that too.
  const { activePaneId: _dropped, ...panesBare } = good;
  expect(workspaceLayoutFromValue(JSON.parse(JSON.stringify(panesBare)))).toEqual(panesBare);
  for (const bad of [
    { tabs: [], activeTabId: "nope" },
    { tabs: [{ id: "t1", kind: "browser", targetId: "x" }], activeTabId: "t1" },
    { tabs: [{ id: "t1", kind: "file", targetId: "x" }, { id: "t1", kind: "file", targetId: "y" }], activeTabId: "t1" },
    { tabs: [], activeTabId: null, activePaneId: null },
    { ...good, panes: [{ id: "pane-1", tabId: "missing", order: 0 }] },
    { ...good, panes: [{ id: "pane-1", tabId: "tab-1", order: 0 }, { id: "pane-2", tabId: "tab-1", order: 2 }] },
    { ...good, activePaneId: "pane-9" },
    { ...good, panes: "panes" },
    { ...good, extra: true },
  ]) expect(workspaceLayoutFromValue(bad)).toBeNull();
});

it("binds layout responses to the requested workspace and null empty state", () => {
  expect(workspaceLayoutResponseFromValue({ workspaceId: "w1", layout: good }, "w1")).toEqual(good);
  expect(workspaceLayoutResponseFromValue({ workspaceId: "w1", layout: null }, "w1")).toBeNull();
  expect(workspaceLayoutResponseFromValue({ workspaceId: "w1", layout: good }, "w2")).toBeNull();
  expect(workspaceLayoutResponseFromValue({ workspaceId: "w1", layout: { ...good, activePaneId: "pane-9" } }, "w1")).toBeNull();
});

it("keeps stored selection local: a merge-save sends stored ids back, never the other device's", () => {
  // The shipped TerminalPanel merge rule: when saving, send the stored
  // active ids back unchanged (only a brand-new layout picks its own tab),
  // so one device's save cannot hijack another device's focus. This test
  // pins the parsing half of that contract: the stored row must round-trip
  // validation unchanged, including its selection, so the panel can echo it
  // back byte-identically instead of substituting a local selection.
  const stored = workspaceLayoutResponseFromValue({ workspaceId: "w1", layout: good }, "w1");
  expect(stored).not.toBeNull();
  expect(JSON.parse(JSON.stringify(workspaceLayoutFromValue(stored)))).toEqual(stored);
  expect(stored!.activeTabId).toBe("tab-1");
  expect(stored!.activePaneId).toBe("pane-2");
});
