export type Screen =
  | "Workspaces"
  | "Bots"
  | "BotRoutines"
  | "Threads"
  | "ThreadMessages"
  | "Inbox"
  | "Actions";

export type NavigationParams = {
  Workspaces: undefined;
  Bots: undefined;
  BotRoutines: { botId: string; botName: string };
  Threads: { workspaceId: string; workspaceName: string; focusRunId?: string };
  ThreadMessages: { workspaceId: string; threadId: string; threadTitle: string };
  Inbox: undefined;
  Actions: undefined;
};

export type NavigationState = {
  current: Screen;
  params: Record<string, unknown> | undefined;
  history: Array<{ screen: Screen; params: Record<string, unknown> | undefined }>;
};

export type NavigationAction =
  | { type: "NAVIGATE"; screen: Screen; params?: Record<string, unknown> }
  | { type: "GO_BACK" }
  | { type: "RESET"; screen: Screen; params?: Record<string, unknown> };

export type NotificationDestination = {
  screen: Screen;
  params: Record<string, unknown>;
};