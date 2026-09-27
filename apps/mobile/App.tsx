import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { applyActionEvent, CLIENT_VERSION, createApiClient, emptyActionEventState, type ActionEventState } from "@remotecode/client";

const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? "http://127.0.0.1:3000";
const clientOrigin = process.env.EXPO_PUBLIC_CLIENT_ORIGIN ?? "http://localhost:5173";
const compatibilityMessage = "This RemoteCode client version is not supported. Update the host or use a supported client version.";

type Connection = "signed_out" | "connecting" | "connected" | "disconnected" | "incompatible";

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    if (error.status === 426) return compatibilityMessage;
    if (error.status === 401) return "Sign in failed. Check the host password.";
  }
  return "The host could not confirm this request. Check the receipt before trying again.";
}

export default function App() {
  const [password, setPassword] = useState("");
  const [action, setAction] = useState("");
  const [connection, setConnection] = useState<Connection>("signed_out");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<ActionEventState>(emptyActionEventState);
  const [busy, setBusy] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const syncTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationGeneration = useRef(0);
  const eventState = useRef(emptyActionEventState());

  useEffect(() => () => {
    if (syncTimeout.current) clearTimeout(syncTimeout.current);
    socket.current?.close();
  }, []);

  async function connect() {
    const generation = ++operationGeneration.current;
    setBusy(true);
    setError("");
    try {
      const client = createApiClient(apiOrigin);
      const { error: loginError } = await client.api.auth.login.post({ password });
      if (loginError) throw loginError;
      if (generation !== operationGeneration.current) return;
      const { error: sessionError } = await client.api.auth.session.get();
      if (sessionError) throw sessionError;
      if (generation !== operationGeneration.current) return;

      eventState.current = emptyActionEventState();
      setEvents(eventState.current);
      setConnection("connecting");
      const endpoint = new URL("/api/events", apiOrigin);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.searchParams.set("clientVersion", String(CLIENT_VERSION));
      const NativeWebSocket = WebSocket as unknown as new (
        url: string,
        protocols: string[],
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const ws = new NativeWebSocket(endpoint.toString(), [], { headers: { Origin: clientOrigin } });
      socket.current?.close();
      socket.current = ws;
      syncTimeout.current = setTimeout(() => {
        if (socket.current !== ws || generation !== operationGeneration.current) return;
        socket.current = null;
        ws.close();
        setConnection("disconnected");
        setError("The host did not send a current snapshot. Reconnect before continuing.");
      }, 5000);
      ws.onmessage = (message) => {
        if (socket.current !== ws || generation !== operationGeneration.current) return;
        try {
          const parsed: unknown = JSON.parse(String(message.data));
          const result = applyActionEvent(eventState.current, parsed);
          if (!result.validMessage) throw new Error("Invalid host event");
          eventState.current = result.state;
          setEvents(result.state);
          if (result.requestSnapshot) {
            setConnection("connecting");
            setError("The event stream has a gap. Waiting for a current snapshot.");
            if (syncTimeout.current) clearTimeout(syncTimeout.current);
            syncTimeout.current = setTimeout(() => {
              if (socket.current !== ws || generation !== operationGeneration.current) return;
              socket.current = null;
              ws.close();
              setConnection("disconnected");
              setError("The host did not repair the event snapshot. Reconnect before continuing.");
            }, 5000);
            ws.send(JSON.stringify({ type: "sync" }));
          } else if (result.snapshotApplied && !result.state.needsSnapshot) {
            if (syncTimeout.current) clearTimeout(syncTimeout.current);
            setConnection("connected");
            setError("");
          } else if (!result.state.needsSnapshot && connection === "connected") {
            setError("");
          }
        } catch {
          if (syncTimeout.current) clearTimeout(syncTimeout.current);
          socket.current = null;
          eventState.current = emptyActionEventState();
          setEvents(eventState.current);
          ws.close();
          setConnection("disconnected");
          setError("The host sent an unreadable event. Reconnect before continuing.");
        }
      };
      ws.onerror = () => {
        if (socket.current !== ws || generation !== operationGeneration.current) return;
        socket.current = null;
        if (syncTimeout.current) clearTimeout(syncTimeout.current);
        setConnection("disconnected");
        setError("Could not connect to the host event stream. Reconnect to try again.");
        ws.close();
      };
      ws.onclose = (event) => {
        if (socket.current !== ws || generation !== operationGeneration.current) return;
        socket.current = null;
        if (syncTimeout.current) clearTimeout(syncTimeout.current);
        if (event.code === 4401) {
          operationGeneration.current += 1;
          eventState.current = emptyActionEventState();
          setEvents(eventState.current);
          setPassword("");
          setAction("");
          setBusy(false);
          setConnection("signed_out");
          setError("The host session expired or was revoked. Sign in again.");
        } else {
          setConnection(event.code === 4406 ? "incompatible" : "disconnected");
          if (event.code === 4406) setError(compatibilityMessage);
        }
      };
    } catch (cause) {
      if (generation === operationGeneration.current) {
        eventState.current = emptyActionEventState();
        setEvents(eventState.current);
        setAction("");
        setConnection("disconnected");
        setError(errorMessage(cause));
      }
    } finally {
      if (generation === operationGeneration.current) setBusy(false);
    }
  }

  async function submitAction() {
    if (connection !== "connected" || eventState.current.needsSnapshot || !action.trim() || busy) return;
    const generation = operationGeneration.current;
    setBusy(true);
    setError("");
    try {
      const { data, error: requestError } = await createApiClient(apiOrigin).api.actions.post({ action: action.trim() });
      if (requestError) throw requestError;
      if (!data || "error" in data) throw new Error("Missing action receipt");
      if (generation !== operationGeneration.current) return;
      setAction("");
      const createdAt: unknown = data.createdAt;
      const receipt = { ...data, createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt) };
      const next = { ...eventState.current, actions: [receipt, ...eventState.current.actions.filter((item) => item.id !== receipt.id)] };
      eventState.current = next;
      setEvents(next);
    } catch (cause) {
      if (generation === operationGeneration.current) setError(errorMessage(cause));
    } finally {
      if (generation === operationGeneration.current) setBusy(false);
    }
  }

  async function signOut() {
    const generation = ++operationGeneration.current;
    setBusy(true);
    const activeSocket = socket.current;
    socket.current = null;
    activeSocket?.close();
    if (syncTimeout.current) clearTimeout(syncTimeout.current);
    eventState.current = emptyActionEventState();
    setEvents(eventState.current);
    setConnection("signed_out");
    setPassword("");
    setAction("");
    setError("");
    try {
      const { error: logoutError } = await createApiClient(apiOrigin).api.auth.logout.post();
      if (logoutError) throw logoutError;
    } catch {
      if (generation === operationGeneration.current) {
        setError("Disconnected on this device. The host could not confirm logout; its session may still be active.");
      }
    } finally {
      if (generation === operationGeneration.current) setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>RemoteCode mobile</Text>
      <Text style={styles.endpoint}>Host: {apiOrigin}</Text>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.heading}>Host connection</Text>
        <Text accessibilityLiveRegion="polite" testID="connection-status" style={styles.status}>{connection.replace("_", " ")}</Text>
        {connection === "signed_out" || connection === "disconnected" || connection === "incompatible" ? <>
          <TextInput accessibilityLabel="Host password" autoCapitalize="none" secureTextEntry value={password} onChangeText={setPassword} placeholder="Host password" style={styles.input} />
          <Pressable accessibilityRole="button" accessibilityLabel="Sign in to host" disabled={busy || !password} onPress={() => void connect()} style={styles.button}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in to host</Text>}
          </Pressable>
        </> : null}
        {connection === "connected" ? <>
          <TextInput accessibilityLabel="Action" value={action} onChangeText={setAction} placeholder="Send an action" maxLength={120} style={styles.input} />
          <Pressable accessibilityRole="button" accessibilityLabel="Submit action" disabled={busy || !action.trim()} onPress={() => void submitAction()} style={styles.button}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Submit action</Text>}
          </Pressable>
        </> : null}
        {connection !== "signed_out" ? <Pressable accessibilityRole="button" accessibilityLabel="Sign out" disabled={busy && connection !== "connected"} onPress={() => void signOut()} style={styles.secondaryButton}><Text style={styles.secondaryText}>Sign out</Text></Pressable> : null}
        {error ? <Text accessibilityRole="alert" testID="connection-error" style={styles.error}>{error}</Text> : null}
      </View>
      {connection === "connected" ? <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.heading}>Confirmed receipts</Text>
        {events.actions.length === 0 ? <Text style={styles.muted}>No confirmed actions yet.</Text> : events.actions.map((receipt) => (
          <View key={receipt.id} style={styles.receipt}>
            <Text style={styles.actionText}>{receipt.action}</Text>
            <Text style={styles.muted}>Receipt {receipt.id}</Text>
            <Text style={styles.muted}>{String(receipt.createdAt)}</Text>
          </View>
        ))}
      </View> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, gap: 16, justifyContent: "center", padding: 24, backgroundColor: "#f4f7f5" },
  title: { color: "#183337", fontSize: 28, fontWeight: "700" },
  endpoint: { color: "#50696b", fontSize: 14, marginBottom: 4 },
  card: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 16, borderWidth: 1, gap: 14, padding: 20 },
  heading: { color: "#183337", fontSize: 18, fontWeight: "700" },
  status: { color: "#126b54", fontSize: 15, fontWeight: "600" },
  input: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, color: "#183337", minHeight: 46, paddingHorizontal: 12 },
  button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 10, justifyContent: "center", minHeight: 46, paddingHorizontal: 16 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  secondaryButton: { alignItems: "center", minHeight: 42, justifyContent: "center" },
  secondaryText: { color: "#126b54", fontWeight: "700" },
  error: { color: "#9c3026", fontSize: 14 },
  muted: { color: "#50696b", fontSize: 12 },
  receipt: { borderTopColor: "#e3ebe7", borderTopWidth: 1, gap: 5, paddingTop: 12 },
  actionText: { color: "#183337", fontSize: 15, fontWeight: "600" },
});
