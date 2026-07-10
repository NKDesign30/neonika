import type { TNeonHeartbeatWakeIntent } from "./heartbeatWake.js";

/**
 * Heartbeat wake-deferral policy (pure).
 *
 * Port of upstream `src/infra/heartbeat-cooldown.ts`. `now` is always injected
 * (no internal `Date.now()`), so the decision is deterministic and testable.
 * One Neon divergence: `recordNeonHeartbeatRunStart` is rebuilt immutable (it
 * returns a fresh slice instead of mutating the buffer in place).
 *
 * Decision order is load-bearing: the flood-guard runs BEFORE the
 * scheduled/event gates on every non-immediate, non-manual wake.
 */

export type TNeonHeartbeatDeferReason = "not-due" | "min-spacing" | "flood";

/** Discriminated union: `reason` is only present on the defer branch. */
export type TNeonHeartbeatDeferDecision =
  | { readonly defer: false }
  | { readonly defer: true; readonly reason: TNeonHeartbeatDeferReason };

export interface INeonHeartbeatShouldDeferInput {
  readonly intent: TNeonHeartbeatWakeIntent;
  readonly reason: string | undefined;
  readonly now: number;
  readonly nextDueMs: number;
  readonly lastRunStartedAtMs?: number;
  readonly recentRunStarts?: readonly number[];
  readonly minSpacingMs?: number;
  readonly floodWindowMs?: number;
  readonly floodThreshold?: number;
}

export const DEFAULT_MIN_WAKE_SPACING_MS = 30_000;
export const DEFAULT_FLOOD_WINDOW_MS = 60_000;
export const DEFAULT_FLOOD_THRESHOLD = 5;

/**
 * Decide whether a wake should be deferred.
 * - `manual`: never deferred (operator intent, flood-exempt).
 * - `immediate`: runs unless the flood-guard trips.
 * - otherwise the flood-guard is checked first, then:
 *   - `scheduled`: defer `not-due` while `now < nextDueMs`.
 *   - `event`: the first wake (no prior run) bypasses all gates for
 *     responsiveness; then `not-due` while early, then `min-spacing` while a
 *     run started within the spacing window.
 */
export function shouldDeferNeonHeartbeatWake(
  input: INeonHeartbeatShouldDeferInput
): TNeonHeartbeatDeferDecision {
  if (input.intent === "manual") {
    return { defer: false };
  }

  if (input.intent === "immediate") {
    return checkFloodGuard(input) ?? { defer: false };
  }

  const flood = checkFloodGuard(input);
  if (flood) {
    return flood;
  }

  if (input.intent === "scheduled") {
    return input.now < input.nextDueMs ? { defer: true, reason: "not-due" } : { defer: false };
  }

  // intent === "event"
  if (input.lastRunStartedAtMs === undefined) {
    return { defer: false }; // bootstrap responsiveness: first wake bypasses gates
  }
  if (input.now < input.nextDueMs) {
    return { defer: true, reason: "not-due" };
  }
  const minSpacing = input.minSpacingMs ?? DEFAULT_MIN_WAKE_SPACING_MS;
  if (minSpacing > 0 && input.now - input.lastRunStartedAtMs < minSpacing) {
    return { defer: true, reason: "min-spacing" };
  }
  return { defer: false };
}

/**
 * Immutable run-start recorder (Neon divergence from upstream's mutating
 * push/shift): returns a fresh array keeping only the newest
 * `floodThreshold + 1` timestamps. Never mutates the input buffer.
 */
export function recordNeonHeartbeatRunStart(
  buffer: readonly number[],
  ts: number,
  floodThreshold?: number
): number[] {
  const max = (floodThreshold ?? DEFAULT_FLOOD_THRESHOLD) + 1;
  const next = [...buffer, ts];
  return next.length > max ? next.slice(-max) : next;
}

function checkFloodGuard(
  input: INeonHeartbeatShouldDeferInput
): TNeonHeartbeatDeferDecision | null {
  const floodWindow = input.floodWindowMs ?? DEFAULT_FLOOD_WINDOW_MS;
  const floodThreshold = input.floodThreshold ?? DEFAULT_FLOOD_THRESHOLD;
  const recentRunStarts = input.recentRunStarts;
  if (!recentRunStarts || recentRunStarts.length < floodThreshold || floodWindow <= 0) {
    return null;
  }

  const windowStart = input.now - floodWindow;
  let inWindow = 0;
  // recentRunStarts is assumed ascending-sorted; count back from the newest.
  for (let i = recentRunStarts.length - 1; i >= 0; i -= 1) {
    const ts = recentRunStarts[i];
    if (ts === undefined || ts < windowStart) {
      break;
    }
    inWindow += 1;
  }

  return inWindow >= floodThreshold ? { defer: true, reason: "flood" } : null;
}
