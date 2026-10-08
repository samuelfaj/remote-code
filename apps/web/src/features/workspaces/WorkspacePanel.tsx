import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native-web";
import { color, space, ui } from "../../design/tokens";
import {
  createApiClient,
  pendingWorkspaceFromValue,
  workspaceErrorStatus,
  workspaceDeadlineIsOpen,
  workspaceListFromValue,
  workspaceReceiptFromValue,
  workspaceGitStatus,
  workspaceGitDiff,
} from "@remotecode/client";
import type { GitDiff, GitStatus, PendingWorkspace, Workspace } from "@remotecode/client";
import { Icon } from "../shell/icons";
import type { LiveSignals } from "../shell/live";

function safeTestId(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

const deadlineMs = 10_000;
type Props = {
  userId: string;
  onUnauthorized: () => void;
  selectedWorkspaceId?: string | null;
  live?: LiveSignals;
  /** Bumped by the sidebar's Refresh workspaces action. */
  refreshSignal?: number;
};

function storageKey(userId: string) {
  return `remotecode.pending-workspace:${JSON.stringify([window.location.origin, userId])}`;
}

export function WorkspacePanel({ userId, onUnauthorized, selectedWorkspaceId, live, refreshSignal }: Props) {
  const active = useRef(true);
  const readGeneration = useRef(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Sync selectedId with parent's selectedWorkspaceId
  useEffect(() => {
    if (selectedWorkspaceId) setSelectedId(selectedWorkspaceId);
  }, [selectedWorkspaceId]);
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
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  // The git view is a snapshot of a folder that work keeps changing, so it
  // has to be reloadable without reselecting the workspace.
  const [gitReload, setGitReload] = useState(0);
  const [gitDiff, setGitDiff] = useState<GitDiff | null>(null);
  const [gitSelectedFile, setGitSelectedFile] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
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
  }, [userId]);

  // A live signal is a bumped counter, not data: when the host reports that
  // workspaces changed, re-read the authoritative list rather than trusting it.
  const liveWorkspaces = live?.workspaces;
  useEffect(() => {
    if (liveWorkspaces === undefined) return;
    void refresh(deadlineMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveWorkspaces]);

  // The sidebar's Refresh workspaces action renegotiates the host capability too,
  // because the create button is gated on it.
  useEffect(() => {
    if (!refreshSignal) return;
    void refresh(deadlineMs, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // A files signal re-reads git status; gitReload already drives that read.
  const liveFiles = live?.files;
  useEffect(() => {
    if (liveFiles === undefined) return;
    setGitReload((count) => count + 1);
  }, [liveFiles]);

  useEffect(() => {
    if (!selected) {
      setGitStatus(null);
      setGitDiff(null);
      setGitSelectedFile(null);
      setGitError("");
      return;
    }
    const workspaceId = selected.id;
    let cancelled = false;
    async function fetchStatus() {
      try {
        const status = await workspaceGitStatus(workspaceId, window.location.origin);
        if (!cancelled) {
          setGitStatus(status);
          setGitDiff(null);
          setGitSelectedFile(null);
          setGitError("");
        }
      } catch (error) {
        if (!cancelled) {
          setGitStatus(null);
          setGitDiff(null);
          setGitSelectedFile(null);
          setGitError(
            error instanceof Error && error.message === "not_a_repository"
              ? "No git repository in this workspace."
              : "Git status is unavailable.",
          );
        }
      }
    }
    void fetchStatus();
    return () => {
      cancelled = true;
    };
  }, [selected?.id, gitReload]);

  async function selectGitFile(path: string) {
    if (!selected) return;
    setGitSelectedFile(path);
    setGitLoading(true);
    try {
      const diff = await workspaceGitDiff(selected.id, path, window.location.origin);
      setGitDiff(diff);
      setGitError("");
    } catch (error) {
      setGitDiff(null);
      setGitError(
        error instanceof Error ? error.message : "Could not load diff.",
      );
    } finally {
      setGitLoading(false);
    }
  }

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

  const createDisabled =
    busy || Boolean(pending) || capability === "unsupported" || !storageReady || !name.trim();

  return (
    <View style={styles.panel} testID="workspace-panel">
      <View style={ui.section}>
        <View style={ui.sectionHeader}>
          <Icon name="folder" size={12} />
          <Text accessibilityRole="header" style={ui.sectionLabel}>
            Workspaces
          </Text>
        </View>
        <View style={ui.field}>
          <Text style={ui.fieldLabel}>Workspace name</Text>
          <TextInput
            accessibilityLabel="Workspace name"
            value={name}
            onChangeText={setName}
            placeholder="Workspace name"
            style={styles.input}
          />
        </View>
        <View style={ui.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create workspace"
            disabled={createDisabled}
            onPress={() => void mutate("create")}
            style={[styles.button, createDisabled && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>Create workspace</Text>
          </Pressable>
        </View>
        {capability === "unsupported" ? (
          <View style={ui.statusRow}>
            <View style={[ui.dot, styles.dotWarning]} />
            <Text testID="workspace-unsupported" style={ui.warning}>
              This host does not support workspace-metadata-v1. Writes are disabled.
            </Text>
          </View>
        ) : null}
      </View>
      {selected ? (
        <View style={styles.selected} testID="selected-workspace">
          <View style={ui.sectionHeader}>
            <Icon name="check" size={12} />
            <Text style={ui.sectionLabel}>Selected workspace</Text>
          </View>
          <Text style={ui.body}>Selected: {selected.name}</Text>
          {!selected.archived ? (
            <>
              <View style={ui.field}>
                <Text style={ui.fieldLabel}>New workspace name</Text>
                <TextInput
                  accessibilityLabel="New workspace name"
                  value={rename}
                  onChangeText={setRename}
                  placeholder="New workspace name"
                  style={styles.input}
                />
              </View>
              <View style={ui.row}>
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
                  <Text style={ui.buttonLabel}>Archive workspace</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={ui.emptyText}>Archived workspaces are read-only.</Text>
          )}
        </View>
      ) : null}
      {pending ? (
        <View style={styles.pending}>
          <View style={ui.sectionHeader}>
            <Icon name="clock" size={12} />
            <Text style={ui.sectionLabel}>Pending confirmation</Text>
          </View>
          <Text style={ui.hint}>
            Workspace operation awaits confirmation. Check its receipt; it will
            not be resent.
          </Text>
          <View style={ui.row}>
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
        </View>
      ) : null}
      {readError ? (
        <Text accessibilityRole="alert" testID="workspace-read-error" style={ui.error}>
          {readError}
        </Text>
      ) : null}
      {message ? (
        <View style={ui.statusRow}>
          <View style={[ui.dot, styles.dotNeutral]} />
          <Text testID="workspace-status" style={ui.meta}>{message}</Text>
        </View>
      ) : null}
      {selected ? (
        <View style={styles.gitPanel} testID="git-status">
          <View style={ui.sectionHeader}>
            <Icon name="branch" size={12} />
            <Text accessibilityRole="header" style={ui.sectionLabel}>
              Git
            </Text>
          </View>
          <View style={ui.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh git status"
              testID="refresh-git-status"
              onPress={() => setGitReload((count) => count + 1)}
              style={styles.secondary}
            >
              <Text style={ui.buttonLabel}>Refresh git status</Text>
            </Pressable>
          </View>
          {gitError ? (
            <Text style={ui.error}>{gitError}</Text>
          ) : gitStatus ? (
            <>
              <View style={ui.statusRow}>
                <View style={[ui.dot, gitStatus.clean ? styles.dotSuccess : styles.dotWarning]} />
                <Text style={ui.meta}>
                  Branch: {gitStatus.branch ?? "unknown"}{" "}
                  {gitStatus.clean ? "(clean)" : "(dirty)"}
                </Text>
              </View>
              {gitStatus.changed.length > 0 && (
                <>
                  <Text style={[ui.sectionLabel, styles.subLabel]}>Changed</Text>
                  {gitStatus.changed.map((path) => (
                    <Pressable
                      key={path}
                      accessibilityRole="button"
                      accessibilityLabel={`Show diff for ${path}`}
                      testID={`git-file-${safeTestId(path)}`}
                      onPress={() => void selectGitFile(path)}
                      style={[
                        styles.gitFileRow,
                        gitSelectedFile === path ? styles.gitFileRowSelected : undefined,
                      ]}
                    >
                      <Icon name="file" size={12} />
                      <Text style={styles.gitFilePath}>{path}</Text>
                    </Pressable>
                  ))}
                </>
              )}
              {gitStatus.untracked.length > 0 && (
                <>
                  <Text style={[ui.sectionLabel, styles.subLabel]}>Untracked</Text>
                  {gitStatus.untracked.map((path) => (
                    <Pressable
                      key={path}
                      accessibilityRole="button"
                      accessibilityLabel={`Show diff for ${path}`}
                      testID={`git-file-${safeTestId(path)}`}
                      onPress={() => void selectGitFile(path)}
                      style={[
                        styles.gitFileRow,
                        gitSelectedFile === path ? styles.gitFileRowSelected : undefined,
                      ]}
                    >
                      <Icon name="file" size={12} />
                      <Text style={styles.gitFilePath}>{path}</Text>
                    </Pressable>
                  ))}
                </>
              )}
              {gitStatus.changed.length === 0 && gitStatus.untracked.length === 0 && (
                <Text style={ui.emptyText}>No changed or untracked files.</Text>
              )}
              {gitDiff ? (
                <View style={ui.card}>
                  <Text testID="git-diff" style={ui.mono}>{gitDiff.diff}</Text>
                  {gitDiff.truncated && (
                    <Text style={ui.hint}>Diff truncated.</Text>
                  )}
                </View>
              ) : null}
              {gitSelectedFile && !gitDiff && !gitLoading && !gitError ? (
                <Text style={ui.hint}>Select a file to view its diff.</Text>
              ) : null}
              {gitLoading ? <Text style={ui.hint}>Loading diff…</Text> : null}
            </>
          ) : (
            <Text style={ui.hint}>Loading git status…</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: space.md,
  },
  input: {
    ...ui.input,
  },
  button: {
    ...ui.buttonPrimary,
  },
  buttonText: {
    ...ui.buttonLabelPrimary,
  },
  buttonDisabled: {
    ...ui.buttonDisabled,
  },
  secondary: {
    ...ui.button,
  },
  selected: {
    ...ui.section,
    borderTopWidth: 1,
    borderTopColor: color.line,
    paddingTop: space.md,
  },
  pending: {
    ...ui.section,
    borderTopWidth: 1,
    borderTopColor: color.line,
    paddingTop: space.md,
  },
  gitPanel: {
    ...ui.section,
    borderTopWidth: 1,
    borderTopColor: color.line,
    paddingTop: space.md,
  },
  subLabel: {
    paddingTop: space.xs,
  },
  gitFileRow: {
    ...ui.listItem,
    alignItems: "center",
    flexDirection: "row",
    gap: space.sm,
    minHeight: 28,
  },
  gitFileRowSelected: {
    ...ui.listItemSelected,
  },
  gitFilePath: {
    ...ui.mono,
    flexShrink: 1,
    minWidth: 0,
  },
  dotNeutral: {
    backgroundColor: color.textTertiary,
  },
  dotSuccess: {
    backgroundColor: color.success,
  },
  dotWarning: {
    backgroundColor: color.warning,
  },
});
