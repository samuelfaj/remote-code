import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native-web";
// noVNC 1.7.0 exports the RFB client from its package root (its `exports` map is
// `"./core/rfb.js"`); importing `@novnc/novnc/core/rfb` is blocked by that map.
// The package ships no type declarations, so the surface used here is typed below.
// @ts-expect-error noVNC ships no type declarations
import RFB from "@novnc/novnc";
import { color, radius, space, ui } from "../../design/tokens";
import { Icon } from "../shell/icons";
import { type LiveSignals } from "../shell/live";

// The frozen host contract. `getMachine`/`openMachineTerminal`/`MachineState`
// land in @remotecode/client with the API workstream; until that lands the panel
// reads the same shape straight off the host, so the two swap one-for-one.
export type MachineState = {
  available: boolean;
  display: string;
  width: number;
  height: number;
  vncPort: number;
  vncListening: boolean;
  terminalCommand: string;
  detail: string;
};

async function getMachine(origin: string): Promise<MachineState> {
  const response = await fetch(`${origin}/api/machine`, { credentials: "include" });
  if (!response.ok) throw new Error(`machine_read_failed:${response.status}`);
  return await response.json() as MachineState;
}

async function openMachineTerminal(origin: string): Promise<{ started: boolean; detail?: string }> {
  const response = await fetch(`${origin}/api/machine/terminal`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error(`machine_terminal_failed:${response.status}`);
  return await response.json() as { started: boolean; detail?: string };
}

type RfbClient = {
  scaleViewport: boolean;
  resizeSession: boolean;
  addEventListener(type: string, listener: (event: Event) => void): void;
  disconnect(): void;
};
type RfbConstructor = new (target: HTMLElement, channel: WebSocket) => RfbClient;

type Props = {
  userId: string;
  live?: LiveSignals;
};

export function MachinePanel(_props: Props) {
  const [machine, setMachine] = useState<MachineState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [status, setStatus] = useState("Checking the host machine…");
  const [terminalResult, setTerminalResult] = useState("");
  const canvasHost = useRef<HTMLDivElement | null>(null);

  // Read the host's report once on mount. A read that fails is an unavailable
  // machine, never a silent success.
  useEffect(() => {
    let cancelled = false;
    getMachine(window.location.origin)
      .then((state) => {
        if (cancelled) return;
        setMachine(state);
      })
      .catch(() => {
        if (cancelled) return;
        setReadError("Could not read the host machine. It may be unreachable.");
      });
    return () => { cancelled = true; };
  }, []);

  // The socket is opened only after the host has confirmed a display.
  useEffect(() => {
    if (!machine?.available || !canvasHost.current) return;
    const socket = new WebSocket(`${window.location.origin.replace(/^http/, "ws")}/api/machine/vnc`);
    const rfb = new (RFB as RfbConstructor)(canvasHost.current, socket);
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    setStatus("Connecting to the machine…");
    rfb.addEventListener("connect", () => {
      setStatus(`Connected to ${machine.display} · ${machine.width}×${machine.height}`);
    });
    rfb.addEventListener("disconnect", () => setStatus("Disconnected"));
    const fail = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail;
      setStatus(detail?.reason ? `Machine connection failed: ${detail.reason}` : "Machine connection failed.");
    };
    rfb.addEventListener("securityfailure", fail);
    rfb.addEventListener("credentialsrequired", fail);
    return () => { rfb.disconnect(); };
  }, [machine?.available]);

  async function handleOpenTerminal() {
    setTerminalResult("");
    try {
      const result = await openMachineTerminal(window.location.origin);
      setTerminalResult(result.started ? "Terminal opened on the machine." : result.detail ?? "The machine did not open a terminal.");
    } catch {
      setTerminalResult("Could not reach the host machine.");
    }
  }

  const unavailable = readError ?? (machine && !machine.available
    ? machine.detail || `No desktop is available for ${machine.display}.`
    : null);

  return (
    <View testID="machine-panel" style={styles.panel}>
      <View style={ui.sectionHeader}>
        <Icon name="monitor" size={14} />
        <Text style={ui.sectionLabel}>Machine</Text>
      </View>
      {unavailable ? (
        <Text testID="machine-unavailable" style={ui.warning}>{unavailable}</Text>
      ) : (
        <Text testID="machine-status" style={ui.body}>{status}</Text>
      )}
      {machine?.available ? (
        <View testID="machine-canvas" style={styles.canvasHost}>
          <div ref={canvasHost} style={styles.canvas} />
        </View>
      ) : null}
      {machine?.available ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Open terminal"
            onPress={() => void handleOpenTerminal()}
            style={ui.button}
            testID="open-terminal"
          >
            <Text style={ui.buttonLabel}>Open terminal</Text>
          </Pressable>
        </View>
      ) : null}
      {terminalResult ? <Text testID="machine-terminal-result" style={ui.body}>{terminalResult}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    ...ui.section,
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.panel,
    borderWidth: 1,
    gap: space.md,
    padding: space.lg,
  },
  canvasHost: {
    backgroundColor: color.terminalBg,
    borderColor: color.line,
    borderRadius: radius.card,
    borderWidth: 1,
    height: 360,
    overflow: "hidden",
    width: "100%",
  },
  canvas: {
    height: "100%",
    width: "100%",
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.md,
  },
});
