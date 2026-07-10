/**
 * Cron schedule parsing + next-run computation (rebuild-native, pure).
 *
 * neon-core stores a job's schedule as a single `schedule: string`. Until now
 * only `every-<N>m` (linear interval) and `manual-only` were understood. This
 * module adds a real 5-field cron-expression parser so `isCronJobDue` can route
 * cron-expr jobs through an actual next-match computation.
 *
 * Deliberately rebuild-native instead of pulling `croner` as a dependency
 * (consistent with the no-new-dep posture that blocks the media utilities):
 * no supply chain, no croner year-rollback workarounds, fully deterministic and
 * `nowMs`-driven for tests.
 *
 * Intentional reductions vs upstream `src/cron/schedule.ts` (cite for parity):
 * - UTC only — no timezone / DST resolution (a TZ-aware variant is a later slice).
 * - No seconds field, no month/weekday names (numeric 5-field only).
 * - No `at:<iso>` one-shot kind yet (manual / interval / cron only).
 * Standard Vixie day-of-month vs day-of-week OR-semantics is honored.
 *
 * Pure: no I/O, no side effect, no gate. The real consumer is `isCronJobDue`
 * (neonAutomation.ts) -> evaluateNeonCronRunIntent -> cronTimerRuntime tick.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_LOOKAHEAD_DAYS = 366;

export interface INeonCronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

export type TNeonCronSchedule =
  | { readonly kind: "manual" }
  | { readonly kind: "interval"; readonly intervalMs: number }
  | { readonly kind: "cron"; readonly fields: INeonCronFields }
  | { readonly kind: "invalid"; readonly reason: string };

const INTERVAL_PATTERN = /^every-(\d+)(m|h|d)$/;

const INTERVAL_UNIT_MS: Record<"m" | "h" | "d", number> = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS
};

export function parseNeonCronSchedule(schedule: string): TNeonCronSchedule {
  const trimmed = schedule.trim();
  if (trimmed.length === 0) {
    return { kind: "invalid", reason: "empty schedule" };
  }
  if (trimmed === "manual-only") {
    return { kind: "manual" };
  }

  const intervalMatch = INTERVAL_PATTERN.exec(trimmed);
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2] as "m" | "h" | "d";
    if (!Number.isInteger(amount) || amount <= 0) {
      return { kind: "invalid", reason: `invalid interval amount: ${trimmed}` };
    }
    return { kind: "interval", intervalMs: amount * INTERVAL_UNIT_MS[unit] };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      kind: "invalid",
      reason: `expected manual-only, every-<N>m|h|d, or a 5-field cron expression (got ${parts.length} fields)`
    };
  }

  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = parts as [
    string,
    string,
    string,
    string,
    string
  ];

  const minute = parseCronField(minuteSpec, 0, 59);
  const hour = parseCronField(hourSpec, 0, 23);
  const dayOfMonth = parseCronField(domSpec, 1, 31);
  const month = parseCronField(monthSpec, 1, 12);
  const dayOfWeek = parseDayOfWeekField(dowSpec);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return { kind: "invalid", reason: `invalid cron field in: ${trimmed}` };
  }

  return {
    kind: "cron",
    fields: {
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
      dayOfMonthRestricted: domSpec !== "*",
      dayOfWeekRestricted: dowSpec !== "*"
    }
  };
}

/**
 * Earliest scheduled time strictly after `afterMs` (UTC). For interval, that is
 * `afterMs + intervalMs`. For cron, the next minute-boundary match within a
 * bounded look-ahead window. `undefined` for manual / invalid / no match.
 */
export function computeNeonNextRunAtMs(schedule: string, afterMs: number): number | undefined {
  const parsed = parseNeonCronSchedule(schedule);
  if (parsed.kind === "manual" || parsed.kind === "invalid") {
    return undefined;
  }
  if (parsed.kind === "interval") {
    return afterMs + parsed.intervalMs;
  }
  return computeNextCronMatchMs(parsed.fields, afterMs);
}

/**
 * Is a schedule due at `nowMs` given the last run? A cron/interval job is due
 * when its next scheduled time after the last run is at or before now. A
 * cron-expr job that never ran is conservatively NOT due (needs an explicit
 * seed/force) so loading a catalog cannot surprise-fire.
 */
export function isNeonCronScheduleDue(
  schedule: string,
  nowMs: number,
  lastRunAtMs?: number
): boolean {
  const parsed = parseNeonCronSchedule(schedule);
  if (parsed.kind === "manual" || parsed.kind === "invalid") {
    return false;
  }
  if (lastRunAtMs === undefined) {
    // No anchor: interval is due immediately; cron-expr waits for a seed.
    return parsed.kind === "interval";
  }
  const next = computeNeonNextRunAtMs(schedule, lastRunAtMs);
  return next !== undefined && next <= nowMs;
}

export function describeNeonCronSchedule(schedule: string): string {
  const parsed = parseNeonCronSchedule(schedule);
  switch (parsed.kind) {
    case "manual":
      return "manual-only (no automatic run)";
    case "interval":
      return `interval: every ${Math.round(parsed.intervalMs / MINUTE_MS)}m`;
    case "cron":
      return `cron (UTC): ${schedule.trim()}`;
    case "invalid":
      return `invalid: ${parsed.reason}`;
  }
}

function computeNextCronMatchMs(fields: INeonCronFields, afterMs: number): number | undefined {
  // First candidate = next minute boundary strictly after afterMs.
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const deadline = t + MAX_LOOKAHEAD_DAYS * DAY_MS;
  // Hard iteration guard (belt-and-suspenders against a logic bug).
  let guard = 0;
  const maxGuard = MAX_LOOKAHEAD_DAYS * 1440 + 1440;

  while (t <= deadline && guard < maxGuard) {
    guard += 1;
    const d = new Date(t);
    const month = d.getUTCMonth() + 1;

    if (!fields.month.has(month)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(fields, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(d.getUTCHours())) {
      t = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours() + 1,
        0,
        0,
        0
      );
      continue;
    }
    if (!fields.minute.has(d.getUTCMinutes())) {
      t += MINUTE_MS;
      continue;
    }
    return t;
  }
  return undefined;
}

function dayMatches(fields: INeonCronFields, d: Date): boolean {
  const domOk = fields.dayOfMonth.has(d.getUTCDate());
  const dowOk = fields.dayOfWeek.has(d.getUTCDay());
  // Vixie semantics: when BOTH day-of-month and day-of-week are restricted,
  // a match on EITHER qualifies. When only one is restricted, it must match.
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) {
    return domOk || dowOk;
  }
  if (fields.dayOfMonthRestricted) {
    return domOk;
  }
  if (fields.dayOfWeekRestricted) {
    return dowOk;
  }
  return true;
}

function parseDayOfWeekField(spec: string): ReadonlySet<number> | undefined {
  // Accept 0-7 (both 0 and 7 = Sunday), normalize 7 -> 0 to match getUTCDay().
  const raw = parseCronField(spec, 0, 7);
  if (!raw) {
    return undefined;
  }
  const normalized = new Set<number>();
  for (const value of raw) {
    normalized.add(value === 7 ? 0 : value);
  }
  return normalized;
}

function parseCronField(spec: string, min: number, max: number): ReadonlySet<number> | undefined {
  const values = new Set<number>();
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) {
      return undefined;
    }

    let rangePart = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      const stepValue = Number(part.slice(slash + 1));
      if (!Number.isInteger(stepValue) || stepValue <= 0) {
        return undefined;
      }
      step = stepValue;
      rangePart = part.slice(0, slash);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2) {
        return undefined;
      }
      const a = Number(bounds[0]);
      const b = Number(bounds[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        return undefined;
      }
      lo = a;
      hi = b;
    } else {
      const single = Number(rangePart);
      if (!Number.isInteger(single)) {
        return undefined;
      }
      lo = single;
      // "N/step" (single value with a step) runs from N up to max, per cron.
      hi = slash >= 0 ? max : single;
    }

    if (lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : undefined;
}
