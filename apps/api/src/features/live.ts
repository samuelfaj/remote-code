export type LiveNotice = { userId: string; type: string; workspaceId?: string };
export type LiveNotifier = (notice: LiveNotice) => void;
