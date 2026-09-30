import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import {
  createApiClient,
  pendingWorkspaceFromValue,
  pendingWorkspaceValueMatches,
  workspaceDeadlineIsOpen,
  workspaceErrorStatus,
  workspaceFromValue,
  workspaceListFromValue,
  workspaceReceiptFromValue,
} from "@remotecode/client";
import type { PendingWorkspace, Workspace } from "@remotecode/client";

const deadlineMs = 10_000;
type Props = { origin: string; userId: string; onUnauthorized: () => void };

function storageKey(origin: string, userId: string) {
  return `remotecode.pending-workspace:${JSON.stringify([origin, userId])}`;
}

let pendingStorageQueue = Promise.resolve();

function withPendingStorage<T>(work: () => Promise<T>) {
  const result = pendingStorageQueue.then(work);
  pendingStorageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function beforeWorkspaceDeadline<T>(work: Promise<T>, deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { expired: true as const };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work.then((value) => ({ expired: false as const, value })),
      new Promise<{ expired: true }>((resolve) => {
        timer = setTimeout(() => resolve({ expired: true }), remaining);
      }),
    ]);
    if (result.expired || !workspaceDeadlineIsOpen(deadline))
      return { expired: true as const };
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type PendingWriteResult = "saved" | "not_written" | "cleaned" | "unsafe";
type PendingClearResult = "cleared" | "retained" | "different" | "unsafe";

export function WorkspacePanel({ origin, userId, onUnauthorized }: Props) {
  const api = useMemo(() => createApiClient(origin), [origin]);
  const mounted = useRef(true);
  const storageGeneration = useRef(0);
  const readGeneration = useRef(0);
  const pendingRef = useRef<PendingWorkspace | null>(null);
  const unsentPending = useRef<PendingWorkspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rename, setRename] = useState("");
  const [pending, setPending] = useState<PendingWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [readError, setReadError] = useState("");
  const [message, setMessage] = useState("");
  const [capability, setCapability] = useState<
    "unknown" | "supported" | "unsupported"
  >("unknown");
  const selected =
    workspaces.find((workspace) => workspace.id === selectedId) ?? null;

  function updatePending(value: PendingWorkspace | null) {
    pendingRef.current = value;
    setPending(value);
  }

  async function removeStoredPendingDirect(
    operation: PendingWorkspace,
    absentIsSafe: boolean,
  ): Promise<PendingClearResult> {
    const key = storageKey(origin, userId);
    const stored = await AsyncStorage.getItem(key);
    if (stored === null) return absentIsSafe ? "cleared" : "different";
    if (!pendingWorkspaceValueMatches(stored, operation)) return "different";
    await AsyncStorage.removeItem(key);
    return (await AsyncStorage.getItem(key)) === null ? "cleared" : "unsafe";
  }

  async function removeStoredPending(
    operation: PendingWorkspace,
    absentIsSafe: boolean,
  ): Promise<PendingClearResult> {
    return withPendingStorage(() =>
      removeStoredPendingDirect(operation, absentIsSafe),
    );
  }

  async function cleanupUnsentPending(
    operation: PendingWorkspace,
    generation: number,
  ) {
    let result: PendingClearResult;
    try {
      result = await removeStoredPending(operation, true);
    } catch {
      result = "unsafe";
    }
    if (generation !== storageGeneration.current || !mounted.current)
      return result === "cleared";
    if (
      !pendingWorkspaceValueMatches(
        JSON.stringify(pendingRef.current),
        operation,
      )
    )
      return false;
    if (result === "cleared") {
      unsentPending.current = null;
      updatePending(null);
      setStorageReady(true);
      setMessage(
        "No workspace request was sent; pending ID cleanup was confirmed.",
      );
      return true;
    }
    setStorageReady(false);
    setMessage(
      "No workspace request was sent; storage cleanup is unconfirmed. Writes remain disabled.",
    );
    return false;
  }

  async function persistPending(operation: PendingWorkspace, deadline: number) {
    const key = storageKey(origin, userId);
    const raw = JSON.stringify(operation);
    const generation = storageGeneration.current;
    unsentPending.current = operation;
    updatePending(operation);
    setStorageReady(false);
    const write = withPendingStorage(async (): Promise<PendingWriteResult> => {
      if (
        generation !== storageGeneration.current ||
        !mounted.current ||
        !workspaceDeadlineIsOpen(deadline)
      )
        return "not_written";
      try {
        if ((await AsyncStorage.getItem(key)) !== null) return "unsafe";
        if (!workspaceDeadlineIsOpen(deadline)) return "not_written";
        await AsyncStorage.setItem(key, raw);
        const stored = await AsyncStorage.getItem(key);
        if (!pendingWorkspaceValueMatches(stored, operation)) return "unsafe";
        if (
          !workspaceDeadlineIsOpen(deadline) ||
          generation !== storageGeneration.current ||
          !mounted.current
        ) {
          const cleanup = await removeStoredPendingDirect(operation, true);
          return cleanup === "cleared" ? "cleaned" : "unsafe";
        }
        return "saved";
      } catch {
        try {
          const cleanup = await removeStoredPendingDirect(operation, true);
          return cleanup === "cleared" ? "cleaned" : "unsafe";
        } catch {
          return "unsafe";
        }
      }
    });

    let result: Awaited<typeof write> | null = null;
    try {
      const waited = await beforeWorkspaceDeadline(write, deadline);
      if (!waited.expired) result = waited.value;
    } catch {
      result = "unsafe";
    }
    if (
      result === "saved" &&
      generation === storageGeneration.current &&
      mounted.current
    ) {
      setStorageReady(true);
      return true;
    }
    if (result === "cleaned" || result === "not_written") {
      if (generation === storageGeneration.current && mounted.current) {
        unsentPending.current = null;
        updatePending(null);
        setStorageReady(true);
        setMessage("No workspace request was sent; no pending ID remains.");
      }
      return false;
    }
    setStorageReady(false);
    setMessage(
      "No workspace request was sent; pending ID storage is unresolved. Writes remain disabled.",
    );
    void write
      .then((lateResult) => {
        if (lateResult === "saved")
          return cleanupUnsentPending(operation, generation);
        if (lateResult === "cleaned" || lateResult === "not_written") {
          if (generation === storageGeneration.current && mounted.current) {
            unsentPending.current = null;
            updatePending(null);
            setStorageReady(true);
            setMessage(
              "No workspace request was sent; pending ID cleanup was confirmed.",
            );
          }
          return true;
        }
        return false;
      })
      .catch(() => undefined);
    return false;
  }

  async function clearPendingAfterReceipt(
    operation: PendingWorkspace,
    deadline: number,
  ) {
    const key = storageKey(origin, userId);
    const raw = JSON.stringify(operation);
    const generation = storageGeneration.current;
    const clear = withPendingStorage(async (): Promise<PendingClearResult> => {
      const stored = await AsyncStorage.getItem(key);
      if (!pendingWorkspaceValueMatches(stored, operation)) return "different";
      if (!workspaceDeadlineIsOpen(deadline)) return "retained";
      await AsyncStorage.removeItem(key);
      if ((await AsyncStorage.getItem(key)) !== null) return "unsafe";
      if (
        !workspaceDeadlineIsOpen(deadline) ||
        generation !== storageGeneration.current ||
        !mounted.current
      ) {
        if ((await AsyncStorage.getItem(key)) === null) {
          await AsyncStorage.setItem(key, raw);
          return pendingWorkspaceValueMatches(
            await AsyncStorage.getItem(key),
            operation,
          )
            ? "retained"
            : "unsafe";
        }
        return "unsafe";
      }
      return "cleared";
    });
    let result: PendingClearResult | null = null;
    try {
      const waited = await beforeWorkspaceDeadline(clear, deadline);
      if (!waited.expired) result = waited.value;
    } catch {
      result = "unsafe";
    }
    if (
      result === "cleared" &&
      workspaceDeadlineIsOpen(deadline) &&
      generation === storageGeneration.current &&
      mounted.current
    ) {
      unsentPending.current = null;
      updatePending(null);
      setStorageReady(true);
      return true;
    }
    if (
      result === "retained" &&
      generation === storageGeneration.current &&
      mounted.current
    ) {
      setStorageReady(true);
      return false;
    }
    setStorageReady(false);
    void clear
      .then(async (lateResult) => {
        let recovered = lateResult === "retained";
        if (lateResult === "cleared") {
          recovered = await withPendingStorage(async () => {
            const current = await AsyncStorage.getItem(key);
            if (current !== null)
              return pendingWorkspaceValueMatches(current, operation);
            await AsyncStorage.setItem(key, raw);
            return pendingWorkspaceValueMatches(
              await AsyncStorage.getItem(key),
              operation,
            );
          }).catch(() => false);
        }
        if (
          generation === storageGeneration.current &&
          mounted.current &&
          recovered
        ) {
          updatePending(operation);
          setStorageReady(true);
          setMessage(
            "Receipt read missed the deadline. Outcome remains unknown; pending ID was retained.",
          );
        }
      })
      .catch(() => undefined);
    return false;
  }

  async function refresh(
    timeoutMs = deadlineMs,
    renegotiateCapability = false,
  ) {
    const generation = ++readGeneration.current;
    setReadError("");
    if (renegotiateCapability) {
      try {
        const version = await createApiClient(origin, {
          timeoutMs,
        }).api.version.get();
        if (!mounted.current || generation !== readGeneration.current) return;
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
          setMessage(
            available
              ? ""
              : "This host does not support workspace-metadata-v1. No workspace request was sent.",
          );
        }
      } catch {
        if (mounted.current && generation === readGeneration.current) {
          setCapability("unknown");
          setMessage(
            "Host capability check is unavailable. Retry before writing.",
          );
        }
      }
    }
    try {
      const readApi = createApiClient(origin, { timeoutMs });
      const { data, error } = await readApi.api.workspaces.get();
      if (!mounted.current || generation !== readGeneration.current) return;
      if (error) {
        if (workspaceErrorStatus(error) === 401) onUnauthorized();
        setReadError(
          "Could not load workspaces. Try Refresh workspaces again.",
        );
        return;
      }
      const rows = workspaceListFromValue(data);
      if (!rows) throw new Error("Invalid workspace list");
      setWorkspaces(rows);
      if (selectedId && !rows.some((workspace) => workspace.id === selectedId))
        setSelectedId(null);
    } catch {
      if (mounted.current && generation === readGeneration.current)
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
      if (!mounted.current || generation !== readGeneration.current) return;
      if (error) {
        if (workspaceErrorStatus(error) === 401) onUnauthorized();
        setReadError(
          "Could not open this workspace. Refresh the list and try again.",
        );
        return;
      }
      const confirmed = workspaceFromValue(data);
      if (!confirmed || confirmed.id !== workspace.id) {
        setReadError("Host returned invalid workspace metadata.");
        return;
      }
      setWorkspaces((items) =>
        items.map((item) => (item.id === confirmed.id ? confirmed : item)),
      );
    } catch {
      if (mounted.current && generation === readGeneration.current)
        setReadError(
          "Could not open this workspace. Refresh the list and try again.",
        );
    }
  }

  useEffect(() => {
    let active = true;
    const generation = ++storageGeneration.current;
    mounted.current = true;
    setStorageReady(false);
    setWorkspaces([]);
    setSelectedId(null);
    updatePending(null);
    setReadError("");
    void withPendingStorage(() =>
      AsyncStorage.getItem(storageKey(origin, userId)),
    )
      .then((raw) => {
        if (!active || generation !== storageGeneration.current) return;
        if (raw !== null) {
          const restored = pendingWorkspaceFromValue(JSON.parse(raw));
          if (!restored) throw new Error("Invalid pending workspace identity");
          updatePending(restored);
        }
        setStorageReady(true);
      })
      .catch(() => {
        if (active && generation === storageGeneration.current)
          setMessage(
            "Pending workspace recovery could not be read. Writes are disabled until device storage is repaired.",
          );
      });
    void refresh();
    return () => {
      active = false;
      mounted.current = false;
      storageGeneration.current++;
      const unsent = unsentPending.current;
      if (unsent) void removeStoredPending(unsent, true).catch(() => undefined);
    };
  }, [api, origin, userId]);

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
      const receiptApi = createApiClient(origin, {
        timeoutMs: Math.min(2_000, remaining),
      });
      const result = await receiptApi.api.workspaces
        .receipts({ requestId: operation.requestId })
        .outcome.get();
      if (!mounted.current) return;
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
      if (!(await clearPendingAfterReceipt(operation, end))) {
        if (!mounted.current) return;
        setMessage(
          workspaceDeadlineIsOpen(end)
            ? "Receipt found, but pending identity was not safely cleared. Writes remain disabled."
            : "Receipt arrived after the deadline. Outcome remains unknown; check again manually.",
        );
        return;
      }
      if (Date.now() < end) {
        await refresh(Math.min(2_000, end - Date.now()));
        if (!mounted.current) return;
        setMessage("Workspace change confirmed.");
      } else if (mounted.current)
        setMessage(
          "Workspace change confirmed. Refresh to read current workspace metadata.",
        );
    } catch {
      if (mounted.current)
        setMessage("Receipt lookup failed. Outcome remains unknown.");
    } finally {
      if (mounted.current && !duringMutation) setBusy(false);
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
      const preflight = await createApiClient(origin, {
        timeoutMs: remaining,
      }).api.version.get();
      if (!mounted.current) return;
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
      const generation = storageGeneration.current;
      const requestId = randomUUID();
      operation =
        kind === "create"
          ? { kind, requestId }
          : { kind, requestId, workspaceId: workspace!.id };
      if (!(await persistPending(operation, end))) return;
      if (!mounted.current || generation !== storageGeneration.current) return;
      const remainingBeforePost = end - Date.now();
      if (remainingBeforePost <= 0) {
        setStorageReady(false);
        setMessage(
          "No workspace request was sent; pending ID cleanup is running. Writes remain disabled until storage confirms cleanup.",
        );
        void cleanupUnsentPending(operation, generation);
        return;
      }
      const writeApi = createApiClient(origin, {
        timeoutMs: remainingBeforePost,
      });
      unsentPending.current = null;
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
      if (!mounted.current) return;
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
      if (!(await clearPendingAfterReceipt(operation, end))) {
        if (!mounted.current) return;
        setMessage(
          workspaceDeadlineIsOpen(end)
            ? "Receipt found, but pending identity was not safely cleared. Writes remain disabled."
            : "Workspace response arrived after the deadline. Outcome remains unknown; check its receipt manually.",
        );
        return;
      }
      if (!mounted.current) return;
      setName("");
      setRename("");
      if (Date.now() < end) {
        await refresh(Math.min(2_000, end - Date.now()));
        if (!mounted.current) return;
        setMessage("Workspace change confirmed.");
      } else if (mounted.current)
        setMessage(
          "Workspace change confirmed. Refresh to read current workspace metadata.",
        );
    } catch {
      if (mounted.current) {
        setMessage(
          "Workspace request outcome is unknown. Check its receipt; no mutation will be replayed.",
        );
        if (operation && Date.now() < end)
          await loadReceipt(operation, true, end);
      }
    } finally {
      if (mounted.current) setBusy(false);
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
      {!storageReady ? <Text>Checking workspace recovery storage…</Text> : null}
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
      {message ? (
        <Text accessibilityLiveRegion="polite" testID="workspace-status">
          {message}
        </Text>
      ) : null}
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
