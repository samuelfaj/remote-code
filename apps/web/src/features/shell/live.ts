// Live-refresh signals pushed from the host's `/api/events` socket.
//
// A signal is a counter, not data: when the host says a resource changed, the
// surface that shows it re-reads the authoritative route. Nothing is ever
// displayed from an event payload alone, so an unconfirmed value can never
// reach the UI through this channel.

export type LiveResource =
  | "workspaces"
  | "bots"
  | "runs"
  | "threads"
  | "messages"
  | "inbox"
  | "schedules"
  | "terminal"
  | "screen"
  | "files";

export type LiveSignals = Partial<Record<LiveResource, number>>;
