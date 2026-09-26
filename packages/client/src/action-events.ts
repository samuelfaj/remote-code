export type ActionReceipt = {
  id: string;
  action: string;
  createdAt: string;
};

export type ActionEventState = {
  cursor: number | null;
  actions: ActionReceipt[];
  needsSnapshot: boolean;
};

export type ActionEventResult = {
  state: ActionEventState;
  requestSnapshot: boolean;
  snapshotApplied: boolean;
  validMessage: boolean;
};

export function emptyActionEventState(): ActionEventState {
  return { cursor: null, actions: [], needsSnapshot: false };
}

function isReceipt(value: unknown): value is ActionReceipt {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string"
    && "action" in value && typeof value.action === "string"
    && "createdAt" in value && typeof value.createdAt === "string";
}

export function applyActionEvent(state: ActionEventState, input: unknown): ActionEventResult {
  if (typeof input !== "object" || input === null || !("type" in input)) {
    return { state, requestSnapshot: false, snapshotApplied: false, validMessage: false };
  }

  if (input.type === "snapshot") {
    if (!("cursor" in input) || typeof input.cursor !== "number" || !Number.isSafeInteger(input.cursor) || input.cursor < 0
      || !("actions" in input) || !Array.isArray(input.actions) || !input.actions.every(isReceipt)
      || new Set(input.actions.map((receipt) => receipt.id)).size !== input.actions.length) {
      return { state, requestSnapshot: false, snapshotApplied: false, validMessage: false };
    }
    return {
      state: { cursor: input.cursor, actions: input.actions, needsSnapshot: false },
      requestSnapshot: false,
      snapshotApplied: true,
      validMessage: true,
    };
  }

  if (input.type !== "action.created" || !("cursor" in input) || typeof input.cursor !== "number"
    || !Number.isSafeInteger(input.cursor) || input.cursor < 1 || !("receipt" in input) || !isReceipt(input.receipt)) {
    return { state, requestSnapshot: false, snapshotApplied: false, validMessage: false };
  }

  const receipt = input.receipt as ActionReceipt;
  if (state.needsSnapshot) return { state, requestSnapshot: false, snapshotApplied: false, validMessage: true };
  if (state.cursor === null || input.cursor > state.cursor + 1) {
    return {
      state: { ...state, needsSnapshot: true },
      requestSnapshot: true,
      snapshotApplied: false,
      validMessage: true,
    };
  }
  if (input.cursor <= state.cursor) return { state, requestSnapshot: false, snapshotApplied: false, validMessage: true };

  return {
    state: {
      cursor: input.cursor,
      needsSnapshot: false,
      actions: [receipt, ...state.actions.filter((item) => item.id !== receipt.id)],
    },
    requestSnapshot: false,
    snapshotApplied: false,
    validMessage: true,
  };
}
