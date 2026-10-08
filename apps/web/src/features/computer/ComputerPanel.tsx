import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native-web";
import {
  heartbeatScreenPossession,
  readScreenPossession,
  releaseScreenPossession,
  takeScreenPossession,
  type ScreenPossessionState,
} from "@remotecode/client";
import { color, space, font, ui } from "../../design/tokens";

type Props = {
  selectedWorkspaceId: string | null;
  selectedBotId: string | null;
  userId: string;
};

const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;

export function ComputerPanel({ selectedWorkspaceId, selectedBotId, userId }: Props) {
  const [possession, setPossession] = useState<ScreenPossessionState | null>(null);
  const [takeError, setTakeError] = useState("");
  const possessionGeneration = useRef(0);
  const [returnStatus, setReturnStatus] = useState("");
  const [heartbeatStatus, setHeartbeatStatus] = useState<"idle" | "confirmed" | "failed">("idle");
  const [heartbeatAt, setHeartbeatAt] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const tokenRef = useRef<string | null>(null);
  const active = useRef(true);

  useEffect(() => {
    function online() { setIsOnline(true); }
    function offline() { setIsOnline(false); }
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  async function refreshPossession() {
    if (!selectedWorkspaceId) return;
    const generation = possessionGeneration.current;
    try {
      const state = await readScreenPossession(selectedWorkspaceId, window.location.origin);
      // A read that started before this client took the screen reports the old
      // holder; ignoring it stops the panel from showing "superseded" right
      // after its own confirmed take.
      if (generation !== possessionGeneration.current) return;
      setPossession(state);
      if (state.state !== "holder") {
        setHeartbeatStatus("idle");
        setHeartbeatAt(null);
      }
    } catch {
      // keep existing state on transient failure
    }
  }

  useEffect(() => {
    active.current = true;
    refreshPossession();
    const id = setInterval(refreshPossession, POLL_MS);
    return () => { active.current = false; clearInterval(id); };
  }, [selectedWorkspaceId]);

  // Heartbeat when we are the holder
  useEffect(() => {
    if (possession?.state !== "holder" || !tokenRef.current) return;
    setHeartbeatStatus("confirmed");
    setHeartbeatAt(Date.now());
    const id = setInterval(async () => {
      if (!active.current || !selectedWorkspaceId || !tokenRef.current) return;
      try {
        await heartbeatScreenPossession(selectedWorkspaceId, tokenRef.current, window.location.origin);
        setHeartbeatStatus("confirmed");
        setHeartbeatAt(Date.now());
      } catch {
        setHeartbeatStatus("failed");
      }
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [possession?.state, selectedWorkspaceId]);

  async function handleTakeControl() {
    if (!selectedWorkspaceId) return;
    setTakeError("");
    try {
      const result = await takeScreenPossession(selectedWorkspaceId, window.location.origin);
      possessionGeneration.current += 1;
      tokenRef.current = result.token;
      setPossession({ state: "holder", expiresAt: result.expiresAt, epoch: result.epoch, supersededCount: 0 });
      setReturnStatus("");
      setHeartbeatStatus("confirmed");
      setHeartbeatAt(Date.now());
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 409) {
        setTakeError("Another client already holds this session.");
      } else {
        setTakeError("Could not take control.");
      }
    }
  }

  async function handleReturnControl() {
    if (!selectedWorkspaceId || !tokenRef.current) return;
    setReturnStatus("returning");
    const token = tokenRef.current;
    tokenRef.current = null;
    try {
      await releaseScreenPossession(selectedWorkspaceId, token, window.location.origin);
      possessionGeneration.current += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = await readScreenPossession(selectedWorkspaceId, window.location.origin);
      if (state.state === "none") {
        setReturnStatus("returned");
        setPossession(state);
        setHeartbeatStatus("idle");
        setHeartbeatAt(null);
      } else {
        setReturnStatus("unknown");
      }
    } catch {
      setReturnStatus("unknown");
    }
  }

  // The host reports possession relative to this client's own token, so "none"
  // means this client holds nothing — it is not a statement that nobody else
  // does. Another client's lock is only learned from the host refusing a take.
  const ownerLabel = possession?.state === "holder"
    ? "You"
    : possession?.state === "none"
      ? "No possession from this client"
      : possession?.state === "superseded"
        ? "Another client took it"
        : possession?.state === "expired"
          ? "This client's window expired"
          : "Unknown";

  const sinceLabel = possession?.state === "holder" && possession.expiresAt
    ? `expires ${new Date(possession.expiresAt).toLocaleTimeString()}`
    : possession?.state === "expired" && possession.expiresAt
      ? `expired at ${new Date(possession.expiresAt).toLocaleTimeString()}`
      : "";

  // A client that was displaced, or whose window ran out, can take the screen
  // back: the host allows a takeover, and control has to be recoverable.
  const canTake = possession?.state !== "holder" && isOnline;
  const canReturn = possession?.state === "holder" && isOnline;

  return (
    <View testID="computer-panel" style={ui.panel}>
      <Text style={ui.heading}>Computer Panel</Text>
      {selectedBotId && <Text style={ui.body}>Bot: {selectedBotId}</Text>}
      {selectedWorkspaceId && <Text style={ui.body}>Workspace: {selectedWorkspaceId}</Text>}
      <View style={styles.keyValueRow}>
        <Text testID="computer-owner" style={ui.body}>
          <Text style={ui.meta}>Owner: </Text>
          {ownerLabel}
        </Text>
      </View>
      <View style={styles.keyValueRow}>
        <Text testID="computer-state" style={ui.body}>
          <Text style={ui.meta}>State: </Text>
          {possession?.state ?? "none"}
        </Text>
      </View>
      <View style={styles.keyValueRow}>
        <Text style={ui.meta}>Connection:</Text>
        <Text testID="computer-connection" style={ui.body}>
          {isOnline ? "Connected" : "Connection dropped"}
        </Text>
      </View>
      {sinceLabel ? <Text style={ui.body}>{sinceLabel}</Text> : null}
      {takeError ? <Text testID="computer-error" style={ui.error}>{takeError}</Text> : null}
      {returnStatus === "returned" && <Text testID="return-result" style={ui.success}>returned</Text>}
      {returnStatus === "unknown" && <Text style={ui.error}>Outcome unknown — no retry sent.</Text>}
      {returnStatus === "returning" && <Text style={ui.body}>Returning…</Text>}
      {possession?.state === "holder" && (
        <Text testID="computer-heartbeat" style={ui.body}>
          Heartbeat: {heartbeatStatus === "confirmed" ? "confirmed" : heartbeatStatus === "failed" ? "not confirmed" : "pending"}
          {heartbeatAt ? ` (last ${new Date(heartbeatAt).toLocaleTimeString()})` : null}
        </Text>
      )}
      <Pressable
        testID="take-control"
        onPress={handleTakeControl}
        disabled={!canTake}
        style={[ui.buttonPrimary, !canTake && ui.buttonDisabled]}
      >
        <Text style={ui.buttonLabelPrimary}>Take control</Text>
      </Pressable>
      <Pressable
        testID="return-control"
        onPress={handleReturnControl}
        disabled={!canReturn || returnStatus === "returning"}
        style={[ui.button, (!canReturn || returnStatus === "returning") && ui.buttonDisabled]}
      >
        <Text style={ui.buttonLabel}>Return control</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  keyValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.sm,
  },
});
