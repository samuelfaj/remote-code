import { useLayoutEffect, useRef, useState } from "react";
import "./styles.css";
import { TerminalScreen, type TerminalScreenHandle } from "./TerminalScreen";
import {
  createApiClient, fileFolderStateFromValue, terminalAttachedReceipt, terminalInputAckFromValue, terminalInputRejectionIsDefinitive, terminalPollFromValue, terminalRejectionMessage,
  terminalReceiptFromValue, terminalReferenceFromValue, workspaceErrorStatus, workspaceFromValue,
  workspaceLayoutFromValue, workspaceLayoutResponseFromValue,
  type TerminalReceipt, type TerminalReference, type Workspace, type WorkspaceLayout,
} from "@remotecode/client";

type Props = { userId: string; workspace: Workspace | null; blocked: boolean; onUnauthorized: () => void };
const budgetMs = 10_000;
const outputLimit = 64 * 1024;

// Line input; output is parsed by a read-only xterm emulator from validated byte pages.
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
  const screen = useRef<TerminalScreenHandle>(null);
  const [reference, setReference] = useState<TerminalReference | null>(null);
  const [receipt, setReceipt] = useState<TerminalReceipt | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [cols, setCols] = useState("80");
  const [rows, setRows] = useState("24");
  const [gap, setGap] = useState(false);
  const [message, setMessage] = useState("");
  const [directKeys, setDirectKeys] = useState(false);
  const [queuedKeys, setQueuedKeys] = useState(0);
  const [layout, setLayout] = useState<WorkspaceLayout | null>(null);
  const [layoutMessage, setLayoutMessage] = useState("");
  // This device's own tab/pane selection. The shared layout row stores
  // tabs/panes; the active ids it carries belong to whichever client saved
  // last, so this device never adopts them and never writes its own
  // selection back — switching tabs or panes here cannot move another
  // device's focus.
  const [localTabId, setLocalTabId] = useState<string | null>(null);
  const [localPaneId, setLocalPaneId] = useState<string | null>(null);
  const layoutSavedAt = useRef(0);
  const localTabIdRef = useRef<string | null>(null);
  localTabIdRef.current = localTabId;
  const keyQueue = useRef<string[]>([]);
  const sameWorkspace = reference?.start.workspaceId === workspace?.id;
  const currentReceipt = receipt?.workspaceId === workspace?.id ? receipt : null;
  const closed = currentReceipt?.cleanup === "removed";
  const canInput = !blocked && !workspace?.archived && storageReady && sameWorkspace &&
    !!reference?.terminalId && !reference.inputUncertain && !reference.stopRequested && !reference.resizeUncertain &&
    currentReceipt?.state === "running" && (currentReceipt.inputState === null || currentReceipt.inputState === "written");
  const canResize = !blocked && !workspace?.archived && storageReady && sameWorkspace &&
    !!reference?.terminalId && !reference.inputUncertain && !reference.stopRequested && !reference.resizeUncertain &&
    currentReceipt?.state === "running" && currentReceipt.resizeState !== "unknown";
  const colsValue = /^\d+$/.test(cols) ? Number(cols) : NaN;
  const rowsValue = /^\d+$/.test(rows) ? Number(rows) : NaN;
  const validSize = colsValue >= 2 && colsValue <= 300 && rowsValue >= 2 && rowsValue <= 200;

  function clearScreen(withGap: boolean) { screen.current?.reset(); bytes.current = new Uint8Array(0); cursor.current = 0; setGap(withGap); }

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
    if (workspaceErrorStatus(result.error) === 503) throw new Error("Terminal login check is unavailable");
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
    if (workspaceErrorStatus(result.error) === 404) throw new Error("Workspace is gone on this host");
    if (workspaceErrorStatus(result.error) === 503) throw new Error("Terminal login check is unavailable");
    const owned = result.error ? null : workspaceFromValue(result.data);
    if (!owned || owned.id !== workspace.id) throw new Error("Workspace unavailable");
    if (starting && owned.archived) throw new Error("Workspace is archived");
    if (starting) {
      const folder = await client(end).api.workspaces({ workspaceId: workspace.id }).folder.get();
      if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
      if (workspaceErrorStatus(folder.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(folder.error) === 404) throw new Error("Workspace is gone on this host");
      if (workspaceErrorStatus(folder.error) === 409) throw new Error("Workspace is archived");
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

  // A post-reservation start failure attaches the host receipt alongside the
  // error; shared terminalAttachedReceipt validates it against the attempt's
  // start identity (called with .start below).

  async function poll(end: number, current: () => boolean, expected: TerminalReference) {
    if (!expected.terminalId) throw new Error("Start receipt is pending");
    const offset = cursor.current;
    const result = await client(end).api.terminals({ terminalId: expected.terminalId }).get({ query: { offset: String(offset) } });
    if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
    if (result.error) {
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(result.error) === 404) clearScreen(true);
      if (workspaceErrorStatus(result.error) === 409 &&
        terminalRejectionMessage(result.error) === "terminal_offset_ahead") {
        // Client cursor ran past the producer end (stale cursor after a
        // restart or a second reader advanced state). Reset to the retained
        // window on the next poll instead of failing: no fence, no resend,
        // next tick re-reads with the gap disclosed.
        clearScreen(true);
        throw new Error("Terminal cursor ran ahead. Re-reading retained output; nothing was resent.");
      }
      if (workspaceErrorStatus(result.error) === 503) {
        // Host-side failure on a readonly read. Most 503s are host outages,
        // but receipt-validation 503s are not — so report unconfirmed state
        // with auto-retry, not a definitive outage verdict.
        throw new Error("Terminal state is unconfirmed. State reads retry automatically; nothing was resent.");
      }
      if (workspaceErrorStatus(result.error) === 422) {
        // Invalid poll offset: the client cursor is corrupt (negative or
        // unsafe integer). Same recovery as offset-ahead — reset display
        // refs so the next tick re-reads the retained window. Readonly, no
        // fence, no resend.
        clearScreen(true);
        throw new Error("Terminal cursor is invalid. Re-reading retained output; nothing was resent.");
      }
      throw new Error("Terminal state unavailable for this login");
    }
    const confirmed = terminalPollFromValue(result.data, expected, offset);
    if (!confirmed) throw new Error("Invalid terminal poll");
    screen.current?.resize(confirmed.cols, confirmed.rows);
    if (confirmed.outputAvailable) {
      if (confirmed.gap) clearScreen(true);
      const chunk = Uint8Array.from(atob(confirmed.outputBase64), (character) => character.charCodeAt(0));
      const joined = new Uint8Array(bytes.current.length + chunk.length);
      joined.set(bytes.current); joined.set(chunk, bytes.current.length);
      const truncated = joined.length > outputLimit;
      bytes.current = joined.slice(-outputLimit);
      if (truncated) { screen.current?.reset(); setGap(true); }
      cursor.current = confirmed.nextOffset;
      if (chunk.length) await screen.current?.write(truncated ? bytes.current : chunk);
      if (!current() || Date.now() >= end) throw new Error("Terminal rendering context expired");
    } else clearScreen(true);
    const { outputAvailable, ...fields } = confirmed;
    const canonical = terminalReceiptFromValue(Object.fromEntries(Object.entries(fields).filter(([name]) =>
      !["baseOffset", "offset", "nextOffset", "endOffset", "gap", "outputBase64",
        "retainedBytes", "totalBytes", "droppedBytes"].includes(name))), expected.start, expected.terminalId);
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
        if (saved.terminalId) {
          try {
            await poll(end, current, saved);
          } catch (error) {
            // Surface the poll's own honest verdicts instead of flattening
            // them; everything else stays unconfirmed. Offset-ahead and
            // invalid-cursor are transient (next poll re-reads), so they
            // also stay generic here.
            if (error instanceof Error &&
              (error.message === "Terminal state unavailable for this login" ||
                error.message === "Terminal state is unconfirmed. State reads retry automatically; nothing was resent.")) throw error;
            throw new Error("Terminal state is unconfirmed. Original identity retained; inspect manually. No mutation was resent.");
          }
        }
        else {
          const result = await client(end).api.workspaces({ workspaceId: workspace.id }).terminals.receipts({ requestId: saved.start.requestId }).get();
          if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
          if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
          if (workspaceErrorStatus(result.error) === 404) throw new Error("No terminal receipt is visible to this login");
          const value = result.error ? null : terminalReceiptFromValue(result.data, saved.start);
          if (!value) throw new Error("Original start remains unknown");
          acceptReceipt(value, saved);
        }
        if (current()) setMessage("Original terminal state inspected. No start or input was resent.");
      } else {
        const result = await client(end).api.workspaces({ workspaceId: workspace.id }).terminals.get();
        if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
        if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
        if (workspaceErrorStatus(result.error) === 404) throw new Error("Workspace is gone on this host");
        if (workspaceErrorStatus(result.error) === 503) throw new Error("Terminal login check is unavailable");
        if (result.error || !result.data || !("terminals" in result.data) || !Array.isArray(result.data.terminals)) throw new Error("Protected terminal routes unavailable");
        setAvailable(true);
        setMessage("Protected terminal routes are available. Prepare the workspace folder before starting.");
      }
    } catch (error) {
      if (current()) {
        setReceipt(null); setAvailable(false);
        setMessage(error instanceof Error &&
          (error.message === "Terminal state unavailable for this login" ||
            error.message === "No terminal receipt is visible to this login" ||
            error.message === "Terminal state is unconfirmed. State reads retry automatically; nothing was resent." ||
            error.message === "Workspace is gone on this host" ||
            error.message === "Terminal login check is unavailable")
          ? error.message
          : "Terminal state is unconfirmed or unavailable on this host. Original identity retained; inspect manually. No mutation was resent.");
      }
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
    clearScreen(false); setDraft(""); setLayout(null); setLocalTabId(null); setLocalPaneId(null); setLayoutMessage("");
    if (workspace && !blocked) {
      void inspect();
      const current = currentCheck(); const end = Date.now() + budgetMs;
      const startedAt = Date.now();
      void loadLayout(end, current, workspace.id, startedAt).catch((error) => {
        if (current()) setLayoutMessage(error instanceof Error && error.message === "Saved layout is unreadable on this host"
          ? "Saved layout is unreadable on this host. Tabs start empty; saving overwrites the bad row."
          : error instanceof Error && error.message === "Workspace is gone on this host"
            ? "Workspace is gone on this host. Layout was not loaded; pick another workspace."
            : "Layout is unconfirmed. Inspect state; nothing was overwritten blindly.");
      });
    }
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
        catch (error) {
          if (current()) {
            setReceipt(null);
            if (error instanceof Error && error.message === "Terminal state unavailable for this login" &&
              referenceRef.current === saved) {
              // Definitive 404 on the auto-poll: this login can never observe
              // the terminal again, so release the stale reference and let
              // the user start fresh. No mutation was sent; nothing to fence.
              try { writeReference(null, saved); } catch { /* Storage already reports itself; keep the message. */ }
            }
            setMessage(error instanceof Error && error.message === "Terminal login check is unavailable"
              ? "Terminal login check is unavailable. State reads retry automatically; nothing was resent."
              : error instanceof Error && error.message === "Terminal state unavailable for this login"
                ? "Terminal not found for this login. Start a new terminal when ready."
                : error instanceof Error && (error.message === "Terminal cursor ran ahead. Re-reading retained output; nothing was resent." ||
                  error.message === "Terminal cursor is invalid. Re-reading retained output; nothing was resent.")
                  ? error.message
                  : "Terminal state is unconfirmed. State reads retry automatically; nothing was resent.");
          }
        }
        finally { if (current()) { working.current = false; setBusy(false); drainKeys(); } }
      }
      if (!cancelled && current()) timer = setTimeout(tick, 750);
    };
    timer = setTimeout(tick, 750);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [userId, workspace?.id, workspace?.archived, blocked, reference?.terminalId]);

  async function start() {
    if (!workspace || blocked || workspace.archived || !storageReady || referenceRef.current || working.current || !available) return;
    const current = currentCheck(); const end = Date.now() + budgetMs;
    const value: TerminalReference = { start: { requestId: crypto.randomUUID(), workspaceId: workspace.id, cols: 80, rows: 24 }, terminalId: null, inputUncertain: false, stopRequested: false, resizeUncertain: false };
    working.current = true; setBusy(true); setMessage("Checking the current login and folder…");
    clearScreen(false);
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
      if (workspaceErrorStatus(result.error) === 404) {
        // Ambiguous: pre-reservation misses (workspace/folder/token) reserve
        // nothing, but post-INSERT guard()/launch() re-checks throw the same
        // 404 after the reserved row commits, and the server strips the
        // receipt on 404. The response carries no marker, so keep the
        // reference and report unknown with the request ID retained.
        setMessage("Workspace may be gone on this host. Start outcome is unknown. Original request ID retained; inspect its receipt. No automatic resend.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 409 && terminalRejectionMessage(result.error) === "request_id_conflict") {
        // Same request ID with different dims: a terminal already exists for
        // this ID, but its stored dims differ from this attempt's, so the
        // receipt cannot validate against the conflicting dims. Report the
        // conflict honestly with the original request ID retained; the user
        // inspects the existing receipt instead of starting a second terminal.
        setMessage("A terminal already exists for this request with different dimensions. Original request ID retained; inspect its receipt. No second terminal was started.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 409 &&
        (terminalRejectionMessage(result.error) === "workspace_archived" ||
          terminalRejectionMessage(result.error) === "terminal_workspace_changed" ||
          terminalRejectionMessage(result.error) === "terminal_workspace_identity_required")) {
        // Usually pre-reservation refusals (nothing reserved — drop the
        // reference and retry fresh). But the same messages can fire from
        // post-INSERT guard()/launch() re-checks with a receipt attached, so
        // prefer an attached valid receipt when present before clearing.
        const attached = terminalAttachedReceipt(result.error, value.start);
        if (attached) {
          acceptReceipt(attached, value);
          setMessage("Terminal start reported a workspace refusal, but the host receipt confirms state. Inspect it before acting.");
          return;
        }
        // Definitive pre-reservation refusals: the backend throws before the
        // INSERT transaction, so nothing was reserved. Drop the local
        // reference and let the user fix the cause and try again fresh.
        writeReference(null, value);
        const reason = terminalRejectionMessage(result.error);
        setMessage(reason === "workspace_archived"
          ? "Workspace is archived. Nothing was started; unarchive it or pick another workspace."
          : reason === "terminal_workspace_identity_required"
            ? "Workspace folder ownership changed. Nothing was started; prepare the folder and try again."
            : "Workspace folder changed. Nothing was started; prepare the folder and try again.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 422) {
        // Invalid request shape: nothing was reserved server-side, so drop
        // the local reference and let the user try again with a fresh ID.
        writeReference(null, value);
        setMessage("Host rejected the start request as invalid. Nothing was started; try again.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 503 && terminalRejectionMessage(result.error) === "terminals_closing") {
        // Host is shutting down: nothing was reserved for this request.
        // Drop the local reference so a later try uses a fresh request ID.
        writeReference(null, value);
        setMessage("Host is shutting down. Nothing was started; try again later.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 503) {
        // All 503s share one posture: terminals_closing is handled above
        // (proven pre-reservation clear); everything else is ambiguous
        // because post-reservation failures attach a receipt alongside the
        // error. Prefer an attached valid receipt when present; otherwise
        // keep the reference and report unknown with the request ID retained.
        // terminal_capacity keeps its own capacity wording, other 503s share
        // the generic host-failure wording.
        const reason = terminalRejectionMessage(result.error);
        const attached = terminalAttachedReceipt(result.error, value.start);
        if (attached) {
          acceptReceipt(attached, value);
          setMessage(reason === "terminal_capacity"
            ? "Terminal start reported host capacity pressure, but the host receipt confirms state. Inspect it before acting."
            : "Terminal start reported a host failure, but the host receipt confirms state. Inspect it before acting.");
          return;
        }
        setMessage(reason === "terminal_capacity"
          ? "Host may be at terminal capacity. Start outcome is unknown. Original request ID retained; inspect its receipt. No automatic resend."
          : "Host failed to start the terminal. Start outcome is unknown. Original request ID retained; inspect its receipt. No automatic resend.");
        return;
      }
      const confirmed = result.error ? null : terminalReceiptFromValue(result.data, value.start);
      if (!confirmed) throw new Error("Start outcome unknown");
      acceptReceipt(confirmed, value);
      setMessage("Terminal start confirmed by the host. No command was executed on this device.");
    } catch (error) {
      if (current()) {
        setReceipt(null);
        setMessage(error instanceof Error && (error.message === "Workspace is archived" ||
          error.message === "Workspace is gone on this host" ||
          error.message === "Prepare the workspace folder first" ||
          error.message === "Terminal login check is unavailable")
          ? `${error.message}. No start was sent.`
          : sent ? "Terminal start outcome is unknown. Original request ID retained; inspect its receipt. No automatic resend." : "Terminal preflight or storage failed. No start was sent; repair or inspect before trying again.");
      }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  async function send(text: string, proposal?: string) {
    const saved = referenceRef.current;
    if (!saved?.terminalId || !canInput) return;
    const encoded = new TextEncoder().encode(text);
    if (!encoded.length || encoded.length > 4096 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== text) { setMessage("Input must be valid UTF-8, at most 4096 bytes."); return; }
    if (working.current) {
      // Direct keystrokes queue while a send or state poll holds the lock;
      // the queue drains in order once the lock releases. Line input keeps
      // its old behavior: the Send buttons disable while busy.
      if (proposal === undefined) enqueueKey(text);
      return;
    }
    const current = currentCheck(); const end = Date.now() + budgetMs;
    working.current = true; setBusy(true);
    let sent = false;
    try {
      const owned = await preflight(end, current);
      if (owned.archived) throw new Error("Workspace is archived");
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
      if (terminalInputRejectionIsDefinitive(workspaceErrorStatus(result.error), terminalRejectionMessage(result.error))) {
        writeReference(saved, next);
        setMessage(terminalRejectionMessage(result.error) === "terminal_input_pending"
          ? "Host is still writing the previous input. Wait for the next state poll, then try again; nothing was queued."
          : "Host refused input. Nothing was queued; inspect state before trying again.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 422) {
        // Invalid input shape: the backend validates before reserving the
        // sequence, so clear the locally set uncertainty fence and let the
        // user fix the input and try again.
        writeReference(saved, next);
        setMessage("Host rejected the input as invalid. Nothing was queued; fix the input and try again.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 404) {
        // Unknown terminal for this login: another login's terminal, a
        // removed terminal, or a revoked session. Nothing was queued.
        // Clear the fence so input is not blocked on a terminal this login
        // can never observe; the user selects the original workspace/login
        // or starts fresh.
        writeReference(saved, next);
        clearScreen(true);
        setMessage("Terminal not found for this login. Nothing was queued; select the original workspace or start a new terminal.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 503 &&
        terminalRejectionMessage(result.error) === "terminals_unavailable") {
        // Host unavailable before any reservation: available() throws before
        // liveContext/reservation, so nothing was queued. Clear the fence.
        writeReference(saved, next);
        setMessage("Terminal host is unavailable. Nothing was queued; try again when the host is back.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 503) {
        // Any other host failure: the reservation point is unknown (the
        // response carries no marker on this route), so keep the fence set
        // before POST and report unknown with no resend; the next poll shows
        // the durable input state.
        setMessage("Host failed to write the input. Input delivery is unknown. Further input is blocked, including after reload. State reads never resend input; inspect or stop the terminal.");
        return;
      }
      const ack = result.error ? null : terminalInputAckFromValue(result.data, saved.terminalId, sequence);
      if (!ack || ack.state === "unknown") throw new Error("Input outcome unknown");
      writeReference(saved, next);
      if (proposal !== undefined && draftRef.current === proposal) setDraft("");
      setReceipt(null);
      setMessage(keyQueue.current.length > 0 ? `Input queued by the host. ${keyQueue.current.length} keystroke(s) waiting.` : "Input queued by the host. This is not confirmation that the command succeeded.");
    } catch (error) {
      if (current()) {
        setReceipt(null);
        setMessage(error instanceof Error && error.message === "Workspace is archived"
          ? `${error.message}. No input was sent.`
          : error instanceof Error && (error.message === "Terminal login check is unavailable" ||
            error.message === "Workspace is gone on this host")
            ? `${error.message}. No input was sent; state reads retry automatically.`
            : sent ? "Input delivery is unknown. Further input is blocked, including after reload. State reads never resend input; inspect or stop the terminal." : "Input preflight or storage failed. No input was sent. Inspect the host before trying again.");
      }
      if (keyQueue.current.length > 0) {
        const dropped = keyQueue.current.length;
        keyQueue.current = []; setQueuedKeys(0);
        if (current()) setMessage((prior) => `${prior} ${dropped} queued keystroke(s) discarded unsent.`);
      }
    } finally { if (current()) { working.current = false; setBusy(false); drainKeys(); } }
  }

  // Direct-keystroke queue: keys typed while a send or poll holds the lock
  // wait here instead of being dropped. The queue drains one key per send()
  // round-trip; a failed or uncertain send keeps the fence (input stays
  // blocked) and drops the queue so no key is silently reordered past it.
  // Definitive refusals and invalid input return early instead: the fence is
  // cleared and surviving keys drain in order on the next send.
  function enqueueKey(text: string) {
    const encoded = new TextEncoder().encode(text);
    if (!encoded.length || encoded.length > 4096) return;
    const queuedBytes = new TextEncoder().encode(keyQueue.current.join("")).length;
    if (queuedBytes + encoded.length > 4096) return;
    keyQueue.current.push(text);
    setQueuedKeys(keyQueue.current.length);
  }

  function drainKeys() {
    const saved = referenceRef.current;
    if (!saved?.terminalId || working.current || keyQueue.current.length === 0) { setQueuedKeys(keyQueue.current.length); return; }
    if (!canInput) {
      // Input can never flow again on this reference (uncertain fence,
      // stopped terminal, or unobservable login): surface the drop count
      // instead of clearing silently, so no keystroke vanishes quietly.
      const dropped = keyQueue.current.length;
      keyQueue.current = []; setQueuedKeys(0);
      setMessage((prior) => prior.length > 0 ? `${prior} ${dropped} queued keystroke(s) discarded unsent.` : `${dropped} queued keystroke(s) discarded unsent.`);
      return;
    }
    const next = keyQueue.current.shift()!;
    setQueuedKeys(keyQueue.current.length);
    void send(next);
  }

  function clearKeys() { keyQueue.current = []; setQueuedKeys(0); }

  async function resize() {
    const saved = referenceRef.current;
    if (!saved?.terminalId || !canResize || working.current || !validSize) return;
    const wantCols = colsValue, wantRows = rowsValue;
    const current = currentCheck(); const end = Date.now() + budgetMs;
    working.current = true; setBusy(true);
    let sent = false;
    try {
      const owned = await preflight(end, current);
      if (owned.archived) throw new Error("Workspace is archived");
      const fresh = await poll(end, current, saved);
      if (!current() || fresh.state !== "running" || fresh.resizeState === "unknown") throw new Error("Resize is not ready");
      const next = { ...saved, resizeUncertain: true };
      writeReference(next, saved);
      if (!current() || Date.now() >= end) { writeReference(saved, next); return; }
      sent = true;
      const result = await client(end).api.terminals({ terminalId: saved.terminalId }).resize.post({ cols: wantCols, rows: wantRows });
      if (!current() || Date.now() >= end) throw new Error("Resize outcome unknown");
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(result.error) === 409) {
        // Resize refused on an unsettled terminal: fall back to a readonly
        // poll for the authoritative receipt instead of failing. If the poll
        // itself throws, the outcome is unknown (fence kept) with no resend.
        // terminal_not_running is definitive (the process ended — no resize
        // can apply), so say so directly instead of polling a dead terminal.
        if (terminalRejectionMessage(result.error) === "terminal_not_running") {
          setMessage("Terminal process ended. Resize cannot apply; Stop the terminal to release it.");
          return;
        }
        try {
          const settled = await poll(end, current, saved);
          if (settled.resizeState === "applied" && settled.cols === wantCols && settled.rows === wantRows) {
            writeReference(saved, next);
            acceptReceipt(settled, saved);
            setMessage(`Host confirms ${settled.cols} columns × ${settled.rows} rows.`);
          } else {
            acceptReceipt(settled, next);
            setMessage("Resize is not complete. Input stays blocked; Stop the terminal to release it.");
          }
        } catch {
          setMessage("Resize outcome is unconfirmed after a refusal. The terminal size is unknown; Stop the terminal to release it.");
        }
        return;
      }
      if (workspaceErrorStatus(result.error) === 422) {
        // Invalid dims shape: the backend validates before touching resize
        // state, so clear the locally set fence and let the user fix and retry.
        writeReference(saved, next);
        setMessage("Host rejected the size as invalid. Nothing changed; fix the dimensions and try again.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 404) {
        // Unknown terminal for this login: clear the fence (this login can
        // never observe it) and clear the screen of its stale bytes.
        writeReference(saved, next);
        clearScreen(true);
        setMessage("Terminal not found for this login. Nothing changed; select the original workspace or start a new terminal.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 503 &&
        terminalRejectionMessage(result.error) === "terminals_unavailable") {
        // Host unavailable: available() throws this only pre-reservation on
        // the top-level call, but post-update guard() calls re-check it too,
        // and the response carries no marker. The safe posture is unknown:
        // keep the fence and let the next poll show the durable resize state.
        // (A proven pre-update unavailable would clear; unprovable here.)
        setMessage("Terminal host is unavailable. Resize outcome is unknown. Further input and resize are blocked, including after reload. Stop the terminal to release it.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 503) {
        // Any other host failure: the resize_state update point is unknown
        // (the response carries no marker on this route), so keep the fence
        // and report unknown with no resend; the next poll shows the durable
        // resize state.
        setMessage("Host failed to apply the size. Resize outcome is unknown. Further input and resize are blocked, including after reload. Stop the terminal to release it.");
        return;
      }
      const confirmed = result.error ? null : terminalReceiptFromValue(result.data, saved.start, saved.terminalId);
      if (!confirmed || confirmed.resizeState !== "applied" || confirmed.cols !== wantCols || confirmed.rows !== wantRows) throw new Error("Resize outcome unknown");
      writeReference(saved, next);
      acceptReceipt(confirmed, saved);
      setMessage(`Host confirms ${confirmed.cols} columns × ${confirmed.rows} rows.`);
    } catch (error) {
      if (current()) {
        setReceipt(null);
        setMessage(error instanceof Error && error.message === "Workspace is archived"
          ? `${error.message}. No resize was sent.`
          : error instanceof Error && (error.message === "Terminal login check is unavailable" ||
            error.message === "Workspace is gone on this host")
            ? `${error.message}. No resize was sent; state reads retry automatically.`
            : sent ? "Resize outcome is unknown. Further input and resize are blocked, including after reload. Stop the terminal to release it." : "Resize preflight or storage failed. No resize was sent. Inspect the host before trying again.");
      }
    } finally { if (current()) { working.current = false; setBusy(false); } }
  }

  async function loadLayout(end: number, current: () => boolean, workspaceId: string, after?: number) {
    const result = await client(end).api.workspaces({ workspaceId }).layout.get();
    if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
    if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
    if (workspaceErrorStatus(result.error) === 503) throw new Error("Saved layout is unreadable on this host");
    if (workspaceErrorStatus(result.error) === 404) throw new Error("Workspace is gone on this host");
    if (result.error) throw new Error("Workspace layout unavailable");
    const parsed = result.data && (result.data as { layout?: unknown }).layout === null
      ? null : workspaceLayoutResponseFromValue(result.data, workspaceId);
    if (result.data && (result.data as { layout?: unknown }).layout !== null && !parsed) throw new Error("Invalid workspace layout");
    // A save that confirmed while this read was in flight wins: stale reads
    // must not overwrite it (>= covers same-millisecond clock ties).
    if (after !== undefined && layoutSavedAt.current >= after) return;
    // Per-device selection: the server stores shared tabs/panes, but the
    // active tab/pane it returns belongs to whichever client saved last.
    // Never adopt it, or one device's selection hijacks this device's focus.
    // Fall back to the first stored tab; keep a purely local selection.
    if (current()) {
      setLayout(parsed);
      // Local selection defaults to the first shared tab and its first pane;
      // a stored active id from another device is never adopted.
      setLocalTabId(parsed ? parsed.tabs[0]?.id ?? null : null);
      const firstTab = parsed?.tabs[0]?.id;
      const firstPane = parsed?.panes?.filter((pane) => pane.tabId === firstTab).sort((a, b) => a.order - b.order)[0]?.id ?? null;
      setLocalPaneId(firstPane);
      setLayoutMessage(parsed ? `Layout restored: ${parsed.tabs.length} tab(s).` : "No saved layout for this workspace.");
    }
  }

  async function saveLayout() {
    if (!workspace || blocked || !storageReady || working.current) return;
    const current = currentCheck(); const end = Date.now() + budgetMs;
    working.current = true; setBusy(true);
    try {
      const owned = await preflight(end, current);
      if (owned.archived) throw new Error("Workspace is archived");
      // Merge, never blind-replace: reload the stored layout first so file,
      // thread and pane entries the terminal panel does not own survive.
      const stored = await client(end).api.workspaces({ workspaceId: workspace.id }).layout.get();
      if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
      if (workspaceErrorStatus(stored.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(stored.error) === 503) {
        // Corrupt stored row: nothing salvageable to merge, but the PUT
        // path upserts unconditionally, so a fresh save repairs the row.
        // Seed empty and continue instead of throwing.
        if (current()) setLayoutMessage("Saved layout is unreadable on this host. Starting empty; saving repairs the stored row.");
      } else if (stored.error) {
        if (workspaceErrorStatus(stored.error) === 404) throw new Error("Workspace is gone on this host");
        throw new Error("Workspace layout unavailable");
      }
      const existing = (stored.data as { layout?: unknown } | undefined)?.layout === null ||
        workspaceErrorStatus(stored.error) === 503
        ? { tabs: [], activeTabId: null } : workspaceLayoutResponseFromValue(stored.data, workspace.id);
      if ((stored.data as { layout?: unknown } | undefined)?.layout !== null && workspaceErrorStatus(stored.error) !== 503 && !existing) throw new Error("Invalid workspace layout");
      const saved = referenceRef.current;
      const terminalTab = saved?.terminalId && saved.start.workspaceId === workspace.id
        ? [{ id: `terminal-${saved.terminalId.slice(0, 8)}`, kind: "terminal" as const, targetId: saved.terminalId }]
        : [];
      // This panel owns only its live terminal tab (matched by live
      // terminalId) plus stale "terminal-"-prefixed tabs it wrote before:
      // drop the stale ones, keep file/thread tabs AND foreign terminal tabs
      // owned by other devices/sessions (no "terminal-" prefix and not this
      // device's live id). Panes pointing at a dropped terminal tab are
      // pruned too, so the merged layout stays valid instead of failing
      // the save.
      const kept = (existing?.tabs ?? []).filter((tab) => tab.kind !== "terminal" || !(tab.targetId === saved?.terminalId || tab.id.startsWith("terminal-")));
      const keptIds = new Set(kept.map((tab) => tab.id));
      // Pruning a dropped terminal tab can leave pane order gaps; validators
      // require dense orders from zero, so re-index surviving panes.
      const keptPanes = (existing?.panes ?? [])
        .filter((pane) => keptIds.has(pane.tabId))
        .sort((a, b) => a.order - b.order)
        .map((pane, index) => ({ ...pane, order: index }));
      const tabs = [...kept, ...terminalTab];
      // Merge keeps the stored shared structure but never adopts the stored
      // selection: active tab/pane stays local to this device. Send the
      // stored active ids back unchanged so a merge-save cannot move another
      // device's focus; only a brand-new layout picks the fresh terminal tab.
      const storedActiveTab = existing?.activeTabId ?? null;
      const storedActivePane = existing?.activePaneId;
      const next: WorkspaceLayout = { tabs, activeTabId: terminalTab.length > 0 && tabs.length === terminalTab.length ? terminalTab[0].id : storedActiveTab };
      const survivingPanes = keptPanes.filter((pane) => tabs.some((tab) => tab.id === pane.tabId));
      if (survivingPanes.length > 0 || existing?.panes !== undefined) {
        next.panes = survivingPanes;
        next.activePaneId = survivingPanes.some((pane) => pane.id === storedActivePane) ? storedActivePane ?? null : null;
      }
      if (terminalTab.length === 0 && tabs.length === 0) { next.activeTabId = null; }
      // A pruned selection must fall back to a surviving tab, but locally:
      // keep the stored id when valid so this save does not move it, else
      // fall back to the first surviving tab.
      if (next.activeTabId !== null && !tabs.some((tab) => tab.id === next.activeTabId)) next.activeTabId = tabs[0]?.id ?? null;
      if (!workspaceLayoutFromValue(next)) throw new Error("Invalid workspace layout");
      // Live archived re-check just before PUT: the workspace may have been
      // archived after preflight. The backend refuses with 409, but a local
      // check avoids sending a doomed write.
      const live = await client(end).api.workspaces({ workspaceId: workspace.id }).get();
      if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
      if (workspaceErrorStatus(live.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(live.error) === 404) throw new Error("Workspace is gone on this host");
      if (workspaceErrorStatus(live.error) === 503) throw new Error("Terminal login check is unavailable");
      const liveWorkspace = live.error ? null : workspaceFromValue(live.data);
      if (!liveWorkspace) throw new Error("Workspace layout unavailable");
      if (liveWorkspace.archived) throw new Error("Workspace is archived");
      const result = await client(end).api.workspaces({ workspaceId: workspace.id }).layout.put(next);
      if (!current() || Date.now() >= end) throw new Error("Terminal context expired");
      if (workspaceErrorStatus(result.error) === 401) onUnauthorized();
      if (workspaceErrorStatus(result.error) === 409) throw new Error("Workspace is archived");
      if (workspaceErrorStatus(result.error) === 422) throw new Error("Saved layout shape is invalid");
      if (workspaceErrorStatus(result.error) === 503) throw new Error("Layout write failed on this host");
      if (workspaceErrorStatus(result.error) === 404) throw new Error("Workspace is gone on this host");
      const confirmed = result.error ? null : workspaceLayoutResponseFromValue(result.data, workspace.id);
      if (!confirmed) throw new Error("Workspace layout not confirmed");
      layoutSavedAt.current = Date.now();
      if (current()) {
        // Keep rendering the shared tabs, but keep this device's own
        // selection: a confirmed save must not move local focus to the
        // stored active id another device may have written. Compute the next
        // tab id first (not via ref) so the pane fallback uses the tab this
        // save actually selects, never a stale render value.
        setLayout(confirmed);
        const nextTabId = localTabIdRef.current !== null && confirmed.tabs.some((tab) => tab.id === localTabIdRef.current)
          ? localTabIdRef.current : confirmed.tabs[0]?.id ?? null;
        setLocalTabId(nextTabId);
        setLocalPaneId((prior) => {
          const panes = confirmed.panes ?? [];
          const inTab = panes.filter((pane) => pane.tabId === nextTabId).sort((a, b) => a.order - b.order);
          if (prior !== null && inTab.some((pane) => pane.id === prior)) return prior;
          return inTab[0]?.id ?? null;
        });
        setLayoutMessage(`Layout saved: ${confirmed.tabs.length} tab(s).`);
      }
    } catch (error) {
      if (current()) setLayoutMessage(error instanceof Error && error.message === "Workspace is archived"
        ? "Workspace is archived. Layout was not saved."
        : error instanceof Error && error.message === "Saved layout shape is invalid"
          ? "Saved layout shape is invalid. Stored layout unchanged; reload and save again."
          : error instanceof Error && error.message === "Layout write failed on this host"
          ? "Layout write failed on this host. Stored layout unchanged; try saving again."
          : error instanceof Error && error.message === "Workspace is gone on this host"
            ? "Workspace is gone on this host. Layout was not saved; pick another workspace."
            : error instanceof Error && error.message === "Terminal login check is unavailable"
              ? "Terminal login check is unavailable. Layout was not saved; state reads retry automatically."
              : "Layout is unconfirmed. Inspect state; nothing was overwritten blindly.");
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
      if (workspaceErrorStatus(result.error) === 409) {
        // Stop refused on an already-settling terminal: fall back to a
        // readonly poll for the authoritative receipt instead of failing.
        // If the poll itself throws, the outcome is unknown (fence kept);
        // an observable receipt is adopted with a cleanup-branched message.
        // The 409 only proves the refusal; removal is proven by the poll.
        try {
          const settled = await poll(end, current, saved);
          acceptReceipt(settled, next);
          setMessage(settled.cleanup === "removed" ? "Stop confirmed by a follow-up state read; the terminal ended and its process was removed." : "Stop is not complete. Inspect state; no automatic stop resend.");
        } catch {
          setMessage("Stop outcome is unconfirmed after a refusal. The terminal state is unknown for this login; inspect state. No stop request is resent automatically.");
        }
        return;
      }
      if (workspaceErrorStatus(result.error) === 422) {
        // Invalid stop shape: the backend validates before acting, so clear
        // the locally set stop fence and let the user inspect or retry.
        writeReference(saved, next);
        setMessage("Host rejected the stop request as invalid. Nothing changed; inspect state before trying again.");
        return;
      }
      if (workspaceErrorStatus(result.error) === 404) {
        // Distinguish the two 404 sources: a pre-action ownedRow miss means
        // no stop was ever initiated (release the fence so the slot is not
        // stuck); a post-action final-read miss means the outcome is unknown.
        // The stop route's first ownedRow runs before makeContext/stopContext,
        // but the response carries no marker — so verify with a readonly poll:
        // if the terminal is observable, the miss was transient/pre-action
        // and the fence releases; if it is gone, the outcome stays unknown.
        try {
          await poll(end, current, saved);
          writeReference(saved, next);
          clearScreen(true);
          setMessage("Terminal not found for this login, but its state reads. Stop fence released; inspect state or start a new terminal.");
        } catch {
          setMessage("Stop outcome is unconfirmed. The terminal is gone for this login; inspect state. No stop request is resent automatically.");
        }
        return;
      }
      if (workspaceErrorStatus(result.error) === 503) {
        // Host failure on stop: the stop point is unknown (initiated or not),
        // and the response carries no marker — so keep the fence and verify
        // with a readonly poll the same way as the 404 path: observable →
        // adopt the authoritative receipt; gone → outcome stays unknown.
        // No resend either way.
        try {
          const settled = await poll(end, current, saved);
          acceptReceipt(settled, next);
          setMessage(settled.cleanup === "removed" ? "Stop confirmed by a follow-up state read; the terminal ended and its process was removed." : "Stop is not complete. Inspect state; no automatic stop resend.");
        } catch {
          setMessage("Stop outcome is unconfirmed after a host failure. The terminal state is unknown for this login; inspect state. No stop request is resent automatically.");
        }
        return;
      }
      const confirmed = result.error ? null : terminalReceiptFromValue(result.data, saved.start, saved.terminalId);
      if (!confirmed) throw new Error("Stop outcome unknown");
      acceptReceipt(confirmed, next);
      setMessage(confirmed.cleanup === "removed" ? "Stop confirmed by the host receipt; the terminal ended and its process was removed." : "Stop is not complete. Inspect state; no automatic stop resend.");
    } catch (error) {
      if (current()) {
        setReceipt(null);
        setMessage(error instanceof Error && (error.message === "Terminal login check is unavailable" ||
          error.message === "Workspace is gone on this host")
          ? `${error.message}. No stop was sent; state reads retry automatically.`
          : "Stop outcome is unconfirmed. Input stays disabled. Inspect state; no stop request is resent automatically.");
      }
    }
    finally { if (current()) { working.current = false; setBusy(false); } }
  }

  return <section className="terminal-panel" aria-label="Linux terminal" style={{ border: "1px solid #dce4df", borderRadius: 8, padding: 16, marginTop: 16, maxWidth: "100%" }}>
    <h3>Linux terminal</h3>
    {!workspace ? <p>Select a workspace to use its host terminal.</p> : <>
      <p>Line input with a read-only terminal screen. {directKeys ? `Direct keyboard input is on: typing in the terminal screen queues each keystroke and sends them in order through the same host input queue.${queuedKeys > 0 ? ` ${queuedKeys} waiting.` : ""}` : "Direct keyboard input is off."}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy || blocked || !available || !storageReady || !!reference || workspace.archived} onClick={() => void start()}>Start Linux terminal</button>
        <button type="button" disabled={busy || blocked} onClick={() => void inspect()}>Inspect terminal state</button>
        <button type="button" disabled={busy || blocked || !storageReady || !sameWorkspace || !reference?.terminalId || reference.stopRequested || closed} onClick={() => void stop()}>Stop terminal</button>
      </div>
      <p role="status" data-testid="terminal-status">{message}</p>
      {reference && !sameWorkspace ? <p>Select the original workspace to inspect its terminal reference.</p> : null}
      {reference?.inputUncertain ? <p role="alert">Input delivery remains unknown. No input will be resent automatically.</p> : null}
      {reference?.resizeUncertain ? <p role="alert">Resize outcome remains unknown. The terminal size is unconfirmed and input is blocked; Stop the terminal to release it.</p> : null}
      {reference?.stopRequested ? <p>Stop is unconfirmed. Input stays disabled until the host confirms cleanup.</p> : null}
      {currentReceipt?.inputState === "queued" ? <p data-testid="terminal-input-backpressure">Host buffered input. Poll before sending more.</p> : null}
      <p data-testid="terminal-host-state">{currentReceipt ? `Host state: ${currentReceipt.state}; cleanup: ${currentReceipt.cleanup}; ${currentReceipt.cols} columns × ${currentReceipt.rows} rows; resize: ${currentReceipt.resizeState}${currentReceipt.exitCode === null ? "" : `; exit code: ${currentReceipt.exitCode}`}` : "Host terminal state is unconfirmed."}</p>
      {gap ? <p>Earlier output was discarded or is unavailable. Only received bytes are shown.</p> : null}
      {currentReceipt?.flow ? <p data-testid="terminal-flow-state">{`Flow: ${currentReceipt.flow.totalBytes} produced, ${currentReceipt.flow.retainedBytes} retained, ${currentReceipt.flow.droppedBytes} dropped.`}</p> : null}
      <TerminalScreen ref={screen} size={currentReceipt ? { cols: currentReceipt.cols, rows: currentReceipt.rows } : null}
        onKey={directKeys && canInput ? (key) => void send(key) : undefined} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" disabled={busy || blocked || !canInput} onClick={() => { clearKeys(); setDirectKeys((value) => !value); if (!directKeys) screen.current?.focus(); }}>
          {directKeys ? "Turn off direct keyboard input" : "Turn on direct keyboard input"}
        </button>
      </div>
      <div className="terminal-resize">
        <label>Columns (2–300)<input type="number" inputMode="numeric" min={2} max={300} step={1} value={cols} onChange={(event) => setCols(event.target.value)} /></label>
        <label>Rows (2–200)<input type="number" inputMode="numeric" min={2} max={200} step={1} value={rows} onChange={(event) => setRows(event.target.value)} /></label>
        <button type="button" disabled={busy || !canResize || !validSize} onClick={() => void resize()}>Apply size</button>
      </div>
      <label style={{ display: "block" }}>Terminal input<textarea aria-label="Terminal input" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} autoCorrect="off" autoCapitalize="off" style={{ boxSizing: "border-box", width: "100%", minHeight: 72 }} /></label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy || !canInput || !draft} onClick={() => void send(draft.endsWith("\n") ? draft : `${draft}\n`, draft)}>Send input</button>
        <button type="button" disabled={busy || !canInput} onClick={() => void send("\x03")}>Send Ctrl+C</button>
        <button type="button" disabled={busy || blocked || !storageReady || !workspace || workspace.archived} onClick={() => void saveLayout()}>Save layout</button>
      </div>
      <p data-testid="terminal-layout-state">{layoutMessage || "Layout not loaded for this workspace."}{layout ? ` Shared tabs: ${layout.tabs.length}; this device: ${localTabId ?? "none"}; pane: ${localPaneId ?? "none"}; selection stays on this device.` : ""}</p>
      {layout ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }} aria-label="Local tabs" data-testid="terminal-local-tabs">
        {layout.tabs.length === 0 ? <span>No shared tabs yet.</span> : layout.tabs.map((tab) => <button key={tab.id} type="button" disabled={tab.id === localTabId} onClick={() => {
          setLocalTabId(tab.id);
          const inTab = (layout.panes ?? []).filter((pane) => pane.tabId === tab.id).sort((a, b) => a.order - b.order);
          setLocalPaneId(inTab[0]?.id ?? null);
        }}>Open {tab.id}{tab.id === localTabId ? " (this device)" : ""}</button>)}
      </div> : null}
      {layout && localTabId ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }} aria-label="Local panes" data-testid="terminal-local-panes">
        {layout.panes?.filter((pane) => pane.tabId === localTabId).sort((a, b) => a.order - b.order).map((pane) => <button key={pane.id} type="button" disabled={pane.id === localPaneId} onClick={() => setLocalPaneId(pane.id)}>Open {pane.id}{pane.id === localPaneId ? " (this device)" : ""}</button>) ?? null}
        {(layout.panes?.filter((pane) => pane.tabId === localTabId).length ?? 0) === 0 ? <span>No panes on this tab.</span> : null}
      </div> : null}
    </>}
  </section>;
}
