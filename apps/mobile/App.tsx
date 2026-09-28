import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { actionReceiptFromResponse, isDefinitiveActionRejection, applyActionEvent, CLIENT_VERSION, createApiClient, emptyActionEventState, type ActionEventState } from "@remotecode/client";
import { getMobileHealth } from "./src/features/health/api";

const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? "http://127.0.0.1:3000";
const clientOrigin = process.env.EXPO_PUBLIC_CLIENT_ORIGIN ?? "http://localhost:5173";
const compatibilityMessage = "This RemoteCode client version is not supported. Update the host or use a supported client version.";

type PendingAuth = { kind: "login" | "logout"; requestId: string }
  | { kind: "revoke_login"; requestId: string; loginRequestId: string };
const authStorageKey = `remotecode.pending-auth:${apiOrigin}`;

function authReceiptMatches(value: unknown, pending: PendingAuth) {
  if (!value || typeof value !== "object" || !("requestId" in value) || !("kind" in value) || !("outcome" in value)) return false;
  if (value.requestId !== pending.requestId || value.kind !== pending.kind) return false;
  return pending.kind === "logout" ? value.outcome === "sessions_revoked"
    : pending.kind === "revoke_login" && value.outcome === "login_revoked"
      && "targetRequestId" in value && value.targetRequestId === pending.loginRequestId;
}

function isCredentialRejection(response: { status: number; error: unknown }) {
  const error = response.error;
  if (response.status !== 401 || !error || typeof error !== "object" || !("value" in error)) return false;
  const value = error.value;
  return typeof value === "object" && value !== null && "error" in value && value.error === "unauthorized";
}

type Connection = "signed_out" | "connecting" | "connected" | "disconnected" | "incompatible";

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    if (error.status === 426) return compatibilityMessage;
    if (error.status === 401) return "Sign in failed. Check the host password.";
  }
  return "The host could not confirm this request. Check the receipt before trying again.";
}

function HostReadiness() {
  const [readiness, setReadiness] = useState<"ready" | "not_ready" | "unknown">("unknown");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await getMobileHealth(apiOrigin);
        if (active) setReadiness(result ?? "unknown");
      } catch {
        if (active) setReadiness("unknown");
      }
      if (active) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return <Text accessibilityLiveRegion="polite" testID="host-readiness" style={readiness === "not_ready" ? styles.error : styles.status}>
    {readiness === "ready" ? "Host ready" : readiness === "not_ready" ? "Host not ready" : "Host readiness unavailable"}
  </Text>;
}

export default function App() {
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const authPending = useRef<PendingAuth | null>(null);
  const authLock = useRef(false);
  const [password, setPassword] = useState("");
  const [action, setAction] = useState("");
  const [connection, setConnection] = useState<Connection>("signed_out");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<ActionEventState>(emptyActionEventState);
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const actionLock = useRef(false);
  const storageQueue = useRef(Promise.resolve());
  const socket = useRef<WebSocket | null>(null);
  const syncTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationGeneration = useRef(0);
  const eventState = useRef(emptyActionEventState());

  useEffect(() => {
    let active = true;
    void withPendingStorage(async () => {
      const raw = await AsyncStorage.getItem(authStorageKey);
      let pending: PendingAuth | null = null;
      if (raw) {
        const value = JSON.parse(raw);
        if (!value || !["login", "logout", "revoke_login"].includes(value.kind)
          || typeof value.requestId !== "string" || !validatePendingId(value.requestId)
          || (value.kind === "revoke_login" && (typeof value.loginRequestId !== "string" || !validatePendingId(value.loginRequestId)))) {
          throw new Error("Invalid auth identity");
        }
        pending = value;
      }
      if (!active) return;
      authPending.current = pending;
      setPendingAuth(pending);
      setAuthReady(true);
      if (pending) {
        setConnection("disconnected");
        setAuthMessage("An earlier auth outcome is unknown. Check its receipt; no request will be resent.");
      }
    }).catch(() => { if (active) setAuthMessage("Device storage could not recover the auth identity. Sending is disabled. Restart to check again."); });
    return () => { active = false; operationGeneration.current++; };
  }, []);

  useEffect(() => () => {
    if (syncTimeout.current) clearTimeout(syncTimeout.current);
    socket.current?.close();
  }, []);

  function withPendingStorage<T>(work: () => Promise<T>): Promise<T> {
    const result = storageQueue.current.then(work);
    storageQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }

  function validatePendingId(value: string | null) {
    if (value !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error("Invalid persisted request identity");
    }
    return value;
  }

  function clearRecoveryView() {
    actionLock.current = false;
    setPendingKey(null);
    setPendingRequestId(null);
    setStorageReady(false);
    setRecoveryMessage("");
  }

  async function forgetPending(key: string, requestId: string) {
    return withPendingStorage(async () => {
      if (await AsyncStorage.getItem(key) !== requestId) return false;
      await AsyncStorage.removeItem(key);
      return await AsyncStorage.getItem(key) === null;
    }).catch(() => false);
  }

  async function saveAuth(pending: PendingAuth, previous: PendingAuth | null, generation: number) {
    await withPendingStorage(async () => {
      if (generation !== operationGeneration.current) throw new Error("Stale auth operation");
      const expected = previous ? JSON.stringify(previous) : null;
      if (await AsyncStorage.getItem(authStorageKey) !== expected) throw new Error("Auth storage changed");
      const raw = JSON.stringify(pending);
      await AsyncStorage.setItem(authStorageKey, raw);
      if (await AsyncStorage.getItem(authStorageKey) !== raw) throw new Error("Auth identity was not retained");
    }).catch((cause) => {
      if (generation === operationGeneration.current) setAuthReady(false);
      throw cause;
    });
    if (generation !== operationGeneration.current) return false;
    authPending.current = pending;
    setPendingAuth(pending);
    return true;
  }

  async function finishAuth(pending: PendingAuth, generation: number) {
    const cleared = await forgetPending(authStorageKey, JSON.stringify(pending));
    if (generation !== operationGeneration.current) return false;
    if (!cleared) {
      setAuthMessage("The host confirmed the result, but device storage could not clear its identity. Check again.");
      return false;
    }
    authPending.current = null;
    setPendingAuth(null);
    return true;
  }

  async function runAuth(work: (generation: number) => Promise<void>) {
    if (authLock.current || !authReady) return;
    authLock.current = true;
    const generation = ++operationGeneration.current;
    setBusy(true);
    setError("");
    setAuthMessage("");
    try { await work(generation); }
    catch {
      if (generation === operationGeneration.current) {
        setAuthMessage("The auth outcome is unknown. Check the receipt before another attempt. If device storage is unavailable, restart to check again.");
      }
    } finally {
      authLock.current = false;
      if (generation === operationGeneration.current) setBusy(false);
    }
  }

  async function supportsAuthRecovery(generation: number) {
    const response = await createApiClient(apiOrigin).api.version.get();
    if (generation !== operationGeneration.current) return false;
    if (response.error || !response.data?.capabilities.includes("auth-request-recovery-v1")) {
      setAuthMessage("Update the host to support auth receipt recovery. No auth request was sent.");
      return false;
    }
    return true;
  }

  async function confirmLogin(pending: PendingAuth, generation: number) {
    const { data: session, error: sessionError } = await createApiClient(apiOrigin).api.auth.session.get();
    if (generation !== operationGeneration.current) return false;
    if (pending.kind !== "login" || sessionError || !session || !("userId" in session)
      || typeof session.userId !== "string" || !("loginRequestId" in session) || session.loginRequestId !== pending.requestId) return false;
    if (!await finishAuth(pending, generation)) return true;
    setPassword("");
    setAuthMessage("");
    await establishSession(session.userId, generation);
    return true;
  }

  async function connect() {
    if (!password || authPending.current || busy) return;
    await runAuth(async (generation) => {
      if (!await supportsAuthRecovery(generation)) return;
      const pending: PendingAuth = { kind: "login", requestId: randomUUID() };
      if (!await saveAuth(pending, null, generation)) return;
      clearRecoveryView();
      setConnection("disconnected");
      const response = await createApiClient(apiOrigin).api.auth.login.post({ password, requestId: pending.requestId });
      if (generation !== operationGeneration.current) return;
      if (isCredentialRejection(response)) {
        if (await finishAuth(pending, generation)) setAuthMessage("Sign in failed. Check the host password. No session was created.");
        return;
      }
      if (!await confirmLogin(pending, generation) && generation === operationGeneration.current) {
        setAuthMessage("The login outcome is unknown. Check the receipt or explicitly revoke the old login before another attempt.");
      }
    });
  }

  async function checkAuthReceipt() {
    const pending = authPending.current;
    if (!pending || busy) return;
    await runAuth(async (generation) => {
      if (pending.kind === "login" && await confirmLogin(pending, generation)) return;
      if (generation !== operationGeneration.current) return;
      const response = await createApiClient(apiOrigin).api.auth.receipts({ requestId: pending.requestId }).lookup.post(password ? { password } : {});
      if (generation !== operationGeneration.current) return;
      const receipt = response.data && "receipt" in response.data ? response.data.receipt : null;
      if (authReceiptMatches(receipt, pending)) {
        if (await finishAuth(pending, generation)) {
          setConnection("signed_out");
          setAuthMessage(pending.kind === "logout" ? "Sign-out confirmed. You may start a new login." : "Old login revocation confirmed. You may start a distinct new login.");
        }
      } else if (pending.kind === "login" && receipt?.requestId === pending.requestId && receipt.kind === "login") {
        setAuthMessage("The login receipt is confirmed, but a matching cookie is not confirmed on this device. Explicitly revoke the old login before a new attempt.");
      } else {
        setAuthMessage(response.status === 404
          ? "No auth receipt is confirmed yet. The outcome is unknown; an old login can be explicitly revoked and fenced."
          : "The host could not check the auth receipt. Enter the host password and check again; the outcome remains unknown.");
      }
    });
  }

  async function revokeOldLogin() {
    const previous = authPending.current;
    if (!previous || previous.kind !== "login" || !password || busy) return;
    await runAuth(async (generation) => {
      if (!await supportsAuthRecovery(generation)) return;
      const pending: PendingAuth = { kind: "revoke_login", requestId: randomUUID(), loginRequestId: previous.requestId };
      if (!await saveAuth(pending, previous, generation)) return;
      const response = await createApiClient(apiOrigin).api.auth.login({ loginRequestId: previous.requestId }).revoke.post({ password, requestId: pending.requestId });
      if (generation !== operationGeneration.current) return;
      if (isCredentialRejection(response)) {
        if (await saveAuth(previous, pending, generation)) setAuthMessage("Revocation was rejected. Check the host password; the old login still needs recovery.");
      } else if (!response.error && authReceiptMatches(response.data, pending)) {
        if (await finishAuth(pending, generation)) setAuthMessage("Old login revocation confirmed. You may start a distinct new login.");
      } else setAuthMessage("The revocation outcome is unknown. Check its receipt; do not resend it.");
    });
  }

  async function establishSession(userId: string, generation: number) {
    try {
      const key = `remotecode.pending-action:${JSON.stringify([apiOrigin, userId])}`;
      const pending = await withPendingStorage(async () => validatePendingId(await AsyncStorage.getItem(key)));
      if (generation !== operationGeneration.current) return;
      setPendingKey(key);
      setPendingRequestId(pending);
      setStorageReady(true);

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
        setRecoveryMessage("");
        setConnection("disconnected");
        setError("Could not connect to the host event stream. Reconnect to try again.");
        ws.close();
      };
      ws.onclose = (event) => {
        if (socket.current !== ws || generation !== operationGeneration.current) return;
        socket.current = null;
        if (syncTimeout.current) clearTimeout(syncTimeout.current);
        setRecoveryMessage("");
        if (event.code === 4401) {
          operationGeneration.current += 1;
          eventState.current = emptyActionEventState();
          setEvents(eventState.current);
          setPassword("");
          setAction("");
          setBusy(false);
          clearRecoveryView();
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
    if (connection !== "connected" || eventState.current.needsSnapshot || !action.trim() || busy
      || actionLock.current || pendingRequestId || !pendingKey || !storageReady) return;
    const generation = operationGeneration.current;
    const activeSocket = socket.current;
    const isCurrent = () => generation === operationGeneration.current && socket.current === activeSocket;
    const key = pendingKey;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setRecoveryMessage("");
    let sent = false;
    try {
      const client = createApiClient(apiOrigin);
      const version = await client.api.version.get();
      if (!isCurrent()) return;
      if (version.error || !version.data?.capabilities.includes("action-request-recovery-v1")) {
        setRecoveryMessage("Update the host to support action receipt recovery. No action was sent.");
        return;
      }
      const prepared = await withPendingStorage(async () => {
        const existing = validatePendingId(await AsyncStorage.getItem(key));
        if (existing) return { requestId: existing, send: false };
        if (!isCurrent()) return null;
        const requestId = randomUUID();
        await AsyncStorage.setItem(key, requestId);
        if (await AsyncStorage.getItem(key) !== requestId) throw new Error("Pending identity was not retained");
        if (!isCurrent()) {
          await AsyncStorage.removeItem(key);
          return null;
        }
        return { requestId, send: true };
      });
      if (!isCurrent() || !prepared) return;
      setPendingRequestId(prepared.requestId);
      if (!prepared.send) {
        setRecoveryMessage("An earlier outcome is unknown. Check its receipt before sending another action.");
        return;
      }
      sent = true;
      const response = await client.api.actions.post({ action: action.trim(), requestId: prepared.requestId });
      if (!isCurrent()) return;
      const receipt = actionReceiptFromResponse(response);
      if (receipt || isDefinitiveActionRejection(response)) {
        const cleared = await forgetPending(key, prepared.requestId);
        if (!isCurrent()) return;
        if (cleared) setPendingRequestId(null);
        if (receipt) {
          setAction("");
          const next = { ...eventState.current, actions: [receipt, ...eventState.current.actions.filter((item) => item.id !== receipt.id)] };
          eventState.current = next;
          setEvents(next);
          setRecoveryMessage(cleared ? "" : `Confirmed receipt ${receipt.id}. Device storage could not clear the pending identity; check again.`);
        } else {
          setError(errorMessage(response.error));
          if (!cleared) setRecoveryMessage("The host rejected the action, but device storage could not clear its identity. Sending remains disabled.");
        }
      } else {
        setRecoveryMessage("The outcome is unknown. Check the action receipt before sending another action.");
      }
    } catch {
      if (isCurrent()) {
        if (!sent) setStorageReady(false);
        setRecoveryMessage(sent
          ? "The outcome is unknown. Check the action receipt before sending another action."
          : "The action could not be prepared safely. No action was sent. Sign out and sign in again to check the host and device storage.");
      }
    } finally {
      if (generation === operationGeneration.current) {
        actionLock.current = false;
        setBusy(false);
      }
    }
  }

  async function checkActionReceipt() {
    if (connection !== "connected" || eventState.current.needsSnapshot || busy || actionLock.current || !pendingKey || !pendingRequestId) return;
    const generation = operationGeneration.current;
    const activeSocket = socket.current;
    const isCurrent = () => generation === operationGeneration.current && socket.current === activeSocket;
    const key = pendingKey;
    const requestId = pendingRequestId;
    actionLock.current = true;
    setBusy(true);
    setRecoveryMessage("");
    try {
      const response = await createApiClient(apiOrigin).api.actions.receipts({ requestId }).get();
      if (!isCurrent()) return;
      const receipt = actionReceiptFromResponse(response);
      if (receipt) {
        const cleared = await forgetPending(key, requestId);
        if (!isCurrent()) return;
        if (cleared) setPendingRequestId(null);
        const next = { ...eventState.current, actions: [receipt, ...eventState.current.actions.filter((item) => item.id !== receipt.id)] };
        eventState.current = next;
        setEvents(next);
        setRecoveryMessage(`Confirmed receipt ${receipt.id}.${cleared ? "" : " Device storage could not clear the pending identity; check again."}`);
      } else if (response.status === 401) {
        operationGeneration.current += 1;
        socket.current = null;
        activeSocket?.close();
        if (syncTimeout.current) clearTimeout(syncTimeout.current);
        eventState.current = emptyActionEventState();
        setEvents(eventState.current);
        clearRecoveryView();
        setPassword("");
        setAction("");
        setBusy(false);
        setConnection("signed_out");
        setError("The host session expired or was revoked. Sign in again.");
      } else {
        setRecoveryMessage(response.status === 404
          ? "No receipt is confirmed yet. The outcome is still unknown; check again later without resending."
          : "The host could not check the receipt. The outcome is still unknown.");
      }
    } catch {
      if (isCurrent()) setRecoveryMessage("The host could not check the receipt. The outcome is still unknown.");
    } finally {
      if (generation === operationGeneration.current) {
        actionLock.current = false;
        setBusy(false);
      }
    }
  }

  async function signOut() {
    if (authPending.current) return;
    await runAuth(async (generation) => {
      const activeSocket = socket.current;
      socket.current = null;
      activeSocket?.close();
      if (syncTimeout.current) clearTimeout(syncTimeout.current);
      eventState.current = emptyActionEventState();
      setEvents(eventState.current);
      setConnection("disconnected");
      clearRecoveryView();
      setPassword("");
      setAction("");
      if (!await supportsAuthRecovery(generation)) return;
      const pending: PendingAuth = { kind: "logout", requestId: randomUUID() };
      if (!await saveAuth(pending, null, generation)) return;
      const response = await createApiClient(apiOrigin).api.auth.logout.post({ requestId: pending.requestId });
      if (generation !== operationGeneration.current) return;
      if (!response.error && authReceiptMatches(response.data, pending)) {
        if (await finishAuth(pending, generation)) {
          setConnection("signed_out");
          setAuthMessage("Sign-out confirmed.");
        }
      } else setAuthMessage("Disconnected on this device. The logout outcome is unknown; the host session may still be active. Check its receipt.");
    });
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.page}>
          <Text accessibilityRole="header" style={styles.title}>RemoteCode mobile</Text>
          <Text style={styles.endpoint}>Host: {apiOrigin}</Text>
          <HostReadiness />
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>Host connection</Text>
            <Text accessibilityLiveRegion="polite" testID="connection-status" style={styles.status}>{connection.replace("_", " ")}</Text>
            {connection === "signed_out" || connection === "disconnected" || connection === "incompatible" ? <>
              <TextInput accessibilityLabel="Host password" autoCapitalize="none" secureTextEntry value={password} onChangeText={setPassword} placeholder="Host password" style={styles.input} />
              <Pressable accessibilityRole="button" accessibilityLabel="Sign in to host" accessibilityState={{ disabled: busy || !password || !authReady || Boolean(pendingAuth) }} disabled={busy || !password || !authReady || Boolean(pendingAuth)} onPress={() => void connect()} style={styles.button}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in to host</Text>}
              </Pressable>
            </> : null}
            {pendingAuth ? <View style={styles.recovery}>
              <Text style={styles.muted}>An auth request is awaiting confirmation. Checking does not resend it.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Check auth receipt" accessibilityState={{ disabled: busy || !authReady }} disabled={busy || !authReady} onPress={() => void checkAuthReceipt()} style={styles.button}>
                <Text style={styles.buttonText}>Check auth receipt</Text>
              </Pressable>
              {pendingAuth.kind === "login" ? <Pressable accessibilityRole="button" accessibilityLabel="Revoke old login" accessibilityState={{ disabled: busy || !password || !authReady }} disabled={busy || !password || !authReady} onPress={() => void revokeOldLogin()} style={styles.secondaryButton}>
                <Text style={styles.secondaryText}>Revoke old login</Text>
              </Pressable> : null}
            </View> : null}
            {authMessage ? <Text accessibilityLiveRegion="polite" testID="auth-recovery-status" style={styles.muted}>{authMessage}</Text> : null}
            {connection === "connected" ? <>
              <TextInput accessibilityLabel="Action" value={action} onChangeText={setAction} autoCorrect={false} placeholder="Send an action" maxLength={120} style={styles.input} />
              <Pressable accessibilityRole="button" accessibilityLabel="Submit action" accessibilityState={{ disabled: busy || !action.trim() || Boolean(pendingRequestId) || !storageReady }} disabled={busy || !action.trim() || Boolean(pendingRequestId) || !storageReady} onPress={() => void submitAction()} style={[styles.button, (busy || !action.trim() || Boolean(pendingRequestId) || !storageReady) && styles.disabled]}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Submit action</Text>}
              </Pressable>
            </> : null}
            {connection === "connected" && pendingRequestId ? <View style={styles.recovery}>
              <Text style={styles.muted}>An action is awaiting confirmation. Checking its receipt will not resend it.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Check action receipt" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void checkActionReceipt()} style={[styles.button, busy && styles.disabled]}>
                <Text style={styles.buttonText}>Check action receipt</Text>
              </Pressable>
            </View> : null}
            {connection === "connected" && recoveryMessage ? <Text accessibilityLiveRegion="polite" testID="action-recovery-status" style={styles.muted}>{recoveryMessage}</Text> : null}
            {connection !== "signed_out" && !pendingAuth ? <Pressable accessibilityRole="button" accessibilityLabel="Sign out" disabled={busy && connection !== "connected"} onPress={() => void signOut()} style={styles.secondaryButton}><Text style={styles.secondaryText}>Sign out</Text></Pressable> : null}
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
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f4f7f5" },
  disabled: { opacity: 0.5 },
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
  recovery: { gap: 12 },
  muted: { color: "#50696b", fontSize: 12 },
  receipt: { borderTopColor: "#e3ebe7", borderTopWidth: 1, gap: 5, paddingTop: 12 },
  actionText: { color: "#183337", fontSize: 15, fontWeight: "600" },
});
