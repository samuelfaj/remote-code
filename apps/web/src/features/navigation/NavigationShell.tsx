import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createApiClient, listBots, listThreads, type Bot, type Thread, type Workspace } from "@remotecode/client";
import { AgentPanel } from "../agent/AgentPanel";
import { ComputerPanel } from "../computer/ComputerPanel";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminals/TerminalPanel";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";
import { Icon, type IconName } from "../shell/icons";
import type { LiveSignals } from "../shell/live";

type Props = {
  userId: string;
  onUnauthorized: () => void;
  eventCursor?: number | null;
  footer?: ReactNode;
  live: LiveSignals;
};

type SurfaceKind = "workspace" | "agent" | "terminal" | "files" | "computer";

const SURFACE_DEFS: Record<SurfaceKind, { icon: IconName; title: string }> = {
  workspace: { icon: "folder", title: "Workspace" },
  agent: { icon: "sparkles", title: "Agent" },
  terminal: { icon: "terminal", title: "Terminal" },
  files: { icon: "file", title: "Files" },
  computer: { icon: "monitor", title: "Computer" },
};

const SURFACE_ORDER: SurfaceKind[] = ["workspace", "agent", "terminal", "files", "computer"];

// The macOS app opens a workspace's pane with these three surfaces.
const DEFAULT_SURFACES: SurfaceKind[] = ["workspace", "agent", "terminal"];

type WorkspaceSurfaces = { open: SurfaceKind[]; active: SurfaceKind };

function safeTestId(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

export function NavigationShell({ userId, onUnauthorized, eventCursor, footer, live = {} }: Props) {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [surfacesById, setSurfacesById] = useState<Record<string, WorkspaceSurfaces>>({});
  const [newBotName, setNewBotName] = useState("");
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [hostOpen, setHostOpen] = useState(true);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRefs = useRef<Partial<Record<SurfaceKind, HTMLDivElement | null>>>({});
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 901;
  });

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const visibleWorkspaces = filter.trim()
    ? workspaces.filter((w) => w.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : workspaces;
  const currentSurfaces = selectedWorkspaceId ? surfacesById[selectedWorkspaceId] ?? null : null;
  const openSurfaces = currentSurfaces?.open ?? [];
  const activeSurface = currentSurfaces?.active ?? null;

  async function loadWorkspaces() {
    try {
      const result = await api.api.workspaces.get();
      if (result.data) {
        const data = result.data as { workspaces: Workspace[] };
        setWorkspaces(data.workspaces);
      }
    } catch {
      // keep existing list on transient failure
    }
  }

  async function loadBotsForSelectedWorkspace() {
    if (!selectedWorkspaceId) {
      setBots([]);
      return;
    }
    try {
      const data = await listBots(window.location.origin);
      setBots(data);
    } catch {
      setBots([]);
    }
  }

  useEffect(() => {
    // Below the shell breakpoint the sidebar overlays the content, so a viewport
    // that enters mobile width would otherwise cover the pane it drew over.
    const syncSidebarToViewport = () => setSidebarOpen(window.innerWidth >= 901);
    window.addEventListener("resize", syncSidebarToViewport);
    return () => window.removeEventListener("resize", syncSidebarToViewport);
  }, []);

  // The host's counters are the refresh signal: no polling loop, one initial
  // load on mount and after sign-in (both re-enter through these effects).
  useEffect(() => {
    void loadWorkspaces();
  }, [api, live.workspaces]);

  useEffect(() => {
    void loadBotsForSelectedWorkspace();
  }, [api, live.bots, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedBotId) {
      setThreads([]);
      return;
    }
    const workspaceId = selectedWorkspaceId;
    async function load() {
      try {
        const data = await listThreads(workspaceId, window.location.origin);
        setThreads(data);
      } catch {
        setThreads([]);
      }
    }
    load();
  }, [selectedBotId, selectedWorkspaceId]);

  function focusItem(index: number) {
    const item = itemRefs.current[index];
    if (item) item.focus();
  }

  function handleRowKeyDown(event: React.KeyboardEvent) {
    const currentIndex = itemRefs.current.findIndex((row) => row === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(Math.min(itemRefs.current.length - 1, currentIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(Math.max(0, currentIndex - 1));
    }
  }

  function selectWorkspace(workspace: Workspace) {
    setSelectedWorkspaceId(workspace.id);
    setSelectedBotId(null);
    setThreads([]);
    setNewBotName("");
    setSurfacesById((map) =>
      map[workspace.id]
        ? map
        : { ...map, [workspace.id]: { open: [...DEFAULT_SURFACES], active: "workspace" } },
    );
  }

  function openSurface(kind: SurfaceKind) {
    setTabMenuOpen(false);
    setSurfacesById((map) => {
      const id = selectedWorkspaceId;
      if (!id) return map;
      const current = map[id] ?? { open: [], active: kind };
      const open = current.open.includes(kind)
        ? current.open
        : [...current.open, kind].sort((a, b) => SURFACE_ORDER.indexOf(a) - SURFACE_ORDER.indexOf(b));
      return { ...map, [id]: { open, active: kind } };
    });
  }

  function activateSurface(kind: SurfaceKind) {
    if (!selectedWorkspaceId) return;
    setSurfacesById((map) => {
      const current = map[selectedWorkspaceId];
      if (current) map = { ...map, [selectedWorkspaceId]: { ...current, active: kind } };
      return map;
    });
  }

  function closeSurface(kind: SurfaceKind) {
    setTabMenuOpen(false);
    if (!selectedWorkspaceId) return;
    setSurfacesById((map) => {
      const current = map[selectedWorkspaceId];
      if (!current) return map;
      const open = current.open.filter((surface) => surface !== kind);
      let active = current.active;
      if (current.active === kind && open.length) {
        const index = SURFACE_ORDER.indexOf(kind);
        active = open[Math.min(index, open.length - 1)]!;
      }
      return { ...map, [selectedWorkspaceId]: { open, active } };
    });
  }

  function selectBot(bot: Bot) {
    setSelectedBotId(bot.id);
    setThreads([]);
    openSurface("agent");
  }

  async function createBot() {
    const name = newBotName.trim();
    if (!name || !selectedWorkspaceId) return;
    try {
      const result = await api.api.bots.post({ name, instructions: undefined, context: undefined });
      if (result.error) throw new Error("Bot creation failed");
      setNewBotName("");
      await loadBotsForSelectedWorkspace();
    } catch {
      // The list stays as-is; the next live signal re-reads it.
    }
  }

  function panelVisible(kind: SurfaceKind) {
    if (!selectedWorkspaceId) return kind === "workspace";
    return openSurfaces.includes(kind) && activeSurface === kind;
  }

  return (
    <div className="rc-shell">
      <div
        aria-label="Navigation sidebar"
        className="rc-sidebar"
        data-closed={!sidebarOpen}
        data-testid="app-sidebar"
        role="navigation"
      >
        <div className="rc-sidebar__identity">
          <span className="rc-spacer" />
          <span aria-hidden="true" className="rc-avatar">
            {userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "RC"}
          </span>
        </div>

        <div className="rc-sidebar__actions">
          <button className="rc-action-row" onClick={() => openSurface("workspace")} type="button">
            <span className="rc-action-row__icon">
              <Icon name="folderPlus" size={16} />
            </span>
            New Workspace
          </button>
          <button
            aria-label={threads.length ? `Active Threads, ${threads.length} open` : "Active Threads"}
            className="rc-action-row"
            onClick={() => openSurface("agent")}
            type="button"
          >
            <span className="rc-action-row__icon">
              <Icon name="bolt" size={16} />
            </span>
            <span className="rc-action-row__label">Active Threads</span>
            {threads.length ? <span aria-hidden="true" className="rc-badge">{threads.length}</span> : null}
          </button>
          <button className="rc-action-row" onClick={() => openSurface("agent")} type="button">
            <span className="rc-action-row__icon">
              <Icon name="calendar" size={16} />
            </span>
            Scheduled Tasks
          </button>
        </div>

        <div className="rc-sidebar__section">
          <span>Workspaces</span>
          <button
            aria-label="Refresh workspaces"
            className="rc-iconbtn rc-sidebar__section-action"
            onClick={() => {
              setRefreshSignal((count) => count + 1);
              void loadWorkspaces();
            }}
            type="button"
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
        {workspaces.length ? (
          <label className="rc-search">
            <Icon name="search" size={12} />
            <input
              aria-label="Filter workspaces"
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter workspaces"
              type="search"
              value={filter}
            />
          </label>
        ) : null}
        <ul
          aria-label="Workspaces"
          className="rc-list"
          data-testid="workspace-list"
          onKeyDown={handleRowKeyDown}
          role="list"
        >
          {visibleWorkspaces.map((workspace, index) => (
            <li key={workspace.id}>
              <button
                aria-label={`Open workspace ${workspace.name}`}
                aria-current={selectedWorkspaceId === workspace.id ? "true" : undefined}
                className="rc-ws-row"
                data-testid={`workspace-item-${safeTestId(workspace.name)}`}
                onClick={() => selectWorkspace(workspace)}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                title={workspace.name}
                type="button"
              >
                <span className="rc-ws-row__icon">
                  <Icon name="folder" size={14} />
                </span>
                <span className="rc-ws-row__name">
                  {workspace.name}
                  {workspace.archived ? " (archived)" : ""}
                </span>
              </button>
            </li>
          ))}
          {!visibleWorkspaces.length ? (
            <li className="rc-list__empty">{workspaces.length ? "No workspace matches the filter." : "No workspaces yet"}</li>
          ) : null}
        </ul>

        {selectedWorkspaceId ? (
          <>
            <div className="rc-sidebar__section">Bots</div>
            <ul aria-label="Bots" className="rc-list" data-testid="bot-list" role="list">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <button
                    aria-label={`Open bot ${bot.name}`}
                    aria-current={selectedBotId === bot.id ? "true" : undefined}
                    className="rc-ws-row"
                    data-testid={`bot-item-${safeTestId(bot.name)}`}
                    onClick={() => selectBot(bot)}
                        type="button"
                  >
                    <span className="rc-ws-row__icon">
                      <Icon name="bot" size={14} />
                    </span>
                    <span className="rc-ws-row__name">{bot.name}</span>
                  </button>
                </li>
              ))}
              {!bots.length ? <li className="rc-list__empty">No bots</li> : null}
            </ul>
            <div className="rc-bot-create">
              <input
                aria-label="New bot name"
                onChange={(event) => setNewBotName(event.currentTarget.value)}
                placeholder="New bot name"
                type="text"
                value={newBotName}
              />
              <button
                data-testid="new-bot"
                disabled={!newBotName.trim()}
                onClick={() => void createBot()}
                type="button"
              >
                Create bot
              </button>
            </div>
          </>
        ) : null}

        <div className="rc-sidebar__footer">
          <div className="rc-account">
            <span aria-hidden="true" className="rc-avatar">
              {userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "RC"}
            </span>
            <span>
              <span className="rc-account__name">{userId}</span>
              <br />
              <span className="rc-account__meta">
                {selectedWorkspace ? selectedWorkspace.name : "No workspace selected"}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="rc-scrim" data-open={sidebarOpen} onClick={() => setSidebarOpen(false)} />

      <div className="rc-main">
        {/* The strip stays mounted even with no tabs, so the sidebar toggle is
            always reachable, including before a workspace is selected. */}
        <div className="rc-tabs" role="tablist" aria-label="Open surfaces">
          <div className="rc-tabs__scroll">
            {openSurfaces.map((kind) => (
              <div
                aria-controls="app-content"
                aria-label={SURFACE_DEFS[kind].title}
                aria-selected={activeSurface === kind}
                className="rc-tab"
                key={kind}
                onClick={() => activateSurface(kind)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activateSurface(kind);
                    return;
                  }
                  // Roving focus: an inactive tab is not in the tab order, so the
                  // arrows are what move between open surfaces from the keyboard.
                  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = openSurfaces[(openSurfaces.indexOf(kind) + step + openSurfaces.length) % openSurfaces.length]!;
                  activateSurface(next);
                  tabRefs.current[next]?.focus();
                }}
                ref={(element) => {
                  tabRefs.current[kind] = element;
                }}
                role="tab"
                tabIndex={activeSurface === kind ? 0 : -1}
              >
                <span className="rc-tab__icon">
                  <Icon name={SURFACE_DEFS[kind].icon} size={12} />
                </span>
                <span className="rc-tab__label">
                  {kind === "workspace" && selectedWorkspace ? selectedWorkspace.name : SURFACE_DEFS[kind].title}
                </span>
                <button
                  aria-label={`Close ${SURFACE_DEFS[kind].title} tab`}
                  className="rc-tab__close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeSurface(kind);
                  }}
                  type="button"
                >
                  <Icon name="x" size={9} strokeWidth={2.4} />
                </button>
              </div>
            ))}
            {selectedWorkspaceId ? (
              <button aria-label="Open a surface" className="rc-tab-new" onClick={() => setTabMenuOpen((open) => !open)} type="button">
                <Icon name="plus" size={13} />
              </button>
            ) : null}
          </div>
          <div className="rc-tabs__right">
            <button
              aria-expanded={sidebarOpen}
              aria-label="Toggle sidebar"
              className="rc-iconbtn"
              data-testid="sidebar-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              type="button"
            >
              <Icon name="sidebar" size={14} />
            </button>
            <button
              aria-label="All tabs"
              className="rc-iconbtn"
              onClick={() => setTabMenuOpen((open) => !open)}
              type="button"
            >
              <Icon name="chevronDown" size={11} />
            </button>
          </div>
          {tabMenuOpen ? (
            <div className="rc-menu" role="menu">
              {SURFACE_ORDER.map((kind) => (
                <button
                  aria-checked={openSurfaces.includes(kind)}
                  className="rc-menu__item"
                  key={kind}
                  onClick={() => openSurface(kind)}
                  role="menuitemradio"
                  type="button"
                >
                  <Icon name={SURFACE_DEFS[kind].icon} size={13} />
                  {openSurfaces.includes(kind) ? `Go to ${SURFACE_DEFS[kind].title}` : `Open ${SURFACE_DEFS[kind].title}`}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rc-body" data-testid="app-content" id="app-content">
          <div className="rc-body__inner">
            {selectedWorkspaceId && !openSurfaces.length ? (
              <div className="rc-empty">
                <span className="rc-empty__title">No surfaces open</span>
                <span className="rc-empty__hint">Open a surface to work in this workspace.</span>
                <button
                  aria-label="Open a surface"
                  className="rc-empty__button"
                  onClick={() => setTabMenuOpen(true)}
                  type="button"
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
            ) : null}
            {/* Every surface stays mounted: a file draft and a terminal session
                survive a tab switch, which unmounting would silently discard. */}
            <div hidden={!panelVisible("workspace")}>
              <WorkspacePanel
                live={live}
                refreshSignal={refreshSignal}
                onUnauthorized={onUnauthorized}
                selectedWorkspaceId={selectedWorkspaceId}
                userId={userId}
              />
            </div>
            <div hidden={!panelVisible("agent")}>
              <AgentPanel
                eventCursor={eventCursor}
                live={live}
                selectedBotId={selectedBotId}
                selectedBotName={bots.find((bot) => bot.id === selectedBotId)?.name ?? null}
                selectedWorkspaceName={selectedWorkspace?.name ?? null}
                selectedWorkspaceId={selectedWorkspaceId}
                userId={userId}
              />
            </div>
            <div hidden={!panelVisible("terminal")}>
              <TerminalPanel
                blocked={false}
                live={live}
                onUnauthorized={onUnauthorized}
                userId={userId}
                workspace={selectedWorkspace}
              />
            </div>
            <div hidden={!panelVisible("files")}>
              <FilePanel
                blocked={false}
                live={live}
                onUnauthorized={onUnauthorized}
                userId={userId}
                workspace={selectedWorkspace}
              />
            </div>
            <div hidden={!panelVisible("computer")}>
              <ComputerPanel
                live={live}
                selectedBotId={selectedBotId}
                selectedWorkspaceId={selectedWorkspaceId}
                userId={userId}
              />
            </div>
          </div>
        </div>

        <div className="rc-hostbar" data-collapsed={!hostOpen}>
          <button
            aria-expanded={hostOpen}
            className="rc-hostbar__head"
            onClick={() => setHostOpen((open) => !open)}
            type="button"
          >
            <Icon name="chevronDown" size={11} />
            Host
          </button>
          <div className="rc-hostbar__body" hidden={!hostOpen}>
            {footer}
          </div>
        </div>
      </div>
    </div>
  );
}
