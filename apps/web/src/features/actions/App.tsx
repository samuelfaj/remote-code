import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native-web";
import { createApiClient } from "@remotecode/client";

type ActionReceipt = { id: string; action: string; createdAt: string };
type ActionEvent =
  | { type: "snapshot"; actions: ActionReceipt[] }
  | { type: "action.created"; receipt: ActionReceipt };

export function App() {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const [action, setAction] = useState("Verify shared Linux backend");
  const [actions, setActions] = useState<ActionReceipt[]>([]);
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [connected, setConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const socketUrl = new URL("/api/events", window.location.href);
    socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as ActionEvent;
      if (event.type === "snapshot") setActions(event.actions);
      if (event.type === "action.created") {
        setReceipt(event.receipt);
        setActions((current) => [event.receipt, ...current.filter((item) => item.id !== event.receipt.id)]);
      }
    };

    void api.api.actions.get().then(({ data, error: requestError }) => {
      if (!active) return;
      if (requestError) setError("Could not read the backend action list.");
      else if (data) {
        setActions((current) => {
          const merged = new Map([...data.actions, ...current].map((item) => [item.id, item]));
          return [...merged.values()].sort((left, right) =>
            new Date(String(right.createdAt)).getTime() - new Date(String(left.createdAt)).getTime(),
          );
        });
      }
    });

    return () => {
      active = false;
      socket.close();
    };
  }, [api]);

  async function recordAction() {
    const value = action.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError("");
    const { data, error: requestError } = await api.api.actions.post({ action: value });
    if (requestError || !data) {
      setError("The backend did not confirm this action.");
    } else {
      setReceipt(data);
      setActions((current) => [data, ...current.filter((item) => item.id !== data.id)]);
    }
    setSubmitting(false);
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.shell}>
        <Text style={styles.eyebrow}>LINUX HOST PROOF</Text>
        <Text accessibilityRole="header" style={styles.title}>One backend, two browsers</Text>
        <Text style={styles.intro}>
          This React Native Web screen records actions through the Elysia service running in the Linux container.
        </Text>

        <View style={styles.statusRow}>
          <View style={[styles.dot, connected ? styles.online : styles.offline]} />
          <Text accessibilityRole="text" aria-live="polite" testID="connection-status" style={styles.status}>
            {connected ? "Live updates connected" : "Connecting to Linux backend…"}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Action sent to the backend</Text>
          <TextInput
            accessibilityLabel="Action description"
            onChangeText={setAction}
            placeholder="Describe the action"
            style={styles.input}
            value={action}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting || !connected }}
            disabled={submitting || !connected}
            onPress={recordAction}
            style={({ pressed }) => [styles.button, pressed && styles.pressed, (submitting || !connected) && styles.disabled]}
          >
            <Text style={styles.buttonText}>{submitting ? "Saving…" : "Write backend receipt"}</Text>
          </Pressable>
          {error ? <Text accessibilityRole="text" aria-live="assertive" style={styles.error}>{error}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Confirmed backend receipt</Text>
          {receipt ? (
            <View testID="latest-receipt">
              <Text style={styles.receiptAction}>{receipt.action}</Text>
              <Text selectable style={styles.receiptId}>Receipt {receipt.id}</Text>
              <Text style={styles.timestamp}>{String(receipt.createdAt)}</Text>
            </View>
          ) : <Text style={styles.empty}>No action has been recorded in this session.</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Shared action history</Text>
          {actions.length ? actions.map((item) => (
            <View key={item.id} style={styles.historyRow}>
              <Text style={styles.historyAction}>{item.action}</Text>
              <Text selectable style={styles.historyId}>{item.id}</Text>
            </View>
          )) : <Text style={styles.empty}>The backend has no receipts yet.</Text>}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, backgroundColor: "#f4f7f5", padding: 24 },
  shell: { alignSelf: "center", width: "100%", maxWidth: 760, gap: 18, paddingVertical: 28 },
  eyebrow: { color: "#0d7056", fontSize: 12, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: "#183337", fontSize: 36, fontWeight: "800", letterSpacing: -1.2 },
  intro: { color: "#50696b", fontSize: 16, lineHeight: 24, maxWidth: 640 },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 9, paddingVertical: 4 },
  dot: { borderRadius: 6, height: 10, width: 10 },
  online: { backgroundColor: "#16865f" },
  offline: { backgroundColor: "#bf6d24" },
  status: { color: "#385354", fontSize: 14, fontWeight: "700" },
  card: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 16, borderWidth: 1, gap: 12, padding: 18 },
  label: { color: "#304e4e", fontSize: 12, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  input: { backgroundColor: "#fbfdfc", borderColor: "#c9d8d1", borderRadius: 10, borderWidth: 1, color: "#183337", fontSize: 16, paddingHorizontal: 13, paddingVertical: 12 },
  button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 10, justifyContent: "center", minHeight: 46, paddingHorizontal: 16 },
  pressed: { opacity: 0.84 },
  disabled: { opacity: 0.55 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "750" },
  error: { color: "#a52d20", fontSize: 14 },
  receiptAction: { color: "#183337", fontSize: 17, fontWeight: "750" },
  receiptId: { color: "#476361", fontFamily: "monospace", fontSize: 12 },
  timestamp: { color: "#647d78", fontSize: 12 },
  empty: { color: "#6a807c", fontSize: 14 },
  historyRow: { borderTopColor: "#e8efeb", borderTopWidth: 1, gap: 5, paddingTop: 10 },
  historyAction: { color: "#244140", fontSize: 14, fontWeight: "650" },
  historyId: { color: "#748983", fontFamily: "monospace", fontSize: 11 },
});
