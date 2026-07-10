import type { IconName } from "./icons.js";

// Tab model from the Claude Design export (core.jsx NAV_GROUPS), grouped
// Chat / Control / Agent / Settings.
export type Tab =
  | "chat"
  | "overview"
  | "activity"
  | "workboard"
  | "sessions"
  | "usage"
  | "cron"
  | "agents"
  | "skills"
  | "nodes"
  | "dreams"
  | "indexer"
  | "transcript"
  | "config"
  | "channels"
  | "logs";

export interface NavItem {
  readonly id: Tab;
  readonly name: string;
  readonly icon: IconName;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Chat",
    items: [{ id: "chat", name: "Chat", icon: "messageSquare" }],
  },
  {
    label: "Control",
    items: [
      { id: "overview", name: "Overview", icon: "barChart" },
      { id: "activity", name: "Activity", icon: "activity" },
      { id: "workboard", name: "Workboard", icon: "folder" },
      { id: "sessions", name: "Sessions", icon: "fileText" },
      { id: "usage", name: "Usage", icon: "coins" },
      { id: "cron", name: "Cron", icon: "loader" },
    ],
  },
  {
    label: "Agent",
    items: [
      { id: "agents", name: "Agents", icon: "folder" },
      { id: "skills", name: "Skills", icon: "zap" },
      { id: "nodes", name: "Nodes", icon: "monitor" },
      { id: "dreams", name: "Dreaming", icon: "moon" },
      { id: "indexer", name: "Indexer", icon: "brain" },
      { id: "transcript", name: "Transcripts", icon: "fileText" },
    ],
  },
  {
    label: "Settings",
    items: [
      { id: "config", name: "Settings", icon: "settings" },
      { id: "channels", name: "Channels", icon: "link" },
      { id: "logs", name: "Logs", icon: "scrollText" },
    ],
  },
] as const;

const TAB_TITLES: Record<Tab, string> = {
  chat: "Chat",
  overview: "Overview",
  activity: "Activity",
  workboard: "Workboard",
  sessions: "Sessions",
  usage: "Usage",
  cron: "Cron",
  agents: "Agents",
  skills: "Skills",
  nodes: "Nodes",
  dreams: "Dreaming",
  indexer: "Indexer",
  transcript: "Transcripts",
  config: "Settings",
  channels: "Channels",
  logs: "Logs",
};

const ALL_TABS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
const DEFAULT_TAB: Tab = "overview";

export function isTab(value: string): value is Tab {
  return (ALL_TABS as readonly string[]).includes(value);
}

export function titleForTab(tab: Tab): string {
  return TAB_TITLES[tab];
}

// Resolve the active tab from a location hash (#overview etc.), defaulting to
// overview for empty/unknown hashes.
export function tabFromHash(hash: string): Tab {
  const raw = (hash || "").replace(/^#/, "").trim().toLowerCase();
  return isTab(raw) ? raw : DEFAULT_TAB;
}

// Extract a tab from a /mission-control/<view> pathname, or undefined when the
// path is not a mission-control route (so callers can fall back to the hash).
export function tabFromMissionControlPath(pathname: string): Tab | undefined {
  const trimmed = (pathname || "").replace(/\/+$/, "");
  if (trimmed !== "/mission-control" && !trimmed.startsWith("/mission-control/")) {
    return undefined;
  }
  const segment = trimmed.slice("/mission-control".length).replace(/^\//, "").toLowerCase();
  return isTab(segment) ? segment : undefined;
}

// Resolve the active tab from the full location: a /mission-control/<view> path
// (production, served same-origin by the gateway) wins; otherwise the #<view>
// hash (standalone dev under /control-ui/). Unknown values default to overview.
export function tabFromLocation(pathname: string, hash: string): Tab {
  return tabFromMissionControlPath(pathname) ?? tabFromHash(hash);
}

// Canonical mission-control path for a tab — used to keep history in sync when
// the SPA runs under /mission-control/*.
export function missionControlPath(tab: Tab): string {
  return `/mission-control/${tab}`;
}

// True when the SPA is currently served from a mission-control route (production),
// as opposed to standalone dev where hash routing is used instead.
export function isMissionControlLocation(pathname: string): boolean {
  const trimmed = (pathname || "").replace(/\/+$/, "");
  return trimmed === "/mission-control" || trimmed.startsWith("/mission-control/");
}

export { ALL_TABS, DEFAULT_TAB };
