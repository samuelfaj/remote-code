import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { color } from "../../design/tokens";

export type TerminalScreenHandle = {
  // Recreates the emulator so parser, UTF-8 decoder and buffers all start clean.
  reset(): void;
  resize(cols: number, rows: number): void;
  write(bytes: Uint8Array): Promise<void>;
  focus(): void;
};
type Props = { size: { cols: number; rows: number } | null; onKey?: (text: string) => void };

Terminal.strings.promptLabel = "Terminal screen focus";

export const TerminalScreen = forwardRef<TerminalScreenHandle, Props>(function TerminalScreen({ size, onKey }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const pending = useRef(new Set<() => void>());
  const dims = useRef(size);
  const keyHandler = useRef(onKey);
  keyHandler.current = onKey;

  function create() {
    const next = new Terminal({
      disableStdin: false, scrollback: 1000, screenReaderMode: true, cursorBlink: false,
      cols: dims.current?.cols ?? 80, rows: dims.current?.rows ?? 24, fontSize: 13,
      theme: { background: color.terminalBg, foreground: color.terminalFg, cursor: color.terminalFg, selectionBackground: color.selection },
    });
    // Direct keyboard input stays gated by the parent: the emulator only
    // forwards keystrokes while a handler is attached; with no handler the
    // screen is effectively read-only.
    next.onKey(({ key }) => keyHandler.current?.(key));
    next.open(host.current!);
    term.current = next;
  }
  function destroy() {
    term.current?.dispose(); term.current = null;
    for (const done of pending.current) done();
    pending.current.clear();
  }

  useLayoutEffect(() => { create(); return destroy; }, []);
  useLayoutEffect(() => {
    if (size) { dims.current = size; term.current?.resize(size.cols, size.rows); }
  }, [size?.cols, size?.rows]);
  useImperativeHandle(ref, () => ({
    reset() { destroy(); create(); },
    resize(cols, rows) { dims.current = { cols, rows }; term.current?.resize(cols, rows); },
    focus() { term.current?.focus(); },
    write(bytes) {
      const target = term.current;
      return target ? new Promise<void>((resolve) => {
        const done = () => { pending.current.delete(done); resolve(); };
        pending.current.add(done);
        target.write(bytes, done);
      }) : Promise.resolve();
    },
  }), []);

  return <div className="terminal-screen" role="group" aria-label="Terminal output" ref={host} />;
});
