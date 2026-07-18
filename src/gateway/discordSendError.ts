import {
  planNeonDeliveryRetry,
  type INeonDeliveryRetryInput
} from "./deliveryRetryPolicy.js";

/**
 * Pure classification of a Discord send failure plus its bridge to the existing
 * delivery retry policy (deliveryRetryPolicy.ts). This is the "durable delivery"
 * half that was missing: the retry SCHEDULE (5s/25s/2m/10m, MAX_RETRIES) existed,
 * but nothing read a Discord 429 `retry-after` or distinguished a transient
 * failure from a permanent one.
 *
 * Both functions are pure — no send, no mutation, `safety.outboundSent` stays
 * literal `false`. They are duck-typed on the error shape (status / statusCode /
 * retryAfter) rather than `instanceof` so they work against discord.js
 * `DiscordAPIError`/`RateLimitError` without importing or constructing those
 * classes. discord.js v14 `RateLimitError.retryAfter` is in MILLISECONDS
 * (verified against the installed package); a 429 `retry-after` overrides the
 * computed backoff because Discord told us exactly when to retry.
 *
 * Mirrors upstream `extensions/discord/src/retry.ts`
 * (`isRetryableDiscordTransientError`, retryable status 408/429/5xx) +
 * `retry-after.ts`.
 */

export interface INeonDiscordSendErrorClassification {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly reason: string;
}

// Discord transient HTTP statuses (upstream DISCORD_RETRYABLE_STATUS_CODES + 5xx).
const RETRYABLE_STATUS = new Set([408, 429]);

function readErrorStatus(error: { status?: unknown; statusCode?: unknown }): number | undefined {
  if (typeof error.status === "number" && Number.isInteger(error.status)) {
    return error.status;
  }
  if (typeof error.statusCode === "number" && Number.isInteger(error.statusCode)) {
    return error.statusCode;
  }
  return undefined;
}

/** Classify a Discord send error as retryable/permanent and extract any retry-after. */
export function classifyNeonDiscordSendError(error: unknown): INeonDiscordSendErrorClassification {
  if (typeof error !== "object" || error === null) {
    return { retryable: false, reason: "non-object error is not retryable" };
  }
  const candidate = error as { status?: unknown; statusCode?: unknown; retryAfter?: unknown };

  // RateLimitError-shaped: a finite non-negative retryAfter (ms) means rate limited.
  if (typeof candidate.retryAfter === "number" && Number.isFinite(candidate.retryAfter) && candidate.retryAfter >= 0) {
    const status = readErrorStatus(candidate);
    return {
      retryable: true,
      retryAfterMs: candidate.retryAfter,
      ...(status !== undefined ? { status } : {}),
      reason: "rate limited (retry-after present)"
    };
  }

  const status = readErrorStatus(candidate);
  if (status === undefined) {
    return { retryable: false, reason: "error has no HTTP status; treated as permanent" };
  }
  if (RETRYABLE_STATUS.has(status) || status >= 500) {
    return { retryable: true, status, reason: `transient HTTP ${status}` };
  }
  return { retryable: false, status, reason: `permanent HTTP ${status}` };
}

export type TNeonSendRetryAction = "retry" | "give-up" | "exhausted";

export interface INeonSendRetryPlan {
  readonly action: TNeonSendRetryAction;
  readonly classification: INeonDiscordSendErrorClassification;
  readonly retryCount: number;
  readonly nextEligibleAtMs: number;
  readonly waitMs: number;
  readonly reason: string;
  readonly safety: { readonly outboundSent: false };
}

/**
 * Decide what to do after a send failure: give up on a permanent error, give up
 * once retries are exhausted, or schedule the next attempt. A Discord
 * `retry-after` (ms) overrides the computed backoff; otherwise the existing
 * delivery backoff schedule applies. Pure: no send, no mutation.
 */
export function planNeonDeliveryRetryAfterSendError(params: {
  readonly error: unknown;
  readonly retry: INeonDeliveryRetryInput;
}): INeonSendRetryPlan {
  const safety = { outboundSent: false } as const;
  const classification = classifyNeonDiscordSendError(params.error);

  if (!classification.retryable) {
    return {
      action: "give-up",
      classification,
      retryCount: params.retry.retryCount,
      nextEligibleAtMs: params.retry.now,
      waitMs: 0,
      reason: `permanent failure, not retrying: ${classification.reason}`,
      safety
    };
  }

  const decision = planNeonDeliveryRetry(params.retry);
  if (decision.state === "exhausted") {
    return {
      action: "exhausted",
      classification,
      retryCount: decision.retryCount,
      nextEligibleAtMs: decision.nextEligibleAtMs,
      waitMs: 0,
      reason: `retries exhausted at ${decision.retryCount}`,
      safety
    };
  }

  // Discord told us exactly when to retry: honour retry-after over the backoff.
  if (classification.retryAfterMs !== undefined) {
    return {
      action: "retry",
      classification,
      retryCount: decision.retryCount,
      nextEligibleAtMs: params.retry.now + classification.retryAfterMs,
      waitMs: classification.retryAfterMs,
      reason: "retry honouring Discord retry-after",
      safety
    };
  }

  return {
    action: "retry",
    classification,
    retryCount: decision.retryCount,
    nextEligibleAtMs: decision.nextEligibleAtMs,
    waitMs: decision.remainingBackoffMs,
    reason: `retry on computed backoff (${decision.state})`,
    safety
  };
}
