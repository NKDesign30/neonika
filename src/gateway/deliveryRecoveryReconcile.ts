import {
  planNeonDeliveryRetry,
  type INeonDeliveryRetryDecision,
  type INeonDeliveryRetryInput
} from "./deliveryRetryPolicy.js";

/**
 * Delivery recovery reconciliation (DP-1, the decision partner of the retry
 * policy), a 1:1 rebuild of upstream `src/infra/outbound/delivery-queue-recovery.ts`
 * `PERMANENT_ERROR_PATTERNS` + `isPermanentDeliveryError`.
 *
 * Pure classification + scheduling: given an optional transport error and the
 * retry state, it decides whether a stuck delivery is a permanent failure (give
 * up immediately — chat gone, bot kicked, recipient invalid) or a transient one
 * that follows the backoff schedule. It never sends; `safety.outboundSent` is
 * literal `false`, and the raw error is only matched against patterns, never
 * stored, logged, or echoed into the result.
 */

/**
 * Errors that must not be retried — the delivery is moved straight to failed.
 * Verbatim from upstream `PERMANENT_ERROR_PATTERNS`.
 */
export const NEON_PERMANENT_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i
];

export type TNeonDeliveryReconcileState =
  | "permanent-failure"
  | "retry-eligible"
  | "retry-waiting"
  | "exhausted";

export interface INeonDeliveryReconcileInput extends INeonDeliveryRetryInput {
  /** Optional transport error from the last attempt. Matched, never stored. */
  readonly error?: string;
}

export interface INeonDeliveryReconcileDecision {
  readonly state: TNeonDeliveryReconcileState;
  readonly permanent: boolean;
  /** The backoff retry decision, or null when the error is permanent. */
  readonly retry: INeonDeliveryRetryDecision | null;
  readonly reason: string;
  readonly safety: { readonly outboundSent: false };
}

/** True when the error matches a permanent pattern (do not retry). */
export function isNeonPermanentDeliveryError(error: string): boolean {
  return NEON_PERMANENT_DELIVERY_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

const RETRY_STATE_TO_RECONCILE: Readonly<Record<INeonDeliveryRetryDecision["state"], TNeonDeliveryReconcileState>> =
  {
    eligible: "retry-eligible",
    waiting: "retry-waiting",
    exhausted: "exhausted"
  };

/**
 * Reconciles a stuck delivery: a permanent error gives up immediately, anything
 * else follows the backoff retry schedule. Pure — no send, no mutation.
 */
export function reconcileNeonDeliveryRecovery(
  input: INeonDeliveryReconcileInput
): INeonDeliveryReconcileDecision {
  const safety = { outboundSent: false } as const;

  if (input.error !== undefined && isNeonPermanentDeliveryError(input.error)) {
    return {
      state: "permanent-failure",
      permanent: true,
      retry: null,
      reason: "permanent-error-pattern",
      safety
    };
  }

  const retry = planNeonDeliveryRetry(input);

  return {
    state: RETRY_STATE_TO_RECONCILE[retry.state],
    permanent: false,
    retry,
    reason: `retry-${retry.state}`,
    safety
  };
}

export function renderNeonDeliveryReconcileReport(
  decision: INeonDeliveryReconcileDecision
): string {
  const backoff =
    decision.retry && decision.retry.state !== "exhausted"
      ? `next backoff ${Math.round(decision.retry.backoffMs / 1000)}s`
      : "no further retry";

  return [
    "Neonika Delivery Recovery Reconcile",
    `State: ${decision.state} (${decision.reason})`,
    `Permanent: ${decision.permanent}`,
    `Retry: ${backoff}`,
    `Outbound sent: ${decision.safety.outboundSent}`
  ].join("\n");
}
