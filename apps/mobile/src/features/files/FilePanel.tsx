import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { createApiClient, fileReceiptFromValue, pendingFileValueMatches, workspaceErrorStatus, workspaceFromValue, type PendingFile, type Workspace } from "@remotecode/client";
import { beforeFileDeadline, clearStoredFile, directoryFromValue, fileStorageKey, folderStateFromValue, isVersionConflict, openFileFromValue, persistStoredFile, readPendingFile, textSha256, validText, type FileEntry, type OpenFile } from "./file-editor";

const deadlineMs = 10_000;
let storageQueue = Promise.resolve();
function queued<T>(work: () => Promise<T>) {
  const result = storageQueue.then(work);
  storageQueue = result.then(() => undefined, () => undefined);
  return result;
}
type Props = { origin: string; userId: string; workspace: Workspace | null; blocked: boolean; onUnauthorized: () => void };
type Inspection = { workspaceId: string; supported: boolean; provisioned: boolean; archived: boolean };
type Editor = { host: OpenFile; draft: string; needsRead: boolean };

export function FilePanel({ origin, userId, workspace, blocked, onUnauthorized }: Props) {
  const key = fileStorageKey(origin, userId);
  const live = useRef({ origin, userId, workspace, blocked });
  live.current = { origin, userId, workspace, blocked };
  const active = useRef(false);
  const epoch = useRef(0);
  const storageEpoch = useRef(0);
  const working = useRef(false);
  const pendingRef = useRef<PendingFile | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [listing, setListing] = useState<{ workspaceId: string; path: string; entries: FileEntry[] } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
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
  async function session(end: number, current: () => boolean) {
    const result = await request(end).api.auth.session.get();
    if (!current()) return false;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (result.error) { unauthorized(result.error); throw new Error("Session unavailable"); }
    if (!result.data || !("userId" in result.data) || result.data.userId !== userId) { onUnauthorized(); return false; }
    return true;
  }
  async function inspect(end: number, current: () => boolean) {
    if (!workspace) return null;
    setInspection(null);
    const version = await request(end).api.version.get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (version.error || !Array.isArray(version.data?.capabilities)) throw new Error("Capabilities unavailable");
    if (!version.data.capabilities.includes("workspace-files-v1")) {
      setInspection({ workspaceId: workspace.id, supported: false, provisioned: false, archived: workspace.archived });
      setMessage("This host does not support workspace-files-v1. No file request was sent.");
      return null;
    }
    if (!await session(end, current)) return null;
    const owner = await request(end).api.workspaces({ workspaceId: workspace.id }).get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (owner.error) { unauthorized(owner.error); throw new Error("Workspace unavailable"); }
    const confirmed = workspaceFromValue(owner.data);
    if (!confirmed || confirmed.id !== workspace.id) throw new Error("Invalid workspace");
    const folder = await request(end).api.workspaces({ workspaceId: workspace.id }).folder.get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File deadline expired");
    if (folder.error) { unauthorized(folder.error); throw new Error("Folder unavailable"); }
    const state = folderStateFromValue(folder.data, workspace.id);
    if (!state) throw new Error("Invalid folder status");
    const result = { workspaceId: workspace.id, supported: true, provisioned: state === "provisioned", archived: confirmed.archived };
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
          if (live.current.workspace?.id !== workspace.id || live.current.userId !== userId || live.current.origin !== origin || editorRef.current?.host !== old.host || pendingRef.current) return;
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
      if (!current() || !state?.provisioned) return;
      const files = request(end).api.workspaces({ workspaceId: workspace.id }).files;
      if (content) {
        const response = await files.content.get({ query: { path } });
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File deadline expired");
        if (response.error) { unauthorized(response.error); throw new Error("File unavailable"); }
        const host = await openFileFromValue(response.data, workspace.id, path);
        if (!current()) return;
        if (!host || Date.now() >= end) throw new Error("Invalid file content");
        if (!same && editorRef.current?.draft !== old?.draft) { setMessage("Draft changed while reading another file. Draft kept; open again to confirm discard."); return; }
        setEditor(value => ({ host, draft: same && value ? value.draft : host.content, needsRead: false }));
        setMessage(same ? "Current host text read. Draft kept; compare before writing." : "Text and version read from host.");
      } else {
        const response = await files.get({ query: path ? { path } : {} });
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File deadline expired");
        if (response.error) { unauthorized(response.error); throw new Error("Directory unavailable"); }
        const entries = directoryFromValue(response.data, path);
        if (!entries) throw new Error("Invalid listing");
        setListing({ workspaceId: workspace.id, path, entries });
        setMessage(state.archived ? "Archived workspace. Files are read-only." : "Folder and files confirmed by host.");
      }
    } catch {
      if (current()) { setInspection(null); if (!content) setListing(null); setMessage("Could not read current files. Draft kept; refresh manually before writing."); }
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
      if (cleared) { updatePending(null); setStorageReady(true); setMessage("No SAVE was sent. Unsent identity cleanup confirmed."); }
      else { setStorageReady(false); setMessage("No SAVE was sent. Identity cleanup is unverified; writes disabled."); }
    }).catch(() => {
      if (active.current && storageEpoch.current === storeGeneration) setStorageReady(false);
    });
  }
  async function save() {
    const value = editorRef.current;
    if (!workspace || !value || value.host.workspaceId !== workspace.id || working.current || blocked || workspace.archived ||
      !storageReady || pendingRef.current || value.needsRead || value.draft === value.host.content || !validText(value.draft) || !inspected?.provisioned || inspected.archived) return;
    const current = begin();
    const end = Date.now() + deadlineMs;
    const storeGeneration = storageEpoch.current;
    working.current = true; setBusy(true); setMessage("Checking SAVE authority…");
    let operation: PendingFile | null = null;
    let sent = false;
    try {
      const state = await inspect(end, current);
      if (!current() || !state?.provisioned || state.archived) return;
      const resultSha256 = await textSha256(value.draft);
      if (!current()) return;
      if (Date.now() >= end) throw new Error("File deadline expired");
      operation = { kind: "save", requestId: randomUUID(), workspaceId: workspace.id, path: value.host.path, resultSha256 };
      updatePending(operation); setStorageReady(false);
      const identity = operation;
      const allowed = () => current() && Date.now() < end;
      const persisted = await beforeFileDeadline(queued(() => persistStoredFile(AsyncStorage, key, identity, allowed)), end);
      if (persisted.expired || !current() || Date.now() >= end) { cleanupUnsent(identity, storeGeneration); return; }
      if (persisted.value !== "saved") {
        if (persisted.value === "cleaned" || persisted.value === "not_written") { updatePending(null); setStorageReady(true); }
        setMessage("No SAVE was sent. Pending storage could not be verified; repair storage before writing.");
        return;
      }
      setEditor(item => item?.host === value.host ? { ...item, needsRead: true } : item);
      sent = true;
      const response = await request(end).api.workspaces({ workspaceId: workspace.id }).files.content.put({ requestId: identity.requestId, path: identity.path, content: value.draft, expectedVersion: value.host.version });
      if (!current()) return;
      if (Date.now() >= end) throw new Error("File deadline expired");
      if (response.error) {
        unauthorized(response.error);
        if (isVersionConflict(response.error) && await clearConfirmed(identity, end, current)) setMessage("Version conflict. Draft kept; read current host text before another explicit SAVE.");
        else if (current()) setMessage("SAVE was not confirmed. Keep request ID and check its receipt manually; no retry.");
        return;
      }
      if (!fileReceiptFromValue(response.data, identity, workspace.id)) { setMessage("SAVE receipt did not match pending identity. Outcome unknown; request ID kept."); return; }
      if (await clearConfirmed(identity, end, current)) setMessage("SAVE receipt confirmed. Read current host text before another write; draft kept.");
      else if (current()) setMessage("Receipt found, but identity cleanup is unverified. Writes remain blocked.");
    } catch {
      if (!sent && operation) cleanupUnsent(operation, storeGeneration);
      if (current()) { setInspection(null); setMessage(sent ? "SAVE outcome unknown. Request ID and draft kept; check receipt manually." : "No SAVE was sent. Preflight or storage failed; refresh manually."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }
  async function checkReceipt() {
    const operation = pendingRef.current;
    if (!workspace || !operation || operation.workspaceId !== workspace.id || working.current) return;
    const current = begin();
    const end = Date.now() + deadlineMs;
    working.current = true; setBusy(true); setMessage("Checking file receipt. No SAVE will be resent.");
    try {
      if (!await session(end, current)) return;
      const stored = await beforeFileDeadline(queued(() => AsyncStorage.getItem(key)), end);
      if (!current()) return;
      if (stored.expired || !pendingFileValueMatches(stored.value, operation)) throw new Error("Pending identity unavailable");
      const response = await request(end).api.workspaces({ workspaceId: operation.workspaceId }).files.receipts({ requestId: operation.requestId }).get();
      if (!current()) return;
      if (Date.now() >= end) throw new Error("File deadline expired");
      if (response.error) { unauthorized(response.error); setMessage("Receipt unavailable. Outcome unknown; request ID retained."); return; }
      if (!fileReceiptFromValue(response.data, operation, workspace.id)) { setMessage("Receipt did not match persisted identity. Outcome unknown; request ID retained."); return; }
      if (await clearConfirmed(operation, end, current)) { setEditor(item => item?.host.workspaceId === workspace.id ? { ...item, needsRead: true } : item); setMessage("Historical file receipt confirmed. Read current host text before writing again."); }
      else if (current()) setMessage("Receipt found, but storage cleanup is unverified. Writes remain blocked.");
    } catch { if (current()) { setStorageReady(false); setMessage("Receipt or pending storage could not be checked. Outcome unknown; no SAVE resent."); } }
    finally { if (current()) { working.current = false; setBusy(false); } }
  }
  useLayoutEffect(() => {
    active.current = true;
    const storeGeneration = ++storageEpoch.current;
    epoch.current++;
    updatePending(null); setStorageReady(false); setEditor(null); editorRef.current = null;
    void queued(() => AsyncStorage.getItem(key)).then(raw => {
      if (!active.current || storageEpoch.current !== storeGeneration || live.current.origin !== origin || live.current.userId !== userId) return;
      updatePending(readPendingFile(raw)); setStorageReady(true);
    }).catch(() => {
      if (active.current && storageEpoch.current === storeGeneration) { setStorageReady(false); setMessage("Pending file storage unavailable. Writes disabled; repair storage and relaunch."); }
    });
    return () => { active.current = false; storageEpoch.current++; epoch.current++; };
  }, [origin, userId]);
  useLayoutEffect(() => {
    epoch.current++; working.current = false; setBusy(false); setInspection(null); setListing(null); setMessage("");
    if (workspace && !blocked) void read("");
  }, [origin, userId, workspace?.id, workspace?.archived, blocked]);
  const dirty = currentEditor !== null && currentEditor.draft !== currentEditor.host.content;
  const disabled = busy || blocked || !workspace || workspace.archived || !storageReady || Boolean(pending) || !inspected?.supported || !inspected.provisioned || inspected.archived;
  return <View style={styles.card} testID="file-panel">
    <Text accessibilityRole="header" style={styles.heading}>Files and editor</Text>
    {!workspace ? <Text>Select a workspace to inspect files.</Text> : <>
      <Text>Files in {workspace.name}{workspace.archived ? " (archived, read-only)" : ""}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh files" disabled={busy || blocked} onPress={() => void read(currentListing?.path ?? "")} style={styles.secondary}><Text>Refresh files</Text></Pressable>
      {currentListing ? <>
        <Text>Directory: {currentListing.path || "Workspace root"}</Text>
        {currentListing.path ? <Pressable accessibilityRole="button" accessibilityLabel="Open parent directory" disabled={busy || blocked} onPress={() => void read(currentListing.path.split("/").slice(0, -1).join("/"))} style={styles.secondary}><Text>Parent directory</Text></Pressable> : null}
        {!currentListing.entries.length ? <Text>This directory is empty.</Text> : currentListing.entries.map(entry => <Pressable key={entry.name} accessibilityRole="button" accessibilityLabel={`Open ${entry.type} ${entry.name}`} disabled={busy || blocked} onPress={() => void read(currentListing.path ? `${currentListing.path}/${entry.name}` : entry.name, entry.type === "file")} style={styles.row}><Text>{entry.name}{entry.type === "directory" ? "/" : ` (${entry.size} bytes)`}</Text></Pressable>)}
      </> : null}
      {currentEditor ? <View style={styles.editor}>
        <Text>{currentEditor.host.path} · {currentEditor.needsRead ? "current version must be read" : "last read version available"}</Text>
        <TextInput accessibilityLabel="File draft" multiline value={currentEditor.draft} editable={!workspace.archived && !inspected?.archived} onChangeText={draft => {
          const item = editorRef.current;
          if (live.current.workspace?.id !== workspace.id || !item || item.host !== currentEditor.host) return;
          editorRef.current = { ...item, draft };
          setEditor(value => value?.host === item.host ? { ...value, draft } : value);
        }} style={styles.textarea}/>
        {dirty ? <><Text>Draft differs from last read host text.</Text><TextInput accessibilityLabel="Last read host text" multiline editable={false} value={currentEditor.host.content} style={styles.textarea}/></> : null}
        {!validText(currentEditor.draft) ? <Text accessibilityRole="alert">SAVE requires valid UTF-8 without NUL, at most 1 MiB.</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Read current file" disabled={busy || blocked} onPress={() => void read(currentEditor.host.path, true)} style={styles.secondary}><Text>Read current file (keep draft)</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Save file" disabled={disabled || currentEditor.needsRead || !dirty || !validText(currentEditor.draft)} onPress={() => void save()} style={[styles.button, (disabled || currentEditor.needsRead || !dirty) && styles.disabled]}><Text style={styles.buttonText}>Save file</Text></Pressable>
      </View> : null}
    </>}
    {pending ? <View style={styles.pending} testID="pending-file"><Text>File operation awaits confirmation. No automatic write retry.</Text><Text selectable>Request ID: {pending.requestId}</Text><Pressable accessibilityRole="button" accessibilityLabel="Check file receipt" disabled={busy || pending.workspaceId !== workspace?.id} onPress={() => void checkReceipt()} style={styles.secondary}><Text>{pending.workspaceId === workspace?.id ? "Check file receipt" : "Select original workspace to check receipt"}</Text></Pressable></View> : null}
    {!storageReady ? <Text accessibilityRole="alert">File recovery storage unavailable. Writes disabled.</Text> : null}
    {message ? <Text testID="file-status" accessibilityLiveRegion="polite">{message}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ card: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 16, borderWidth: 1, gap: 10, padding: 18 }, heading: { color: "#183337", fontSize: 18, fontWeight: "700" }, row: { borderTopColor: "#e3ebe7", borderTopWidth: 1, paddingVertical: 10 }, editor: { gap: 8 }, textarea: { borderColor: "#c9d9d2", borderRadius: 9, borderWidth: 1, minHeight: 120, padding: 12, textAlignVertical: "top" }, button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 9, justifyContent: "center", minHeight: 42 }, disabled: { opacity: 0.55 }, buttonText: { color: "#fff", fontWeight: "700" }, secondary: { alignItems: "center", justifyContent: "center", minHeight: 40 }, pending: { backgroundColor: "#fff0cf", gap: 8, padding: 12 } });
