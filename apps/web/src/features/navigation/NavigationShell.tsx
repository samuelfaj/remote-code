import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native-web";
import { color, space, radius, font, sidebarWidth, contentMaxWidth, ui } from "../../design/tokens";
import { createApiClient, listBots, listThreads, type Bot, type Thread, type Workspace } from "@remotecode/client";
import { AgentPanel } from "../agent/AgentPanel";
import { ComputerPanel } from "../computer/ComputerPanel";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";

type Props = { userId: string; onUnauthorized: () => void; eventCursor?: number | null; footer?: ReactNode };

function safeTestId(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

export function NavigationShell({ userId, onUnauthorized, eventCursor, footer }: Props) {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 769;
  });
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null;

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
    const syncSidebarToViewport = () => setSidebarOpen(window.innerWidth >= 769);
    window.addEventListener("resize", syncSidebarToViewport);
    return () => window.removeEventListener("resize", syncSidebarToViewport);
  }, []);

  useEffect(() => {
    loadWorkspaces();
    loadBotsForSelectedWorkspace();
  }, [api]);

  useEffect(() => {
    const id = setInterval(() => {
      loadWorkspaces();
      loadBotsForSelectedWorkspace();
    }, 3000);
    return () => clearInterval(id);
  }, [selectedWorkspaceId]);

  // Auto-select first workspace when list changes and none is selected

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
    const ref = itemRefs.current[index];
    if (ref) ref.focus();
  }

  function handleWorkspaceListKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((r) => r === document.activeElement);
      const next = Math.min(itemRefs.current.length - 1, currentIndex + 1);
      focusItem(next);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((r) => r === document.activeElement);
      const prev = Math.max(0, currentIndex - 1);
      focusItem(prev);
    }
  }

  function handleBotListKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((r) => r === document.activeElement);
      const next = Math.min(itemRefs.current.length - 1, currentIndex + 1);
      focusItem(next);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((r) => r === document.activeElement);
      const prev = Math.max(0, currentIndex - 1);
      focusItem(prev);
    }
  }

  function handleThreadListKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((r) => r === document.activeElement);
      const next = Math.min(itemRefs.current.length - 1, currentIndex + 1);
      focusItem(next);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((r) => r === document.activeElement);
      const prev = Math.max(0, currentIndex - 1);
      focusItem(prev);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle sidebar"
          accessibility-expanded={sidebarOpen}
          testID="sidebar-toggle"
          onPress={() => setSidebarOpen((v) => !v)}
          style={styles.toggleButton}
        >
          <Text style={styles.toggleText}>{sidebarOpen ? "Close sidebar" : "Open sidebar"}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>RemoteCode</Text>
      </View>

      <View style={styles.body}>
        <View
          style={[styles.sidebar, sidebarOpen ? styles.sidebarOpen : styles.sidebarClosed]}
          testID="app-sidebar"
          data-closed={!sidebarOpen}
          accessibilityRole="navigation"
          accessibilityLabel="Navigation sidebar"
        >
          <View style={styles.sidebarSection}>
            <Text style={styles.sectionHeading}>Workspaces</Text>
            <View
              testID="workspace-list"
              accessibilityRole="list"
              accessibilityLabel="Workspaces"
              style={styles.list}
              // @ts-ignore
              onKeyDown={handleWorkspaceListKeyDown}
            >
              {workspaces.map((workspace, index) => (
                <Pressable
                  key={workspace.id}
                  // @ts-ignore
                  ref={(el: HTMLDivElement | null) => { itemRefs.current[index] = el; }}
                  accessibilityRole="option"
                  testID={`workspace-item-${safeTestId(workspace.name)}`}
                  onPress={() => {
                    setSelectedWorkspaceId(workspace.id);
                    setSelectedBotId(null);
                    setThreads([]);
                  }}
                  style={[
                    styles.listItem,
                    selectedWorkspaceId === workspace.id && styles.listItemSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.listItemText,
                      selectedWorkspaceId === workspace.id && styles.listItemTextSelected,
                    ]}
                  >
                    {workspace.name}{workspace.archived ? " (archived)" : ""}
                  </Text>
                </Pressable>
              ))}
              {!workspaces.length && <Text style={styles.emptyText}>No workspaces yet</Text>}
            </View>
          </View>

          {selectedWorkspaceId && (
            <View style={styles.sidebarSection}>
              <Text style={styles.sectionHeading}>Bots</Text>
              <View
                testID="bot-list"
                accessibilityRole="list"
                accessibilityLabel="Bots"
                style={styles.list}
                // @ts-ignore
                onKeyDown={handleBotListKeyDown}
              >
                {bots.map((bot, index) => (
                  <Pressable
                    key={bot.id}
                    // @ts-ignore
                    ref={(el: HTMLDivElement | null) => { itemRefs.current[index] = el; }}
                    accessibilityRole="option"
                    testID={`bot-item-${safeTestId(bot.name)}`}
                    onPress={() => {
                      setSelectedBotId(bot.id);
                      setThreads([]);
                    }}
                    style={[
                      styles.listItem,
                      selectedBotId === bot.id && styles.listItemSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.listItemText,
                        selectedBotId === bot.id && styles.listItemTextSelected,
                      ]}
                    >
                      {bot.name}
                    </Text>
                  </Pressable>
                ))}
                {!bots.length && <Text style={styles.emptyText}>No bots</Text>}
              </View>
            </View>
          )}

          {selectedBotId && (
            <View style={styles.sidebarSection}>
              <Text style={styles.sectionHeading}>Threads</Text>
              <View
                testID="thread-list"
                accessibilityRole="list"
                accessibilityLabel="Threads"
                style={styles.list}
                // @ts-ignore
                onKeyDown={handleThreadListKeyDown}
              >
                {threads.map((thread, index) => (
                  <Pressable
                    key={thread.id}
                    // @ts-ignore
                    ref={(el: HTMLDivElement | null) => { itemRefs.current[index] = el; }}
                    accessibilityRole="option"
                    testID={`thread-item-${safeTestId(thread.title)}`}
                    style={styles.listItem}
                  >
                    <Text style={styles.listItemText}>{thread.title}</Text>
                  </Pressable>
                ))}
                {!threads.length && <Text style={styles.emptyText}>No threads</Text>}
              </View>
            </View>
          )}
        </View>

        <View style={styles.content} testID="app-content">
          <View style={styles.contentInner}>
            <WorkspacePanel userId={userId} onUnauthorized={onUnauthorized} selectedWorkspaceId={selectedWorkspaceId} />
            <ComputerPanel userId={userId} selectedWorkspaceId={selectedWorkspaceId} selectedBotId={selectedBotId} />
            <AgentPanel userId={userId} selectedWorkspaceId={selectedWorkspaceId} selectedBotId={selectedBotId} eventCursor={eventCursor} />
            {footer}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    backgroundColor: color.surface,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  toggleButton: { padding: space.sm, minHeight: 44 },
  toggleText: { color: color.textSecondary, fontSize: font.body },
  headerTitle: { flex: 1, color: color.text, fontSize: font.title3, fontWeight: "600" },
  signOutButton: { padding: space.sm, minHeight: 44 },
  signOutText: { color: color.danger, fontSize: font.body, fontWeight: "600" },
  body: { flex: 1, flexDirection: "row", overflow: "hidden" },
  sidebar: {
    backgroundColor: color.surface,
    borderRightWidth: 1,
    borderRightColor: color.line,
    overflow: "auto",
  },
  sidebarOpen: { width: sidebarWidth, minWidth: sidebarWidth },
  sidebarClosed: { width: 0, minWidth: 0, display: "none" },
  sidebarSection: { padding: space.md, gap: space.sm },
  sectionHeading: ui.sectionLabel,
  list: { gap: space.xs, maxHeight: 300, overflow: "auto" },
  listItem: {
    ...ui.listItem,
    minHeight: 32,
  },
  listItemSelected: { ...ui.listItemSelected },
  listItemText: { color: color.textSecondary, fontSize: font.body },
  listItemTextSelected: { color: color.accent, fontWeight: "600" },
  emptyText: { color: color.textTertiary, fontSize: font.body, padding: space.md },
  content: { flex: 1, overflow: "auto", backgroundColor: color.bg },
  contentInner: {
    alignSelf: "center",
    gap: space.xl,
    maxWidth: contentMaxWidth,
    paddingHorizontal: space.xxl,
    paddingVertical: space.xl,
    width: "100%",
  },
});
