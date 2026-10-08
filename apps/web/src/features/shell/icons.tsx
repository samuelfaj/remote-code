// Inline SF-Symbol-flavoured icon set. The macOS app draws every control with an
// SF Symbol; the web shell keeps the same 16px grid and 1.7px stroke so the two
// chrome languages read as one product. No emoji is used as an icon.

export type IconName =
  | "activity"
  | "alert"
  | "arrowUp"
  | "bolt"
  | "bot"
  | "branch"
  | "calendar"
  | "check"
  | "chevronDown"
  | "clock"
  | "copy"
  | "file"
  | "folder"
  | "folderPlus"
  | "gear"
  | "grid"
  | "inbox"
  | "monitor"
  | "plus"
  | "refresh"
  | "search"
  | "shield"
  | "sidebar"
  | "sparkles"
  | "terminal"
  | "x";

const paths: Record<IconName, string> = {
  activity: "M3 12h4l2.5-6 3 12L15 12h6",
  alert: "M12 4.5 2.8 20h18.4L12 4.5Z M12 10v4.5 M12 17.4v.2",
  arrowUp: "M12 19.5V5 M5.5 11.5 12 5l6.5 6.5",
  bolt: "M13.5 2.5 4.5 13.5h6l-1 8 9-11h-6l1-8Z",
  bot: "M6 9h12v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9Z M12 5v4 M9.5 13.5v1.5 M14.5 13.5v1.5 M4 12v3 M20 12v3",
  branch: "M7 5.5a2 2 0 1 0 0-.1 M7 18.5a2 2 0 1 0 0-.1 M17 9.5a2 2 0 1 0 0-.1 M7 7.6v8.8 M17 11.6c0 3-2.6 4.4-6.5 4.4H9",
  calendar: "M4.5 6.5h15v13h-15z M4.5 10.5h15 M8.5 4v4 M15.5 4v4 M9 14h2v2H9z",
  check: "M5 12.5 9.5 17 19 7.5",
  chevronDown: "M6.5 9.5 12 15l5.5-5.5",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 7.5V12l3 2",
  copy: "M9 9h10v11H9z M15 9V4H5v11h4",
  file: "M6 3.5h7l5 5v12H6z M13 3.5v5h5",
  folder: "M3.5 6.5h6l2 2.5h9v9.5h-17z",
  folderPlus: "M3.5 6.5h6l2 2.5h9v9.5h-17z M12 12.5v4 M10 14.5h4",
  gear: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z M19.4 14.6a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2.5a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.2-3l-.1-.1a2 2 0 1 1 2.9-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.9l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z",
  grid: "M4 4.5h6.5V11H4z M13.5 4.5H20V11h-6.5z M4 13h6.5v6.5H4z M13.5 13H20v6.5h-6.5z",
  inbox: "M3.5 12.5h4l1 2.5h7l1-2.5h4 M3.5 12.5 6 5.5h12l2.5 7v6h-17z",
  monitor: "M3.5 5h17v11h-17z M9 20h6 M12 16v4",
  plus: "M12 5v14 M5 12h14",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5V9h-4.5",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M15.8 15.8 20 20",
  shield: "M12 3.5 5 6.5v6c0 4.2 3 7.4 7 8.5 4-1.1 7-4.3 7-8.5v-6l-7-3Z",
  sidebar: "M3.5 5h17v14h-17z M9.5 5v14",
  sparkles: "M11 3.5 12.8 8.7 18 10.5 12.8 12.3 11 17.5 9.2 12.3 4 10.5l5.2-1.8L11 3.5Z M18 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z",
  terminal: "M4.5 5h15v14h-15z M8 10l2.5 2.5L8 15 M12.5 15.5h4",
  x: "M6.5 6.5 17.5 17.5 M17.5 6.5 6.5 17.5",
};

type Props = {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
};

export function Icon({ name, size = 14, className, strokeWidth = 1.7 }: Props) {
  return (
    <svg
      aria-hidden="true"
      className={["rc-icon", className].filter(Boolean).join(" ")}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={paths[name]} />
    </svg>
  );
}
