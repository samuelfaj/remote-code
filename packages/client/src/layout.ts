export type LayoutTab = { id: string; kind: "file" | "terminal" | "thread"; targetId: string };
export type LayoutPane = { id: string; tabId: string; order: number };
export type WorkspaceLayout = {
  tabs: LayoutTab[];
  activeTabId: string | null;
  panes?: LayoutPane[];
  activePaneId?: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const layoutKeys = "activePaneId,activeTabId,panes,tabs";
const bareKeys = "activeTabId,tabs";
const panesOnlyKeys = "activeTabId,panes,tabs";

function id(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export function workspaceLayoutFromValue(value: unknown): WorkspaceLayout | null {
  const row = record(value);
  if (!row) return null;
  const keys = Object.keys(row).sort().join(",");
  if (keys !== bareKeys && keys !== layoutKeys && keys !== panesOnlyKeys) return null;
  if (!Array.isArray(row.tabs) || row.tabs.length > 32) return null;
  const ids = new Set<string>();
  const tabs: LayoutTab[] = [];
  for (const entry of row.tabs) {
    const tab = record(entry);
    if (!tab || !id(tab.id, 64) || ids.has(tab.id as string) ||
      (tab.kind !== "file" && tab.kind !== "terminal" && tab.kind !== "thread") ||
      !id(tab.targetId, 128)) return null;
    ids.add(tab.id as string);
    tabs.push({ id: tab.id as string, kind: tab.kind as LayoutTab["kind"], targetId: tab.targetId as string });
  }
  if (row.activeTabId !== null && (typeof row.activeTabId !== "string" || !ids.has(row.activeTabId))) return null;
  const panesValue = (row as { panes?: unknown }).panes;
  const activePaneId = (row as { activePaneId?: unknown }).activePaneId;
  let panes: LayoutPane[] | undefined;
  if (panesValue !== undefined) {
    if (!Array.isArray(panesValue) || panesValue.length > 32) return null;
    const paneIds = new Set<string>();
    panes = [];
    for (const entry of panesValue) {
      const pane = record(entry);
      if (!pane || !id(pane.id, 64) || paneIds.has(pane.id as string) ||
        typeof pane.tabId !== "string" || !ids.has(pane.tabId) ||
        !Number.isInteger(pane.order) || (pane.order as number) < 0 || (pane.order as number) > 31) return null;
      paneIds.add(pane.id as string);
      panes.push({ id: pane.id as string, tabId: pane.tabId as string, order: pane.order as number });
    }
    if (activePaneId !== undefined && activePaneId !== null &&
      (typeof activePaneId !== "string" || !paneIds.has(activePaneId))) return null;
    const orders = panes.map((pane) => pane.order).sort((a, b) => a - b);
    if (orders.some((order, index) => order !== index)) return null;
  } else if (activePaneId !== undefined) return null;
  return {
    tabs, activeTabId: row.activeTabId as string | null,
    ...(panes === undefined ? {} : { panes }),
    ...(activePaneId === undefined ? {} : { activePaneId: activePaneId as string | null }),
  };
}

export function workspaceLayoutResponseFromValue(value: unknown, workspaceId: string): WorkspaceLayout | null {
  const row = record(value);
  if (!row || row.workspaceId !== workspaceId) return null;
  if (row.layout === null) return null;
  return workspaceLayoutFromValue(row.layout);
}
