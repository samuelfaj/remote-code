import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { listThreadMessages, listThreads, postThreadMessage, type Thread } from "@remotecode/client";

type Props = {
  origin: string;
  workspaceId: string;
  workspaceName: string;
  focusRunId?: string;
  onBack: () => void;
  onSelectThread: (thread: Thread) => void;
};

export function ThreadsScreen({ origin, workspaceId, workspaceName, focusRunId, onBack, onSelectThread }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await listThreads(workspaceId, origin);
        if (active) { setThreads(data); setLoading(false); }
      } catch {
        if (active) { setError("Could not load threads."); setLoading(false); }
      }
    }
    void load();
    return () => { active = false; };
  }, [origin, workspaceId]);

  // A push for a run names the run, not its thread, and runs carry no thread id
  // on the API: the thread is the one whose messages record that run.
  const focused = useRef(false);
  useEffect(() => {
    if (!focusRunId || loading || focused.current || threads.length === 0) return;
    let active = true;
    void (async () => {
      for (const thread of threads) {
        try {
          const result = await listThreadMessages(workspaceId, thread.id, origin);
          if (!active) return;
          if (result.messages.some((message) => message.runId === focusRunId)) {
            focused.current = true;
            onSelectThread(thread);
            return;
          }
        } catch { /* a thread that cannot be read cannot hold the run */ }
      }
    })();
    return () => { active = false; };
  }, [focusRunId, loading, threads, workspaceId, origin, onSelectThread]);

  if (loading) return <Text style={styles.status}>Loading threads…</Text>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Text style={styles.heading}>Threads in {workspaceName}</Text>
      {threads.length === 0 ? <Text style={styles.status}>No threads yet.</Text> : null}
      {threads.map((thread) => (
        <Pressable
          key={thread.id}
          accessibilityRole="button"
          accessibilityLabel={`Thread ${thread.title}`}
          onPress={() => onSelectThread(thread)}
          style={styles.row}
        >
          <Text style={styles.name}>{thread.title}</Text>
          <Text style={styles.skills}>{thread.updatedAt}</Text>
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" accessibilityLabel="Back to Workspaces" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backText}>Back to Workspaces</Text>
      </Pressable>
    </ScrollView>
  );
}

type ThreadMessagesProps = {
  origin: string;
  workspaceId: string;
  threadId: string;
  threadTitle: string;
  onBack: () => void;
};

export function ThreadMessagesScreen({ origin, workspaceId, threadId, threadTitle, onBack }: ThreadMessagesProps) {
  const [messages, setMessages] = useState<Array<{ id: string; kind: string; body: string; createdAt: string }>>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await listThreadMessages(workspaceId, threadId, origin);
        if (active) { setMessages(result.messages); setLoading(false); }
      } catch {
        if (active) { setError("Could not load messages."); setLoading(false); }
      }
    }
    void load();
    return () => { active = false; };
  }, [origin, workspaceId, threadId]);

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await postThreadMessage(workspaceId, threadId, input.trim(), undefined, undefined, origin);
      setInput("");
      const result = await listThreadMessages(workspaceId, threadId, origin);
      setMessages(result.messages);
    } catch {
      setError("Could not send message.");
    } finally {
      setSending(false);
    }
  }

  if (loading) return <Text style={styles.status}>Loading messages…</Text>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Text style={styles.heading}>{threadTitle}</Text>
      {messages.length === 0 ? <Text style={styles.status}>No messages yet.</Text> : null}
      {messages.map((msg) => (
        <View key={msg.id} style={styles.messageRow}>
          <Text style={styles.messageBody}>{msg.body}</Text>
          <Text style={styles.skills}>{msg.createdAt}</Text>
        </View>
      ))}
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Thread message"
          value={input}
          onChangeText={setInput}
          placeholder="Send a message"
          style={styles.input}
          editable={!sending}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          disabled={sending || !input.trim()}
          onPress={() => void sendMessage()}
          style={[styles.button, (sending || !input.trim()) && styles.disabled]}
        >
          <Text style={styles.buttonText}>{sending ? "Sending…" : "Send"}</Text>
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to threads" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backText}>Back to threads</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, gap: 12, padding: 16 },
  row: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 12, borderWidth: 1, padding: 14, gap: 4 },
  name: { color: "#183337", fontSize: 15, fontWeight: "600" },
  skills: { color: "#50696b", fontSize: 13 },
  heading: { color: "#183337", fontSize: 16, fontWeight: "700", marginBottom: 8 },
  status: { color: "#50696b", fontSize: 14 },
  error: { color: "#9c3026", fontSize: 14 },
  messageRow: { backgroundColor: "#f4f7f5", borderRadius: 10, padding: 12, gap: 4 },
  messageBody: { color: "#183337", fontSize: 14 },
  composer: { gap: 8, marginTop: 8 },
  input: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, color: "#183337", minHeight: 46, paddingHorizontal: 12 },
  button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 10, justifyContent: "center", minHeight: 42, paddingHorizontal: 16 },
  disabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  backButton: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 10, justifyContent: "center", minHeight: 42, paddingHorizontal: 16, marginTop: 12 },
  backText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});