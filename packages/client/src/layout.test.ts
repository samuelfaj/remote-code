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
