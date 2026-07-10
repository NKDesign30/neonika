import { html, type TemplateResult } from "lit";

// Phosphor Icons (https://phosphoricons.com) — loaded as the icon font via
// @phosphor-icons/web (regular + bold imported in main.ts). We keep stable
// semantic names so the views never need to know Phosphor's naming, then map
// each to its Phosphor glyph.
const PHOSPHOR = {
  messageSquare: "chat-circle",
  barChart: "chart-bar",
  activity: "pulse",
  link: "link",
  radio: "broadcast",
  fileText: "file-text",
  zap: "lightning",
  monitor: "monitor",
  settings: "gear",
  loader: "spinner",
  brain: "brain",
  moon: "moon",
  terminal: "terminal-window",
  globe: "globe",
  search: "magnifying-glass",
  plus: "plus",
  folder: "folder",
  send: "paper-plane-tilt",
  scrollText: "scroll",
  chevronDown: "caret-down",
  chevronRight: "caret-right",
  command: "command",
  sun: "sun",
  cpu: "cpu",
  coins: "coins",
  alertTriangle: "warning",
  check: "check",
  arrowUpRight: "arrow-up-right",
  pause: "pause",
  wifi: "wifi-high",
  filter: "funnel",
  download: "download-simple",
  refresh: "arrows-clockwise",
  layoutGrid: "squares-four",
  kanban: "kanban",
  clock: "clock",
  users: "users",
  cloud: "cloud",
} as const satisfies Record<string, string>;

export type IconName = keyof typeof PHOSPHOR;
export type IconWeight = "regular" | "bold" | "fill";

export function isIconName(value: string): value is IconName {
  return value in PHOSPHOR;
}

// Renders a Phosphor icon. Weight maps to Phosphor's class convention
// (regular -> "ph", bold -> "ph-bold", fill -> "ph-fill"); color is inherited
// via currentColor. An optional className lets callers attach layout hooks
// (e.g. the design's .stat__go positioning).
export function icon(name: IconName, size = 16, weight: IconWeight = "regular", className = ""): TemplateResult {
  const weightClass = weight === "regular" ? "ph" : `ph-${weight}`;
  const cls = className ? `${weightClass} ph-${PHOSPHOR[name]} ${className}` : `${weightClass} ph-${PHOSPHOR[name]}`;
  return html`<i
    class=${cls}
    style=${`font-size:${size}px;line-height:1;display:inline-flex;flex-shrink:0`}
    aria-hidden="true"
  ></i>`;
}
