import { createHash } from "node:crypto";

/**
 * Heartbeat scheduling math (pure).
 *
 * Port of upstream `src/infra/heartbeat-schedule.ts`. Every function is a pure
 * deterministic computation: `now` is always a numeric input, there is no
 * `setTimeout`/`setInterval` and no I/O. The only non-arithmetic dependency is
 * `node:crypto` sha256 in `resolveHeartbeatPhaseMs`, which is deterministic.
 *
 * The phase offset spreads many agents that share one interval across the
 * window (deterministic per agent), so they do not all fire on the same tick.
 */

/** Bound the active-slot seek so a sub-minute interval can never busy-loop. */
const MAX_SEEK_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SEEK_ITERATIONS = 10080; // 7 days at 1-minute granularity

/**
 * Stable per-agent phase offset in `[0, intervalMs)`, derived from
 * `sha256("<schedulerSeed>:<agentId>")`. Deterministic across sessions: the
 * same agent always lands on the same slot, with low collision spread.
 */
export function resolveHeartbeatPhaseMs(params: {
  readonly schedulerSeed: string;
  readonly agentId: string;
  readonly intervalMs: number;
}): number {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

/**
 * Phase-aligned next-due timestamp, ALWAYS strictly greater than `nowMs` (a
 * zero delta is forced to a full interval, so the first tick never
 * double-fires). The result satisfies `result % intervalMs === phaseMs`.
 */
export function computeNextHeartbeatPhaseDueMs(params: {
  readonly nowMs: number;
  readonly intervalMs: number;
  readonly phaseMs: number;
}): number {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const nowMs = Number.isFinite(params.nowMs) ? Math.floor(params.nowMs) : 0;
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
  const cyclePos = normalizeModulo(nowMs, intervalMs);
  let deltaMs = normalizeModulo(phaseMs - cyclePos, intervalMs);
  if (deltaMs === 0) {
    deltaMs = intervalMs;
  }
  return nowMs + deltaMs;
}

/**
 * Idempotent re-resolve: when a previous due is still in the future and was
 * computed for the same interval+phase, it is returned unchanged (no drift on
 * repeated calls). Otherwise a fresh phase-aligned due is computed.
 */
export function resolveNextHeartbeatDueMs(params: {
  readonly nowMs: number;
  readonly intervalMs: number;
  readonly phaseMs: number;
  readonly prev?: {
    readonly intervalMs: number;
    readonly phaseMs: number;
    readonly nextDueMs: number;
  };
}): number {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
  const nowMs = Number.isFinite(params.nowMs) ? Math.floor(params.nowMs) : 0;

  const prev = params.prev;
  if (
    prev &&
    resolvePositiveIntervalMs(prev.intervalMs) === intervalMs &&
    normalizeModulo(Math.floor(prev.phaseMs), intervalMs) === phaseMs &&
    prev.nextDueMs > nowMs
  ) {
    return prev.nextDueMs;
  }

  return computeNextHeartbeatPhaseDueMs({ nowMs, intervalMs, phaseMs });
}

/**
 * Walk forward from `startMs` in interval steps to the first slot where
 * `isActive` holds. Bounded by both a 7-day horizon and an iteration cap so a
 * sub-minute interval can never busy-loop. Without `isActive` the start is
 * returned unchanged. When no active slot is found within the bound, `startMs`
 * is returned as a fallback — the caller MUST still gate via an active-hours
 * check, never assume the returned slot is active.
 */
export function seekNextActivePhaseDueMs(params: {
  readonly startMs: number;
  readonly intervalMs: number;
  readonly phaseMs: number;
  readonly isActive?: (ms: number) => boolean;
}): number {
  const isActive = params.isActive;
  if (!isActive) {
    return params.startMs;
  }

  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const horizonMs = params.startMs + MAX_SEEK_HORIZON_MS;
  let candidateMs = params.startMs;
  let iterations = 0;
  while (candidateMs <= horizonMs && iterations < MAX_SEEK_ITERATIONS) {
    if (isActive(candidateMs)) {
      return candidateMs;
    }
    candidateMs += intervalMs;
    iterations += 1;
  }

  // phaseMs is intentionally unused: startMs is already phase-aligned by the
  // caller, the seek only advances in whole-interval steps so alignment holds.
  void params.phaseMs;
  return params.startMs;
}

/** Euclidean modulo: result is always in `[0, divisor)`, even for negatives. */
export function normalizeModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function resolvePositiveIntervalMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : 1;
}
