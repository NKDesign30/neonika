// Display formatting helpers. Pure, no DOM, easy to unit test.

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

export function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

// Compact relative time from an ISO timestamp ("now", "4m", "2h", "3d").
export function relativeTime(iso: string | undefined, nowMs: number = Date.parse(referenceNow())): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, nowMs - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

// Forward-looking counterpart to relativeTime: "in 4m", "in 2h", or "now"
// once the moment has arrived. For schedules (next run, next tick).
export function relativeUntil(iso: string | undefined, nowMs: number = Date.parse(referenceNow())): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = then - nowMs;
  if (diff < 45_000) return "now";
  // Round, don't floor: 50s away is "in 1m", never the nonsensical "in 0m".
  const min = Math.max(1, Math.round(diff / 60_000));
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.floor(hr / 24)}d`;
}

// Indirection so callers can stub "now" in tests without touching Date globals.
let nowProvider: () => string = () => new Date().toISOString();
export function setNowProvider(fn: () => string): void {
  nowProvider = fn;
}
export function referenceNow(): string {
  return nowProvider();
}

export function shortTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour12: false });
}

export function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Collapse consecutive identical items (by caller-defined key) into one entry
// with a repeat count — event floods ("Assistant stream" × 40) become a single
// line. Only adjacent runs collapse; order is preserved and the first item of
// each run (the newest, lists render newest-first) represents the group.
export interface ICollapsedRun<T> {
  readonly item: T;
  readonly count: number;
}
export function collapseConsecutive<T>(items: readonly T[], keyOf: (item: T) => string): readonly ICollapsedRun<T>[] {
  const groups: ICollapsedRun<T>[] = [];
  let currentKey: string | undefined;
  for (const item of items) {
    const key = keyOf(item);
    const last = groups[groups.length - 1];
    if (last !== undefined && key === currentKey) {
      groups[groups.length - 1] = { item: last.item, count: last.count + 1 };
    } else {
      groups.push({ item, count: 1 });
      currentKey = key;
    }
  }
  return groups;
}
