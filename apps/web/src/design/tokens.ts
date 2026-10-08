import { StyleSheet } from "react-native-web";

// Distill macOS app palette (macos-app Sources/DesignSystemKit/Tokens.swift).
export const color = {
  bg: "#0F1419",
  surface: "#171D24",
  surfaceRaised: "#1B222B",
  surfaceOverlay: "#212A34",
  line: "#2A3440",
  lineStrong: "#394654",
  text: "#E7EDF3",
  textSecondary: "#9DA9B5",
  textTertiary: "#6B7785",
  accent: "#7CC7FF",
  onAccent: "#0A0E13",
  success: "#8EE6A8",
  warning: "#FFD37A",
  danger: "#FF8F8F",
  hover: "rgba(255,255,255,0.05)",
  pressed: "rgba(255,255,255,0.09)",
  selection: "rgba(124,199,255,0.16)",
  focusRing: "rgba(124,199,255,0.65)",
  terminalBg: "#20242E",
  terminalFg: "#F2F2F2",
  disabled: 0.38,
} as const;

export const space = { xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 20, xxxl: 24, huge: 32 } as const;

export const radius = { control: 5, card: 7, panel: 9, modal: 12, pill: 999 } as const;

const sans = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const font = {
  caption2: 10,
  caption: 11,
  bodyDense: 12,
  body: 13,
  title3: 15,
  title2: 18,
  title: 22,
  sans,
  mono,
} as const;

// Fixed control geometry shared by the shell and the feature panels, so every
// dense surface uses the same row, icon and tab rhythm (macOS DS.Space/DS.Radius).
export const size = {
  sidebarWidth: 300,
  sidebarRow: 38,
  sidebarActionRow: 42,
  sidebarSearchHeight: 30,
  tabStripHeight: 34,
  tabMinWidth: 132,
  tabMaxWidth: 240,
  iconButton: 26,
  iconButtonTall: 22,
  iconSm: 12,
  iconMd: 14,
  iconLg: 16,
  control: 30,
  headerHeight: 34,
  contentMaxWidth: 1180,
} as const;

export const motion = { micro: 160, standard: 220 } as const;

export const sidebarWidth = size.sidebarWidth;
export const contentMaxWidth = size.contentMaxWidth;

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  scroll: { backgroundColor: color.bg },

  panel: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.panel,
    padding: space.lg,
    gap: space.md,
  },
  card: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.sm,
  },

  title: { color: color.text, fontFamily: sans, fontSize: font.title2, fontWeight: "600" },
  heading: { color: color.text, fontFamily: sans, fontSize: font.title3, fontWeight: "600" },
  subheading: { color: color.text, fontFamily: sans, fontSize: font.body, fontWeight: "600" },
  sectionLabel: {
    color: color.textTertiary,
    fontFamily: sans,
    fontSize: font.caption,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  body: { color: color.text, fontFamily: sans, fontSize: font.body },
  bodyStrong: { color: color.text, fontFamily: sans, fontSize: font.body, fontWeight: "600" },
  secondary: { color: color.textSecondary, fontFamily: sans, fontSize: font.body },
  meta: { color: color.textTertiary, fontFamily: sans, fontSize: font.caption },
  mono: { color: color.textSecondary, fontFamily: mono, fontSize: font.bodyDense },
  success: { color: color.success, fontFamily: sans, fontSize: font.body, fontWeight: "600" },
  warning: { color: color.warning, fontFamily: sans, fontSize: font.body, fontWeight: "600" },
  error: { color: color.danger, fontFamily: sans, fontSize: font.body, fontWeight: "600" },
  emptyText: { color: color.textTertiary, fontFamily: sans, fontSize: font.body },

  input: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
    color: color.text,
    fontFamily: sans,
    fontSize: font.body,
    minHeight: size.control,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    width: "100%",
  },
  inputMultiline: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
    color: color.text,
    fontFamily: sans,
    fontSize: font.body,
    minHeight: 64,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    width: "100%",
  },

  button: {
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
    flexDirection: "row",
    gap: space.sm,
    minHeight: size.control,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs + 2,
  },
  buttonPrimary: {
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: "center",
    backgroundColor: color.accent,
    borderWidth: 1,
    borderColor: color.accent,
    borderRadius: radius.control,
    flexDirection: "row",
    gap: space.sm,
    minHeight: size.control,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs + 2,
  },
  buttonDanger: {
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.danger,
    borderRadius: radius.control,
    flexDirection: "row",
    gap: space.sm,
    minHeight: size.control,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs + 2,
  },
  buttonDisabled: { opacity: color.disabled },
  buttonLabel: { color: color.text, fontFamily: sans, fontSize: font.body, fontWeight: "500" },
  buttonLabelPrimary: { color: color.onAccent, fontFamily: sans, fontSize: font.body, fontWeight: "600" },

  row: { alignItems: "center", flexDirection: "row", gap: space.md },
  listItem: {
    backgroundColor: "transparent",
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  listItemSelected: { backgroundColor: color.selection },
  selectionText: { color: color.accent },

  divider: { backgroundColor: color.line, height: 1, width: "100%" },

  // Dense section used inside a surface body: a hairline-separated block with a
  // compact header row, so panels stop stacking rounded cards.
  section: { gap: space.sm },
  sectionHeader: {
    alignItems: "center",
    borderBottomColor: color.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: space.md,
    minHeight: 32,
    paddingBottom: space.sm,
  },
  field: { gap: space.xs },
  fieldLabel: { color: color.textSecondary, fontFamily: sans, fontSize: font.caption, fontWeight: "500" },
  hint: { color: color.textTertiary, fontFamily: sans, fontSize: font.caption, lineHeight: 16 },

  pill: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.surfaceOverlay,
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  pillLabel: { color: color.textSecondary, fontFamily: sans, fontSize: font.caption2, fontWeight: "600" },
  statusRow: { alignItems: "center", flexDirection: "row", gap: space.sm },
  dot: { borderRadius: radius.pill, height: 7, width: 7 },
});
