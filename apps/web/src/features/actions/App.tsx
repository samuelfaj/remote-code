import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native-web";
import { actionReceiptFromResponse, isDefinitiveActionRejection, applyActionEvent, CLIENT_VERSION, createApiClient, emptyActionEventState } from "@remotecode/client";
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


type PendingAuth = { kind: "login"; requestId: string }
  | { kind: "logout"; requestId: string }
  | { kind: "revoke_login"; requestId: string; targetRequestId: string };
const authStorageKey = "remotecode.pending-auth";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readPendingAuth(): PendingAuth | null {
  const raw = sessionStorage.getItem(authStorageKey);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value.requestId !== "string" || !uuidPattern.test(value.requestId)
    || !["login", "logout", "revoke_login"].includes(value.kind)
    || Object.keys(value).sort().join(",") !== (value.kind === "revoke_login" ? "kind,requestId,targetRequestId" : "kind,requestId")
    || (value.kind === "revoke_login" && (typeof value.targetRequestId !== "string"
      || !uuidPattern.test(value.targetRequestId) || value.targetRequestId === value.requestId))) {
    throw new Error("Invalid pending auth identity");
  }
  return value;
}

function matchesAuthReceipt(value: unknown, operation: PendingAuth) {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return receipt.requestId === operation.requestId && receipt.kind === operation.kind
    && receipt.targetRequestId === (operation.kind === "revoke_login" ? operation.targetRequestId : null)
    && receipt.outcome === ({ login: "session_created", logout: "sessions_revoked", revoke_login: "login_revoked" }[operation.kind]);
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
  const authPostApi = useMemo(() => createApiClient(window.location.origin, { timeoutMs: 6_000 }), []);
  const authReadApi = useMemo(() => createApiClient(window.location.origin, { timeoutMs: 3_500 }), []);
  const actionPostApi = useMemo(() => createApiClient(window.location.origin, { timeoutMs: 6_000 }), []);
  const actionReceiptApi = useMemo(() => createApiClient(window.location.origin, { timeoutMs: 3_500 }), []);
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
  const [actionPhase, setActionPhase] = useState<"sending" | "checking" | null>(null);
  const submitting = actionPhase !== null;
  const [error, setError] = useState("");
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [recoveryStorageReady, setRecoveryStorageReady] = useState(false);
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const pendingAuthRef = useRef<PendingAuth | null>(null);
  const [authStorageReady, setAuthStorageReady] = useState(false);
  const [authCompatible, setAuthCompatible] = useState(false);
  const [authWorking, setAuthWorking] = useState(false);
  const authBusy = useRef(false);
  const [authMessage, setAuthMessage] = useState("");
  const actionBusy = useRef(false);
  const authEpoch = useRef(0);
  const connectionGeneration = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);

  function recoveryKey(userId: string) {
    return `remotecode.pending-action:${userId}`;
  }

  function restoreActionRecovery(userId: string) {
    setSessionUserId(userId);
    setRecoveryMessage("");
    try {
      const requestId = sessionStorage.getItem(recoveryKey(userId));
      if (requestId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new Error("Invalid pending action identity");
      }
      setPendingRequestId(requestId);
      setRecoveryStorageReady(true);
    } catch {
      setPendingRequestId(null);
      setRecoveryStorageReady(false);
      setRecoveryMessage("Browser storage could not restore the pending action. Sending is disabled to avoid a duplicate.");
    }
  }

  function clearActionRecoveryView() {
    actionBusy.current = false;
    setSessionUserId(null);
    setPendingRequestId(null);
    setRecoveryStorageReady(false);
    setRecoveryMessage("");
  }

  function forgetPendingAction(userId: string, requestId: string) {
    try {
      const key = recoveryKey(userId);
      if (sessionStorage.getItem(key) !== requestId) return false;
      sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) !== null) return false;
      setPendingRequestId(null);
      return true;
    } catch {
      return false;
    }
  }

  function persistAuth(operation: PendingAuth | null) {
    try {
      if (JSON.stringify(readPendingAuth()) !== JSON.stringify(pendingAuthRef.current)) throw new Error("Auth identity changed");
      if (operation) sessionStorage.setItem(authStorageKey, JSON.stringify(operation));
      else sessionStorage.removeItem(authStorageKey);
      if (JSON.stringify(readPendingAuth()) !== JSON.stringify(operation)) throw new Error("Auth identity not persisted");
      pendingAuthRef.current = operation;
      setPendingAuth(operation);
      return true;
    } catch {
      setAuthStorageReady(false);
      setAuthMessage("Browser storage could not preserve auth recovery. No further auth operation will be sent; restore storage and reload.");
      return false;
    }
  }

  async function requireAuthRecovery() {
    const { data, error: versionError } = await api.api.version.get();
    const compatible = !versionError && Boolean(data?.capabilities.includes("auth-request-recovery-v1"));
    setAuthCompatible(compatible);
    if (!compatible) setError("This host does not confirm auth-request-recovery-v1. Update the host and reload before signing in or out.");
    return compatible;
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const operation = readPendingAuth();
        pendingAuthRef.current = operation;
        setPendingAuth(operation);
        setAuthStorageReady(true);
        if (operation) setAuthMessage("The auth outcome is unknown. Check its receipt without resending.");
        const { data: version, error: versionError } = await api.api.version.get();
        if (!active) return;
        const compatible = !versionError && Boolean(version?.capabilities.includes("auth-request-recovery-v1"));
        setAuthCompatible(compatible);
        if (!compatible) setError("This host does not confirm auth-request-recovery-v1. Update the host and reload before signing in or out.");
        if (operation) return;
        const { data, error: sessionError } = await api.api.auth.session.get();
        if (!active) return;
        if (!sessionError && data && "userId" in data && typeof data.userId === "string") {
          restoreActionRecovery(data.userId);
          setAuthenticated(true);
        }
        if (isUnsupportedClientVersion(sessionError)) setError(compatibilityMessage);
      } catch {
        if (active) {
          setAuthStorageReady(false);
          setError("The host session or browser recovery storage could not be checked. Reload before sending auth operations.");
        }
      } finally {
        if (active) setCheckingSession(false);
      }
    })();
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
      setActionPhase(null);
      actionBusy.current = false;
      setRecoveryMessage("");
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
      setActionPhase(null);
      actionBusy.current = false;
      setRecoveryMessage("");
      eventStateRef.current = emptyActionEventState();
      setEventState(eventStateRef.current);
      if (event.code === 4401) {
        authEpoch.current += 1;
        setReconnecting(false);
        setAuthenticated(false);
        clearActionRecoveryView();
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
        setActionPhase(null);
        actionBusy.current = false;
        setRecoveryMessage("");
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
        setActionPhase(null);
        actionBusy.current = false;
        setRecoveryMessage("");
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

  function hideSession() {
    connectionGeneration.current += 1;
    socketRef.current?.close();
    socketRef.current = null;
    setAuthenticated(false);
    clearActionRecoveryView();
    setConnected(false);
    setConnectionFailed(false);
    setReconnecting(false);
    setActionPhase(null);
    eventStateRef.current = emptyActionEventState();
    setEventState(eventStateRef.current);
  }

  async function confirmLogin(operation: PendingAuth, epoch: number, deadline = Infinity) {
    const { data, error: sessionError } = await authReadApi.api.auth.session.get();
    if (epoch !== authEpoch.current || Date.now() >= deadline) return false;
    if (!sessionError && data && "loginRequestId" in data && data.loginRequestId === operation.requestId) {
      if (!persistAuth(null)) return false;
      restoreActionRecovery(data.userId);
      setAuthenticated(true);
      setAuthMessage("");
      return true;
    }
    return false;
  }

  async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function consultUncertainLogin(operation: PendingAuth, credential: string, epoch: number, deadline: number) {
    if (epoch !== authEpoch.current || Date.now() >= deadline) return;
    if (await beforeDeadline(confirmLogin(operation, epoch, deadline), deadline)) return;
    if (epoch !== authEpoch.current) return;
    if (Date.now() >= deadline) {
      setAuthMessage("The auth outcome is unknown. Check its receipt later without resending.");
      return;
    }
    try {
      const response = await beforeDeadline(authReadApi.api.auth.receipts({ requestId: operation.requestId }).lookup.post({ password: credential }), deadline);
      if (epoch !== authEpoch.current) return;
      if (!response) {
        setAuthMessage("The auth outcome is unknown. Check its receipt later without resending.");
        return;
      }
      const { data, error: lookupError, status } = response;
      if (!lookupError && data && "receipt" in data && matchesAuthReceipt(data.receipt, operation)) {
        setAuthMessage("Login receipt confirmed, but no matching cookie is confirmed. Enter the host passphrase and explicitly revoke old login before a distinct sign in.");
      } else if (status === 404) {
        setAuthMessage("No auth receipt is confirmed yet. The outcome remains unknown; do not resend. You may explicitly revoke old login to fence it.");
      } else {
        setAuthMessage("The auth outcome is unknown. Check its receipt later without resending.");
      }
    } catch {
      if (epoch === authEpoch.current) setAuthMessage("The auth outcome is unknown. Check its receipt later without resending.");
    }
  }

  async function mutateAuth(kind: PendingAuth["kind"]) {
    if (authBusy.current || !authStorageReady || !authCompatible) return;
    const previous = pendingAuthRef.current;
    if (kind === "revoke_login" ? previous?.kind !== "login" : Boolean(previous)) return;
    if (kind !== "logout" && !password) {
      setError("Enter the host passphrase before sending this auth operation.");
      return;
    }
    authBusy.current = true;
    setAuthWorking(true);
    const epoch = ++authEpoch.current;
    const credential = password;
    setPassword("");
    setError("");
    let loginRecovery: PendingAuth | null = null;
    let loginDeadline = 0;
    try {
      if (!await requireAuthRecovery() || epoch !== authEpoch.current) return;
      const operation: PendingAuth = kind === "revoke_login" && previous
        ? { kind, requestId: crypto.randomUUID(), targetRequestId: previous.requestId }
        : { kind: kind as "login" | "logout", requestId: crypto.randomUUID() };
      if (!persistAuth(operation)) return;
      if (kind === "logout") hideSession();
      setAuthMessage("The auth outcome is unknown until confirmed. No automatic retry will be sent.");
      if (operation.kind === "login") {
        loginRecovery = operation;
        loginDeadline = Date.now() + 13_000;
      }
      const response = operation.kind === "login"
        ? await authPostApi.api.auth.login.post({ password: credential, requestId: operation.requestId })
        : operation.kind === "logout"
          ? await api.api.auth.logout.post({ requestId: operation.requestId })
          : await api.api.auth.login({ loginRequestId: operation.targetRequestId }).revoke.post({ password: credential, requestId: operation.requestId });
      if (epoch !== authEpoch.current) return;
      const { data, error: requestError, status } = response;
      if (operation.kind === "login" && !requestError && data && "receipt" in data && matchesAuthReceipt(data.receipt, operation)) {
        if (!await confirmLogin(operation, epoch) && epoch === authEpoch.current) setAuthMessage("Login receipt received, but no matching cookie is confirmed. Check auth receipt or explicitly revoke old login.");
      } else if (operation.kind !== "login" && !requestError && matchesAuthReceipt(data, operation)) {
        if (persistAuth(null)) setAuthMessage(operation.kind === "logout" ? "Confirmed logout. Newer sessions are not changed by receipt recovery." : "Confirmed old login revoked or fenced. You may now sign in with a distinct request.");
      } else if (operation.kind !== "logout" && [401, 403, 422, 426].includes(status)
        && requestError && typeof requestError.value === "object" && requestError.value !== null
        && "error" in requestError.value && typeof requestError.value.error === "string"
        && ["unauthorized", "https_required", "invalid_auth_request", "unsupported_client_version"].includes(requestError.value.error)) {
        if (persistAuth(previous)) setAuthMessage("The auth request was rejected before acceptance. Check the passphrase and host configuration.");
        setError(requestErrorMessage(requestError, "The host did not accept this passphrase. Check the host configuration and try again."));
      } else if (operation.kind === "login") {
        await consultUncertainLogin(operation, credential, epoch, loginDeadline);
      }
    } catch {
      if (loginRecovery) await consultUncertainLogin(loginRecovery, credential, epoch, loginDeadline);
      else if (epoch === authEpoch.current) setAuthMessage("The auth outcome is unknown. Check its receipt without resending.");
    } finally {
      authBusy.current = false;
      setAuthWorking(false);
    }
  }

  async function checkAuthReceipt() {
    const operation = pendingAuthRef.current;
    if (!operation || authBusy.current || !authStorageReady) return;
    authBusy.current = true;
    setAuthWorking(true);
    const epoch = ++authEpoch.current;
    const credential = password;
    setPassword("");
    setError("");
    try {
      if (!await requireAuthRecovery() || epoch !== authEpoch.current) return;
      if (operation.kind === "login" && await confirmLogin(operation, epoch)) return;
      const { data, error: lookupError, status } = await api.api.auth.receipts({ requestId: operation.requestId }).lookup.post(credential ? { password: credential } : {});
      if (epoch !== authEpoch.current) return;
      if (!lookupError && data && "receipt" in data && matchesAuthReceipt(data.receipt, operation)) {
        if (operation.kind === "login") {
          setAuthMessage("Login receipt confirmed, but no matching cookie is confirmed. Enter the host passphrase and explicitly revoke old login before a distinct sign in.");
        } else if (persistAuth(null)) {
          setAuthMessage(operation.kind === "logout" ? "Confirmed logout. Newer sessions are not changed by receipt recovery." : "Confirmed old login revoked or fenced. You may now sign in with a distinct request.");
        }
      } else {
        setAuthMessage(status === 401 ? "Enter the current host passphrase to check this auth receipt. The outcome remains unknown."
          : status === 404 ? "No auth receipt is confirmed yet. The outcome remains unknown; do not resend. You may explicitly revoke old login to fence it."
            : requestErrorMessage(lookupError, "The auth outcome is unknown. Check its receipt later without resending."));
      }
    } catch {
      setAuthMessage("The auth outcome is unknown. Check its receipt later without resending.");
    } finally {
      authBusy.current = false;
      setAuthWorking(false);
    }
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
      clearActionRecoveryView();
      setConnectionFailed(false);
      eventStateRef.current = emptyActionEventState();
      setEventState(eventStateRef.current);
      setError(requestErrorMessage(requestError, "The host session expired or was revoked."));
      return;
    }
    restoreActionRecovery(data.userId);
    setConnectionFailed(false);
    setError("");
    setConnectionAttempt((attempt) => attempt + 1);
  }

  async function recordAction() {
    const value = action.trim();
    if (!value || actionBusy.current || pendingRequestId || !connected || !sessionUserId || !recoveryStorageReady) return;
    if (value.length > 120) {
      setError("Use at most 120 characters for an action.");
      return;
    }
    const epoch = authEpoch.current;
    const generation = connectionGeneration.current;
    const isCurrent = () => epoch === authEpoch.current && generation === connectionGeneration.current;
    actionBusy.current = true;
    setActionPhase("sending");
    setError("");
    setRecoveryMessage("");
    let requestId: string | undefined;
    let deadline = 0;
    try {
      const version = await api.api.version.get();
      if (!isCurrent()) return;
      if (version.error || !version.data || !Array.isArray(version.data.capabilities)
        || !version.data.capabilities.includes("action-request-recovery-v1")) {
        setError("Update the host to support action receipt recovery. No action was sent.");
        return;
      }
      try {
        const key = recoveryKey(sessionUserId);
        if (sessionStorage.getItem(key) !== null) {
          restoreActionRecovery(sessionUserId);
          return;
        }
        requestId = crypto.randomUUID();
        sessionStorage.setItem(key, requestId);
        if (sessionStorage.getItem(key) !== requestId) throw new Error("Pending identity was not retained");
      } catch {
        setError("Browser storage is unavailable. No action was sent.");
        return;
      }
      setPendingRequestId(requestId);
      deadline = Date.now() + 10_000;
      let postTimer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        actionPostApi.api.actions.post({ action: value, requestId }),
        new Promise<null>((resolve) => { postTimer = setTimeout(() => resolve(null), 6_000); }),
      ]);
      if (postTimer) clearTimeout(postTimer);
      if (!isCurrent()) return;
      const receipt = response && actionReceiptFromResponse(response);
      const requestError = response?.error;
      if (receipt) {
        const cleared = forgetPendingAction(sessionUserId, requestId);
        setRecoveryMessage(cleared ? "" : `Confirmed receipt ${receipt.id}. Browser storage could not clear the pending identity; check the receipt again.`);
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "sync" }));
      } else if (response && isDefinitiveActionRejection(response)) {
        const cleared = forgetPendingAction(sessionUserId, requestId);
        setError(requestErrorMessage(requestError, "The host rejected this action before acceptance."));
        if (!cleared) setRecoveryMessage("Browser storage could not clear the rejected request. Sending remains disabled.");
      } else {
        await consultUncertainAction(requestId, sessionUserId, deadline, isCurrent);
      }
    } catch {
      if (isCurrent()) {
        if (requestId) await consultUncertainAction(requestId, sessionUserId, deadline, isCurrent);
        else setRecoveryMessage("The host could not be checked. No action was sent.");
      }
    } finally {
      if (isCurrent()) {
        actionBusy.current = false;
        setActionPhase(null);
      }
    }
  }

  async function consultUncertainAction(requestId: string, userId: string, deadline: number, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    setActionPhase("checking");
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          actionReceiptApi.api.actions.receipts({ requestId }).get(),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
        ]);
        if (!isCurrent()) return;
        if (response?.status === 401) {
          authEpoch.current += 1;
          hideSession();
          setError("The host session expired or was revoked.");
          return;
        }
        const receipt = response && actionReceiptFromResponse(response);
        if (receipt) {
          const cleared = forgetPendingAction(userId, requestId);
          setRecoveryMessage(`Confirmed receipt ${receipt.id}.${cleared ? "" : " Browser storage could not clear the pending identity; check the receipt again."}`);
          if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "sync" }));
          return;
        }
      } catch {
        // An unavailable read does not determine the mutation outcome.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (isCurrent()) setRecoveryMessage("The outcome is unknown. Check the action receipt later without resending.");
  }

  async function checkActionReceipt() {
    if (!pendingRequestId || !sessionUserId || !connected || actionBusy.current) return;
    const epoch = authEpoch.current;
    const generation = connectionGeneration.current;
    const isCurrent = () => epoch === authEpoch.current && generation === connectionGeneration.current;
    actionBusy.current = true;
    setActionPhase("checking");
    setRecoveryMessage("");
    try {
      const response = await api.api.actions.receipts({ requestId: pendingRequestId }).get();
      if (!isCurrent()) return;
      const receipt = actionReceiptFromResponse(response);
      const { error: requestError, status } = response;
      if (receipt) {
        const cleared = forgetPendingAction(sessionUserId, pendingRequestId);
        setRecoveryMessage(`Confirmed receipt ${receipt.id}.${cleared ? "" : " Browser storage could not clear the pending identity; check the receipt again."}`);
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "sync" }));
      } else if (status === 401) {
        authEpoch.current += 1;
        hideSession();
        setError("The host session expired or was revoked.");
      } else {
        setRecoveryMessage(status === 404
          ? "No receipt is confirmed yet. The outcome is still unknown; check again later without resending."
          : requestErrorMessage(requestError, "The host could not check the receipt. The outcome is still unknown."));
      }
    } catch {
      if (isCurrent()) setRecoveryMessage("The host could not check the receipt. The outcome is still unknown.");
    } finally {
      if (isCurrent()) {
        actionBusy.current = false;
        setActionPhase(null);
      }
    }
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
              accessibilityState={{ disabled: authWorking || Boolean(pendingAuth) || !authStorageReady || !authCompatible }}
              disabled={authWorking || Boolean(pendingAuth) || !authStorageReady || !authCompatible}
              onPress={() => void mutateAuth("login")}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Sign in</Text>
            </Pressable>
            {pendingAuth ? <View style={styles.recovery}>
              <Text style={styles.empty}>An auth operation is awaiting confirmation. Checking does not resend it.</Text>
              <Pressable accessibilityRole="button" disabled={authWorking || !authStorageReady} accessibilityState={{ disabled: authWorking || !authStorageReady }} onPress={() => void checkAuthReceipt()} style={styles.button}>
                <Text style={styles.buttonText}>{authWorking ? "Checking auth…" : "Check auth receipt"}</Text>
              </Pressable>
              {pendingAuth.kind === "login" ? <Pressable accessibilityRole="button" disabled={authWorking || !authStorageReady || !authCompatible} accessibilityState={{ disabled: authWorking || !authStorageReady || !authCompatible }} onPress={() => void mutateAuth("revoke_login")} style={styles.button}>
                <Text style={styles.buttonText}>Revoke old login</Text>
              </Pressable> : null}
            </View> : null}
            {authMessage ? <Text testID="auth-recovery-status" aria-live="polite" style={styles.empty}>{authMessage}</Text> : null}
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

        <Pressable accessibilityRole="button" disabled={authWorking || !authStorageReady || !authCompatible} accessibilityState={{ disabled: authWorking || !authStorageReady || !authCompatible }} onPress={() => void mutateAuth("logout")} style={styles.button}>
          <Text style={styles.buttonText}>Sign out</Text>
        </Pressable>

        {authMessage ? <Text testID="auth-recovery-status" aria-live="polite" style={styles.empty}>{authMessage}</Text> : null}
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
            accessibilityState={{ disabled: submitting || !connected || Boolean(pendingRequestId) || !recoveryStorageReady }}
            disabled={submitting || !connected || Boolean(pendingRequestId) || !recoveryStorageReady}
            onPress={recordAction}
            style={({ pressed }) => [styles.button, pressed && styles.pressed, (submitting || !connected || Boolean(pendingRequestId) || !recoveryStorageReady) && styles.disabled]}
          >
            <Text style={styles.buttonText}>{actionPhase === "sending" ? "Saving…" : "Write backend receipt"}</Text>
          </Pressable>
          {pendingRequestId ? (
            <View testID="pending-action" style={styles.recovery}>
              <Text style={styles.empty}>An action is awaiting confirmation. Check its receipt; this will not resend it.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: submitting || !connected }}
                disabled={submitting || !connected}
                onPress={() => void checkActionReceipt()}
                style={[styles.button, (submitting || !connected) && styles.disabled]}
              >
                <Text style={styles.buttonText}>{actionPhase === "checking" ? "Checking receipt…" : "Check action receipt"}</Text>
              </Pressable>
            </View>
          ) : null}
          {recoveryMessage ? <Text testID="action-recovery-status" accessibilityRole="text" aria-live="polite" style={styles.empty}>{recoveryMessage}</Text> : null}
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
  recovery: { gap: 12 },
  receiptAction: { color: "#183337", fontSize: 17, fontWeight: "750" },
  receiptId: { color: "#476361", fontFamily: "monospace", fontSize: 12 },
  timestamp: { color: "#647d78", fontSize: 12 },
  empty: { color: "#6a807c", fontSize: 14 },
  historyRow: { borderTopColor: "#e8efeb", borderTopWidth: 1, gap: 5, paddingTop: 10 },
  historyAction: { color: "#244140", fontSize: 14, fontWeight: "650" },
  historyId: { color: "#748983", fontFamily: "monospace", fontSize: 11 },
});
