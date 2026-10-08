import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native-web";
import {
  createApiClient,
  createSchedule,
  getAgentProvider,
  type AgentProvider,
  listBots,
  listSchedules,
  listThreadMessages,
  listThreads,
  setScheduleEnabled,
  type Bot,
  type Schedule,
  type Thread,
  type ThreadMessage,
  type WorkspaceRun,
} from "@remotecode/client";
import { color, space, font, radius, ui } from "../../design/tokens";
import { Icon, type IconName } from "../shell/icons";
import { type LiveSignals } from "../shell/live";

type Props = {
  userId: string;
  selectedWorkspaceId: string | null;
  selectedWorkspaceName?: string | null;
  selectedBotId: string | null;
  selectedBotName?: string | null;
  // The cursor of the app's own live event stream. The panel re-reads on every
  // event rather than opening a second socket: the app already holds exactly one
  // connection to the host, and a second one is a second thing to keep honest.
  eventCursor?: number | null;
  // Live-refresh signals pushed from the host's `/api/events` socket. A counter
  // change means the host says that resource changed, so the panel re-reads the
  // authoritative route instead of polling on a timer.
  live?: LiveSignals;
};

function safeTestId(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

const TERMINAL_STATES = new Set(["completed", "interrupted", "failed"]);

// Status carries a glyph plus its text label, so a state never reads as colour alone.
const RUN_STATE_GLYPH: Record<string, IconName> = {
  running: "activity",
  completed: "check",
  failed: "x",
  interrupted: "alert",
};

// The host reports what it actually has: a connected provider is one whose
// credential is present and whose models the agent lists.
function providerStateText(provider: AgentProvider | null): string {
  if (!provider || !provider.configured) return "No provider configured on this host";
  if (provider.state === "connected") return `Connected \u00b7 ${provider.model}`;
  return provider.detail || (provider.state === "unauthenticated" ? "Not signed in" : "Unavailable");
}

function providerStateColor(provider: AgentProvider | null) {
  if (!provider || !provider.configured) return color.textTertiary;
  if (provider.state === "connected") return color.success;
  return provider.state === "unavailable" ? color.danger : color.warning;
}

function runStateColor(state: string) {
  if (state === "failed") return color.danger;
  if (state === "interrupted") return color.warning;
  if (state === "completed") return color.success;
  return color.accent;
}

// A run's owning thread. The backend now stores it on the run view, but the
// generated client type may not carry the field yet, so read it structurally.
function runThreadId(run: WorkspaceRun): string | null {
  const value = (run as { threadId?: string | null }).threadId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type Permission = {
  requestId: string;
  title: string;
  kind: string;
  options: Array<{ optionId: string; kind: string; name: string | null }>;
  toolCall: unknown;
  requestedAt: string;
};

type InboxItem = {
  id: string;
  kind: string;
  title: string;
  state: string;
  read: boolean;
  createdAt: string;
};

// A send attempt the panel is tracking until the host answers. The request ID is
// minted once per attempt and reused on Retry, so the backend replays it
// idempotently instead of starting a second run.
type PromptAttempt = { requestId: string; prompt: string };
type PendingPrompt = PromptAttempt & { status: "sending" | "failed"; message?: string };

export function AgentPanel({ userId, selectedWorkspaceId, selectedWorkspaceName, selectedBotId, selectedBotName, eventCursor, live }: Props) {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const active = useRef(true);
  const [agentProvider, setAgentProvider] = useState<AgentProvider | null>(null);
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [runError, setRunError] = useState("");
  const [permissionsByRun, setPermissionsByRun] = useState<Record<string, Permission[]>>({});
  const [permError, setPermError] = useState("");
  // The host's permission view has no runId, so each run's requests are stored
  // under the run they were read for; a refresh replaces that run's list rather
  // than appending to it a second time.
  const permissions = Object.values(permissionsByRun).flat();
  const [bots, setBots] = useState<Bot[]>([]);
  const [rosterError, setRosterError] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadError, setThreadError] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [msgError, setMsgError] = useState("");
  // Run replies: messages keyed by thread, so a run shows its own agent answer.
  const [threadMessages, setThreadMessages] = useState<Record<string, ThreadMessage[]>>({});
  const threadFetches = useRef<Set<string>>(new Set());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedError, setSchedError] = useState("");
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [inboxError, setInboxError] = useState("");
  const [needsYouCount, setNeedsYouCount] = useState(0);
  const [botRoutines, setBotRoutines] = useState<Schedule[]>([]);
  const [botRoutineError, setBotRoutineError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<PendingPrompt | null>(null);

  async function refreshRuns() {
    if (!selectedWorkspaceId) { setRuns([]); return; }
    try {
      const result = await api.api.workspaces({ workspaceId: selectedWorkspaceId }).runs.get();
      if (result.error) throw new Error("Failed to load runs");
      const data = result.data as { runs: WorkspaceRun[] };
      if (active.current) setRuns(data.runs ?? []);
    } catch {
      if (active.current) setRunError("Could not load runs.");
    }
  }

  async function stopRun(runId: string) {
    try {
      const result = await api.api.runs({ id: runId }).stop.post();
      if (result.error) throw new Error("Stop request failed");
      const updated = result.data as WorkspaceRun;
      setRuns((prev) => prev.map((r) => (r.id === runId ? updated : r)));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Could not stop run.");
    }
  }

  async function refreshPermissions(runId: string) {
    try {
      const result = await api.api.runs({ id: runId }).permissions.get();
      if (result.error) throw new Error("Permission lookup failed");
      const data = result.data as { permissions: Permission[] };
      setPermissionsByRun((prev) => ({ ...prev, [runId]: data.permissions ?? [] }));
    } catch {
      setPermError("Could not load permissions.");
    }
  }

  async function decidePermission(runId: string, requestId: string, decision: "allow" | "deny") {
    try {
      const result = await api.api.runs({ id: runId }).permissions({ requestId }).post({ decision });
      if (result.error) throw new Error("Permission decision failed");
      setPermissionsByRun((prev) => ({ ...prev, [runId]: (prev[runId] ?? []).filter((p) => p.requestId !== requestId) }));
      await refreshPermissions(runId);
    } catch (e) {
      setPermError(e instanceof Error ? e.message : "Permission decision failed.");
    }
  }

  async function refreshRoster() {
    try {
      const data = await listBots(window.location.origin);
      if (active.current) setBots(data);
    } catch {
      if (active.current) setRosterError("Could not load bots.");
    }
  }

  async function refreshThreads() {
    if (!selectedWorkspaceId) { setThreads([]); return; }
    try {
      const data = await listThreads(selectedWorkspaceId, window.location.origin);
      if (active.current) setThreads(data);
    } catch {
      if (active.current) setThreadError("Could not load threads.");
    }
  }

  async function refreshMessages(threadId: string) {
    if (!selectedWorkspaceId) return;
    try {
      const data = await listThreadMessages(selectedWorkspaceId, threadId, window.location.origin);
      if (active.current) setMessages(data.messages);
    } catch {
      if (active.current) setMsgError("Could not load messages.");
    }
  }

  // Read each visible run's thread once per refresh pass: the in-flight ref
  // dedupes a thread shared by several runs, and a fresh pass re-reads so a
  // settled run's answer lands. Messages are cached under their thread.
  async function refreshRunReplies() {
    if (!selectedWorkspaceId) return;
    const list = selectedBotId ? runs.filter((run) => run.botId === selectedBotId) : runs;
    const threadIds = new Set<string>();
    for (const run of list) {
      const threadId = runThreadId(run);
      if (threadId) threadIds.add(threadId);
    }
    for (const threadId of threadIds) {
      if (threadFetches.current.has(threadId)) continue;
      threadFetches.current.add(threadId);
      try {
        const data = await listThreadMessages(selectedWorkspaceId, threadId, window.location.origin);
        if (active.current) setThreadMessages((prev) => ({ ...prev, [threadId]: data.messages }));
      } catch {
        // A thread read only enriches the run row; a failure leaves it untouched.
      } finally {
        threadFetches.current.delete(threadId);
      }
    }
  }

  async function refreshSchedules() {
    try {
      const data = await listSchedules(window.location.origin);
      if (active.current) {
        const filtered = selectedWorkspaceId ? data.filter((s) => s.workspaceId === selectedWorkspaceId) : data;
        setSchedules(filtered);
      }
    } catch {
      if (active.current) setSchedError("Could not load schedules.");
    }
  }

  async function toggleScheduleEnabled(id: string, enabled: boolean) {
    try {
      await setScheduleEnabled(id, enabled, window.location.origin);
      await refreshSchedules();
    } catch (e) {
      setSchedError(e instanceof Error ? e.message : "Could not update schedule.");
    }
  }

  async function submitSchedule(kind: "task" | "routine", prompt: string, localTime: string, timezone: string, workspaceId?: string, botId?: string): Promise<boolean> {
    try {
      const created = await createSchedule(kind, workspaceId, botId, prompt, localTime, timezone, window.location.origin);
      await refreshSchedules();
      // The one workspace schedule shown is the one the host stored.
      return Boolean(created?.id);
    } catch (e) {
      setSchedError(e instanceof Error ? e.message : "Could not create schedule.");
      return false;
    }
  }

  async function refreshInbox() {
    try {
      const result = await api.api.inbox.get();
      if (result.error) throw new Error("Inbox fetch failed");
      const data = result.data as { items: InboxItem[] };
      if (active.current) {
        setInbox(data.items);
        setNeedsYouCount(data.items.filter((i) => i.state === "open" && !i.read).length);
      }
    } catch {
      if (active.current) setInboxError("Could not load inbox.");
    }
  }

  async function handleMarkRead(id: string) {
    try {
      const result = await api.api.inbox({ id }).read.post();
      if (result.error) throw new Error("Mark read failed");
      await refreshInbox();
    } catch (e) {
      setInboxError(e instanceof Error ? e.message : "Could not mark item read.");
    }
  }

  async function handleResolve(id: string) {
    try {
      const result = await api.api.inbox({ id }).resolve.post();
      if (result.error) throw new Error("Resolve failed");
      await refreshInbox();
    } catch (e) {
      setInboxError(e instanceof Error ? e.message : "Could not resolve item.");
    }
  }

  async function refreshBotRoutines() {
    if (!selectedBotId) { setBotRoutines([]); return; }
    try {
      const data = await listSchedules(window.location.origin);
      if (active.current) {
        const routines = data.filter((s) => s.botId === selectedBotId);
        setBotRoutines(routines);
      }
    } catch {
      if (active.current) setBotRoutineError("Could not load bot routines.");
    }
  }

  // Send a prompt: the panel shows a pending row the instant Send is pressed and
  // waits for the host's own answer. With a bot selected the run starts against
  // that bot; otherwise it is a workspace run. The run itself is only shown once
  // the authoritative runs read returns it.
  async function sendPrompt(attempt: PromptAttempt) {
    if (!selectedWorkspaceId) return;
    setPending({ ...attempt, status: "sending" });
    const body = { workspaceId: selectedWorkspaceId, prompt: attempt.prompt, requestId: attempt.requestId };
    try {
      const result = selectedBotId
        ? await api.api.bots({ id: selectedBotId }).run.post(body)
        : await api.api.runs.post(body);
      if (result.error) throw new Error("Prompt was not accepted by the host.");
      if (!active.current) return;
      setPending(null);
      setPrompt("");
      await refreshRuns();
    } catch (e) {
      if (!active.current) return;
      setPending({ ...attempt, status: "failed", message: e instanceof Error ? e.message : "Prompt could not be sent." });
    }
  }

  const sendBusy = pending?.status === "sending";

  function submitPrompt() {
    const text = prompt.trim();
    if (!text || sendBusy || !selectedWorkspaceId) return;
    void sendPrompt({ requestId: crypto.randomUUID(), prompt: text });
  }

  // Initialize
  useEffect(() => {
    active.current = true;
    setRuns([]);
    setRunError("");
    setPermissionsByRun({});
    setPermError("");
    setBots([]);
    setRosterError("");
    setThreads([]);
    setThreadError("");
    setSelectedThreadId(null);
    setMessages([]);
    setMsgError("");
    setThreadMessages({});
    threadFetches.current.clear();
    setSchedules([]);
    setSchedError("");
    setInbox([]);
    setInboxError("");
    setNeedsYouCount(0);
    setBotRoutines([]);
    setBotRoutineError("");

    refreshRuns();
    refreshRoster();
    refreshThreads();
    refreshSchedules();
    refreshInbox();
    refreshBotRoutines();

    return () => {
      active.current = false;
    };
  }, [api, selectedWorkspaceId, selectedBotId]);

  useEffect(() => {
    if (selectedWorkspaceId) {
      refreshRuns();
      refreshThreads();
      refreshSchedules();
      refreshInbox();
    }
  }, [selectedWorkspaceId]);

  // A live event from the app's stream means the host has something new.
  useEffect(() => {
    if (eventCursor == null || !selectedWorkspaceId) return;
    refreshRuns();
    refreshSchedules();
    refreshBotRoutines();
    refreshInbox();
  }, [eventCursor]);

  // A change to a live signal means the host says that resource changed. The
  // panel re-reads the authoritative route for each one that moved instead of
  // polling on a timer. The first run is skipped: the mount effect above already
  // did the initial read.
  const liveFirst = useRef(true);
  useEffect(() => {
    if (liveFirst.current) { liveFirst.current = false; return; }
    if (!selectedWorkspaceId) return;
    if (live?.runs !== undefined) refreshRuns();
    if (live?.bots !== undefined) refreshRoster();
    if (live?.schedules !== undefined) { refreshSchedules(); refreshBotRoutines(); }
    if (live?.inbox !== undefined) refreshInbox();
    if (live?.threads !== undefined) refreshThreads();
    if (live?.messages !== undefined && selectedThreadId) refreshMessages(selectedThreadId);
  }, [live?.runs, live?.bots, live?.schedules, live?.inbox, live?.threads, live?.messages]);

  // Run replies follow the runs and the chat target: a run set change (a run
  // settled), the selected workspace/bot, or a message.changed signal re-reads.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    void refreshRunReplies();
  }, [runs, selectedWorkspaceId, selectedBotId, live?.messages]);

  // The host's provider state backs the Accounts card in the empty conversation.
  useEffect(() => {
    let live = true;
    void getAgentProvider(window.location.origin)
      .then((value) => { if (live) setAgentProvider(value); })
      .catch(() => { /* the card says "unavailable" rather than guessing */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (selectedBotId) {
      refreshBotRoutines();
      refreshRoster();
    }
  }, [selectedBotId]);

  useEffect(() => {
    if (threads.length > 0 && !selectedThreadId) {
      setSelectedThreadId(threads[0].id);
    }
  }, [threads]);

  useEffect(() => {
    if (selectedThreadId && selectedWorkspaceId) {
      refreshMessages(selectedThreadId);
    }
  }, [selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    const nonTerminal = runs.filter((r) => !TERMINAL_STATES.has(r.state));
    for (const run of nonTerminal) {
      refreshPermissions(run.id);
    }
  }, [runs]);

  if (!selectedWorkspaceId) {
    return (
      <View style={[ui.panel, styles.panel]} testID="agent-panel">
        <Text style={ui.heading}>Agent</Text>
        <Text style={ui.body}>Select a workspace to view agent activity.</Text>
      </View>
    );
  }

  // The chat target names the Bot when one is selected, else the workspace. The
  // transcript below shows the selected Bot's runs, or every run in the workspace.
  const chatTargetName = selectedBotId
    ? selectedBotName ?? bots.find((bot) => bot.id === selectedBotId)?.name ?? selectedBotId
    : selectedWorkspaceName ?? selectedWorkspaceId;
  const visibleRuns = selectedBotId ? runs.filter((run) => run.botId === selectedBotId) : runs;
  // The agent's turn for a run: its thread's assistant messages, nothing else.
  const repliesForRun = (run: WorkspaceRun) => {
    const threadId = runThreadId(run);
    if (!threadId) return [];
    return (threadMessages[threadId] ?? []).filter(
      (msg) => msg.runId === run.id && msg.kind === "assistant" && msg.body.trim().length > 0,
    );
  };

  return (
    <ScrollView style={[ui.panel, styles.panel]} testID="agent-panel">
      <Text accessibilityRole="header" style={ui.heading}>Agent</Text>

      {/* 0. Chat target */}
      <View style={ui.sectionHeader} testID="chat-target">
        <Icon name={selectedBotId ? "bot" : "monitor"} size={12} />
        <Text style={[ui.bodyStrong, styles.rowText]}>{chatTargetName}</Text>
      </View>

      {/* 1. Runs */}
      <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
        <View style={ui.sectionHeader}>
          <Icon name="activity" size={12} />
          <Text style={ui.sectionLabel}>Runs</Text>
        </View>
        {runError ? <Text accessibilityRole="alert" testID="run-error" style={ui.error}>{runError}</Text> : null}
        {visibleRuns.length === 0 && !runError ? (
          /* The macOS surface's empty conversation: what a chat looks like
             before anything has been asked, with the host's accounts under it. */
          <View style={styles.emptyConversation} testID="chat-empty">
            <View style={styles.emptyIcon}>
              <Icon name="sparkles" size={26} />
            </View>
            <View style={styles.emptyCopy}>
              <Text style={styles.emptyTitle}>No messages</Text>
              <Text style={styles.emptyHint}>Start a new agent run.</Text>
            </View>
            <View style={styles.accountsCard} testID="agent-accounts">
              <View style={styles.accountsHeader}>
                <Text style={styles.accountsTitle}>Accounts</Text>
                <Text style={styles.accountsSubtitle}>Models from connected accounts appear in Main and Worker.</Text>
              </View>
              <View style={styles.hairline} />
              <View style={styles.accountRow} testID="agent-account-primary">
                <View style={styles.accountInfo}>
                  <Text style={styles.accountName}>{agentProvider?.provider ?? "No provider"}</Text>
                  <View style={styles.accountStatus}>
                    <View style={[ui.dot, { backgroundColor: providerStateColor(agentProvider) }]} />
                    <Text style={styles.accountDetail}>{providerStateText(agentProvider)}</Text>
                  </View>
                </View>
                <Text style={styles.accountModel}>{agentProvider?.credentialVariable ?? ""}</Text>
              </View>
            </View>
          </View>
        ) : null}
        {visibleRuns.map((run) => (
          <View key={run.id} style={styles.runRow} testID={`run-${run.id}`}>
            <View style={styles.runRowInner}>
              <View style={ui.statusRow}>
                <Icon name={RUN_STATE_GLYPH[run.state] ?? "activity"} size={12} />
                <View style={[ui.dot, { backgroundColor: runStateColor(run.state) }]} />
              </View>
              <Text testID={`run-state-${run.id}`} style={[ui.body, styles.rowText]}>{run.state}</Text>
              <Text style={[ui.body, styles.rowText]}>
                state: {run.state} | prompt: {run.prompt.slice(0, 60)}{run.prompt.length > 60 ? "\u2026" : ""} | updated: <Text style={ui.mono}>{run.updatedAt}</Text> | stopReason: {run.stopReason ?? "\u2014"} | error: {run.error ?? "\u2014"}
              </Text>
              {!TERMINAL_STATES.has(run.state) ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Stop run ${run.id}`}
                  testID={`stop-run-${run.id}`}
                  onPress={() => void stopRun(run.id)}
                  style={[ui.button, styles.btnCompact]}
                >
                  <Text style={ui.buttonLabel}>Stop run</Text>
                </Pressable>
              ) : null}
            </View>
            {repliesForRun(run).map((msg) => (
              <View key={msg.id} style={styles.runReply} testID={`run-reply-${run.id}`}>
                <Text style={ui.body}>{msg.body}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>

      {/* 2. Permissions */}
      <View style={[ui.section, styles.sectionSep]}>
        <View style={ui.sectionHeader}>
          <Icon name="shield" size={12} />
          <Text style={ui.sectionLabel}>Permissions</Text>
        </View>
        {permError ? <Text accessibilityRole="alert" style={ui.error}>{permError}</Text> : null}
        {Object.entries(permissionsByRun).flatMap(([runId, list]) => list.map((perm) => ({ runId, perm }))).map(({ runId, perm }) => (
          <View key={perm.requestId} style={styles.attention} testID={`run-permission-${perm.requestId}`}>
            <View style={styles.attentionRow}>
              <Icon name="alert" size={14} />
              <Text style={[ui.body, styles.rowText]}>{perm.title} ({perm.kind})</Text>
            </View>
            <View style={styles.attentionActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Allow permission ${perm.requestId}`}
                testID={`allow-permission-${perm.requestId}`}
                onPress={() => void decidePermission(runId, perm.requestId, "allow")}
                style={[ui.buttonPrimary, styles.btnCompact]}
              >
                <Text style={ui.buttonLabelPrimary}>Allow</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Deny permission ${perm.requestId}`}
                testID={`deny-permission-${perm.requestId}`}
                onPress={() => void decidePermission(runId, perm.requestId, "deny")}
                style={[ui.buttonDanger, styles.btnCompact]}
              >
                <Text style={ui.buttonLabel}>Deny</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {permissions.length === 0 && !permError ? <Text style={ui.body}>No pending permissions.</Text> : null}
      </View>

      {/* 3. Bots */}
      <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
        <View style={ui.sectionHeader}>
          <Icon name="bot" size={12} />
          <Text style={ui.sectionLabel}>Bots</Text>
        </View>
        {rosterError ? <Text accessibilityRole="alert" style={ui.error}>{rosterError}</Text> : null}
        <View testID="roster-list">
          <View style={styles.denseRow} testID={`roster-user-${userId}`}>
            <View style={ui.statusRow}>
              <Icon name="monitor" size={12} />
            </View>
            <Text style={[ui.body, styles.rowText]}>You ({userId})</Text>
          </View>
          {bots.map((bot) => (
            <View key={bot.id} style={[styles.denseRow, selectedBotId === bot.id && ui.listItemSelected]} testID={`roster-bot-${bot.id}`}>
              <View style={ui.statusRow}>
                <Icon name="bot" size={12} />
              </View>
              <Text style={[ui.body, styles.rowText]}>{bot.name}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 4. Threads */}
      <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
        <View style={ui.sectionHeader}>
          <Icon name="grid" size={12} />
          <Text style={ui.sectionLabel}>Threads</Text>
        </View>
        {threadError ? <Text accessibilityRole="alert" style={ui.error}>{threadError}</Text> : null}
        <View testID="thread-list">
          {threads.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              testID={`thread-item-${safeTestId(thread.title)}`}
              onPress={() => setSelectedThreadId(thread.id)}
              style={[styles.denseRow, selectedThreadId === thread.id && ui.listItemSelected]}
            >
              <Icon name="grid" size={12} />
              <Text style={[ui.body, styles.rowText]}>{thread.title}</Text>
            </Pressable>
          ))}
          {!threads.length && !threadError ? <Text style={ui.body}>No threads.</Text> : null}
        </View>
      </View>

      {/* 5. Messages */}
      {selectedThreadId ? (
        <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
          <View style={ui.sectionHeader}>
            <Icon name="file" size={12} />
            <Text style={ui.sectionLabel}>Messages</Text>
          </View>
          {msgError ? <Text accessibilityRole="alert" style={ui.error}>{msgError}</Text> : null}
          {messages.map((msg) => (
            <View key={msg.id} style={styles.messageRow} testID={`thread-message-${msg.id}`}>
              <Text style={[ui.body, styles.rowText]}>
                [<Text style={ui.mono}>{msg.kind}</Text>] {msg.body}
              </Text>
            </View>
          ))}
          {messages.length === 0 && !msgError ? <Text style={ui.body}>No messages.</Text> : null}
        </View>
      ) : null}

      {/* 6. Scheduled Tasks */}
      <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
        <View style={ui.sectionHeader}>
          <Icon name="calendar" size={12} />
          <Text style={ui.sectionLabel}>Scheduled Tasks</Text>
        </View>
        {schedError ? <Text accessibilityRole="alert" style={ui.error}>{schedError}</Text> : null}
        {schedules.map((sch) => (
          <View key={sch.id} style={styles.denseRow} testID={`schedule-${sch.id}`}>
            <View style={ui.statusRow}>
              <Icon name="clock" size={12} />
              <View style={[ui.dot, { backgroundColor: sch.enabled ? color.success : color.textTertiary }]} />
            </View>
            <Text style={[ui.body, styles.rowText]}>
              <Text style={ui.mono}>{sch.prompt}</Text> | localTime: <Text style={ui.mono}>{sch.localTime}</Text> | tz: <Text style={ui.mono}>{sch.timezone}</Text> | enabled: {String(sch.enabled)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Toggle schedule ${sch.id}`}
              testID={`toggle-schedule-${sch.id}`}
              onPress={() => void toggleScheduleEnabled(sch.id, !sch.enabled)}
              style={[ui.button, styles.btnCompact]}
            >
              <Text style={ui.buttonLabel}>{sch.enabled ? "Disable" : "Enable"}</Text>
            </Pressable>
          </View>
        ))}
        <ScheduleForm
          kind="task"
          workspaceId={selectedWorkspaceId}
          onSubmit={(prompt, localTime, timezone) => submitSchedule("task", prompt, localTime, timezone, selectedWorkspaceId)}
        />
      </View>

      {/* 7. Bot Routines */}
      <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
        <View style={ui.sectionHeader}>
          <Icon name="clock" size={12} />
          <Text style={ui.sectionLabel}>Bot Routines</Text>
        </View>
        {botRoutineError ? <Text accessibilityRole="alert" style={ui.error}>{botRoutineError}</Text> : null}
        {selectedBotId ? (
          <>
            {botRoutines.map((routine) => (
              <View key={routine.id} style={styles.denseRow} testID={`bot-routine-${routine.id}`}>
                <View style={ui.statusRow}>
                  <Icon name="clock" size={12} />
                  <View style={[ui.dot, { backgroundColor: routine.enabled ? color.success : color.textTertiary }]} />
                </View>
                <Text style={[ui.body, styles.rowText]}>
                  prompt: {routine.prompt.slice(0, 40)}{routine.prompt.length > 40 ? "\u2026" : ""} | localTime: <Text style={ui.mono}>{routine.localTime}</Text> | tz: <Text style={ui.mono}>{routine.timezone}</Text> | enabled: {String(routine.enabled)}
                </Text>
              </View>
            ))}
            <ScheduleForm
              kind="routine"
              workspaceId={selectedWorkspaceId}
              botId={selectedBotId}
              onSubmit={(prompt, localTime, timezone) => submitSchedule("routine", prompt, localTime, timezone, selectedWorkspaceId, selectedBotId)}
            />
          </>
        ) : (
          <Text style={ui.body}>Select a Bot to view its routines.</Text>
        )}
      </View>

      {/* 8. Needs You (Inbox) */}
      <View style={[ui.section, styles.sectionSep, styles.sectionFlush]}>
        <View style={ui.sectionHeader}>
          <Icon name="inbox" size={12} />
          <Text style={ui.sectionLabel}>Needs you</Text>
        </View>
        {inboxError ? <Text accessibilityRole="alert" style={ui.error}>{inboxError}</Text> : null}
        <View style={styles.attention}>
          <View style={styles.attentionRow}>
            <Icon name="alert" size={14} />
            <Text testID="needs-you" style={ui.body}>Open items: {needsYouCount}</Text>
          </View>
        </View>
        {inbox.map((item) => (
          <View key={item.id} style={styles.denseRow} testID={`inbox-item-${item.id}`}>
            <View style={ui.statusRow}>
              <Icon name="inbox" size={12} />
            </View>
            <Text style={[ui.body, styles.rowText]}>{item.title} ({item.kind}) \u2014 {item.state}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark inbox item ${item.id} read`}
              testID={`mark-read-${item.id}`}
              onPress={() => void handleMarkRead(item.id)}
              style={[ui.button, styles.btnCompact]}
            >
              <Text style={ui.buttonLabel}>Mark read</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Resolve inbox item ${item.id}`}
              testID={`resolve-inbox-${item.id}`}
              onPress={() => void handleResolve(item.id)}
              style={[ui.button, styles.btnCompact]}
            >
              <Text style={ui.buttonLabel}>Resolve</Text>
            </Pressable>
          </View>
        ))}
        {inbox.length === 0 && !inboxError ? <Text style={ui.body}>No inbox items.</Text> : null}
      </View>

      {/* 9. Composer: starts a run against the selected Bot or the workspace.
          The pending row shows the prompt the instant Send is pressed, before the
          host has answered; the run itself waits for the authoritative read. */}
      {pending ? (
        pending.status === "failed" ? (
          <View style={styles.attention} testID="pending-prompt-failed">
            <Text accessibilityRole="alert" style={ui.error}>{pending.message}</Text>
            <Text style={[ui.body, styles.rowText]}>{pending.prompt}</Text>
            <View style={styles.attentionActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry prompt"
                onPress={() => void sendPrompt(pending)}
                style={[ui.buttonPrimary, styles.btnCompact]}
              >
                <Text style={ui.buttonLabelPrimary}>Retry prompt</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Discard prompt"
                onPress={() => setPending(null)}
                style={[ui.button, styles.btnCompact]}
              >
                <Text style={ui.buttonLabel}>Discard prompt</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.denseRow} testID="pending-prompt">
            <Text style={[ui.body, styles.rowText]}>{pending.prompt}</Text>
            <Text style={ui.meta}>Sending{"\u2026"}</Text>
          </View>
        )
      ) : null}

      <View style={ui.card} testID="composer">
        <TextInput
          accessibilityLabel="Prompt"
          {...({ multiline: true } as Record<string, unknown>)}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Ask Distill for changes\u2026"
          style={[ui.input, ui.inputMultiline]}
        />
        {/* The chips name what a send will use: the target, the model the host
            has configured, and where the run executes. */}
        <View style={styles.composerFooter}>
          <View style={ui.statusRow}>
            <View style={styles.chip} testID="composer-target-chip">
              <Icon name={selectedBotId ? "bot" : "folder"} size={11} />
              <Text style={styles.chipText}>{chatTargetName}</Text>
            </View>
            <View style={styles.chip} testID="composer-model-chip">
              <Icon name="activity" size={11} />
              <Text style={styles.chipText}>{agentProvider?.model ? `Main ${agentProvider.model}` : "Main \u2014"}</Text>
            </View>
            <View style={styles.chip} testID="composer-host-chip">
              <Icon name="monitor" size={11} />
              <Text style={styles.chipText}>Local</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send prompt"
            testID="send-prompt"
            disabled={sendBusy || !prompt.trim()}
            onPress={submitPrompt}
            style={[styles.sendButton, (sendBusy || !prompt.trim()) && ui.buttonDisabled]}
          >
            <Icon name="arrowUp" size={14} />
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function ScheduleForm({ kind, workspaceId, botId, onSubmit }: { kind: "task" | "routine"; workspaceId: string | null; botId?: string | null; onSubmit: (prompt: string, localTime: string, timezone: string) => Promise<boolean> }) {
  const [prompt, setPrompt] = useState("");
  const [localTime, setLocalTime] = useState("09:00");
  const [timezone, setTimezone] = useState("UTC");
  const [creating, setCreating] = useState(false);

  return (
    <View style={styles.form}>
      <View style={styles.formGrid}>
        <View style={ui.field}>
          <Text style={ui.fieldLabel}>Schedule prompt</Text>
          <TextInput
            accessibilityLabel="Schedule prompt"
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Prompt"
            style={ui.input}
          />
        </View>
        <View style={ui.field}>
          <Text style={ui.fieldLabel}>Local time</Text>
          <TextInput
            accessibilityLabel="Local time"
            value={localTime}
            onChangeText={setLocalTime}
            placeholder="HH:MM"
            style={ui.input}
          />
        </View>
        <View style={ui.field}>
          <Text style={ui.fieldLabel}>Timezone</Text>
          <TextInput
            accessibilityLabel="Timezone"
            value={timezone}
            onChangeText={setTimezone}
            placeholder="IANA timezone"
            style={ui.input}
          />
        </View>
      </View>
      <View style={styles.formActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Create ${kind} schedule`}
          testID={`create-${kind}-schedule`}
          disabled={creating || !prompt.trim() || !workspaceId}
          onPress={() => {
            // The draft is cleared only once the host confirmed the schedule.
            void (async () => {
              setCreating(true);
              const stored = await onSubmit(prompt.trim(), localTime, timezone);
              if (stored) setPrompt("");
              setCreating(false);
            })();
          }}
          style={[ui.buttonPrimary, (creating || !prompt.trim() || !workspaceId) && ui.buttonDisabled]}
        >
          <Text style={ui.buttonLabelPrimary}>Create {kind} schedule</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  // Sections share one vertical rhythm: a hairline above each block, flush rows
  // inside so the dense lists stay continuous instead of floating in cards.
  sectionSep: {
    borderTopColor: color.line,
    borderTopWidth: 1,
    paddingTop: space.lg,
  },
  sectionFlush: { gap: 0 },
  denseRow: {
    alignItems: "center",
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: space.md,
    minHeight: 34,
    paddingVertical: space.xs,
  },
  // A run is a conversation turn: the row above is the user's turn, the reply
  // below the agent's, split by the same hairline the other dense rows use.
  runRow: {
    borderTopColor: color.line,
    borderTopWidth: 1,
    paddingVertical: space.xs,
  },
  runRowInner: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.md,
    minHeight: 30,
  },
  emptyConversation: {
    alignItems: "center",
    gap: space.lg,
    justifyContent: "center",
    minHeight: 280,
    paddingVertical: space.lg,
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  emptyCopy: { alignItems: "center", gap: space.sm },
  emptyTitle: { color: color.textSecondary, fontSize: 28, fontWeight: "600", letterSpacing: -0.4 },
  emptyHint: { color: color.textTertiary, fontSize: font.body },
  accountsCard: {
    alignSelf: "stretch",
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.control,
    borderWidth: 1,
    maxWidth: 420,
  },
  accountsHeader: { gap: 4, paddingBottom: space.sm, paddingHorizontal: space.md, paddingTop: space.md },
  accountsTitle: { color: color.text, fontSize: 15, fontWeight: "600" },
  accountsSubtitle: { color: color.textTertiary, fontSize: font.caption },
  hairline: { backgroundColor: color.line, height: 1, width: "100%" },
  accountRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  accountInfo: { flexShrink: 1, gap: 4 },
  accountName: { color: color.text, fontSize: font.bodyDense, fontWeight: "600" },
  accountStatus: { alignItems: "center", flexDirection: "row", gap: space.xs },
  accountDetail: { color: color.textSecondary, fontSize: font.caption, flexShrink: 1 },
  accountModel: { color: color.textTertiary, fontFamily: font.mono, fontSize: font.caption },
  composerFooter: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  chip: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: space.xs,
    maxWidth: 220,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  chipText: { color: color.textSecondary, fontSize: font.caption2 },
  sendButton: {
    alignItems: "center",
    backgroundColor: color.accent,
    borderRadius: radius.control,
    height: 30,
    justifyContent: "center",
    width: 34,
  },
  runReply: {
    borderTopColor: color.line,
    borderTopWidth: 1,
    marginTop: space.xs,
    paddingTop: space.xs,
  },
  messageRow: {
    borderTopColor: color.line,
    borderTopWidth: 1,
    paddingVertical: space.sm,
  },
  rowText: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  // Trailing row actions sit at the dense 24px height next to the row body.
  btnCompact: {
    alignSelf: "center",
    minHeight: 24,
    paddingHorizontal: space.md,
    paddingVertical: 0,
  },
  // Attention islands (pending permissions, the needs-you count) carry a
  // warning hairline and an alert glyph so they read apart from plain rows.
  attention: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.warning,
    borderRadius: radius.card,
    borderWidth: 1,
    gap: space.sm,
    padding: space.md,
  },
  attentionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.md,
  },
  attentionActions: {
    flexDirection: "row",
    gap: space.sm,
  },
  form: {
    gap: space.sm,
    paddingVertical: space.sm,
  },
  formGrid: {
    gap: space.sm,
  },
  formActions: {
    flexDirection: "row",
    gap: space.sm,
  },
});
