import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TerminalScreen, type TerminalScreenHandle } from "../../src/features/terminals/TerminalScreen";
import "../../src/features/terminals/styles.css";

const text = (value: string) => new TextEncoder().encode(value);
const STALE = text("STALE-OUTPUT" + "x".repeat(50_000));

function Harness() {
  const screen = useRef<TerminalScreenHandle>(null);
  const [mounted, setMounted] = useState(true);
  const [settled, setSettled] = useState(0);
  const [keys, setKeys] = useState<string[]>([]);
  const [gated, setGated] = useState(false);
  const done = () => setSettled((count) => count + 1);
  const feed = (bytes: Uint8Array) => async () => { await screen.current?.write(bytes); done(); };
  const pending = (after: () => void) => async () => {
    const write = screen.current!.write(STALE);
    after();
    await write;
    done();
  };

  return <section className="terminal-panel" aria-label="Component fixture">
    <div className="terminal-resize">
      <button onClick={feed(text("AAAA\rBB"))}>Feed CR overwrite</button>
      <button onClick={() => { screen.current?.resize(120, 40); done(); }}>Resize 120x40</button>
      <button onClick={() => { screen.current?.reset(); done(); }}>Reset screen</button>
      <button onClick={feed(text("\x1b[35;1H" + "x".repeat(120) + "\x1b[35;100H\x1b[K<"))}>Feed erase and cursor</button>
      <button onClick={feed(text("\x1b[31mred\x1b[0m plain"))}>Feed red text</button>
      <button onClick={feed(text("MAIN"))}>Feed main text</button>
      <button onClick={feed(text("\x1b[?1049h\x1b[2J\x1b[HALT"))}>Enter alt screen</button>
      <button onClick={feed(text("\x1b[?1049l"))}>Leave alt screen</button>
      <button onClick={feed(text("euro:"))}>Feed Euro prefix</button>
      <button onClick={feed(new Uint8Array([0xe2]))}>Feed Euro byte 1</button>
      <button onClick={feed(new Uint8Array([0x82]))}>Feed Euro byte 2</button>
      <button onClick={feed(new Uint8Array([0xac]))}>Feed Euro byte 3</button>
      <button onClick={feed(text(":end"))}>Feed Euro suffix</button>
      <button onClick={feed(text("FRESH"))}>Feed fresh text</button>
      <button onClick={pending(() => screen.current!.reset())}>Pending write then reset</button>
      <button onClick={pending(() => flushSync(() => setMounted(false)))}>Pending write then unmount</button>
      <button onClick={() => { setGated((value) => !value); done(); }}>Toggle key gate</button>
    </div>
    <output id="settled" data-count={settled}>{settled}</output>
    <output id="keys" data-keys={JSON.stringify(keys)}>{keys.join(",")}</output>
    <output id="gate" data-gated={String(gated)}>{String(gated)}</output>
    {mounted ? <TerminalScreen ref={screen} size={null}
      onKey={gated ? undefined : (key) => setKeys((items) => [...items, key])} /> : <p id="unmounted">Terminal screen unmounted</p>}
  </section>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
