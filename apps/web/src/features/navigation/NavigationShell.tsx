import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native-web";
import { createApiClient, listBots, listThreads, type Bot, type Thread, type Workspace } from "@remotecode/client";
import { AgentPanel } from "../agent/AgentPanel";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";

type Props = { userId: string; onUnauthorized: () => void; eventCursor?: number | null };

function safeTestId(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

export function NavigationShell({ userId, onUnauthorized, eventCursor }: Props) {
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
          <WorkspacePanel userId={userId} onUnauthorized={onUnauthorized} selectedWorkspaceId={selectedWorkspaceId} />
          <AgentPanel userId={userId} selectedWorkspaceId={selectedWorkspaceId} selectedBotId={selectedBotId} eventCursor={eventCursor} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: "100vh", backgroundColor: "#f4f7f5" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#d9e5e0",
  },
  toggleButton: { padding: 8, minHeight: 44 },
  toggleText: { color: "#183337", fontSize: 14, fontWeight: "600" },
  headerTitle: { flex: 1, color: "#183337", fontSize: 18, fontWeight: "800" },
  signOutButton: { padding: 8, minHeight: 44 },
  signOutText: { color: "#a52d20", fontSize: 14, fontWeight: "600" },
  body: { flex: 1, flexDirection: "row", overflow: "hidden" },
  sidebar: {
    backgroundColor: "#fff",
    borderRightWidth: 1,
    borderRightColor: "#d9e5e0",
    overflow: "hidden",
  },
  sidebarOpen: { width: 280, minWidth: 280 },
  sidebarClosed: { width: 0, minWidth: 0, display: "none" },
  sidebarSection: { padding: 12, gap: 8 },
  sectionHeading: { color: "#304e4e", fontSize: 12, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  list: { gap: 2, maxHeight: 300, overflow: "scroll" },
  listItem: {
    padding: 10,
    borderRadius: 6,
    minHeight: 44,
    justifyContent: "center",
  },
  listItemSelected: { backgroundColor: "#e8f0ed" },
  listItemText: { color: "#183337", fontSize: 14 },
  listItemTextSelected: { color: "#0d7056", fontWeight: "700" },
  emptyText: { color: "#6a807c", fontSize: 13, padding: 8 },
  content: { flex: 1, overflow: "auto", padding: 16, backgroundColor: "#f4f7f5" },
});
