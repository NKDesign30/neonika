/**
 * Outbound delivery retry policy (DP-1, the "retry" half of retry/ack/drain),
 * a 1:1 rebuild of upstream `src/infra/outbound/delivery-queue-recovery.ts`:
 * `BACKOFF_MS`, `MAX_RETRIES`, `computeBackoffMs`, and
 * `isEntryEligibleForRecoveryRetry`.
 *
 * Pure scheduling only — it computes WHEN a stuck delivery would next be
 * eligible for a re-attempt and WHEN to give up. It never sends:
 * `safety.outboundSent` is literal `false`. The actual re-send still routes
 * through the drain (`deliveryDrainRuntime.ts`) and the canary sender gate.
 *
 * Note on wiring: Neon's persisted delivery candidate does not yet carry
 * `retryCount`/`lastAttemptAt` (the queue is shadow/dry-run), so the policy
 * takes those as inputs. A future retry-tracking layer (or an armed canary
 * dispatch loop) feeds real counts; the CLI demonstrates the schedule directly.
 */

/** Backoff delays in ms indexed by retry count (1-based): retry 1 = 5s ... retry 4 = 10m. */
export const NEON_DELIVERY_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];

/** Retries are abandoned (moved to failed) once retryCount reaches this. */
export const NEON_DELIVERY_MAX_RETRIES = 5;

export type TNeonDeliveryRetryState = "eligible" | "waiting" | "exhausted";

export interface INeonDeliveryRetryInput {
  readonly retryCount: number;
  readonly enqueuedAtMs: number;
  readonly lastAttemptAtMs?: number;
  readonly now: number;
}

export interface INeonDeliveryRetryDecision {
  readonly state: TNeonDeliveryRetryState;
  readonly retryCount: number;
  readonly backoffMs: number;
  readonly nextEligibleAtMs: number;
  readonly remainingBackoffMs: number;
  readonly safety: { readonly outboundSent: false };
}

/** Backoff delay in ms for a given retry count (upstream `computeBackoffMs`). */
export function computeNeonDeliveryBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  const index = Math.min(retryCount - 1, NEON_DELIVERY_BACKOFF_MS.length - 1);
  return NEON_DELIVERY_BACKOFF_MS[index] ?? NEON_DELIVERY_BACKOFF_MS.at(-1) ?? 0;
}

/**
 * Decides whether a stuck delivery is eligible for a recovery re-attempt now,
 * waiting on backoff, or exhausted. Mirrors upstream
 * `isEntryEligibleForRecoveryRetry` plus the `retryCount >= MAX_RETRIES`
 * give-up. Pure: no send, no mutation.
 */
export function planNeonDeliveryRetry(input: INeonDeliveryRetryInput): INeonDeliveryRetryDecision {
  const safety = { outboundSent: false } as const;

  if (input.retryCount >= NEON_DELIVERY_MAX_RETRIES) {
    return {
      state: "exhausted",
      retryCount: input.retryCount,
      backoffMs: 0,
      nextEligibleAtMs: input.now,
      remainingBackoffMs: 0,
      safety
    };
  }

  const backoffMs = computeNeonDeliveryBackoffMs(input.retryCount + 1);

  // No backoff, or the very first replay after a crash (never attempted) is
  // eligible immediately.
  const firstReplayAfterCrash = input.retryCount === 0 && input.lastAttemptAtMs === undefined;
  if (backoffMs <= 0 || firstReplayAfterCrash) {
    return {
      state: "eligible",
      retryCount: input.retryCount,
      backoffMs,
      nextEligibleAtMs: input.now,
      remainingBackoffMs: 0,
      safety
    };
  }

  const hasAttemptTimestamp =
    typeof input.lastAttemptAtMs === "number" &&
    Number.isFinite(input.lastAttemptAtMs) &&
    input.lastAttemptAtMs > 0;
  const baseAttemptAt = hasAttemptTimestamp ? (input.lastAttemptAtMs ?? input.enqueuedAtMs) : input.enqueuedAtMs;
  const nextEligibleAtMs = baseAttemptAt + backoffMs;

  if (input.now >= nextEligibleAtMs) {
    return {
      state: "eligible",
      retryCount: input.retryCount,
      backoffMs,
      nextEligibleAtMs,
      remainingBackoffMs: 0,
      safety
    };
  }

  return {
    state: "waiting",
    retryCount: input.retryCount,
    backoffMs,
    nextEligibleAtMs,
    remainingBackoffMs: nextEligibleAtMs - input.now,
    safety
  };
}

function formatMs(ms: number): string {
  if (ms <= 0) {
    return "0s";
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.round(ms / 60_000)}m`;
}

/** Renders the backoff schedule across retry counts 0..MAX_RETRIES for the CLI. */
export function renderNeonDeliveryRetryScheduleReport(now: number): string {
  const lines: string[] = [];
  for (let retryCount = 0; retryCount <= NEON_DELIVERY_MAX_RETRIES; retryCount += 1) {
    const decision = planNeonDeliveryRetry({ retryCount, enqueuedAtMs: now, now });
    const detail =
      decision.state === "exhausted"
        ? "give up (moved to failed)"
        : `next backoff ${formatMs(decision.backoffMs)} (${decision.state})`;
    lines.push(`retryCount ${retryCount}: ${detail}`);
  }

  return [
    "Neon Delivery Retry Policy",
    `Max retries: ${NEON_DELIVERY_MAX_RETRIES}`,
    `Backoff schedule: ${NEON_DELIVERY_BACKOFF_MS.map(formatMs).join(" -> ")}`,
    "Outbound sent: false",
    ...lines
  ].join("\n");
}
