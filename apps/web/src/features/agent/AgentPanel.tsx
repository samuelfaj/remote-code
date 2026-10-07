import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native-web";
import {
  createApiClient,
  createSchedule,
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

type Props = {
  userId: string;
  selectedWorkspaceId: string | null;
  selectedBotId: string | null;
  // The cursor of the app's own live event stream. The panel re-reads on every
  // event rather than opening a second socket: the app already holds exactly one
  // connection to the host, and a second one is a second thing to keep honest.
  eventCursor?: number | null;
};

function safeTestId(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

const TERMINAL_STATES = new Set(["completed", "interrupted", "failed"]);
const POLL_MS = 2_000;

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

export function AgentPanel({ userId, selectedWorkspaceId, selectedBotId, eventCursor }: Props) {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const active = useRef(true);
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
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedError, setSchedError] = useState("");
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [inboxError, setInboxError] = useState("");
  const [needsYouCount, setNeedsYouCount] = useState(0);
  const [botRoutines, setBotRoutines] = useState<Schedule[]>([]);
  const [botRoutineError, setBotRoutineError] = useState("");

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

  // WebSocket to /api/events (same path as App.tsx action-events)

  // Polling fallback every 2s
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startPolling() {
    if (pollRef.current) return;
    // The roster, the scheduled tasks and the Inbox change while the panel is
    // open, so the same cycle that refreshes the runs refreshes them: what the
    // panel shows has to stay the host's answer, not a snapshot from load.
    pollRef.current = setInterval(() => {
      if (!active.current) return;
      refreshRuns();
      refreshRoster();
      refreshSchedules();
      refreshBotRoutines();
      refreshInbox();
    }, POLL_MS);
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
    startPolling();

    return () => {
      active.current = false;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
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
      <View style={styles.panel} testID="agent-panel">
        <Text style={styles.heading}>Agent</Text>
        <Text>Select a workspace to view agent activity.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.panel} testID="agent-panel">
      <Text accessibilityRole="header" style={styles.heading}>Agent</Text>

      {/* 1. Runs */}
      <Text style={styles.sectionHeading}>Runs</Text>
      {runError ? <Text accessibilityRole="alert" testID="run-error">{runError}</Text> : null}
      {runs.length === 0 && !runError ? <Text>No runs yet.</Text> : null}
      {runs.map((run) => (
        <View key={run.id} style={styles.row} testID={`run-${run.id}`}>
          <Text>state: {run.state} | prompt: {run.prompt.slice(0, 60)}{run.prompt.length > 60 ? "\u2026" : ""} | updated: {run.updatedAt} | stopReason: {run.stopReason ?? "\u2014"}</Text>
          {!TERMINAL_STATES.has(run.state) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop run ${run.id}`}
              testID={`stop-run-${run.id}`}
              onPress={() => void stopRun(run.id)}
              style={styles.smallButton}
            >
              <Text style={styles.smallButtonText}>Stop run</Text>
            </Pressable>
          ) : null}
        </View>
      ))}

      {/* 2. Permissions */}
      <Text style={styles.sectionHeading}>Permissions</Text>
      {permError ? <Text accessibilityRole="alert">{permError}</Text> : null}
      {Object.entries(permissionsByRun).flatMap(([runId, list]) => list.map((perm) => ({ runId, perm }))).map(({ runId, perm }) => (
        <View key={perm.requestId} style={styles.row} testID={`run-permission-${perm.requestId}`}>
          <Text>{perm.title} ({perm.kind})</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Allow permission ${perm.requestId}`}
            testID={`allow-permission-${perm.requestId}`}
            onPress={() => void decidePermission(runId, perm.requestId, "allow")}
            style={styles.smallButton}
          >
            <Text style={styles.smallButtonText}>Allow</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Deny permission ${perm.requestId}`}
            testID={`deny-permission-${perm.requestId}`}
            onPress={() => void decidePermission(runId, perm.requestId, "deny")}
            style={[styles.smallButton, styles.denyButton]}
          >
            <Text style={styles.smallButtonText}>Deny</Text>
          </Pressable>
        </View>
      ))}
      {permissions.length === 0 && !permError ? <Text>No pending permissions.</Text> : null}

      {/* 3. Roster */}
      <Text style={styles.sectionHeading}>Roster</Text>
      {rosterError ? <Text accessibilityRole="alert">{rosterError}</Text> : null}
      <View testID="roster-list">
        <View style={styles.row} testID={`roster-user-${userId}`}>
          <Text>You ({userId})</Text>
        </View>
        {bots.map((bot) => (
          <View key={bot.id} style={styles.row} testID={`roster-bot-${bot.id}`}>
            <Text>{bot.name}</Text>
          </View>
        ))}
      </View>

      {/* 4. Threads & Messages */}
      <Text style={styles.sectionHeading}>Threads</Text>
      {threadError ? <Text accessibilityRole="alert">{threadError}</Text> : null}
      <View testID="thread-list">
        {threads.map((thread) => (
          <Pressable
            key={thread.id}
            accessibilityRole="button"
            testID={`thread-item-${safeTestId(thread.title)}`}
            onPress={() => setSelectedThreadId(thread.id)}
            style={[styles.listItem, selectedThreadId === thread.id && styles.listItemSelected]}
          >
            <Text>{thread.title}</Text>
          </Pressable>
        ))}
        {!threads.length && !threadError ? <Text>No threads.</Text> : null}
      </View>
      {selectedThreadId ? (
        <View style={styles.messages}>
          <Text style={styles.subheading}>Messages</Text>
          {msgError ? <Text accessibilityRole="alert">{msgError}</Text> : null}
          {messages.map((msg) => (
            <View key={msg.id} style={styles.msgRow} testID={`thread-message-${msg.id}`}>
              <Text>[{msg.kind}] {msg.body}</Text>
            </View>
          ))}
          {messages.length === 0 && !msgError ? <Text>No messages.</Text> : null}
        </View>
      ) : null}

      {/* 5. Workspace Scheduled Tasks */}
      <Text style={styles.sectionHeading}>Scheduled Tasks</Text>
      {schedError ? <Text accessibilityRole="alert">{schedError}</Text> : null}
      {schedules.map((sch) => (
        <View key={sch.id} style={styles.row} testID={`schedule-${sch.id}`}>
          <Text>localTime: {sch.localTime} | tz: {sch.timezone} | enabled: {String(sch.enabled)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Toggle schedule ${sch.id}`}
            testID={`toggle-schedule-${sch.id}`}
            onPress={() => void toggleScheduleEnabled(sch.id, !sch.enabled)}
            style={styles.smallButton}
          >
            <Text style={styles.smallButtonText}>{sch.enabled ? "Disable" : "Enable"}</Text>
          </Pressable>
        </View>
      ))}
      <ScheduleForm
        kind="task"
        workspaceId={selectedWorkspaceId}
        onSubmit={(prompt, localTime, timezone) => submitSchedule("task", prompt, localTime, timezone, selectedWorkspaceId)}
      />

      {/* 6. Bot Routines */}
      <Text style={styles.sectionHeading}>Bot Routines</Text>
      {botRoutineError ? <Text accessibilityRole="alert">{botRoutineError}</Text> : null}
      {selectedBotId ? (
        <>
          {botRoutines.map((routine) => (
            <View key={routine.id} style={styles.row} testID={`bot-routine-${routine.id}`}>
              <Text>prompt: {routine.prompt.slice(0, 40)}{routine.prompt.length > 40 ? "\u2026" : ""} | localTime: {routine.localTime} | tz: {routine.timezone} | enabled: {String(routine.enabled)}</Text>
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
        <Text>Select a Bot to view its routines.</Text>
      )}

      {/* 7. Needs You */}
      <Text style={styles.sectionHeading}>Needs you</Text>
      {inboxError ? <Text accessibilityRole="alert">{inboxError}</Text> : null}
      <Text testID="needs-you">Open items: {needsYouCount}</Text>
      {inbox.map((item) => (
        <View key={item.id} style={styles.row} testID={`inbox-item-${item.id}`}>
          <Text>{item.title} ({item.kind}) \u2014 {item.state}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Mark inbox item ${item.id} read`}
            testID={`mark-read-${item.id}`}
            onPress={() => void handleMarkRead(item.id)}
            style={styles.smallButton}
          >
            <Text style={styles.smallButtonText}>Mark read</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Resolve inbox item ${item.id}`}
            testID={`resolve-inbox-${item.id}`}
            onPress={() => void handleResolve(item.id)}
            style={styles.smallButton}
          >
            <Text style={styles.smallButtonText}>Resolve</Text>
          </Pressable>
        </View>
      ))}
      {inbox.length === 0 && !inboxError ? <Text>No inbox items.</Text> : null}
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
      <TextInput
        accessibilityLabel="Schedule prompt"
        value={prompt}
        onChangeText={setPrompt}
        placeholder="Prompt"
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Local time"
        value={localTime}
        onChangeText={setLocalTime}
        placeholder="HH:MM"
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Timezone"
        value={timezone}
        onChangeText={setTimezone}
        placeholder="IANA timezone"
        style={styles.input}
      />
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
        style={styles.smallButton}
      >
        <Text style={styles.smallButtonText}>Create {kind} schedule</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, padding: 12, gap: 8 },
  heading: { color: "#183337", fontSize: 18, fontWeight: "700" },
  sectionHeading: { color: "#183337", fontSize: 14, fontWeight: "700", marginTop: 8 },
  subheading: { color: "#183337", fontSize: 12, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6, borderTopColor: "#e3ebe7", borderTopWidth: 1 },
  listItem: { padding: 8, borderRadius: 6, minHeight: 40, justifyContent: "center" },
  listItemSelected: { backgroundColor: "#e8f0ed" },
  messages: { paddingLeft: 8, gap: 4 },
  msgRow: { paddingVertical: 2 },
  smallButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#126b54", borderRadius: 8, minHeight: 36, justifyContent: "center" },
  smallButtonText: { color: "#fff", fontSize: 12, fontWeight: "750" },
  denyButton: { backgroundColor: "#a52d20" },
  form: { gap: 6, paddingVertical: 8 },
  input: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, minHeight: 42, paddingHorizontal: 12 },
});
