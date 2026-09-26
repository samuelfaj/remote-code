import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native-web";
import { createApiClient } from "@remotecode/client";
import { getWebHealth } from "../health/api";

type ActionReceipt = { id: string; action: string; createdAt: string };
type ActionEvent =
  | { type: "snapshot"; actions: ActionReceipt[] }
  | { type: "action.created"; receipt: ActionReceipt };

type HealthStatus = "checking" | "ready" | "not_ready" | "unavailable";

function HostHealth() {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus("checking");
    void getWebHealth(window.location.origin).then((health) => {
      if (active) setStatus(health === "ready" ? "ready" : "not_ready");
    }).catch(() => {
      if (active) setStatus("unavailable");
    });
    return () => { active = false; };
  }, [attempt]);

  const label = {
    checking: "Checking API health",
    ready: "API ready",
    not_ready: "API not ready",
    unavailable: "API health unavailable",
  }[status];

  return (
    <View style={styles.card}>
      <Text accessibilityRole="text" aria-live="polite" testID="host-health-status">{label}</Text>
      <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)} style={styles.button}>
        <Text style={styles.buttonText}>Refresh host health</Text>
      </Pressable>
    </View>
  );
}

export function App() {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const [action, setAction] = useState("Verify shared Linux backend");
  const [actions, setActions] = useState<ActionReceipt[]>([]);
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [connected, setConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const authEpoch = useRef(0);

  useEffect(() => {
    let active = true;
    void api.api.auth.session.get().then(({ data, error: sessionError }) => {
      if (active) setAuthenticated(!sessionError && Boolean(data && !("error" in data)));
    }).finally(() => {
      if (active) setCheckingSession(false);
    });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    const epoch = authEpoch.current;
    const socketUrl = new URL("/api/events", window.location.href);
    socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);

    socket.onopen = () => {
      if (epoch === authEpoch.current) setConnected(true);
    };
    socket.onclose = (event) => {
      if (epoch !== authEpoch.current) return;
      authEpoch.current += 1;
      setAuthenticated(false);
      setConnected(false);
      setSubmitting(false);
      setActions([]);
      setReceipt(null);
      setError(event.code === 4401 ? "The host session expired or was revoked." : "The host connection closed. Sign in again.");
    };
    socket.onerror = () => {
      if (epoch === authEpoch.current) setConnected(false);
    };
    socket.onmessage = (message) => {
      if (epoch !== authEpoch.current) return;
      const event = JSON.parse(String(message.data)) as ActionEvent;
      if (event.type === "snapshot") setActions(event.actions);
      if (event.type === "action.created") {
        setReceipt(event.receipt);
        setActions((current) => [event.receipt, ...current.filter((item) => item.id !== event.receipt.id)]);
      }
    };

    void api.api.actions.get().then(({ data, error: requestError }) => {
      if (!active || epoch !== authEpoch.current) return;
      if (requestError || !data || "error" in data) setError("Could not read the backend action list.");
      else {
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
  }, [api, authenticated]);

  async function signIn() {
    const epoch = ++authEpoch.current;
    setError("");
    const { data, error: requestError } = await api.api.auth.login.post({ password });
    if (epoch !== authEpoch.current) return;
    if (requestError || !data || "error" in data) {
      setError("The host did not accept this passphrase. Check the host configuration and try again.");
      return;
    }
    setPassword("");
    setAuthenticated(true);
  }

  async function signOut() {
    const epoch = ++authEpoch.current;
    setAuthenticated(false);
    setConnected(false);
    setSubmitting(false);
    setActions([]);
    setReceipt(null);
    const { error: requestError } = await api.api.auth.logout.post();
    if (epoch !== authEpoch.current) return;
    if (requestError) setError("The host could not confirm logout.");
  }

  async function recordAction() {
    const value = action.trim();
    if (!value || submitting) return;
    const epoch = authEpoch.current;
    setSubmitting(true);
    setError("");
    const { data, error: requestError } = await api.api.actions.post({ action: value });
    if (epoch !== authEpoch.current) return;
    if (requestError || !data || "error" in data) {
      setError("The backend did not confirm this action.");
    } else {
      setReceipt(data);
      setActions((current) => [data, ...current.filter((item) => item.id !== data.id)]);
    }
    setSubmitting(false);
  }

  if (checkingSession) return <Text accessibilityRole="text">Checking host session…</Text>;

  if (!authenticated) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.shell}>
          <Text style={styles.eyebrow}>REMOTE CODE HOST</Text>
          <Text accessibilityRole="header" style={styles.title}>Sign in to your host</Text>
          <View style={styles.card}>
            <Text style={styles.label}>Host passphrase</Text>
            <input
              aria-label="Host passphrase"
              className="host-passphrase"
              onChange={(event) => setPassword(event.currentTarget.value)}
              type="password"
              value={password}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void signIn()}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Sign in</Text>
            </Pressable>
            {error ? <Text accessibilityRole="text" aria-live="assertive" style={styles.error}>{error}</Text> : null}
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.shell}>
        <Text style={styles.eyebrow}>LINUX HOST PROOF</Text>
        <Text accessibilityRole="header" style={styles.title}>One backend, two browsers</Text>
        <Text style={styles.intro}>
          This React Native Web screen records actions through the Elysia service running in the Linux container.
        </Text>

        <HostHealth />

        <Pressable accessibilityRole="button" onPress={() => void signOut()} style={styles.button}>
          <Text style={styles.buttonText}>Sign out</Text>
        </Pressable>

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
