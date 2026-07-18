/**
 * Heartbeat active-hours window (pure, UTC-only).
 *
 * UTC-only port of upstream `src/infra/heartbeat-active-hours.ts`. Upstream
 * resolves a configurable IANA timezone via `Intl`; Neonika hard-codes UTC
 * (consistent with the UTC-only cron schedule parser) so the check is fully
 * deterministic and never leaks the host timezone. `now` is always injected as
 * `nowMs` — no internal `Date.now()`, so tests are not wall-clock time-bombs.
 *
 * Fail-open: invalid config or an unparseable `now` returns `true` (active), so
 * a config typo never silently blocks heartbeats. The runtime gate above this
 * (NEON_HEARTBEAT_TIMER_ENABLED) is what actually keeps the layer off.
 */

const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/u;

/** Active-hours window (HH:MM 24h strings, UTC). Optional on the runtime config. */
export interface INeonHeartbeatActiveHours {
  readonly start: string;
  readonly end: string;
}

/**
 * True when `nowMs` falls inside the active-hours window (UTC). No window means
 * always active. A `start === end` window is a null window (always inactive).
 * Handles the midnight wrap (e.g. 22:00-06:00). Fail-open on invalid input.
 */
export function isWithinNeonHeartbeatActiveHours(
  activeHours: INeonHeartbeatActiveHours | undefined,
  nowMs: number
): boolean {
  if (!activeHours) {
    return true;
  }

  const startMin = parseNeonHeartbeatActiveHoursTime({ allow24: false }, activeHours.start);
  const endMin = parseNeonHeartbeatActiveHoursTime({ allow24: true }, activeHours.end);
  if (startMin === null || endMin === null) {
    return true; // fail-open on invalid config
  }
  if (startMin === endMin) {
    return false; // null window
  }

  const currentMin = resolveMinutesUtc(nowMs);
  if (currentMin === null) {
    return true; // fail-open on unparseable now
  }

  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  // Wrap over midnight (e.g. 22:00-06:00).
  return currentMin >= startMin || currentMin < endMin;
}

/**
 * Parse an `HH:MM` 24h string to minutes-since-midnight. `"24:00"` resolves to
 * 1440 only when `allow24` is set (end-of-window sentinel); otherwise null.
 */
export function parseNeonHeartbeatActiveHoursTime(
  opts: { readonly allow24: boolean },
  raw?: string
): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = ACTIVE_HOURS_TIME_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  if (raw === "24:00") {
    return opts.allow24 ? 1440 : null;
  }
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

function resolveMinutesUtc(nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) {
    return null;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(nowMs));

  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const minutePart = parts.find((part) => part.type === "minute")?.value;
  if (hourPart === undefined || minutePart === undefined) {
    return null;
  }
  const hour = Number.parseInt(hourPart, 10);
  const minute = Number.parseInt(minutePart, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }
  return hour * 60 + minute;
}
