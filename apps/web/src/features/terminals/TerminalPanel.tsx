import { useLayoutEffect, useRef, useState } from "react";
import "./styles.css";
import {
  createApiClient, fileFolderStateFromValue, terminalInputAckFromValue, terminalPollFromValue,
  terminalReceiptFromValue, terminalReferenceFromValue, workspaceErrorStatus, workspaceFromValue,
  type TerminalReceipt, type TerminalReference, type Workspace,
} from "@remotecode/client";

type Props = { userId: string; workspace: Workspace | null; blocked: boolean; onUnauthorized: () => void };
const budgetMs = 10_000;
const outputLimit = 64 * 1024;

// ponytail: Line input and bounded plain text; add a terminal renderer for full-screen ANSI programs.
export function TerminalPanel({ userId, workspace, blocked, onUnauthorized }: Props) {
  const origin = window.location.origin;
  const key = `remotecode.terminal:${JSON.stringify([origin, userId])}`;
  const live = useRef({ userId, workspace, blocked });
  live.current = { userId, workspace, blocked };
  const active = useRef(false);
  const epoch = useRef(0);
  const working = useRef(false);
  const referenceRef = useRef<TerminalReference | null>(null);
  const cursor = useRef(0);
  const bytes = useRef(new Uint8Array(0));
  const [reference, setReference] = useState<TerminalReference | null>(null);
  const [receipt, setReceipt] = useState<TerminalReceipt | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [output, setOutput] = useState("");
  const [gap, setGap] = useState(false);
  const [message, setMessage] = useState("");
  const sameWorkspace = reference?.start.workspaceId === workspace?.id;
  const currentReceipt = receipt?.workspaceId === workspace?.id ? receipt : null;
  const closed = currentReceipt?.cleanup === "removed";
  const canInput = !blocked && !workspace?.archived && storageReady && sameWorkspace &&
    !!reference?.terminalId && !reference.inputUncertain && !reference.stopRequested &&
    currentReceipt?.state === "running" && (currentReceipt.inputState === null || currentReceipt.inputState === "written");

  function readReference() {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const parsed = terminalReferenceFromValue(JSON.parse(raw));
    if (!parsed) throw new Error("Invalid terminal reference");
    return parsed;
  }

  function writeReference(value: TerminalReference | null, expected = referenceRef.current) {
    try {
      if (JSON.stringify(readReference()) !== JSON.stringify(expected)) throw new Error("Terminal reference changed");
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
      if (JSON.stringify(readReference()) !== JSON.stringify(value)) throw new Error("Terminal reference storage failed");
      referenceRef.current = value;
      setReference(value);
      setStorageReady(true);
    } catch (error) { setStorageReady(false); throw error; }
  }

  function currentCheck() {
    const generation = epoch.current;
    const id = workspace?.id;
    const archived = workspace?.archived;
    return () => active.current && epoch.current === generation && live.current.userId === userId &&
      live.current.workspace?.id === id && live.current.workspace?.archived === archived && live.current.blocked === blocked;
  }

  function client(end: number) {
    if (Date.now() >= end) throw new Error("Terminal deadline expired");
    return createApiClient(origin, { timeoutMs: end - Date.now() });
  }

  async function session(end: number, current: () => boolean) {
    const result = await client(end).api.auth.session.get();
    if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
    if (result.error || !result.data || !("userId" in result.data) || result.data.userId !== userId) {
      if (workspaceErrorStatus(result.error) === 401 || result.data && "userId" in result.data && result.data.userId !== userId) onUnauthorized();
      throw new Error("Terminal session unavailable");
    }
  }

  async function preflight(end: number, current: () => boolean, starting = false) {
    if (!workspace) throw new Error("No selected workspace");
    await session(end, current);
    const result = await client(end).api.workspaces({ workspaceId: workspace.id }).get();
    if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
    if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
    const owned = result.error ? null : workspaceFromValue(result.data);
    if (!owned || owned.id !== workspace.id || starting && owned.archived) throw new Error("Workspace unavailable");
    if (starting) {
      const folder = await client(end).api.workspaces({ workspaceId: workspace.id }).folder.get();
      if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
      if (workspaceErrorStatus(folder.error) === 401) onUnauthorized();
      if (folder.error || fileFolderStateFromValue(folder.data, workspace.id) !== "provisioned") throw new Error("Prepare the workspace folder first");
    }
    return owned;
  }

  function acceptReceipt(value: TerminalReceipt, expected: TerminalReference) {
    setAvailable(true);
    setReceipt(value);
    if (value.cleanup === "removed") writeReference(null, expected);
    else if (expected.terminalId === null) writeReference({ ...expected, terminalId: value.terminalId }, expected);
  }

  async function poll(end: number, current: () => boolean, expected: TerminalReference) {
    if (!expected.terminalId) throw new Error("Start receipt is pending");
    const offset = cursor.current;
    const result = await client(end).api.terminals({ terminalId: expected.terminalId }).get({ query: { offset: String(offset) } });
    if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
    if (result.error) {
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(result.error) === 404) { bytes.current = new Uint8Array(0); cursor.current = 0; setOutput(""); setGap(true); }
      throw new Error("Terminal state unavailable for this login");
    }
    const confirmed = terminalPollFromValue(result.data, expected, offset);
    if (!confirmed) throw new Error("Invalid terminal poll");
    if (confirmed.outputAvailable) {
      const chunk = Uint8Array.from(atob(confirmed.outputBase64), (character) => character.charCodeAt(0));
      if (confirmed.gap) { bytes.current = new Uint8Array(0); setGap(true); }
      const joined = new Uint8Array(bytes.current.length + chunk.length);
      joined.set(bytes.current); joined.set(chunk, bytes.current.length);
      if (joined.length > outputLimit) setGap(true);
      bytes.current = joined.slice(-outputLimit);
      cursor.current = confirmed.nextOffset;
      setOutput(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.current));
    } else {
      bytes.current = new Uint8Array(0); cursor.current = 0; setOutput(""); setGap(true);
    }
    const { outputAvailable, ...fields } = confirmed;
    const canonical = terminalReceiptFromValue(Object.fromEntries(Object.entries(fields).filter(([name]) =>
      !["baseOffset", "offset", "nextOffset", "endOffset", "gap", "outputBase64"].includes(name))), expected.start, expected.terminalId);
    if (!canonical) throw new Error("Invalid terminal state");
    acceptReceipt(canonical, expected);
    return canonical;
  }

  async function inspect() {
    if (!workspace || blocked || working.current) return;
    const current = currentCheck(); const end = Date.now() + budgetMs;
    working.current = true; setBusy(true); setReceipt(null);
    try {
      await preflight(end, current);
      const saved = referenceRef.current;
      if (saved) {
        if (saved.start.workspaceId !== workspace.id) { setMessage("Select the original workspace to inspect its terminal. No new terminal was started."); return; }
        if (saved.terminalId) await poll(end, current, saved);
        else {
          const result = await client(end).api.workspaces({ workspaceId: workspace.id }).terminals.receipts({ requestId: saved.start.requestId }).get();
          if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
          if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
          const value = result.error ? null : terminalReceiptFromValue(result.data, saved.start);
          if (!value) throw new Error("Original start remains unknown");
          acceptReceipt(value, saved);
        }
        if (current()) setMessage("Original terminal state inspected. No start or input was resent.");
      } else {
        const result = await client(end).api.workspaces({ workspaceId: workspace.id }).terminals.get();
        if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
        if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
        if (result.error || !result.data || !("terminals" in result.data) || !Array.isArray(result.data.terminals)) throw new Error("Protected terminal routes unavailable");
        setAvailable(true);
        setMessage("Protected terminal routes are available. Prepare the workspace folder before starting.");
      }
    } catch {
      if (current()) { setReceipt(null); setAvailable(false); setMessage("Terminal state is unconfirmed or unavailable on this host. Original identity retained; inspect manually. No mutation was resent."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  useLayoutEffect(() => {
    active.current = true;
    try { const saved = readReference(); referenceRef.current = saved; setReference(saved); setStorageReady(true); }
    catch { setStorageReady(false); setMessage("Terminal storage is unavailable. Writes are disabled; no terminal request was sent."); }
    return () => { active.current = false; epoch.current++; };
  }, [userId]);

  useLayoutEffect(() => {
    epoch.current++; working.current = false; setBusy(false); setReceipt(null); setAvailable(false);
    bytes.current = new Uint8Array(0); cursor.current = 0; setOutput(""); setGap(false); setDraft("");
    if (workspace && !blocked) void inspect();
  }, [userId, workspace?.id, workspace?.archived, blocked]);

  useLayoutEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = currentCheck();
    const tick = async () => {
      const saved = referenceRef.current;
      if (cancelled || !current()) return;
      if (!working.current && saved?.terminalId && saved.start.workspaceId === workspace?.id && !blocked) {
        working.current = true; setBusy(true);
        const end = Date.now() + budgetMs;
        try {
          await session(end, current);
          const confirmed = await poll(end, current, saved);
          if (current()) setMessage(saved.inputUncertain ? "Input delivery remains unknown. State reads do not resend or confirm the original input."
            : confirmed.cleanup === "removed" ? "Host confirms the process ended and was removed."
            : saved.stopRequested ? "Stop is unconfirmed. Input remains disabled."
            : "Terminal state read from the host. Input acknowledgements are not command results.");
        }
        catch { if (current()) { setReceipt(null); setMessage("Terminal state is unconfirmed. Input is disabled; only state reads retry automatically."); } }
        finally { if (current()) { working.current = false; setBusy(false); } }
      }
      if (!cancelled && current()) timer = setTimeout(tick, 750);
    };
    timer = setTimeout(tick, 750);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [userId, workspace?.id, workspace?.archived, blocked, reference?.terminalId]);

  async function start() {
    if (!workspace || blocked || workspace.archived || !storageReady || referenceRef.current || working.current || !available) return;
    const current = currentCheck(); const end = Date.now() + budgetMs;
    const value: TerminalReference = { start: { requestId: crypto.randomUUID(), workspaceId: workspace.id, cols: 80, rows: 24 }, terminalId: null, inputUncertain: false, stopRequested: false };
    working.current = true; setBusy(true); setMessage("Checking the current login and folder…");
    bytes.current = new Uint8Array(0); cursor.current = 0; setOutput(""); setGap(false);
    let sent = false;
    try {
      await preflight(end, current, true);
      if (!current() || Date.now() >= end) return;
      writeReference(value, null);
      if (!current() || Date.now() >= end) { writeReference(null, value); return; }
      sent = true;
      const result = await client(end).api.workspaces({ workspaceId: workspace.id }).terminals.post({ requestId: value.start.requestId, cols: value.start.cols, rows: value.start.rows });
      if (!current() || Date.now() >= end) throw new Error("Start outcome unknown");
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      const confirmed = result.error ? null : terminalReceiptFromValue(result.data, value.start);
      if (!confirmed) throw new Error("Start outcome unknown");
      acceptReceipt(confirmed, value);
      setMessage("Terminal start confirmed by the host. No command was executed on this device.");
    } catch {
      if (current()) { setReceipt(null); setMessage(sent ? "Terminal start outcome is unknown. Original request ID retained; inspect its receipt. No automatic resend." : "Terminal preflight or storage failed. No start was sent; repair or inspect before trying again."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  async function send(text: string, proposal?: string) {
    const saved = referenceRef.current;
    if (!saved?.terminalId || !canInput || working.current) return;
    const encoded = new TextEncoder().encode(text);
    if (!encoded.length || encoded.length > 4096 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== text) { setMessage("Input must be valid UTF-8, at most 4096 bytes."); return; }
    const current = currentCheck(); const end = Date.now() + budgetMs;
    working.current = true; setBusy(true);
    let sent = false;
    try {
      const owned = await preflight(end, current);
      if (owned.archived) throw new Error("Workspace archived");
      const fresh = await poll(end, current, saved);
      if (!current() || fresh.state !== "running" || fresh.inputState !== null && fresh.inputState !== "written") throw new Error("Input is not ready");
      const next = { ...saved, inputUncertain: true };
      writeReference(next, saved);
      if (!current() || Date.now() >= end) { writeReference(saved, next); return; }
      const sequence = fresh.inputSequence + 1;
      sent = true;
      const result = await client(end).api.terminals({ terminalId: saved.terminalId }).input.post({ sequence, text });
      if (!current() || Date.now() >= end) throw new Error("Input outcome unknown");
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      const ack = result.error ? null : terminalInputAckFromValue(result.data, saved.terminalId, sequence);
      if (!ack || ack.state === "unknown") throw new Error("Input outcome unknown");
      writeReference(saved, next);
      if (proposal !== undefined && draftRef.current === proposal) setDraft("");
      setReceipt(null);
      setMessage("Input queued by the host. This is not confirmation that the command succeeded.");
    } catch {
      if (current()) { setReceipt(null); setMessage(sent ? "Input delivery is unknown. Further input is blocked, including after reload. State reads never resend input; inspect or stop the terminal." : "Input preflight or storage failed. No input was sent. Inspect the host before trying again."); }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  async function stop() {
    const saved = referenceRef.current;
    if (!saved?.terminalId || saved.start.workspaceId !== workspace?.id || blocked || !storageReady || saved.stopRequested || working.current) return;
    const current = currentCheck(); const end = Date.now() + budgetMs;
    working.current = true; setBusy(true);
    try {
      await preflight(end, current);
      const next = { ...saved, stopRequested: true };
      writeReference(next, saved);
      if (!current() || Date.now() >= end) { writeReference(saved, next); return; }
      const result = await client(end).api.terminals({ terminalId: saved.terminalId }).stop.post();
      if (!current() || Date.now() >= end) throw new Error("Stop outcome unknown");
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      const confirmed = result.error ? null : terminalReceiptFromValue(result.data, saved.start, saved.terminalId);
      if (!confirmed) throw new Error("Stop outcome unknown");
      acceptReceipt(confirmed, next);
      setMessage(confirmed.cleanup === "removed" ? "Host confirms the terminal ended and its process was removed." : "Stop is not complete. Inspect state; no automatic stop resend.");
    } catch { if (current()) { setReceipt(null); setMessage("Stop outcome is unconfirmed. Input stays disabled. Inspect state; no stop request is resent automatically."); } }
    finally { if (current()) { working.current = false; setBusy(false); } }
  }

  return <section className="terminal-panel" aria-label="Linux terminal" style={{ border: "1px solid #dce4df", borderRadius: 8, padding: 16, marginTop: 16, maxWidth: "100%" }}>
    <h3>Linux terminal</h3>
    {!workspace ? <p>Select a workspace to use its host terminal.</p> : <>
      <p>Line input and bounded plain text. Full-screen ANSI programs and client resize controls are not supported yet.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy || blocked || !available || !storageReady || !!reference || workspace.archived} onClick={() => void start()}>Start Linux terminal</button>
        <button type="button" disabled={busy || blocked} onClick={() => void inspect()}>Inspect terminal state</button>
        <button type="button" disabled={busy || blocked || !storageReady || !sameWorkspace || !reference?.terminalId || reference.stopRequested || closed} onClick={() => void stop()}>Stop terminal</button>
      </div>
      <p role="status" data-testid="terminal-status">{message}</p>
      {reference && !sameWorkspace ? <p>Select the original workspace to inspect its terminal reference.</p> : null}
      {reference?.inputUncertain ? <p role="alert">Input delivery remains unknown. No input will be resent automatically.</p> : null}
      {reference?.stopRequested ? <p>Stop is unconfirmed. Input stays disabled until the host confirms cleanup.</p> : null}
      <p data-testid="terminal-host-state">{currentReceipt ? `Host state: ${currentReceipt.state}; cleanup: ${currentReceipt.cleanup}; ${currentReceipt.cols} columns × ${currentReceipt.rows} rows${currentReceipt.exitCode === null ? "" : `; exit code: ${currentReceipt.exitCode}`}` : "Host terminal state is unconfirmed."}</p>
      {gap ? <p>Earlier output was discarded or is unavailable. Only received bytes are shown.</p> : null}
      <pre aria-label="Terminal output" tabIndex={0} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "auto", maxHeight: 280, minHeight: 80, padding: 12, background: "#12201a", color: "#f4f7f5", borderRadius: 6 }}>{output}</pre>
      <label style={{ display: "block" }}>Terminal input<textarea aria-label="Terminal input" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} autoCorrect="off" autoCapitalize="off" style={{ boxSizing: "border-box", width: "100%", minHeight: 72 }} /></label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy || !canInput || !draft} onClick={() => void send(draft.endsWith("\n") ? draft : `${draft}\n`, draft)}>Send input</button>
        <button type="button" disabled={busy || !canInput} onClick={() => void send("\x03")}>Send Ctrl+C</button>
      </div>
    </>}
  </section>;
}
