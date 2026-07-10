import { readReadyCutoverEnv } from "../core/cutover.js";
import type {
  INeonDeliveryQueueCandidate,
  INeonDeliveryQueueSnapshot,
  TNeonDeliveryAckState
} from "./deliveryQueue.js";

/**
 * Reconnect delivery-drain runtime (DP-1 extension, parity row "Reconnect
 * delivery-drain / echtes Re-Send").
 *
 * Upstream source: `src/infra/approval-handler-runtime.ts` calls
 * `transport.deliverPending(...)` to actually send an approved delivery, and
 * `onDeliveryError` leaves a delivery in-flight when the transport throws — that
 * stuck delivery has to be drained (re-attempted) on reconnect. The durable
 * model behind it (`src/channels/message/durable-receive.ts`) lists `pending()`
 * records, skips ones already `complete`, expires entries past `pendingTtlMs`,
 * and `release()`s a record (attempts + 1) to re-queue it.
 *
 * Neon Core mirrors only the read-only/plan half. A delivery candidate that the
 * dispatch path marked `recoveryState: "pending-drain"` (`deliveryDispatch.ts`,
 * set when an armed canary transport attempt errored) is what a reconnect drain
 * would re-attempt. This module computes that plan deterministically and never
 * sends:
 * - `already-done`  -> ackState is "done", the upstream "skip completed" case.
 * - `expired`       -> older than the drain TTL, the upstream `pendingTtlMs` case.
 * - `eligible`      -> would be re-attempted on reconnect.
 *
 * Double gate, no autonomous send: the plan is always safe to render
 * (read-only). `NEON_DELIVERY_DRAIN_ENABLED` only flips the plan from `blocked`
 * to `drained-dry-run`; even then the actual re-send stays behind the separate
 * canary outbound sender gate, so `safety.outboundSent`/`reSent` are literal
 * `false`.
 */

const deliveryDrainEnabledEnvKey = "NEON_DELIVERY_DRAIN_ENABLED";

/** 24h reconnect-drain window: older pending-drain deliveries are not re-attempted. */
const DEFAULT_DRAIN_TTL_MS = 24 * 60 * 60 * 1000;

export type TNeonDeliveryDrainReason = "drain-disabled" | "drain-enabled";
export type TNeonDeliveryDrainState = "blocked" | "drained-dry-run";
export type TNeonDeliveryDrainDisposition = "eligible" | "expired" | "already-done";

export interface INeonDeliveryDrainGate {
  readonly enabled: boolean;
  readonly reason: TNeonDeliveryDrainReason;
  readonly envKey: typeof deliveryDrainEnabledEnvKey;
}

export interface INeonDeliveryDrainEntry {
  readonly candidateId: string;
  readonly runId: string;
  readonly agentId: string;
  /** Leak-safe target label: channel + channelId only, no message content. */
  readonly targetLabel: string;
  readonly ackState: TNeonDeliveryAckState;
  readonly disposition: TNeonDeliveryDrainDisposition;
  readonly ageMs: number;
  readonly createdAt: string;
}

export interface INeonDeliveryDrainTotals {
  readonly pendingDrain: number;
  readonly eligible: number;
  readonly expired: number;
  readonly alreadyDone: number;
}

export interface INeonDeliveryDrainPlanSafety {
  readonly outboundSent: false;
  readonly reSent: false;
  readonly requiresCanaryGate: true;
}

export interface INeonDeliveryDrainPlan {
  readonly state: TNeonDeliveryDrainState;
  readonly reason: TNeonDeliveryDrainReason;
  readonly gate: INeonDeliveryDrainGate;
  readonly generatedAt: string;
  readonly ttlMs: number;
  readonly entries: readonly INeonDeliveryDrainEntry[];
  readonly totals: INeonDeliveryDrainTotals;
  readonly safety: INeonDeliveryDrainPlanSafety;
}

export interface IPlanNeonDeliveryDrainOptions {
  readonly gate: INeonDeliveryDrainGate;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export function resolveNeonDeliveryDrainGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonDeliveryDrainGate {
  const enabled = readReadyCutoverEnv(env, deliveryDrainEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "drain-enabled" : "drain-disabled",
    envKey: deliveryDrainEnabledEnvKey
  };
}

function buildDrainEntry(
  candidate: INeonDeliveryQueueCandidate,
  nowMs: number,
  ttlMs: number
): INeonDeliveryDrainEntry {
  const createdMs = Date.parse(candidate.createdAt);
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
  const disposition: TNeonDeliveryDrainDisposition =
    candidate.ackState === "done" ? "already-done" : ageMs > ttlMs ? "expired" : "eligible";

  return {
    candidateId: candidate.id,
    runId: candidate.runId,
    agentId: candidate.agentId,
    targetLabel: `${candidate.target.channel}/${candidate.target.channelId}`,
    ackState: candidate.ackState,
    disposition,
    ageMs,
    createdAt: candidate.createdAt
  };
}

/**
 * Computes the reconnect-drain plan over the delivery queue snapshot. Pure and
 * side-effect free: it classifies the `pending-drain` candidates and never
 * re-sends. The gate only decides `blocked` vs `drained-dry-run`.
 */
export function planNeonDeliveryDrain(
  snapshot: INeonDeliveryQueueSnapshot,
  options: IPlanNeonDeliveryDrainOptions
): INeonDeliveryDrainPlan {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const ttlMs = options.ttlMs ?? DEFAULT_DRAIN_TTL_MS;

  const entries = snapshot.candidates
    .filter((candidate) => candidate.recoveryState === "pending-drain")
    .map((candidate) => buildDrainEntry(candidate, nowMs, ttlMs))
    // Oldest first (largest age), candidateId as a stable tie-break — mirrors
    // Upstream's deterministic `sortPendingRecords` ordering for the drain.
    .sort((left, right) =>
      left.ageMs === right.ageMs
        ? left.candidateId.localeCompare(right.candidateId)
        : right.ageMs - left.ageMs
    );

  const totals: INeonDeliveryDrainTotals = {
    pendingDrain: entries.length,
    eligible: entries.filter((entry) => entry.disposition === "eligible").length,
    expired: entries.filter((entry) => entry.disposition === "expired").length,
    alreadyDone: entries.filter((entry) => entry.disposition === "already-done").length
  };

  return {
    state: options.gate.enabled ? "drained-dry-run" : "blocked",
    reason: options.gate.reason,
    gate: options.gate,
    generatedAt: new Date(nowMs).toISOString(),
    ttlMs,
    entries,
    totals,
    safety: { outboundSent: false, reSent: false, requiresCanaryGate: true }
  };
}

export function renderNeonDeliveryDrainPlanReport(plan: INeonDeliveryDrainPlan): string {
  const sample = plan.entries
    .slice(0, 10)
    .map(
      (entry, index) =>
        `${index + 1}. [${entry.disposition}] ${entry.targetLabel} ack=${entry.ackState} age=${Math.round(
          entry.ageMs / 1000
        )}s (${entry.runId})`
    );

  return [
    "Neon Delivery Drain Plan",
    `State: ${plan.state} (${plan.reason})`,
    `Gate: ${plan.gate.envKey}=${plan.gate.enabled ? "enabled" : "disabled"}`,
    `Pending-drain: ${plan.totals.pendingDrain} (eligible ${plan.totals.eligible} · expired ${plan.totals.expired} · already-done ${plan.totals.alreadyDone})`,
    `TTL: ${Math.round(plan.ttlMs / 1000)}s`,
    `Outbound sent: ${plan.safety.outboundSent}`,
    `Re-sent: ${plan.safety.reSent}`,
    ...sample
  ].join("\n");
}
