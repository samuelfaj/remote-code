import { createApiClient, type ApiClientOptions } from "./index";

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

export type MachineTerminalResult = {
  started: boolean;
  detail?: string;
};

export async function getMachine(
  origin: string,
  options?: ApiClientOptions,
): Promise<MachineState> {
  const { data, error } = await createApiClient(origin, options).api.machine.get();
  if (error) throw error;
  if (!data) throw new Error("Missing machine state");
  return data as MachineState;
}

export async function openMachineTerminal(
  origin: string,
  options?: ApiClientOptions,
): Promise<MachineTerminalResult> {
  const { data, error } = await createApiClient(origin, options).api.machine.terminal.post();
  if (error) throw error;
  if (!data) throw new Error("Missing machine terminal result");
  return data as MachineTerminalResult;
}
