import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native-web";
import {
  createApiClient,
  pendingWorkspaceFromValue,
  workspaceErrorStatus,
  workspaceDeadlineIsOpen,
  workspaceListFromValue,
  workspaceReceiptFromValue,
  workspaceFromValue,
} from "@remotecode/client";
import type { PendingWorkspace, Workspace } from "@remotecode/client";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminals/TerminalPanel";

const deadlineMs = 10_000;
type Props = { userId: string; onUnauthorized: () => void };

function storageKey(userId: string) {
  return `remotecode.pending-workspace:${JSON.stringify([window.location.origin, userId])}`;
}

export function WorkspacePanel({ userId, onUnauthorized }: Props) {
  const api = useMemo(() => createApiClient(window.location.origin), []);
  const active = useRef(true);
  const readGeneration = useRef(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rename, setRename] = useState("");
  const [pending, setPending] = useState<PendingWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState("");
  const [message, setMessage] = useState("");
  const [capability, setCapability] = useState<
    "unknown" | "supported" | "unsupported"
  >("unknown");
  const [storageReady, setStorageReady] = useState(false);
  const selected =
    workspaces.find((workspace) => workspace.id === selectedId) ?? null;

  function savePending(value: PendingWorkspace | null) {
    try {
      const key = storageKey(userId);
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
      const storedRaw = sessionStorage.getItem(key);
      const stored =
        value && storedRaw !== null
          ? pendingWorkspaceFromValue(JSON.parse(storedRaw))
          : null;
      if (
        (value && JSON.stringify(stored) !== JSON.stringify(value)) ||
        (!value && storedRaw !== null)
      )
        return false;
      setPending(value);
      setStorageReady(true);
      return true;
    } catch {
      setStorageReady(false);
      return false;
    }
  }

  async function refresh(
    timeoutMs = deadlineMs,
    renegotiateCapability = false,
  ) {
    const generation = ++readGeneration.current;
    setReadError("");
    if (renegotiateCapability) {
      try {
        const version = await createApiClient(window.location.origin, {
          timeoutMs,
        }).api.version.get();
        if (!active.current || generation !== readGeneration.current) return;
        if (version.error || !Array.isArray(version.data?.capabilities)) {
          setCapability("unknown");
          setMessage(
            "Host capability check is unavailable. Retry before writing.",
          );
        } else {
          const available = version.data.capabilities.includes(
            "workspace-metadata-v1",
          );
          setCapability(available ? "supported" : "unsupported");
          if (!available)
            setMessage(
              "This host does not support workspace-metadata-v1. No workspace request was sent.",
            );
          else setMessage("");
        }
      } catch {
        if (active.current && generation === readGeneration.current) {
          setCapability("unknown");
          setMessage(
            "Host capability check is unavailable. Retry before writing.",
          );
        }
      }
    }
    try {
      const readApi = createApiClient(window.location.origin, { timeoutMs });
      const { data, error } = await readApi.api.workspaces.get();
      if (!active.current || generation !== readGeneration.current) return;
      if (error) {
        if (workspaceErrorStatus(error) === 401) onUnauthorized();
        setReadError(
          "Could not load workspaces. Try Refresh workspaces again.",
        );
        return;
      }
      const rows = workspaceListFromValue(data);
      if (!rows) {
        setReadError(
          "Host returned invalid workspace metadata.",
        );
        return;
      }
      setWorkspaces(rows);
      if (selectedId && !rows.some((workspace) => workspace.id === selectedId))
        setSelectedId(null);
    } catch {
      if (active.current && generation === readGeneration.current)
        setReadError(
          "Could not load workspaces. Try Refresh workspaces again.",
        );
    }
  }

  async function openWorkspace(workspace: Workspace) {
    const generation = ++readGeneration.current;
    setSelectedId(workspace.id);
    setReadError("");
    try {
      const { data, error } = await api.api
        .workspaces({ workspaceId: workspace.id })
        .get();
      if (!active.current || generation !== readGeneration.current) return;
      if (error) {
        if (workspaceErrorStatus(error) === 401) onUnauthorized();
        setReadError(
          "Could not open this workspace. Refresh the list and try again.",
        );
        return;
      }
      const confirmed = workspaceFromValue(data);
      if (!confirmed) {
        setReadError(
          "Could not open this workspace. Refresh the list and try again.",
        );
        return;
      }
      if (confirmed.id !== workspace.id) {
        setReadError("Host returned invalid workspace metadata.");
        return;
      }
      setWorkspaces((items) =>
        items.map((item) => (item.id === confirmed.id ? confirmed : item)),
      );
    } catch {
      if (active.current && generation === readGeneration.current)
        setReadError(
          "Could not open this workspace. Refresh the list and try again.",
        );
    }
  }

  useEffect(() => {
    active.current = true;
    setWorkspaces([]);
    setSelectedId(null);
    setPending(null);
    setStorageReady(false);
    setReadError("");
    try {
      const raw = sessionStorage.getItem(storageKey(userId));
      if (raw !== null) {
        const restored = pendingWorkspaceFromValue(JSON.parse(raw));
        if (!restored) throw new Error("Invalid pending workspace identity");
        setPending(restored);
      }
      setStorageReady(true);
    } catch {
      setStorageReady(false);
      setMessage(
        "Pending workspace recovery could not be read. Writes are disabled until browser storage is repaired.",
      );
    }
    void refresh();
    return () => {
      active.current = false;
    };
  }, [api, userId]);

  async function loadReceipt(
    operation = pending,
    duringMutation = false,
    deadline?: number,
  ) {
    if (!operation || (busy && !duringMutation)) return;
    readGeneration.current++;
    const end = deadline ?? Date.now() + deadlineMs;
    if (!duringMutation) setBusy(true);
    setMessage("Checking workspace receipt. No mutation will be resent.");
    try {
      const remaining = end - Date.now();
      if (remaining <= 0) return;
      const receiptApi = createApiClient(window.location.origin, {
        timeoutMs: Math.min(2_000, remaining),
      });
      const result = await receiptApi.api.workspaces
        .receipts({ requestId: operation.requestId })
        .outcome.get();
      if (!active.current) return;
      if (!workspaceDeadlineIsOpen(end)) {
        setMessage(
          "Receipt arrived after the deadline. Outcome remains unknown; check again manually.",
        );
        return;
      }
      if (result.error) {
        if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
        setMessage(
          workspaceErrorStatus(result.error) === 404
            ? "No matching receipt is available. Outcome remains unknown; keep this request ID."
            : "Receipt lookup failed. Outcome remains unknown.",
        );
        return;
      }
      const workspace = workspaceReceiptFromValue(
        result.data,
        operation,
        operation.workspaceId,
      );
      if (!workspace) {
        setMessage(
          "Receipt did not match the pending operation. Outcome remains unknown.",
        );
        return;
      }
      if (!workspaceDeadlineIsOpen(end)) {
        setMessage(
          "Receipt arrived after the deadline. Outcome remains unknown; check again manually.",
        );
        return;
      }
      if (!savePending(null)) {
        setMessage(
          "Receipt confirmed, but pending identity could not be cleared. Keep this request ID and check again.",
        );
        return;
      }
      if (Date.now() < end) {
        await refresh(Math.min(2_000, end - Date.now()));
        if (!active.current) return;
        setMessage("Workspace change confirmed.");
      } else
        setMessage(
          "Workspace change confirmed. Refresh to read current workspace metadata.",
        );
    } catch {
      if (active.current)
        setMessage("Receipt lookup failed. Outcome remains unknown.");
    } finally {
      if (active.current && !duringMutation) setBusy(false);
    }
  }

  async function mutate(kind: PendingWorkspace["kind"], workspace?: Workspace) {
    if (busy || pending || capability === "unsupported" || !storageReady)
      return;
    readGeneration.current++;
    const end = Date.now() + deadlineMs;
    setBusy(true);
    setMessage("");
    let operation: PendingWorkspace | null = null;
    try {
      const remaining = end - Date.now();
      if (remaining <= 0) {
        setMessage(
          "No workspace request was sent; the operation deadline expired.",
        );
        return;
      }
      const preflight = await createApiClient(window.location.origin, {
        timeoutMs: remaining,
      }).api.version.get();
      if (!active.current) return;
      if (preflight.error || !Array.isArray(preflight.data?.capabilities)) {
        setCapability("unknown");
        setMessage(
          "Host capability check is unavailable. No workspace request was sent; retry.",
        );
        return;
      }
      if (!preflight.data.capabilities.includes("workspace-metadata-v1")) {
        setCapability("unsupported");
        setMessage(
          "This host does not support workspace-metadata-v1. No workspace request was sent.",
        );
        return;
      }
      setCapability("supported");
      const requestId = crypto.randomUUID();
      operation =
        kind === "create"
          ? { kind, requestId }
          : { kind, requestId, workspaceId: workspace!.id };
      if (!savePending(operation)) {
        setMessage(
          "Could not safely store the pending workspace ID. No workspace request was sent.",
        );
        return;
      }
      const remainingBeforePost = end - Date.now();
      if (remainingBeforePost <= 0) {
        if (!savePending(null))
          setMessage(
            "No workspace request was sent, but pending identity could not be cleared; check its receipt before continuing.",
          );
        else
          setMessage(
            "No workspace request was sent; the deadline expired before submission.",
          );
        return;
      }
      const writeApi = createApiClient(window.location.origin, {
        timeoutMs: remainingBeforePost,
      });
      const response =
        kind === "create"
          ? await writeApi.api.workspaces.post({ requestId, name: name.trim() })
          : await writeApi.api
              .workspaces({ workspaceId: workspace!.id })
              .patch(
                kind === "rename"
                  ? { requestId, name: rename.trim() }
                  : { requestId, archived: true },
              );
      if (!active.current) return;
      readGeneration.current++;
      if (!workspaceDeadlineIsOpen(end)) {
        setMessage(
          "Workspace response arrived after the deadline. Outcome remains unknown; check its receipt manually.",
        );
        return;
      }
      if (response.error) {
        if (workspaceErrorStatus(response.error) === 401) {
          onUnauthorized();
          return;
        }
        setMessage(
          "Workspace request was not confirmed. Check its receipt; no mutation will be replayed.",
        );
        if (Date.now() < end) await loadReceipt(operation, true, end);
        return;
      }
      const receipt = workspaceReceiptFromValue(
        response.data,
        operation,
        operation.workspaceId,
      );
      if (!receipt) {
        setMessage(
          "Workspace response did not match the pending operation. Outcome remains unknown.",
        );
        if (Date.now() < end) await loadReceipt(operation, true, end);
        return;
      }
      if (!workspaceDeadlineIsOpen(end)) {
        setMessage(
          "Workspace response arrived after the deadline. Outcome remains unknown; check its receipt manually.",
        );
        return;
      }
      if (!savePending(null)) {
        setMessage(
          "Workspace change confirmed, but pending identity could not be cleared. Check its receipt again.",
        );
        return;
      }
      setName("");
      setRename("");
      if (Date.now() < end) {
        await refresh(Math.min(2_000, end - Date.now()));
        if (!active.current) return;
        setMessage("Workspace change confirmed.");
      } else
        setMessage(
          "Workspace change confirmed. Refresh to read current workspace metadata.",
        );
    } catch {
      if (active.current) {
        setMessage(
          "Workspace request outcome is unknown. Check its receipt; no mutation will be replayed.",
        );
        if (operation && Date.now() < end)
          await loadReceipt(operation, true, end);
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <View style={styles.card} testID="workspace-panel">
      <Text accessibilityRole="header" style={styles.heading}>
        Workspaces
      </Text>
      <TextInput
        accessibilityLabel="Workspace name"
        value={name}
        onChangeText={setName}
        placeholder="Workspace name"
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create workspace"
        disabled={
          busy ||
          Boolean(pending) ||
          capability === "unsupported" ||
          !storageReady ||
          !name.trim()
        }
        onPress={() => void mutate("create")}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Create workspace</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh workspaces"
        disabled={busy}
        onPress={() => void refresh(deadlineMs, true)}
        style={styles.secondary}
      >
        <Text>Refresh workspaces</Text>
      </Pressable>
      {capability === "unsupported" ? (
        <Text testID="workspace-unsupported">
          This host does not support workspace-metadata-v1. Writes are disabled.
        </Text>
      ) : null}
      {workspaces.length === 0 && !readError ? (
        <Text>No workspaces yet.</Text>
      ) : null}
      {workspaces.map((workspace) => (
        <View key={workspace.id} style={styles.row}>
          <Text>
            {workspace.name}
            {workspace.archived ? " (archived, read-only)" : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open workspace ${workspace.name}`}
            disabled={busy}
            onPress={() => void openWorkspace(workspace)}
          >
            <Text>Open</Text>
          </Pressable>
        </View>
      ))}
      {selected ? (
        <View style={styles.selected} testID="selected-workspace">
          <Text>Selected: {selected.name}</Text>
          {!selected.archived ? (
            <>
              <TextInput
                accessibilityLabel="New workspace name"
                value={rename}
                onChangeText={setRename}
                placeholder="New workspace name"
                style={styles.input}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rename workspace"
                disabled={
                  busy ||
                  Boolean(pending) ||
                  capability === "unsupported" ||
                  !storageReady ||
                  !rename.trim()
                }
                onPress={() => void mutate("rename", selected)}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Rename workspace</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Archive workspace"
                disabled={
                  busy ||
                  Boolean(pending) ||
                  capability === "unsupported" ||
                  !storageReady
                }
                onPress={() => void mutate("archive", selected)}
                style={styles.secondary}
              >
                <Text>Archive workspace</Text>
              </Pressable>
            </>
          ) : (
            <Text>Archived workspaces are read-only.</Text>
          )}
        </View>
      ) : null}
      {pending ? (
        <View style={styles.pending}>
          <Text>
            Workspace operation awaits confirmation. Check its receipt; it will
            not be resent.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Check workspace receipt"
            disabled={busy}
            onPress={() => void loadReceipt()}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Check workspace receipt</Text>
          </Pressable>
        </View>
      ) : null}
      {readError ? (
        <Text accessibilityRole="alert" testID="workspace-read-error">
          {readError}
        </Text>
      ) : null}
      {message ? <Text testID="workspace-status">{message}</Text> : null}
      <FilePanel
        userId={userId}
        workspace={selected}
        blocked={busy || Boolean(pending) || Boolean(readError)}
        onUnauthorized={onUnauthorized}
      />
      <TerminalPanel
        userId={userId}
        workspace={selected}
        blocked={busy || Boolean(pending) || Boolean(readError)}
        onUnauthorized={onUnauthorized}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderColor: "#d9e5e0",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  heading: { color: "#183337", fontSize: 18, fontWeight: "700" },
  input: {
    borderColor: "#c9d9d2",
    borderRadius: 9,
    borderWidth: 1,
    minHeight: 42,
    paddingHorizontal: 12,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#126b54",
    borderRadius: 9,
    justifyContent: "center",
    minHeight: 42,
  },
  buttonText: { color: "#fff", fontWeight: "700" },
  secondary: { alignItems: "center", justifyContent: "center", minHeight: 40 },
  row: {
    alignItems: "center",
    borderTopColor: "#e3ebe7",
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  selected: {
    borderTopColor: "#e3ebe7",
    borderTopWidth: 1,
    gap: 8,
    paddingTop: 12,
  },
  pending: { backgroundColor: "#fff0cf", gap: 8, padding: 12 },
});
