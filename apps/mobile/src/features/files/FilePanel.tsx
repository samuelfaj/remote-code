import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { createApiClient, fileConflictVersion, fileReceiptFromValue, pendingFileValueMatches, workspaceErrorStatus, workspaceFromValue, type PendingFile, type PendingFolder, type Workspace } from "@remotecode/client";
import { beforeFileDeadline, clearPendingFolder, clearStoredFile, directoryFromValue, fileStorageKey, folderStorageKey, folderStateFromValue, isMissingFilePath, isTargetExists, isVersionConflict, nextFileInputScope, openFileFromValue, persistPendingFolder, persistStoredFile, readPendingFile, readPendingFolder, textSha256, validPath, validText, type FileEntry, type FileInputScope, type OpenFile } from "./file-editor";

const deadlineMs = 10_000;
let storageQueue = Promise.resolve();
function queued<T>(work: () => Promise<T>) {
  const result = storageQueue.then(work);
  storageQueue = result.then(() => undefined, () => undefined);
  return result;
}
type Props = { origin: string; userId: string; workspace: Workspace | null; blocked: boolean; onUnauthorized: () => void };
type Inspection = { workspaceId: string; supported: boolean; folder: "provisioned" | "not_provisioned" | "unknown"; archived: boolean };
type Editor = { host: OpenFile; draft: string; needsRead: boolean };

export function FilePanel({ origin, userId, workspace, blocked, onUnauthorized }: Props) {
  const key = fileStorageKey(origin, userId);
  const folderKey = folderStorageKey(origin, userId);
  const live = useRef({ origin, userId, workspace, blocked });
  live.current = { origin, userId, workspace, blocked };
  const inputScopeRef = useRef<FileInputScope | null>(null);
  const inputScope = useMemo(() => nextFileInputScope(inputScopeRef.current, origin, userId, workspace?.id ?? null), [origin, userId, workspace?.id]);
  useLayoutEffect(() => {
    inputScopeRef.current = inputScope;
    return () => { inputScopeRef.current = null; };
  }, [inputScope]);
  const active = useRef(false);
  const epoch = useRef(0);
  const storageEpoch = useRef(0);
  const working = useRef(false);
  const pendingRef = useRef<PendingFile | null>(null);
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | null>(null);
  const pendingFolderRef = useRef<PendingFolder | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [listing, setListing] = useState<{ workspaceId: string; path: string; entries: FileEntry[] } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [createPath, setCreatePath] = useState("");
  const [createText, setCreateText] = useState("");
  const [moveDestination, setMoveDestination] = useState("");
  const [message, setMessage] = useState("");
  editorRef.current = editor;
  const currentEditor = editor?.host.workspaceId === workspace?.id ? editor : null;
  const currentListing = listing?.workspaceId === workspace?.id ? listing : null;
  const inspected = inspection?.workspaceId === workspace?.id ? inspection : null;

  function begin() {
    const mine = ++epoch.current;
    const id = workspace?.id;
    const archived = workspace?.archived;
    return () => active.current && epoch.current === mine && live.current.origin === origin && live.current.userId === userId &&
      live.current.workspace?.id === id && live.current.workspace?.archived === archived && live.current.blocked === blocked;
  }
  function request(end: number) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("File deadline expired");
    return createApiClient(origin, { timeoutMs: remaining });
  }
  function unauthorized(error: unknown) { if (workspaceErrorStatus(error) === 401) onUnauthorized(); }
  function updatePending(value: PendingFile | null) { pendingRef.current = value; setPending(value); }
  function updateFolder(value: PendingFolder | null) { pendingFolderRef.current = value; setPendingFolder(value); }
  async function session(end: number, current: () => boolean) {
    const result = await request(end).api.auth.session.get();
    if (!current()) return false;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (result.error) { unauthorized(result.error); throw new Error("Session could not be confirmed"); }
    if (!result.data || !("userId" in result.data) || result.data.userId !== userId) { onUnauthorized(); return false; }
    return true;
  }
  async function inspect(end: number, current: () => boolean, folderOperation: PendingFolder | null = pendingFolderRef.current) {
    if (!workspace) return null;
    setInspection(null);
    const version = await request(end).api.version.get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (version.error || !Array.isArray(version.data?.capabilities)) throw new Error("Capabilities unavailable");
    if (!version.data.capabilities.includes("workspace-files-v1")) {
      setInspection({ workspaceId: workspace.id, supported: false, folder: "unknown", archived: workspace.archived });
      setMessage("This host does not support workspace-files-v1. No file request was sent.");
      return null;
    }
    if (!await session(end, current)) return null;
    const owner = await request(end).api.workspaces({ workspaceId: workspace.id }).get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (owner.error) { unauthorized(owner.error); throw new Error("Workspace ownership unavailable"); }
    const confirmed = workspaceFromValue(owner.data);
    if (!confirmed) throw new Error("Host returned invalid workspace metadata");
    if (confirmed.id !== workspace.id) throw new Error("Host returned metadata for a different workspace");
    const folder = await request(end).api.workspaces({ workspaceId: workspace.id }).folder.get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (folder.error) { unauthorized(folder.error); throw new Error("Folder status unavailable"); }
    const original = folderOperation?.workspaceId === workspace.id ? folderOperation : null;
    const state = folderStateFromValue(folder.data, workspace.id, original?.requestId);
    if (!state) throw new Error("Folder status did not match the original pending request");
    if (original) {
      const stored = await beforeFileDeadline(queued(() => readPendingFolder(AsyncStorage, folderKey)), end);
      if (!current() || stored.expired || stored.value?.requestId !== original.requestId || stored.value.workspaceId !== original.workspaceId) throw new Error("Pending folder storage identity unavailable");
      const file = await beforeFileDeadline(queued(() => AsyncStorage.getItem(key)), end);
      if (!current() || file.expired) throw new Error("Pending file storage unavailable");
      updatePending(readPendingFile(file.value));
      if (state === "provisioned") {
        const cleared = await beforeFileDeadline(queued(() => clearPendingFolder(AsyncStorage, folderKey, original, () => current() && Date.now() < end)), end);
        if (!current() || cleared.expired || !cleared.value) throw new Error("Pending folder storage cleanup unavailable");
        updateFolder(null);
      }
      setStorageReady(true);
    }
    const result = { workspaceId: workspace.id, supported: true, folder: state, archived: confirmed.archived };
    setInspection(result);
    if (state !== "provisioned") setMessage(state === "not_provisioned" ? "Folder not provisioned. Inspection created no folder." : "Folder status unknown. Writes disabled.");
    return result;
  }
  async function read(path: string, content = false) {
    if (!workspace || working.current || blocked) return;
    const old = editorRef.current;
    const same = old?.host.workspaceId === workspace.id && old.host.path === path;
    if (content && old && !same && old.draft !== old.host.content) {
      if (pendingRef.current) { setMessage("Resolve the pending receipt before replacing this draft."); return; }
      Alert.alert("Discard unsaved draft?", "Opening another file replaces this in-memory draft.", [
        { text: "Cancel", style: "cancel" },
        { text: "Discard and open", style: "destructive", onPress: () => {
          if (!active.current || inputScopeRef.current !== inputScope || live.current.workspace?.id !== workspace.id || live.current.userId !== userId || live.current.origin !== origin || editorRef.current?.host !== old.host || pendingRef.current) return;
          editorRef.current = { ...old, draft: old.host.content };
          setEditor(editorRef.current);
          void read(path, true);
        } },
      ]);
      return;
    }
    const current = begin();
    const end = Date.now() + deadlineMs;
    working.current = true; setBusy(true); setMessage("Reading current host files…");
    if (same) setEditor(value => value ? { ...value, needsRead: true } : value);
    try {
      const state = await inspect(end, current);
      if (!current() || state?.folder !== "provisioned") return;
      const files = request(end).api.workspaces({ workspaceId: workspace.id }).files;
      if (content) {
        const response = await files.content.get({ query: { path } });
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File deadline expired");
        if (response.error) {
          unauthorized(response.error);
          setInspection(null);
          setMessage(workspaceErrorStatus(response.error) === 503 && (response.error as { value?: { error?: unknown } }).value?.error === "request_outcome_unknown"
            ? "File read was not confirmed. Draft kept; retry the read manually."
            : "Host refused the file read. Binary, invalid UTF-8 and files over 1 MiB cannot be edited. Draft kept; retry the read manually.");
          return;
        }
        const host = await openFileFromValue(response.data, workspace.id, path);
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File deadline expired");
        if (!host) { setInspection(null); setMessage("Host response did not match the requested file. Draft kept; retry the read manually."); return; }
        if (!same && editorRef.current?.draft !== old?.draft) { setMessage("Draft changed while reading another file. Draft kept; open again to confirm discard."); return; }
        setEditor(value => ({ host, draft: same && value ? value.draft : host.content, needsRead: false }));
        setMessage(same ? "Current host text read. Draft kept; compare before writing." : "Text and version read from host.");
      } else {
        const response = await files.get({ query: path ? { path } : {} });
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File deadline expired");
        if (response.error) {
          unauthorized(response.error);
          setInspection(null); setListing(null);
          setMessage(workspaceErrorStatus(response.error) === 503 && (response.error as { value?: { error?: unknown } }).value?.error === "request_outcome_unknown"
            ? "Folder listing was not confirmed. Refresh manually; writes stay disabled."
            : "Host refused the folder listing. Refresh manually; writes stay disabled.");
          return;
        }
        const entries = directoryFromValue(response.data, path);
        if (!entries) { setInspection(null); setListing(null); setMessage("Host response did not match the requested folder. Refresh manually; writes stay disabled."); return; }
        setListing({ workspaceId: workspace.id, path, entries });
        setMessage(state.archived ? "Archived workspace. Files are read-only." : "Folder and files confirmed by host.");
      }
    } catch {
      if (current()) { setInspection(null); if (!content) setListing(null); setMessage(content ? "File read was not confirmed. Draft kept; retry the read manually." : "Folder listing was not confirmed. Refresh manually; writes stay disabled."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }
  async function clearConfirmed(operation: PendingFile, end: number, current: () => boolean) {
    const allowed = () => current() && Date.now() < end;
    const result = await beforeFileDeadline(queued(() => clearStoredFile(AsyncStorage, key, operation, allowed)), end);
    if (!current()) return false;
    if (result.expired || !result.value) { setStorageReady(false); return false; }
    updatePending(null); setStorageReady(true);
    return true;
  }
  function cleanupUnsent(operation: PendingFile, storeGeneration: number) {
    const task = queued(() => clearStoredFile(AsyncStorage, key, operation, () => true, true));
    void task.then(cleared => {
      if (!active.current || storageEpoch.current !== storeGeneration || live.current.origin !== origin || live.current.userId !== userId || !pendingFileValueMatches(JSON.stringify(pendingRef.current), operation)) return;
      if (cleared) { updatePending(null); setStorageReady(true); setMessage("No file mutation was sent. Unsent identity cleanup confirmed."); }
      else { setStorageReady(false); setMessage("No file mutation was sent. Identity cleanup is unverified; writes disabled."); }
    }).catch(() => {
      if (active.current && storageEpoch.current === storeGeneration) setStorageReady(false);
    });
  }
  async function prepareFolder() {
    if (!workspace || working.current || blocked || workspace.archived || !storageReady || pendingRef.current) return;
    if (pendingFolderRef.current && pendingFolderRef.current.workspaceId !== workspace.id) { setMessage("Select the original workspace to inspect its pending folder request."); return; }
    const current = begin(); const end = Date.now() + deadlineMs;
    working.current = true; setBusy(true); setMessage("Checking workspace folder before preparation…");
    let operation = pendingFolderRef.current;
    try {
      const state = await inspect(end, current);
      if (!current() || !state || state.archived || (state.folder !== "not_provisioned" && !(operation && state.folder === "unknown"))) return;
      if (!operation) {
        operation = { workspaceId: workspace.id, requestId: randomUUID() };
        updateFolder(operation);
        const saved = await beforeFileDeadline(queued(() => persistPendingFolder(AsyncStorage, folderKey, operation!, () => current() && Date.now() < end)), end);
        if (!current() || saved.expired || saved.value !== "saved") { setStorageReady(false); setMessage("Folder request ID could not be safely persisted. No request was sent; writes remain disabled."); return; }
        updateFolder(operation);
      }
      const stored = await beforeFileDeadline(queued(() => readPendingFolder(AsyncStorage, folderKey)), end);
      if (!current() || stored.expired || stored.value?.requestId !== operation.requestId || stored.value.workspaceId !== operation.workspaceId) throw new Error("Original folder identity unavailable before submission");
      if (!current() || Date.now() >= end) { setMessage("Preparation expired before submission. Original request ID retained."); return; }
      const response = await request(end).api.workspaces({ workspaceId: operation.workspaceId }).folder.post({ requestId: operation.requestId });
      if (!current()) return;
      if (Date.now() >= end) { setMessage("Folder preparation outcome is unknown. Original request ID retained; no automatic retry."); return; }
      if (response.error) { unauthorized(response.error); setMessage("Folder preparation was not confirmed. Original request ID retained; inspect status before any same-ID continuation."); return; }
      const confirmed = await inspect(end, current, operation);
      if (current() && confirmed?.folder === "provisioned") {
        setMessage("Workspace folder confirmed with the original request ID.");
        const refreshed = await request(end).api.workspaces({ workspaceId: operation.workspaceId }).files.get();
        if (current() && !refreshed.error && Date.now() < end) {
          const entries = directoryFromValue(refreshed.data, "");
          if (entries) setListing({ workspaceId: operation.workspaceId, path: "", entries });
        }
      } else if (current()) setMessage("Folder preparation remains unconfirmed. Original request ID retained; no new ID was created.");
    } catch {
      if (current()) { setStorageReady(false); setMessage("Folder preparation outcome or storage is unknown. Original request ID is retained; no automatic retry."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  async function mutate(kind: PendingFile["kind"]) {
    const value = editorRef.current;
    const snapshotText = kind === "create" ? createText : value?.draft;
    const snapshotPath = createPath;
    const snapshotDestination = moveDestination;
    if (!workspace || working.current || blocked || workspace.archived || !storageReady || pendingRef.current || pendingFolderRef.current ||
      inspected?.folder !== "provisioned" || inspected.archived) return;
    if (kind === "create") {
      if (!validPath(snapshotPath) || !validText(snapshotText ?? "")) return;
    } else if (!value || value.host.workspaceId !== workspace.id || value.needsRead || !validText(snapshotText ?? "")) return;
    if (kind === "save" && (!value || snapshotText === value.host.content)) return;
    if (kind === "move" && (!value || snapshotText !== value.host.content || !validPath(snapshotDestination) || snapshotDestination === value.host.path)) return;
    const content = snapshotText ?? "";
    const current = begin();
    const end = Date.now() + deadlineMs;
    const storeGeneration = storageEpoch.current;
    working.current = true; setBusy(true); setMessage(`Checking ${kind.toUpperCase()} authority…`);
    let operation: PendingFile | null = null;
    let sent = false;
    try {
      const state = await inspect(end, current);
      if (!current() || state?.folder !== "provisioned" || state.archived || Date.now() >= end) {
        if (current() && state?.archived) setMessage(`Workspace is archived. No ${kind.toUpperCase()} request was sent.`);
        return;
      }
      if (kind === "move" && (editorRef.current?.host !== value!.host || editorRef.current.needsRead || editorRef.current.draft !== editorRef.current.host.content)) {
        setMessage("MOVE requires the same current verified OPEN. No MOVE request was sent; draft kept.");
        return;
      }
      if (!current() || Date.now() >= end) throw new Error("File deadline expired");
      const requestId = randomUUID();
      operation = kind === "move"
        ? { kind, requestId, workspaceId: workspace.id, sourcePath: value!.host.path, destinationPath: snapshotDestination, expectedVersion: value!.host.version }
        : { kind, requestId, workspaceId: workspace.id, path: kind === "create" ? snapshotPath : value!.host.path, resultSha256: await textSha256(content) };
      if (!current() || Date.now() >= end) throw new Error("File deadline expired");
      updatePending(operation); setStorageReady(false);
      const identity = operation;
      const allowed = () => current() && Date.now() < end;
      const persisted = await beforeFileDeadline(queued(() => persistStoredFile(AsyncStorage, key, identity, allowed)), end);
      if (persisted.expired || !current() || Date.now() >= end) { cleanupUnsent(identity, storeGeneration); return; }
      if (persisted.value !== "saved") {
        if (persisted.value === "cleaned" || persisted.value === "not_written") { updatePending(null); setStorageReady(true); }
        setMessage(`No ${kind.toUpperCase()} was sent. Pending identity could not be verified; repair storage before writing.`);
        return;
      }
      if (kind === "move" && (editorRef.current?.host !== value!.host || editorRef.current.needsRead || editorRef.current.draft !== editorRef.current.host.content)) {
        cleanupUnsent(identity, storeGeneration);
        setMessage("No MOVE was sent. Draft changed during preflight or storage; draft kept.");
        return;
      }
      if (value) setEditor(item => item?.host === value.host ? { ...item, needsRead: true } : item);
      sent = true;
      const files = request(end).api.workspaces({ workspaceId: identity.workspaceId }).files;
      const response = identity.kind === "move"
        ? await files.move.post({ requestId: identity.requestId, sourcePath: identity.sourcePath, destinationPath: identity.destinationPath, expectedVersion: identity.expectedVersion })
        : identity.kind === "create"
          ? await files.post({ requestId: identity.requestId, path: identity.path, content })
          : await files.content.put({ requestId: identity.requestId, path: identity.path, content, expectedVersion: value!.host.version });
      if (!current()) return;
      if (Date.now() >= end) throw new Error("File deadline expired");
      if (response.error) {
        unauthorized(response.error);
        const label = kind.toUpperCase();
        if (identity.kind !== "create" && isVersionConflict(response.error)) {
          const currentVersion = fileConflictVersion(response.error);
          const retry = identity.kind === "move"
            ? "Re-open the source path to read its current version before another explicit MOVE."
            : `Read current host text and compare before another explicit ${label}.`;
          if (await clearConfirmed(identity, end, current)) setMessage(currentVersion
            ? `Version conflict: ${label} was refused. Another client saved first; current host version starts ${currentVersion.slice(0, 8)}. Draft kept. ${retry}`
            : `Version conflict: ${label} was refused. The host did not return the conflicting version. Draft kept. ${retry}`);
        } else if (identity.kind !== "save" && (isTargetExists(response.error) || isMissingFilePath(response.error, identity.kind))) {
          if (await clearConfirmed(identity, end, current)) setMessage(`${label} was refused: ${isTargetExists(response.error) ? "target already exists" : "source or parent path is unavailable"}. No file change occurred. Inputs and draft kept; choose an existing parent and current source explicitly.`);
        } else if (current()) setMessage(`${label} was not confirmed. Keep pending identity and inputs; check its receipt manually. No retry.`);
        return;
      }
      if (!fileReceiptFromValue(response.data, identity, workspace.id)) { setMessage(`${kind.toUpperCase()} receipt did not match pending identity. Outcome unknown; request ID kept.`); return; }
      if (await clearConfirmed(identity, end, current)) setMessage(`${kind.toUpperCase()} receipt confirmed. Inputs and draft kept. Historical receipt is not a writable baseline; explicitly OPEN current file content before writing again.`);
      else if (current()) setMessage("Receipt found, but identity cleanup is unverified. Writes remain blocked.");
    } catch {
      if (!sent && operation) cleanupUnsent(operation, storeGeneration);
      if (current()) { setInspection(null); setMessage(sent ? `${kind.toUpperCase()} outcome unknown. Request ID, inputs and draft kept; check receipt manually. No write retry.` : `No ${kind.toUpperCase()} was sent. Preflight or storage failed; refresh manually.`); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }
  async function checkReceipt() {
    const operation = pendingRef.current;
    if (!workspace || !operation || operation.workspaceId !== workspace.id || working.current) return;
    const current = begin();
    const end = Date.now() + deadlineMs;
    working.current = true; setBusy(true); setMessage("Checking file receipt. No file mutation will be resent.");
    try {
      if (!await session(end, current)) return;
      const stored = await beforeFileDeadline(queued(() => AsyncStorage.getItem(key)), end);
      if (!current()) return;
      if (stored.expired || !pendingFileValueMatches(stored.value, operation)) throw new Error("Pending identity unavailable");
      const response = await request(end).api.workspaces({ workspaceId: operation.workspaceId }).files.receipts({ requestId: operation.requestId }).get();
      if (!current()) return;
      if (Date.now() >= end) { setMessage("Receipt arrived after the deadline. Outcome remains unknown; check again manually."); return; }
      if (response.error) {
        unauthorized(response.error);
        setMessage(workspaceErrorStatus(response.error) === 404 ? "No matching receipt is available. Outcome remains unknown; pending identity and draft are kept."
          : "Receipt lookup failed. Outcome remains unknown; no write was resent.");
        return;
      }
      if (!fileReceiptFromValue(response.data, operation, workspace.id)) { setMessage("Receipt did not match persisted identity. Outcome unknown; request ID retained."); return; }
      if (await clearConfirmed(operation, end, current)) { setEditor(item => item?.host.workspaceId === workspace.id ? { ...item, needsRead: true } : item); setMessage("Historical file receipt confirmed. Read current host text before writing again."); }
      else if (current()) setMessage("Receipt found, but storage cleanup is unverified. Writes remain blocked.");
    } catch { if (current()) { setStorageReady(false); setMessage("Receipt or pending storage could not be checked. Outcome unknown; no file mutation resent."); } }
    finally { if (current()) { working.current = false; setBusy(false); } }
  }
  useLayoutEffect(() => {
    active.current = true;
    const storeGeneration = ++storageEpoch.current;
    epoch.current++;
    updatePending(null); setStorageReady(false); setEditor(null); editorRef.current = null;
    void queued(() => AsyncStorage.getItem(key)).then(async raw => {
      if (!active.current || storageEpoch.current !== storeGeneration || live.current.origin !== origin || live.current.userId !== userId) return;
      const folder = await queued(() => readPendingFolder(AsyncStorage, folderKey));
      updatePending(readPendingFile(raw)); updateFolder(folder); setStorageReady(true);
    }).catch(() => {
      if (active.current && storageEpoch.current === storeGeneration) { setStorageReady(false); setMessage("Pending file storage unavailable. Writes disabled; repair storage and relaunch."); }
    });
    return () => { active.current = false; storageEpoch.current++; epoch.current++; };
  }, [origin, userId]);
  useLayoutEffect(() => {
    setCreatePath(""); setCreateText(""); setMoveDestination("");
  }, [origin, userId, workspace?.id]);
  useLayoutEffect(() => {
    epoch.current++; working.current = false; setBusy(false); setInspection(null); setListing(null); setMessage("");
    if (workspace && !blocked) void read("");
  }, [origin, userId, workspace?.id, workspace?.archived, blocked]);
  const dirty = currentEditor !== null && currentEditor.draft !== currentEditor.host.content;
  const disabled = busy || blocked || !workspace || workspace.archived || !storageReady || Boolean(pending) || Boolean(pendingFolder) || !inspected?.supported || inspected.folder !== "provisioned" || inspected.archived;
  return <View style={styles.card} testID="file-panel">
    <Text accessibilityRole="header" style={styles.heading}>Files and editor</Text>
    {!workspace ? <Text>Select a workspace to inspect files.</Text> : <>
      <Text>Files in {workspace.name}{workspace.archived ? " (archived, read-only)" : ""}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh files" disabled={busy || blocked} onPress={() => void read(currentListing?.path ?? "")} style={styles.secondary}><Text>Refresh files</Text></Pressable>
      <Text testID="folder-status">{inspected?.supported === false ? "Files unavailable on this host." : inspected?.folder === "provisioned" ? "Folder provisioned on Linux." : inspected?.folder === "not_provisioned" ? "Folder not provisioned." : "Folder status unknown. Writes disabled."}</Text>
      {inspected?.supported && (inspected.folder === "not_provisioned" || pendingFolder?.workspaceId === workspace.id && inspected.folder === "unknown") && !workspace.archived && !inspected.archived ? <Pressable accessibilityRole="button" accessibilityLabel="Prepare workspace folder" disabled={busy || blocked || !storageReady || Boolean(pending)} onPress={() => void prepareFolder()} style={styles.secondary}><Text>{pendingFolder ? "Continue folder preparation with same request ID" : "Prepare workspace folder"}</Text></Pressable> : null}
      {pendingFolder ? <Text testID="pending-folder">Folder request remains unknown. Request ID: {pendingFolder.requestId}</Text> : null}
      {currentListing ? <>
        <Text>Directory: {currentListing.path || "Workspace root"}</Text>
        {currentListing.path ? <Pressable accessibilityRole="button" accessibilityLabel="Open parent directory" disabled={busy || blocked} onPress={() => void read(currentListing.path.split("/").slice(0, -1).join("/"))} style={styles.secondary}><Text>Parent directory</Text></Pressable> : null}
        {!currentListing.entries.length ? <Text>This directory is empty.</Text> : currentListing.entries.map(entry => <Pressable key={entry.name} accessibilityRole="button" accessibilityLabel={`Open ${entry.type} ${entry.name}`} disabled={busy || blocked} onPress={() => void read(currentListing.path ? `${currentListing.path}/${entry.name}` : entry.name, entry.type === "file")} style={styles.row}><Text>{entry.name}{entry.type === "directory" ? "/" : ` (${entry.size} bytes)`}</Text></Pressable>)}
      </> : null}
      <View style={styles.editor}>
        <Text accessibilityRole="header">Create text file</Text>
        <Text>Relative path in workspace; parent directory must exist. Existing files are never overwritten.</Text>
        <TextInput accessibilityLabel="New file path" value={createPath} editable={!workspace.archived && !inspected?.archived}
          autoCapitalize="none" autoCorrect={false} onChangeText={path => { if (active.current && inputScopeRef.current === inputScope) setCreatePath(path); }} style={styles.input}/>
        <TextInput accessibilityLabel="New file text" multiline value={createText} editable={!workspace.archived && !inspected?.archived}
          autoCapitalize="none" autoCorrect={false} onChangeText={text => { if (active.current && inputScopeRef.current === inputScope) setCreateText(text); }} style={styles.textarea}/>
        {(!validPath(createPath) || !validText(createText)) ? <Text>Use a valid relative path and UTF-8 text without NUL, up to 1 MiB.</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Create file" disabled={disabled || !validPath(createPath) || !validText(createText)}
          onPress={() => void mutate("create")} style={[styles.button, (disabled || !validPath(createPath) || !validText(createText)) && styles.disabled]}>
          <Text style={styles.buttonText}>Create file</Text>
        </Pressable>
      </View>
      {currentEditor ? <View style={styles.editor}>
        <Text>{currentEditor.host.path} · {currentEditor.needsRead ? "current version must be read" : "last read version available"}</Text>
        <TextInput accessibilityLabel="File draft" multiline value={currentEditor.draft} autoCapitalize="none" autoCorrect={false} editable={!workspace.archived && !inspected?.archived} onChangeText={draft => {
          const item = editorRef.current;
          if (!active.current || inputScopeRef.current !== inputScope || live.current.workspace?.id !== workspace.id || !item || item.host !== currentEditor.host) return;
          editorRef.current = { ...item, draft };
          setEditor(value => value?.host === item.host ? { ...value, draft } : value);
        }} style={styles.textarea}/>
        {dirty ? <><Text>Draft differs from last read host text.</Text><TextInput accessibilityLabel="Last read host text" multiline editable={false} value={currentEditor.host.content} style={styles.textarea}/></> : null}
        {!validText(currentEditor.draft) ? <Text accessibilityRole="alert">SAVE requires valid UTF-8 without NUL, at most 1 MiB.</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Read current file" disabled={busy || blocked} onPress={() => void read(currentEditor.host.path, true)} style={styles.secondary}><Text>Read current file (keep draft)</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Save file" disabled={disabled || currentEditor.needsRead || !dirty || !validText(currentEditor.draft)} onPress={() => void mutate("save")} style={[styles.button, (disabled || currentEditor.needsRead || !dirty) && styles.disabled]}><Text style={styles.buttonText}>Save file</Text></Pressable>
        <TextInput accessibilityLabel="Move destination path" value={moveDestination} editable={!workspace.archived && !inspected?.archived}
          autoCapitalize="none" autoCorrect={false} onChangeText={path => { if (active.current && inputScopeRef.current === inputScope) setMoveDestination(path); }} style={styles.input}/>
        <Text>MOVE uses this explicitly OPEN current version, never an unsaved draft. Destination parent must exist; MOVE never overwrites.</Text>
        {dirty ? <Text>MOVE requires a clean draft. SAVE or explicitly discard it before moving.</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Move file" disabled={disabled || currentEditor.needsRead || dirty || !validPath(moveDestination) || moveDestination === currentEditor.host.path}
          onPress={() => void mutate("move")} style={[styles.button, (disabled || currentEditor.needsRead || dirty || !validPath(moveDestination) || moveDestination === currentEditor.host.path) && styles.disabled]}>
          <Text style={styles.buttonText}>Move file</Text>
        </Pressable>
      </View> : null}
    </>}
    {pending ? <View style={styles.pending} testID="pending-file"><Text>File operation awaits confirmation. No automatic write retry.</Text><Text selectable>Request ID: {pending.requestId}</Text><Pressable accessibilityRole="button" accessibilityLabel="Check file receipt" disabled={busy || pending.workspaceId !== workspace?.id} onPress={() => void checkReceipt()} style={styles.secondary}><Text>{pending.workspaceId === workspace?.id ? "Check file receipt" : "Select original workspace to check receipt"}</Text></Pressable></View> : null}
    {!storageReady ? <Text accessibilityRole="alert">File recovery storage unavailable. Writes disabled.</Text> : null}
    {message ? <Text testID="file-status" accessibilityLiveRegion="polite">{message}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ card: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 16, borderWidth: 1, gap: 10, padding: 18 }, heading: { color: "#183337", fontSize: 18, fontWeight: "700" }, row: { borderTopColor: "#e3ebe7", borderTopWidth: 1, paddingVertical: 10 }, editor: { gap: 8 }, input: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, minHeight: 42, padding: 12 }, textarea: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, minHeight: 120, padding: 12, textAlignVertical: "top" }, button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 9, justifyContent: "center", minHeight: 42 }, disabled: { opacity: 0.55 }, buttonText: { color: "#fff", fontWeight: "700" }, secondary: { alignItems: "center", justifyContent: "center", minHeight: 40 }, pending: { backgroundColor: "#fff0cf", gap: 8, padding: 12 } });
