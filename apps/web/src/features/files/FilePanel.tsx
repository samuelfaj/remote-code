import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native-web";
import { createApiClient, fileReceiptFromValue, workspaceErrorStatus, workspaceFromValue, type PendingFile, type Workspace } from "@remotecode/client";
import { clearPendingFile, clearPendingFolder, directoryFromValue, fileStorageKey, folderStorageKey, folderStateFromValue, isMissingFilePath, isTargetExists, isVersionConflict, openFileFromValue, persistPendingFile, persistPendingFolder, readPendingFile, readPendingFolder, textSha256, validPath, validText, type FileEntry, type FolderState, type OpenFile } from "./file-editor";

const deadlineMs = 10_000;
type Props = { userId: string; workspace: Workspace | null; blocked: boolean; onUnauthorized: () => void };
type Inspection = { workspaceId: string; capability: "supported" | "unsupported" | "unknown"; folder: FolderState; archived: boolean };
type Editor = { host: OpenFile; draft: string; needsRead: boolean };

export function FilePanel({ userId, workspace, blocked, onUnauthorized }: Props) {
  const origin = window.location.origin;
  const key = fileStorageKey(origin, userId);
  const folderKey = folderStorageKey(origin, userId);
  const live = useRef({ userId, workspace, blocked });
  live.current = { userId, workspace, blocked };
  const active = useRef(false);
  const generation = useRef(0);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const pendingRef = useRef(pending);
  const [pendingFolder, setPendingFolder] = useState<{ workspaceId: string; requestId: string } | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [listing, setListing] = useState<{ workspaceId: string; path: string; entries: FileEntry[] } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [creation, setCreation] = useState<Record<string, { path: string; content: string }>>({});
  const [move, setMove] = useState<{ workspaceId: string; sourcePath: string; destinationPath: string } | null>(null);
  const [message, setMessage] = useState("");
  const currentInspection = inspection?.workspaceId === workspace?.id ? inspection : null;
  const currentListing = listing?.workspaceId === workspace?.id ? listing : null;
  const currentEditor = editor?.host.workspaceId === workspace?.id ? editor : null;
  const currentCreation = workspace ? creation[workspace.id] ?? null : null;
  const destination = move && currentEditor && move.workspaceId === workspace?.id && move.sourcePath === currentEditor.host.path ? move.destinationPath : "";

  function requestClient(end: number) {
    if (Date.now() >= end) throw new Error("File operation deadline expired");
    return createApiClient(origin, { timeoutMs: end - Date.now() });
  }

  function currentCheck() {
    const epoch = ++generation.current;
    const workspaceId = workspace?.id;
    const archived = workspace?.archived;
    const wasBlocked = blocked;
    return () => active.current && generation.current === epoch && live.current.userId === userId &&
      live.current.workspace?.id === workspaceId && live.current.workspace?.archived === archived && live.current.blocked === wasBlocked;
  }

  function unauthorized(error: unknown) {
    if (workspaceErrorStatus(error) === 401) onUnauthorized();
  }

  async function sessionIsCurrent(end: number, current: () => boolean) {
    const result = await requestClient(end).api.auth.session.get();
    if (!current()) return false;
    if (Date.now() >= end) throw new Error("File operation deadline expired");
    if (result.error) { unauthorized(result.error); throw new Error("Session could not be confirmed"); }
    if (!result.data || !("userId" in result.data) || result.data.userId !== userId) {
      onUnauthorized();
      return false;
    }
    return true;
  }

  async function inspect(end: number, current: () => boolean, folderOperation = pendingFolder) {
    if (!workspace) return null;
    setInspection(null);
    const version = await requestClient(end).api.version.get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File operation deadline expired");
    if (version.error || !Array.isArray(version.data?.capabilities)) throw new Error("Capabilities unavailable");
    if (!version.data.capabilities.includes("workspace-files-v1")) {
      setInspection({ workspaceId: workspace.id, capability: "unsupported", folder: "unknown", archived: workspace.archived });
      setMessage("This host does not support workspace-files-v1. Files require a Linux host; no file request was sent.");
      return null;
    }
    if (!await sessionIsCurrent(end, current)) return null;
    const owner = await requestClient(end).api.workspaces({ workspaceId: workspace.id }).get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File operation deadline expired");
    if (owner.error) { unauthorized(owner.error); throw new Error("Workspace ownership unavailable"); }
    const confirmed = workspaceFromValue(owner.data);
    if (!confirmed) throw new Error("Host returned invalid workspace metadata");
    if (confirmed.id !== workspace.id) throw new Error("Host returned metadata for a different workspace");
    const result = await requestClient(end).api.workspaces({ workspaceId: workspace.id }).folder.get();
    if (!current()) return null;
    if (Date.now() >= end) throw new Error("File operation deadline expired");
    if (result.error) { unauthorized(result.error); throw new Error("Folder status unavailable"); }
    const originalFolder = folderOperation?.workspaceId === workspace.id ? folderOperation : null;
    const folder = folderStateFromValue(result.data, workspace.id, originalFolder?.requestId);
    if (!folder) throw new Error("Folder status did not match the original pending request");
    if (originalFolder) {
      const stored = readPendingFolder(sessionStorage, folderKey);
      if (stored?.requestId !== originalFolder.requestId || stored.workspaceId !== originalFolder.workspaceId) throw new Error("Original folder identity unavailable");
      if (folder === "provisioned") {
        clearPendingFolder(sessionStorage, folderKey, originalFolder);
        setMessage("Workspace folder confirmed with the original request ID.");
      }
      restorePending();
    }
    const state: Inspection = { workspaceId: workspace.id, capability: "supported", folder, archived: confirmed.archived };
    setInspection(state);
    if (folder !== "provisioned") setMessage(folder === "not_provisioned"
      ? "This workspace has no provisioned folder. Folder inspection is read-only; no folder was created."
      : "Folder status is unknown. File writes stay disabled; refresh inspection manually.");
    return state;
  }

  async function read(path: string, content = false) {
    if (!workspace || working.current) return;
    const existing = editorRef.current;
    const sameFile = existing?.host.workspaceId === workspace.id && existing.host.path === path;
    if (content && existing && !sameFile) {
      if (pendingRef.current) { setMessage("Resolve the pending file receipt before opening another file. The draft is kept."); return; }
      if (existing.draft !== existing.host.content && !window.confirm("Discard the unsaved draft and open another file?")) return;
    }
    const current = currentCheck();
    const end = Date.now() + deadlineMs;
    working.current = true;
    setBusy(true);
    setMessage(content ? "Reading current host text…" : "Inspecting folder and loading files…");
    if (content && sameFile) setEditor((value) => value ? { ...value, needsRead: true } : value);
    try {
      const state = await inspect(end, current);
      if (!current() || state?.folder !== "provisioned") return;
      const files = requestClient(end).api.workspaces({ workspaceId: workspace.id }).files;
      if (content) {
        const result = await files.content.get({ query: { path } });
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File operation deadline expired");
        if (result.error) { unauthorized(result.error); throw new Error("File unavailable"); }
        const host = await openFileFromValue(result.data, workspace.id, path);
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File operation deadline expired");
        if (!host) throw new Error("Invalid file content");
        if (!sameFile && editorRef.current?.draft !== existing?.draft) {
          setMessage("The draft changed while another file was loading. Draft kept; open the other file again to confirm discarding it.");
          return;
        }
        setEditor((value) => ({ host, draft: sameFile && value ? value.draft : host.content, needsRead: false }));
        setMessage(sameFile ? "Current host text and version read. Your editable draft was kept; compare before saving." : "Text and version read from the host.");
      } else {
        const result = await files.get({ query: path ? { path } : {} });
        if (!current()) return;
        if (Date.now() >= end) throw new Error("File operation deadline expired");
        if (result.error) { unauthorized(result.error); throw new Error("Directory unavailable"); }
        const entries = directoryFromValue(result.data, path);
        if (!entries) throw new Error("Invalid directory listing");
        setListing({ workspaceId: workspace.id, path, entries });
        setMessage(state.archived ? "Archived workspace. Files are read-only." : "Folder and files confirmed by the host.");
      }
    } catch {
      if (current()) {
        setInspection(null);
        if (!content) setListing(null);
        setMessage(content ? "Could not read this text file or its version. Binary, invalid UTF-8 and files over 1 MiB cannot be edited. Draft kept; retry the read manually."
          : "Folder or directory could not be confirmed. Refresh manually; writes are disabled.");
      }
    } finally {
      if (current()) { working.current = false; setBusy(false); }
    }
  }

  function restorePending() {
    try {
      const restored = readPendingFile(sessionStorage, key);
      const folder = readPendingFolder(sessionStorage, folderKey);
      pendingRef.current = restored;
      setPending(restored);
      setPendingFolder(folder);
      setStorageReady(true);
    } catch {
      setStorageReady(false);
      setMessage("Pending file recovery could not be read. Writes are disabled until browser storage is repaired and this tab is reloaded.");
    }
  }

  function clearMatching(operation: PendingFile) {
    try {
      clearPendingFile(sessionStorage, key, operation);
      pendingRef.current = null;
      setPending(null);
      return true;
    } catch {
      setStorageReady(false);
      setMessage("Pending file identity could not be safely cleared. Writes are disabled; keep the request ID and repair browser storage before reloading.");
      return false;
    }
  }

  useLayoutEffect(() => {
    active.current = true;
    editorRef.current = null;
    setEditor(null);
    setCreation({});
    setMove(null);
    pendingRef.current = null;
    setPending(null);
    setStorageReady(false);
    restorePending();
    return () => { active.current = false; generation.current++; };
  }, [userId]);

  useLayoutEffect(() => {
    generation.current++;
    working.current = false;
    setBusy(false);
    setInspection(null);
    setListing(null);
    setMessage("");
    if (workspace && !blocked) void read("");
  }, [userId, workspace?.id, workspace?.archived, blocked]);

  async function prepareFolder() {
    if (!workspace || working.current || blocked || workspace.archived || !storageReady || pendingRef.current) return;
    if (pendingFolder && pendingFolder.workspaceId !== workspace.id) { setMessage("Select the original workspace to inspect its pending folder request."); return; }
    const current = currentCheck();
    const end = Date.now() + deadlineMs;
    working.current = true; setBusy(true); setMessage("Checking workspace folder before preparation…");
    let operation = pendingFolder;
    try {
      const state = await inspect(end, current);
      if (!current() || !state || state.archived || (state.folder !== "not_provisioned" && !(operation && state.folder === "unknown"))) return;
      if (!operation) {
        operation = { workspaceId: workspace.id, requestId: crypto.randomUUID() };
        persistPendingFolder(sessionStorage, folderKey, operation);
        setPendingFolder(operation);
      }
      const stored = readPendingFolder(sessionStorage, folderKey);
      if (stored?.requestId !== operation.requestId || stored.workspaceId !== operation.workspaceId) throw new Error("Original folder identity unavailable before submission");
      if (!current() || Date.now() >= end) { setMessage("Preparation expired before submission. Original request ID retained."); return; }
      const response = await requestClient(end).api.workspaces({ workspaceId: operation.workspaceId }).folder.post({ requestId: operation.requestId });
      if (!current()) return;
      if (Date.now() >= end) { setMessage("Folder preparation outcome is unknown. Original request ID retained; no automatic retry."); return; }
      if (response.error) { unauthorized(response.error); setMessage("Folder preparation was not confirmed. Original request ID retained; inspect status before any same-ID continuation."); return; }
      const confirmed = await inspect(end, current, operation);
      if (current() && confirmed?.folder === "provisioned") {
        const listing = await requestClient(end).api.workspaces({ workspaceId: operation.workspaceId }).files.get();
        if (current() && !listing.error && Date.now() < end) {
          const entries = directoryFromValue(listing.data, "");
          if (entries) setListing({ workspaceId: operation.workspaceId, path: "", entries });
        }
      } else if (current() && confirmed?.folder !== "provisioned") setMessage("Folder preparation remains unconfirmed. Original request ID retained; no new ID was created.");
    } catch {
      if (current()) { setStorageReady(false); setMessage("Folder preparation outcome or storage is unknown. Original request ID is retained; no automatic retry."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  async function mutate(kind: PendingFile["kind"]) {
    const value = editorRef.current;
    if (!workspace || working.current || blocked || workspace.archived || !storageReady || pendingRef.current || pendingFolder ||
      currentInspection?.capability !== "supported" || currentInspection.folder !== "provisioned" || currentInspection.archived) return;
    if (kind === "create") {
      if (!currentCreation || !validPath(currentCreation.path) || !validText(currentCreation.content)) return;
    } else {
      if (!value || value.host.workspaceId !== workspace.id || value.needsRead || !validText(value.draft)) return;
      if (kind === "save" ? value.draft === value.host.content
        : value.draft !== value.host.content || !validPath(destination) || destination === value.host.path) return;
    }
    const content = kind === "create" ? currentCreation!.content : value!.draft;
    const label = kind.toUpperCase();
    const current = currentCheck();
    const end = Date.now() + deadlineMs;
    working.current = true;
    setBusy(true);
    setMessage(`Checking ${label} authority…`);
    let sent = false;
    try {
      const state = await inspect(end, current);
      if (!current() || state?.folder !== "provisioned" || state.archived || Date.now() >= end) {
        if (current() && state?.archived) setMessage(`Workspace is archived. No ${label} request was sent.`);
        return;
      }
      const latest = editorRef.current;
      if (kind === "move" && (!latest || latest.host !== value!.host || latest.needsRead || latest.draft !== latest.host.content)) {
        setMessage("MOVE requires the current verified open file with a clean draft. No MOVE request was sent; your draft was kept.");
        return;
      }
      const requestId = crypto.randomUUID();
      const operation: PendingFile = kind === "move"
        ? { kind, requestId, workspaceId: workspace.id, sourcePath: value!.host.path, destinationPath: destination, expectedVersion: value!.host.version }
        : { kind, requestId, workspaceId: workspace.id, path: kind === "create" ? currentCreation!.path : value!.host.path, resultSha256: await textSha256(content) };
      if (!current()) return;
      if (Date.now() >= end) throw new Error("File operation deadline expired");
      try {
        persistPendingFile(sessionStorage, key, operation);
        pendingRef.current = operation;
        setPending(operation);
      } catch {
        restorePending();
        setStorageReady(false);
        setMessage(`Could not persist and read back the pending ${label} identity. No ${label} request was sent; repair browser storage and reload.`);
        return;
      }
      if (!current()) return;
      if (Date.now() >= end) {
        if (clearMatching(operation)) setMessage(`Deadline expired before ${label} submission. No ${label} request was sent.`);
        return;
      }
      setEditor((item) => item?.host.workspaceId === workspace.id ? { ...item, needsRead: true } : item);
      sent = true;
      const files = requestClient(end).api.workspaces({ workspaceId: workspace.id }).files;
      const response = operation.kind === "move"
        ? await files.move.post({ requestId, sourcePath: operation.sourcePath, destinationPath: operation.destinationPath, expectedVersion: operation.expectedVersion })
        : operation.kind === "create"
          ? await files.post({ requestId, path: operation.path, content })
          : await files.content.put({ requestId, path: operation.path, content, expectedVersion: value!.host.version });
      if (!current()) return;
      if (Date.now() >= end) { setMessage(`${label} response arrived after the deadline. Outcome is unknown; check its receipt manually. Draft and inputs kept.`); return; }
      if (response.error) {
        unauthorized(response.error);
        if (operation.kind !== "create" && isVersionConflict(response.error)) {
          if (clearMatching(operation)) setMessage(`Version conflict: ${label} was refused. Draft kept. Read current host text and compare before another explicit ${label}.`);
        } else if (operation.kind !== "save" && (isTargetExists(response.error) || isMissingFilePath(response.error, operation.kind))) {
          if (clearMatching(operation)) setMessage(`${label} was refused: ${isTargetExists(response.error) ? "target already exists" : "source or parent directory is unavailable"}. No file change occurred. Inputs and draft kept; choose an existing parent and current source explicitly.`);
        } else setMessage(`${label} was not confirmed. Keep the draft and inputs and check its receipt manually; no write will be resent automatically.`);
        return;
      }
      const receipt = fileReceiptFromValue(response.data, operation, workspace.id);
      if (!receipt) { setMessage(`${label} response did not match the pending identity. Outcome is unknown; check its receipt manually. Draft and inputs kept.`); return; }
      if (clearMatching(operation)) setMessage(`${label} receipt confirmed for ${receipt.path}. Draft and inputs kept. This historical receipt is not current file content or path; refresh files and open the desired path to read its current text and version before writing again.`);
    } catch {
      if (current()) {
        setInspection(null);
        setMessage(sent ? `${label} outcome is unknown. Draft, inputs and pending identity are kept; check its receipt manually. No automatic write retry.`
          : `${label} preflight failed. No ${label} request was sent; refresh folder inspection manually.`);
      }
    } finally {
      if (current()) { working.current = false; setBusy(false); }
    }
  }

  async function checkReceipt() {
    const operation = pendingRef.current;
    if (!operation || operation.workspaceId !== workspace?.id || working.current) return;
    const current = currentCheck();
    const end = Date.now() + deadlineMs;
    working.current = true;
    setBusy(true);
    setMessage("Checking file receipt. No write will be resent.");
    try {
      if (!await sessionIsCurrent(end, current)) return;
      // Persisted identity, not the editable draft, binds historical receipts.
      try {
        const stored = readPendingFile(sessionStorage, key);
        if (JSON.stringify(stored) !== JSON.stringify(operation)) throw new Error("Pending identity changed");
      } catch {
        setStorageReady(false);
        throw new Error("Pending identity unavailable");
      }
      const result = await requestClient(end).api.workspaces({ workspaceId: operation.workspaceId }).files.receipts({ requestId: operation.requestId }).get();
      if (!current()) return;
      if (Date.now() >= end) { setMessage("Receipt arrived after the deadline. Outcome remains unknown; check again manually."); return; }
      if (result.error) {
        unauthorized(result.error);
        setMessage(workspaceErrorStatus(result.error) === 404 ? "No matching receipt is available. Outcome remains unknown; pending identity and draft are kept."
          : "Receipt lookup failed. Outcome remains unknown; no write was resent.");
        return;
      }
      if (!fileReceiptFromValue(result.data, operation, workspace.id)) {
        setMessage("Receipt did not match the persisted pending identity. Outcome remains unknown; draft kept.");
        return;
      }
      if (clearMatching(operation)) {
        setEditor((item) => item?.host.workspaceId === operation.workspaceId ? { ...item, needsRead: true } : item);
        setMessage("Historical file receipt confirmed. Draft and inputs kept; refresh files and open the desired path to read its current text and version before writing again.");
      }
    } catch {
      if (current()) setMessage("Receipt or pending identity could not be checked. Outcome remains unknown; no write was resent.");
    } finally {
      if (current()) { working.current = false; setBusy(false); }
    }
  }

  const writesDisabled = busy || blocked || !workspace || workspace.archived || !storageReady || Boolean(pending) || Boolean(pendingFolder) ||
    currentInspection?.capability !== "supported" || currentInspection.folder !== "provisioned" || currentInspection.archived;
  const saveDisabled = writesDisabled || !currentEditor || currentEditor.needsRead ||
    currentEditor.draft === currentEditor.host.content || !validText(currentEditor.draft);
  const createDisabled = writesDisabled || !currentCreation || !validPath(currentCreation.path) || !validText(currentCreation.content);
  const moveDisabled = writesDisabled || !currentEditor || currentEditor.needsRead || currentEditor.draft !== currentEditor.host.content ||
    !validPath(destination) || destination === currentEditor.host.path;

  return (
    <View style={styles.panel} testID="file-panel">
      <Text accessibilityRole="header" style={styles.heading}>Files and editor</Text>
      {!workspace ? <Text>Select a workspace to inspect its folder.</Text> : <>
        <Text>Files in {workspace.name}{workspace.archived ? " (archived, read-only)" : ""}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh folder and files" disabled={busy || blocked}
          accessibilityState={{ disabled: busy || blocked }} onPress={() => void read(currentListing?.path ?? "")} style={styles.secondary}>
          <Text>{busy ? "Checking files…" : "Refresh folder and files"}</Text>
        </Pressable>
        <Text testID="folder-status">{currentInspection?.capability === "unsupported" ? "Files unavailable on this host."
          : currentInspection?.folder === "provisioned" ? "Folder provisioned on Linux."
          : currentInspection?.folder === "not_provisioned" ? "Folder not provisioned."
          : "Folder status unknown. Writes disabled."}</Text>
        {currentInspection?.capability === "supported" && (currentInspection.folder === "not_provisioned" || pendingFolder?.workspaceId === workspace.id && currentInspection.folder === "unknown") && !workspace.archived && !currentInspection.archived ? <Pressable accessibilityRole="button" accessibilityLabel="Prepare workspace folder" disabled={busy || blocked || !storageReady || Boolean(pending)} onPress={() => void prepareFolder()} style={styles.secondary}><Text>{pendingFolder ? "Continue folder preparation with same request ID" : "Prepare workspace folder"}</Text></Pressable> : null}
        {pendingFolder ? <Text testID="pending-folder">Folder request remains unknown. Request ID: {pendingFolder.requestId}</Text> : null}
        {currentListing ? <View style={styles.section}>
          <Text>Directory: {currentListing.path || "Workspace root"}</Text>
          {currentListing.path ? <Pressable accessibilityRole="button" accessibilityLabel="Open parent directory" disabled={busy}
            onPress={() => void read(currentListing.path.split("/").slice(0, -1).join("/"))} style={styles.secondary}><Text>Parent directory</Text></Pressable> : null}
          {!currentListing.entries.length ? <Text>This directory is empty.</Text> : currentListing.entries.map((entry) => (
            <Pressable key={entry.name} accessibilityRole="button" accessibilityLabel={`Open ${entry.type} ${entry.name}`} disabled={busy}
              onPress={() => void read(currentListing.path ? `${currentListing.path}/${entry.name}` : entry.name, entry.type === "file")} style={styles.row}>
              <Text>{entry.name}{entry.type === "directory" ? "/" : ` (${entry.size} bytes)`}</Text>
            </Pressable>
          ))}
        </View> : null}
        <View style={styles.section}>
          <Text accessibilityRole="header">Create text file</Text>
          <Text>Paths are relative to the workspace root. The parent directory must already exist.</Text>
          <label htmlFor="workspace-create-path">New file path</label>
          <input id="workspace-create-path" aria-label="New file path" value={currentCreation?.path ?? ""}
            readOnly={workspace.archived || currentInspection?.archived === true}
            onChange={(event) => {
              if (live.current.workspace?.id !== workspace.id) return;
              const path = event.target.value;
              setCreation((values) => ({ ...values, [workspace.id]: { path, content: values[workspace.id]?.content ?? "" } }));
            }}
            style={{ minHeight: 42, padding: 12, border: "1px solid #c9d9d2", borderRadius: 9 }} />
          <label htmlFor="workspace-create-content">New file text</label>
          <textarea id="workspace-create-content" aria-label="New file text" value={currentCreation?.content ?? ""} spellCheck={false}
            readOnly={workspace.archived || currentInspection?.archived === true}
            onChange={(event) => {
              if (live.current.workspace?.id !== workspace.id) return;
              const content = event.target.value;
              setCreation((values) => ({ ...values, [workspace.id]: { path: values[workspace.id]?.path ?? "", content } }));
            }}
            style={{ width: "100%", boxSizing: "border-box", minHeight: 100, resize: "vertical", padding: 12, border: "1px solid #c9d9d2", borderRadius: 9, fontFamily: "monospace", color: "#183337", background: "#fbfdfc" }} />
          {currentCreation && (!validPath(currentCreation.path) || !validText(currentCreation.content))
            ? <Text>Use a non-empty relative file path without reserved or traversal segments, and valid UTF-8 text without NUL, at most 1 MiB.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Create file" disabled={createDisabled} accessibilityState={{ disabled: createDisabled }}
            onPress={() => void mutate("create")} style={[styles.button, createDisabled && styles.disabled]}><Text style={styles.buttonText}>Create file</Text></Pressable>
        </View>
        {currentEditor ? <View style={styles.section}>
          <Text>{currentEditor.host.path} · {currentEditor.needsRead ? "current version must be read" : "last read version available"}</Text>
          <label htmlFor="workspace-file-draft">Editable draft</label>
          <textarea id="workspace-file-draft" aria-label="File draft" value={currentEditor.draft} readOnly={workspace.archived || currentInspection?.archived === true}
            spellCheck={false} onChange={(event) => {
              const item = editorRef.current;
              if (live.current.workspace?.id !== workspace.id || !item || item.host !== currentEditor.host) return;
              const draft = event.target.value;
              editorRef.current = { ...item, draft };
              setEditor((value) => value?.host === item.host ? { ...value, draft } : value);
            }}
            style={{ width: "100%", boxSizing: "border-box", minHeight: 220, resize: "vertical", padding: 12, border: "1px solid #c9d9d2", borderRadius: 9, fontFamily: "monospace", color: "#183337", background: "#fbfdfc" }} />
          {currentEditor.draft !== currentEditor.host.content ? <>
            <Text>Draft differs from last read host text. Reading does not replace your draft.</Text>
            <label htmlFor="workspace-file-host">Last read host text (not live)</label>
            <textarea id="workspace-file-host" aria-label="Last read host text" value={currentEditor.host.content} readOnly
              style={{ width: "100%", boxSizing: "border-box", minHeight: 100, fontFamily: "monospace", border: "1px solid #c9d9d2", borderRadius: 9, padding: 12 }} />
          </> : null}
          {!validText(currentEditor.draft) ? <Text accessibilityRole="alert">SAVE requires valid UTF-8 text without NUL, at most 1 MiB.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Read current file" disabled={busy || blocked}
            onPress={() => void read(currentEditor.host.path, true)} style={styles.secondary}><Text>Read current file (keep draft)</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Save file" disabled={saveDisabled} accessibilityState={{ disabled: saveDisabled }}
            onPress={() => void mutate("save")} style={[styles.button, saveDisabled && styles.disabled]}><Text style={styles.buttonText}>Save file</Text></Pressable>
          <label htmlFor="workspace-move-destination">Move destination path</label>
          <input id="workspace-move-destination" aria-label="Move destination path" value={destination}
            readOnly={workspace.archived || currentInspection?.archived === true}
            onChange={(event) => {
              if (live.current.workspace?.id !== workspace.id || editorRef.current?.host !== currentEditor.host) return;
              setMove({ workspaceId: workspace.id, sourcePath: currentEditor.host.path, destinationPath: event.target.value });
            }}
            style={{ minHeight: 42, padding: 12, border: "1px solid #c9d9d2", borderRadius: 9 }} />
          <Text>MOVE uses the current verified open version, never the unsaved draft. Destination is relative to the workspace root; its parent directory must exist.</Text>
          {currentEditor.draft !== currentEditor.host.content ? <Text>Save or explicitly discard the dirty draft before moving. No draft will be saved by MOVE.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Move file" disabled={moveDisabled} accessibilityState={{ disabled: moveDisabled }}
            onPress={() => void mutate("move")} style={[styles.button, moveDisabled && styles.disabled]}><Text style={styles.buttonText}>Move file</Text></Pressable>
        </View> : null}
      </>}
      {pending ? <View style={styles.pending} testID="pending-file">
        <Text>File operation awaits confirmation. Pending identity stays in this tab; no write will be replayed.</Text>
        <Text>{pending.kind === "move" ? `MOVE: ${pending.sourcePath} to ${pending.destinationPath}` : `${pending.kind.toUpperCase()}: ${pending.path}`}</Text>
        <Text selectable>Request ID: {pending.requestId}</Text>
        <Text>{pending.workspaceId === workspace?.id ? "Check its receipt manually." : "Select the original workspace to check this file receipt."}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Check file receipt" disabled={busy || pending.workspaceId !== workspace?.id}
          onPress={() => void checkReceipt()} style={styles.secondary}><Text>Check file receipt</Text></Pressable>
      </View> : null}
      {!storageReady ? <Text accessibilityRole="alert">Browser recovery storage unavailable. File writes disabled; repair storage and reload.</Text> : null}
      {message ? <Text testID="file-status" aria-live="polite">{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderTopColor: "#e3ebe7", borderTopWidth: 1, gap: 12, paddingTop: 12 },
  heading: { color: "#183337", fontSize: 18, fontWeight: "700" },
  section: { gap: 8 },
  row: { borderTopColor: "#e3ebe7", borderTopWidth: 1, minHeight: 42, justifyContent: "center", paddingVertical: 8 },
  button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 9, justifyContent: "center", minHeight: 42 },
  buttonText: { color: "#fff", fontWeight: "700" },
  disabled: { opacity: 0.55 },
  secondary: { alignItems: "center", justifyContent: "center", minHeight: 40 },
  pending: { backgroundColor: "#fff0cf", gap: 8, padding: 12 },
});
