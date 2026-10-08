import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  createApiClient,
  readScreenPossession,
  heartbeatScreenPossession,
  releaseScreenPossession,
  takeScreenPossession,
  sendScreenInput,
  readRun,
  readRunChanges,
  readWorkspaceRuns,
  runMutation,
  type ScreenInputEvent,
  type ScreenPossessionState,
  type WorkspaceRun,
} from "@remotecode/client";
import type { Workspace } from "@remotecode/client";

const deadlineMs = 10_000;
// Input is applied by the host's own display, which can take seconds per event,
// so sending input gets a longer budget than a plain read.
const inputDeadlineMs = 30_000;
type Props = { origin: string; userId: string; workspace: Workspace | null; blocked: boolean; onUnauthorized: () => void };

export function SessionPanel({ origin, userId, workspace, blocked, onUnauthorized }: Props) {
  const live = useRef({ origin, userId, workspace, blocked });
  live.current = { origin, userId, workspace, blocked };
  const active = useRef(false);
  const epoch = useRef(0);
  const working = useRef(false);
  const possessionTokenRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [possessionState, setPossessionState] = useState<ScreenPossessionState | null>(null);
  const [run, setRun] = useState<WorkspaceRun | null>(null);
  const [runChanges, setRunChanges] = useState<{ files: Array<{ path: string; changeKind: string }>; diff: string; truncated: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [inputText, setInputText] = useState("");

  useEffect(() => {
    let isActive = true;
    active.current = true;
    const mine = ++epoch.current;
    return () => { isActive = false; active.current = false; epoch.current = mine; };
  }, []);

  function begin() {
    const mine = ++epoch.current;
    const id = workspace?.id;
    const archived = workspace?.archived;
    return () => active.current && epoch.current === mine && live.current.origin === origin && live.current.userId === userId &&
      live.current.workspace?.id === id && live.current.workspace?.archived === archived && live.current.blocked === blocked;
  }

  function request(end: number) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("Session deadline expired");
    return createApiClient(origin, { timeoutMs: remaining });
  }

  /// One human input event, sent only while this client holds the screen and
  /// reported only as the host answers.
  async function sendInput(event: ScreenInputEvent) {
    if (!workspace || blocked || working.current || possessionState?.state !== "holder") return;
    const token = possessionTokenRef.current;
    if (!token) { setMessage("Take the screen before sending input."); return; }
    const current = begin();
    const end = Date.now() + inputDeadlineMs;
    working.current = true; setBusy(true);
    try {
      await sendScreenInput(workspace.id, token, event, origin, { timeoutMs: Math.max(1, end - Date.now()) });
      if (current()) setMessage(event.kind === "type" ? "The host applied the text." : `The host applied the ${event.kind}.`);
    } catch {
      if (current()) {
        // A refused input means the host no longer counts us as the holder; the
        // panel asks again instead of assuming either way.
        setMessage("The host refused the input or its outcome is unknown. Nothing was resent.");
        await refreshPossession();
      }
    } finally {
      // The operation always releases its own hold: the fence can move under it
      // (another read bumps the epoch, a workspace change re-runs the effect),
      // and gating this on the fence left every control disabled for good.
      working.current = false;
      setBusy(false);
    }
  }

  // `interactive` marks the reads a person asked for (mount, take, return) as
  // opposed to the poll that keeps the panel current: a poll must not flip the
  // gate that disables the controls, or a tap can land on a disabled button.
  async function refreshPossession(interactive = false) {
    if (!workspace) return;
    const current = begin();
    const end = Date.now() + deadlineMs;
    if (interactive) { working.current = true; setBusy(true); }
    try {
      const state = await readScreenPossession(workspace.id, origin);
      if (!current()) return;
      setPossessionState(state);
      if (state.state === "holder" && possessionTokenRef.current) {
        const runs = await readWorkspaceRuns(workspace.id, origin);
        if (!current()) return;
        const latest = runs[0] ?? null;
        setRun(latest ?? null);
        if (latest) {
          const changes = await readRunChanges(latest.id, origin);
          if (!current()) return;
          setRunChanges(changes);
        } else {
          setRunChanges(null);
        }
      }
    } catch {
      if (current()) setMessage("Possession state unavailable. Outcome remains unknown.");
    } finally { if (interactive) { working.current = false; setBusy(false); } }
  }

  async function handleTakeOver() {
    if (!workspace || working.current) return;
    const current = begin();
    working.current = true; setBusy(true); setMessage("Taking over screen…");
    try {
      if (!await session(Date.now() + deadlineMs, current)) return;
      const outcome = await runMutation({
        send: async () => takeScreenPossession(workspace.id, origin),
        deadlineMs,
        receipt: async () => {
          const state = await readScreenPossession(workspace.id, origin);
          if (state.state === "holder") return { applied: true };
          if (state.state === "none") return { applied: false };
          return null;
        },
        onLateResult: () => {
          if (current()) setMessage("Possession request arrived after the deadline. Outcome remains unknown; check possession state.");
        },
      });
      if (!current()) return;
      if (outcome.status === "committed") {
        possessionTokenRef.current = outcome.result.token;
        setMessage("Screen possession taken.");
        await refreshPossession();
      } else if (outcome.status === "not_committed") {
        setMessage("Take-over was not confirmed. Check possession state.");
      } else {
        setMessage("Take-over outcome is unknown. Checking possession state…");
        await consultPossessionState();
      }
    } catch {
      if (current()) {
        setMessage("Take-over outcome is unknown. Checking possession state…");
        await consultPossessionState();
      }
    } finally {
      // The operation always releases its own hold: the fence can move under it
      // (another read bumps the epoch, a workspace change re-runs the effect),
      // and gating this on the fence left every control disabled for good.
      working.current = false;
      setBusy(false);
    }
  }

  async function handleReturnScreen() {
    if (!workspace || working.current || !possessionTokenRef.current) return;
    const current = begin();
    working.current = true; setBusy(true); setMessage("Returning screen…");
    try {
      if (!await session(Date.now() + deadlineMs, current)) return;
      const outcome = await runMutation({
        send: async () => releaseScreenPossession(workspace.id, possessionTokenRef.current!, origin),
        deadlineMs,
        receipt: async () => {
          const state = await readScreenPossession(workspace.id, origin);
          if (state.state === "none") return { applied: true };
          if (state.state === "holder") return { applied: false };
          return null;
        },
        onLateResult: () => {
          if (current()) setMessage("Release request arrived after the deadline. Outcome remains unknown; check possession state.");
        },
      });
      if (!current()) return;
      if (outcome.status === "committed") {
        possessionTokenRef.current = null;
        setMessage("Screen possession released.");
        await refreshPossession();
      } else if (outcome.status === "not_committed") {
        setMessage("Release was not confirmed. Check possession state.");
      } else {
        setMessage("Release outcome is unknown. Checking possession state…");
        await consultPossessionState();
      }
    } catch {
      if (current()) {
        setMessage("Release outcome is unknown. Checking possession state…");
        await consultPossessionState();
      }
    } finally {
      // The operation always releases its own hold: the fence can move under it
      // (another read bumps the epoch, a workspace change re-runs the effect),
      // and gating this on the fence left every control disabled for good.
      working.current = false;
      setBusy(false);
    }
  }

  async function consultPossessionState() {
    if (!workspace) return;
    try {
      const state = await readScreenPossession(workspace.id, origin);
      setPossessionState(state);
      if (state.state === "holder") {
        possessionTokenRef.current = possessionTokenRef.current ?? null;
        setMessage("Possession confirmed as holder. Outcome may still be pending.");
      } else if (state.state === "none") {
        possessionTokenRef.current = null;
        setMessage("No possession held. The request was not confirmed.");
      } else {
        setMessage(`Possession state is ${state.state}. Outcome remains uncertain.`);
      }
    } catch {
      setMessage("Possession state unavailable. Outcome remains unknown.");
    }
  }

  async function session(end: number, current: () => boolean) {
    const result = await request(end).api.auth.session.get();
    if (!current()) return false;
    if (Date.now() >= end) throw new Error("Session deadline expired");
    if (result.error) { onUnauthorized(); return false; }
    if (!result.data || !("userId" in result.data) || result.data.userId !== userId) { onUnauthorized(); return false; }
    return true;
  }

  useEffect(() => {
    active.current = true;
    const mine = ++epoch.current;
    setPossessionState(null);
    setRun(null);
    setRunChanges(null);
    setMessage("");
    possessionTokenRef.current = null;
    if (workspace && !blocked) void refreshPossession();
    return () => { active.current = false; epoch.current = mine; };
  }, [origin, userId, workspace?.id]);

  // The possession window closes on its own, so a client that is still holding
  // the screen renews it; if the renewal stops working the panel reads the real
  // state instead of claiming it still holds the screen.
  useEffect(() => {
    if (!workspace || possessionState?.state !== "holder" || !possessionTokenRef.current) return;
    const workspaceId = workspace.id;
    const timer = setInterval(() => {
      const token = possessionTokenRef.current;
      if (!token || !active.current) return;
      void heartbeatScreenPossession(workspaceId, token, origin).catch(() => { void consultPossessionState(); });
    }, 8_000);
    return () => clearInterval(timer);
  }, [origin, workspace?.id, possessionState?.state]);

  const disabled = busy || blocked || !workspace;
  const stateLabel = possessionState?.state ?? "none";
  const stateColor = possessionState?.state === "holder" ? "#126b54" : possessionState?.state === "superseded" ? "#b45309" : possessionState?.state === "expired" ? "#9c3026" : "#50696b";

  return <View style={styles.card} testID="session-panel">
    <Text accessibilityRole="header" style={styles.heading}>Session</Text>
    <View style={styles.row}>
      <Text style={[styles.status, { color: stateColor }]}>Possession: {stateLabel}</Text>
    </View>
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel="Take over screen" disabled={disabled} onPress={() => void handleTakeOver()} style={[styles.button, disabled && styles.disabled]} testID="take-over">
        <Text style={styles.buttonText}>Take over screen</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Return screen" disabled={disabled || possessionState?.state !== "holder"} onPress={() => void handleReturnScreen()} style={[styles.secondary, disabled && styles.disabled]} testID="return-screen">
        <Text>Return screen</Text>
      </Pressable>

      {possessionState?.state === "holder" ? (
        <View style={styles.inputRow}>
          <TextInput
            accessibilityLabel="Screen text"
            value={inputText}
            onChangeText={setInputText}
            placeholder="Text to type on the screen"
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send screen text"
            testID="send-screen-text"
            disabled={disabled || !inputText.trim()}
            onPress={() => void sendInput({ kind: "type", text: inputText })}
            style={[styles.button, (disabled || !inputText.trim()) && styles.disabled]}
          >
            <Text style={styles.buttonText}>Send text</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Click screen centre"
            testID="click-screen-centre"
            disabled={disabled}
            onPress={() => void sendInput({ kind: "click", x: 640, y: 450 })}
            style={[styles.secondary, disabled && styles.disabled]}
          >
            <Text>Click centre</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
    <Text testID="session-status" accessibilityLiveRegion="polite" style={styles.status}>{message || "No session activity yet."}</Text>
    <View testID="session-result">
      {!run ? <Text>No run data yet.</Text> : <>
        <Text>Run state: {run.state}</Text>
        {runChanges ? <>
          <Text>Changed files:</Text>
          {runChanges.files.map((f, i) => <Text key={i}>{f.path} ({f.changeKind})</Text>)}
          {runChanges.diff ? <Text>Diff: {runChanges.diff}</Text> : null}
          {runChanges.truncated ? <Text>Diff truncated.</Text> : null}
        </> : <Text>No changes recorded.</Text>}
      </>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  inputRow: { gap: 8, marginTop: 8 },
  input: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, color: "#183337", minHeight: 44, paddingHorizontal: 12 },
  card: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 16, borderWidth: 1, gap: 10, padding: 18 },
  heading: { color: "#183337", fontSize: 18, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  status: { fontSize: 13, fontWeight: "600" },
  button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 9, justifyContent: "center", minHeight: 42, paddingHorizontal: 16 },
  disabled: { opacity: 0.55 },
  buttonText: { color: "#fff", fontWeight: "700" },
  secondary: { alignItems: "center", justifyContent: "center", minHeight: 40 },
});