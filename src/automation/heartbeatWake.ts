/**
 * Heartbeat wake model (pure core).
 *
 * Port of the pure core of upstream `src/infra/heartbeat-wake.ts`: the
 * wake-reason / intent / priority model and the coalescing merge. Upstream keeps
 * a module-level `pendingWakes` singleton plus a `setTimeout` scheduler and a
 * live wake handler. Neon Core deliberately ports ONLY the pure pieces:
 *  - the two shared unions (intent + source),
 *  - reason normalization + priority resolution,
 *  - the target key + the coalescing merge over a CALLER-SUPPLIED map.
 *
 * No module singleton, no timer, no handler — `queueNeonPendingWakeReason`
 * operates on the map the caller hands in, so the function stays pure and
 * test-isolated. The autonomous scheduler/handler stays out (shadow contract).
 */

/** The intent that drives the wake-deferral policy (single source of truth). */
export type TNeonHeartbeatWakeIntent = "scheduled" | "event" | "immediate" | "manual";

/** Where a wake originated. Only `interval`/`retry` are priority-relevant. */
export type TNeonHeartbeatWakeSource =
  | "interval"
  | "manual"
  | "exec-event"
  | "notifications-event"
  | "commitment"
  | "cron"
  | "hook"
  | "background-task"
  | "acp-spawn"
  | "cli-watchdog"
  | "restart-sentinel"
  | "retry"
  | "other";

/** Optional delivery routing override carried on a pending wake. */
export interface INeonHeartbeatWakeOverride {
  readonly target?: string;
  readonly to?: string;
  readonly accountId?: string;
}

/** Normalized pending-wake value stored per target key in the wake map. */
export interface INeonPendingWakeReason {
  readonly source: TNeonHeartbeatWakeSource;
  readonly intent: TNeonHeartbeatWakeIntent;
  readonly reason: string;
  readonly priority: number;
  readonly requestedAt: number;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly heartbeat?: INeonHeartbeatWakeOverride;
}

/** The 3 busy-skip reasons a scheduler should re-queue (retry path). */
export type TNeonRetryableHeartbeatBusySkipReason =
  | "requests-in-flight"
  | "cron-in-progress"
  | "lanes-busy";

export const NEON_HEARTBEAT_WAKE_REASON_FALLBACK = "requested";

const REASON_PRIORITY = {
  ACTION: 3,
  DEFAULT: 2,
  INTERVAL: 1,
  RETRY: 0
} as const;

const retryableBusySkipReasons: ReadonlySet<string> = new Set<TNeonRetryableHeartbeatBusySkipReason>([
  "requests-in-flight",
  "cron-in-progress",
  "lanes-busy"
]);

/** Trim a wake reason; empty/whitespace/undefined collapses to `"requested"`. */
export function normalizeNeonHeartbeatWakeReason(reason?: string): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed.length > 0 ? trimmed : NEON_HEARTBEAT_WAKE_REASON_FALLBACK;
}

/**
 * Resolve the merge priority of a wake. Order is load-bearing:
 * 1. manual/immediate intent -> ACTION (operator action beats everything, even retry),
 * 2. retry source/reason -> RETRY (lowest),
 * 3. scheduled intent or interval source/reason -> INTERVAL,
 * 4. everything else -> DEFAULT.
 */
export function resolveNeonWakePriority(params: {
  readonly source: TNeonHeartbeatWakeSource;
  readonly intent: TNeonHeartbeatWakeIntent;
  readonly reason: string;
}): number {
  if (params.intent === "manual" || params.intent === "immediate") {
    return REASON_PRIORITY.ACTION;
  }
  if (params.source === "retry" || params.reason === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (params.intent === "scheduled" || params.source === "interval" || params.reason === "interval") {
    return REASON_PRIORITY.INTERVAL;
  }
  return REASON_PRIORITY.DEFAULT;
}

/** Coalescing target key: `agentId::sessionKey` (whitespace-only collapses to empty). */
export function getNeonWakeTargetKey(params: {
  readonly agentId?: string;
  readonly sessionKey?: string;
}): string {
  return `${normalizeWakeTarget(params.agentId) ?? ""}::${normalizeWakeTarget(params.sessionKey) ?? ""}`;
}

/**
 * Coalesce a wake into the caller-supplied map (no module singleton). A higher
 * priority overwrites the pending reason; an equal priority with a newer/equal
 * timestamp is last-write-wins; a lower priority is dropped (no downgrade). A
 * delivery override is never lost on coalesce: the merged value keeps
 * `next.heartbeat ?? previous.heartbeat`. Returns the same map for chaining.
 */
export function queueNeonPendingWakeReason(
  map: Map<string, INeonPendingWakeReason>,
  params: {
    readonly source: TNeonHeartbeatWakeSource;
    readonly intent: TNeonHeartbeatWakeIntent;
    readonly reason?: string;
    readonly requestedAt?: number;
    readonly agentId?: string;
    readonly sessionKey?: string;
    readonly heartbeat?: INeonHeartbeatWakeOverride;
  }
): Map<string, INeonPendingWakeReason> {
  const reason = normalizeNeonHeartbeatWakeReason(params.reason);
  const requestedAt = params.requestedAt ?? Date.now();
  const priority = resolveNeonWakePriority({ source: params.source, intent: params.intent, reason });

  const next: INeonPendingWakeReason = {
    source: params.source,
    intent: params.intent,
    reason,
    priority,
    requestedAt,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
    ...(params.heartbeat ? { heartbeat: params.heartbeat } : {})
  };

  const key = getNeonWakeTargetKey({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {})
  });
  const previous = map.get(key);

  if (!previous) {
    map.set(key, next);
    return map;
  }

  const carriedOverride = next.heartbeat ?? previous.heartbeat;
  const merged: INeonPendingWakeReason = carriedOverride
    ? { ...next, heartbeat: carriedOverride }
    : next;

  if (next.priority > previous.priority) {
    map.set(key, merged);
    return map;
  }
  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    map.set(key, merged);
    return map;
  }

  // No-downgrade: a lower-priority same-target follow-up never overwrites.
  return map;
}

/** True when a busy-skip reason should be re-queued by a scheduler (retry path). */
export function isNeonRetryableHeartbeatBusySkipReason(reason: string): boolean {
  return retryableBusySkipReasons.has(reason);
}

function normalizeWakeTarget(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
