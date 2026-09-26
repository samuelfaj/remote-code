import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native-web";
import { applyActionEvent, CLIENT_VERSION, createApiClient, emptyActionEventState } from "@remotecode/client";
import type { ActionEventState } from "@remotecode/client";
import { getWebHealth } from "../health/api";

function isUnsupportedClientVersion(error: unknown) {
  if (typeof error !== "object" || error === null || !("value" in error)) return false;
  const value = error.value;
  return typeof value === "object" && value !== null
    && "error" in value && value.error === "unsupported_client_version";
}

const compatibilityMessage = "This RemoteCode client version is not supported. Update the host or use a supported client version.";

function requestErrorMessage(error: unknown, fallback: string) {
  return isUnsupportedClientVersion(error) ? compatibilityMessage : fallback;
}


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
  const [eventState, setEventState] = useState<ActionEventState>(emptyActionEventState);
  const eventStateRef = useRef(eventState);
  const actions = eventState.actions;
  const receipt = eventState.actions[0] ?? null;
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const authEpoch = useRef(0);
  const connectionGeneration = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let active = true;
    void api.api.auth.session.get().then(({ data, error: sessionError }) => {
      if (!active) return;
      setAuthenticated(!sessionError && Boolean(data && !("error" in data)));
      if (isUnsupportedClientVersion(sessionError)) setError(compatibilityMessage);
    }).finally(() => {
      if (active) setCheckingSession(false);
    });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let synchronized = false;
    let synchronizationTimer: ReturnType<typeof setTimeout>;
    const epoch = authEpoch.current;
    const generation = ++connectionGeneration.current;
    const socketUrl = new URL("/api/events", window.location.href);
    socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("clientVersion", String(CLIENT_VERSION));
    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;
    const isCurrent = () => active && epoch === authEpoch.current
      && generation === connectionGeneration.current && socketRef.current === socket;

    function expireSynchronization() {
      if (!isCurrent() || synchronized) return;
      setConnected(false);
      setSubmitting(false);
      eventStateRef.current = emptyActionEventState();
      setEventState(eventStateRef.current);
      socket.close(4000, "snapshot timeout");
    }

    synchronizationTimer = setTimeout(expireSynchronization, 5000);
    socket.onclose = (event) => {
      if (!isCurrent()) return;
      clearTimeout(synchronizationTimer);
      connectionGeneration.current += 1;
      socketRef.current = null;
      setConnected(false);
      setConnectionFailed(event.code !== 4401);
      setSubmitting(false);
      eventStateRef.current = emptyActionEventState();
      setEventState(eventStateRef.current);
      if (event.code === 4401) {
        authEpoch.current += 1;
        setReconnecting(false);
        setAuthenticated(false);
        setError("The host session expired or was revoked.");
      } else if (event.code === 4406) {
        setError(compatibilityMessage);
      } else if (event.code === 1002) {
        setError("The host sent an invalid live update. Reconnect to try again.");
      } else {
        setError("Live updates disconnected. Reconnect to continue.");
      }
    };
    socket.onerror = () => {
      if (isCurrent()) setConnected(false);
    };
    socket.onmessage = (message) => {
      if (!isCurrent()) return;
      let input: unknown;
      try {
        input = JSON.parse(String(message.data));
      } catch {
        setConnected(false);
        setConnectionFailed(true);
        setSubmitting(false);
        eventStateRef.current = emptyActionEventState();
        setEventState(eventStateRef.current);
        setError("The host sent an invalid live update.");
        socket.close(4002, "invalid event");
        return;
      }
      const result = applyActionEvent(eventStateRef.current, input);
      if (!result.validMessage) {
        setConnected(false);
        setConnectionFailed(true);
        setSubmitting(false);
        eventStateRef.current = emptyActionEventState();
        setEventState(eventStateRef.current);
        setError("The host sent an invalid live update.");
        socket.close(4002, "invalid event");
        return;
      }
      if (result.snapshotApplied) {
        synchronized = true;
        clearTimeout(synchronizationTimer);
        setConnected(true);
        setConnectionFailed(false);
        setError("");
      }
      if (result.state !== eventStateRef.current) {
        eventStateRef.current = result.state;
        setEventState(result.state);
      }
      if (result.requestSnapshot) {
        synchronized = false;
        setConnected(false);
        eventStateRef.current = { ...result.state, actions: [] };
        setEventState(eventStateRef.current);
        clearTimeout(synchronizationTimer);
        synchronizationTimer = setTimeout(expireSynchronization, 5000);
        socket.send(JSON.stringify({ type: "sync" }));
      }
    };

    return () => {
      active = false;
      clearTimeout(synchronizationTimer);
      if (generation === connectionGeneration.current) connectionGeneration.current += 1;
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
  }, [api, authenticated, connectionAttempt]);

  async function signIn() {
    const epoch = ++authEpoch.current;
    setError("");
    const { data, error: requestError } = await api.api.auth.login.post({ password });
    if (epoch !== authEpoch.current) return;
    if (requestError || !data || "error" in data) {
      setError(requestErrorMessage(requestError, "The host did not accept this passphrase. Check the host configuration and try again."));
      return;
    }
    setPassword("");
    setAuthenticated(true);
  }

  async function signOut() {
    const epoch = ++authEpoch.current;
    connectionGeneration.current += 1;
    socketRef.current?.close();
    socketRef.current = null;
    setAuthenticated(false);
    setConnected(false);
    setConnectionFailed(false);
    setReconnecting(false);
    setSubmitting(false);
    eventStateRef.current = emptyActionEventState();
    setEventState(eventStateRef.current);
    const { error: requestError } = await api.api.auth.logout.post();
    if (epoch !== authEpoch.current) return;
    if (requestError) setError("The host could not confirm logout.");
  }

  async function reconnectLiveUpdates() {
    if (reconnecting || connected) return;
    setReconnecting(true);
    const epoch = authEpoch.current;
    const { data, error: requestError } = await api.api.auth.session.get();
    if (epoch !== authEpoch.current) return;
    setReconnecting(false);
    if (requestError || !data || "error" in data) {
      authEpoch.current += 1;
      setAuthenticated(false);
      setConnectionFailed(false);
      eventStateRef.current = emptyActionEventState();
      setEventState(eventStateRef.current);
      setError(requestErrorMessage(requestError, "The host session expired or was revoked."));
      return;
    }
    setConnectionFailed(false);
    setError("");
    setConnectionAttempt((attempt) => attempt + 1);
  }

  async function recordAction() {
    const value = action.trim();
    if (!value || submitting) return;
    const epoch = authEpoch.current;
    const generation = connectionGeneration.current;
    setSubmitting(true);
    setError("");
    const { data, error: requestError } = await api.api.actions.post({ action: value });
    if (epoch !== authEpoch.current || generation !== connectionGeneration.current) return;
    if (requestError || !data || "error" in data) {
      setError(requestErrorMessage(requestError, "The backend did not confirm this action."));
    } else if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "sync" }));
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
            {connected ? "Live updates connected" : connectionFailed ? "Live updates disconnected" : "Synchronizing with Linux backend…"}
          </Text>
          {connectionFailed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: reconnecting }}
              disabled={reconnecting}
              onPress={() => void reconnectLiveUpdates()}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{reconnecting ? "Checking session…" : "Reconnect live updates"}</Text>
            </Pressable>
          ) : null}
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
