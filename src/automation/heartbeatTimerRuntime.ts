import { readReadyCutoverEnv } from "../core/cutover.js";
import {
  isWithinNeonHeartbeatActiveHours,
  type INeonHeartbeatActiveHours
} from "./heartbeatActiveHours.js";
import {
  shouldDeferNeonHeartbeatWake,
  type TNeonHeartbeatDeferReason
} from "./heartbeatCooldown.js";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs
} from "./heartbeatSchedule.js";
import {
  resolveNeonWakePriority,
  type TNeonHeartbeatWakeIntent,
  type TNeonHeartbeatWakeSource
} from "./heartbeatWake.js";

/**
 * Heartbeat timer runtime (gated, default-off).
 *
 * Upstream runs a real heartbeat scheduler: `src/infra/heartbeat-runner.ts`
 * (`startHeartbeatRunner` arms a recursive `setTimeout`, `runHeartbeatOnce`
 * builds a prompt and starts an agent run) driven by `src/infra/heartbeat-wake.ts`
 * (`requestHeartbeat` + a `pendingWakes` queue) and gated by the cooldown
 * (`heartbeat-cooldown.ts`) and active-hours (`heartbeat-active-hours.ts`) policy.
 *
 * Neon Core deliberately stops short of execution — mirroring `cronTimerRuntime`.
 * The wake lane is the autonomous side effect, so it is **default-off**: a tick
 * evaluates anything only when `NEON_HEARTBEAT_TIMER_ENABLED` is explicitly
 * ready. When armed it emits read-only `INeonHeartbeatWakeEmission`s — it never
 * starts a run, builds a prompt, sends, or persists. Wiring an emission into a
 * real agent run stays a primary-cutover decision behind DP-4.
 *
 * intentionally-different vs upstream: there is no recursive `setTimeout` (the
 * clock is injected so the tick is deterministic). Due-ness is owned by a
 * phase-window dedup (the reached phase slot is the dedup key, the no-execution
 * analog of upstream's persisted `nextDueMs`), not by a live timer firing.
 */
export type TNeonHeartbeatTimerReason = "timer-disabled" | "timer-enabled";

const heartbeatTimerEnabledEnvKey = "NEON_HEARTBEAT_TIMER_ENABLED";

export interface INeonHeartbeatTimerGate {
  readonly enabled: boolean;
  readonly reason: TNeonHeartbeatTimerReason;
  readonly envKey: typeof heartbeatTimerEnabledEnvKey;
}

export interface INeonHeartbeatAgentState {
  readonly agentId: string;
  readonly intervalMs: number;
  readonly lastRunStartedAtMs?: number;
  readonly recentRunStarts?: readonly number[];
  readonly activeHours?: INeonHeartbeatActiveHours;
}

export interface INeonHeartbeatWakeEmission {
  readonly agentId: string;
  readonly intent: TNeonHeartbeatWakeIntent;
  readonly source: TNeonHeartbeatWakeSource;
  readonly reason: string;
  readonly priority: number;
  readonly dueMs: number;
  readonly windowKey: string;
  readonly cursorKey?: string;
  readonly commitmentIds?: readonly string[];
}

export interface INeonHeartbeatDeferredAgent {
  readonly agentId: string;
  readonly reason: TNeonHeartbeatDeferReason;
}

export interface IEvaluateNeonHeartbeatTickOptions {
  readonly gate: INeonHeartbeatTimerGate;
  readonly schedulerSeed: string;
  readonly agents: readonly INeonHeartbeatAgentState[];
  readonly commitmentWakes?: readonly INeonHeartbeatCommitmentWakeInput[];
  readonly now?: () => Date;
  readonly alreadyEmitted?: Readonly<Record<string, string>>;
  readonly minSpacingMs?: number;
  readonly floodWindowMs?: number;
  readonly floodThreshold?: number;
}

export interface INeonHeartbeatCommitmentWakeInput {
  readonly agentId: string;
  readonly commitmentId: string;
  readonly dueMs: number;
}

export interface INeonHeartbeatTickResult {
  readonly armed: boolean;
  readonly gate: INeonHeartbeatTimerGate;
  readonly evaluatedAt: string;
  readonly emissions: readonly INeonHeartbeatWakeEmission[];
  readonly emitted: readonly string[];
  readonly deferred: readonly INeonHeartbeatDeferredAgent[];
  readonly outsideActiveHours: readonly string[];
  readonly deduped: readonly string[];
  readonly nextEmitted: Readonly<Record<string, string>>;
  readonly safety: { readonly executed: false; readonly outboundSent: false };
  readonly diagnostics: readonly string[];
}

export function resolveNeonHeartbeatTimerGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonHeartbeatTimerGate {
  const enabled = readReadyCutoverEnv(env, heartbeatTimerEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "timer-enabled" : "timer-disabled",
    envKey: heartbeatTimerEnabledEnvKey
  };
}

export function evaluateNeonHeartbeatTick(
  options: IEvaluateNeonHeartbeatTickOptions
): INeonHeartbeatTickResult {
  const now = (options.now ?? (() => new Date()))();
  const evaluatedAt = now.toISOString();
  const nowMs = now.getTime();

  if (!options.gate.enabled) {
    return {
      armed: false,
      gate: options.gate,
      evaluatedAt,
      emissions: [],
      emitted: [],
      deferred: [],
      outsideActiveHours: [],
      deduped: [],
      nextEmitted: options.alreadyEmitted ?? {},
      safety: { executed: false, outboundSent: false },
      diagnostics: [
        "Heartbeat timer is disabled (default). No tick ran; set NEON_HEARTBEAT_TIMER_ENABLED to arm read-only wake-intent evaluation.",
        "Even when armed the timer only emits shadow wake intents; starting a run stays gated by the run-lifecycle gate (DP-4)."
      ]
    };
  }

  const emissions: INeonHeartbeatWakeEmission[] = [];
  const emitted: string[] = [];
  const deferred: INeonHeartbeatDeferredAgent[] = [];
  const outsideActiveHours: string[] = [];
  const deduped: string[] = [];
  const nextEmitted: Record<string, string> = { ...(options.alreadyEmitted ?? {}) };

  for (const agent of options.agents) {
    const phaseMs = resolveHeartbeatPhaseMs({
      schedulerSeed: options.schedulerSeed,
      agentId: agent.agentId,
      intervalMs: agent.intervalMs
    });
    const nextSlotMs = computeNextHeartbeatPhaseDueMs({
      nowMs,
      intervalMs: agent.intervalMs,
      phaseMs
    });
    // The reached phase slot (<= now) is the dedup window — the no-execution
    // analog of upstream's persisted nextDueMs. computeNext returns the next
    // slot strictly > now, so subtracting one interval yields the current one.
    const dueMs = nextSlotMs - resolvePositiveInterval(agent.intervalMs);
    const windowKey = new Date(dueMs).toISOString();

    if (agent.activeHours && !isWithinNeonHeartbeatActiveHours(agent.activeHours, nowMs)) {
      outsideActiveHours.push(agent.agentId);
      continue;
    }

    // Feed shouldDefer with intent "event" and the REACHED window as nextDueMs so
    // its not-due guard never fires (the window is already <= now — windowKey
    // dedup owns due-ness), while min-spacing + flood + first-run bypass stay live.
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "event",
      reason: undefined,
      now: nowMs,
      nextDueMs: dueMs,
      ...(agent.lastRunStartedAtMs !== undefined
        ? { lastRunStartedAtMs: agent.lastRunStartedAtMs }
        : {}),
      ...(agent.recentRunStarts ? { recentRunStarts: agent.recentRunStarts } : {}),
      ...(options.minSpacingMs !== undefined ? { minSpacingMs: options.minSpacingMs } : {}),
      ...(options.floodWindowMs !== undefined ? { floodWindowMs: options.floodWindowMs } : {}),
      ...(options.floodThreshold !== undefined ? { floodThreshold: options.floodThreshold } : {})
    });
    if (decision.defer) {
      deferred.push({ agentId: agent.agentId, reason: decision.reason });
      continue;
    }

    if (options.alreadyEmitted?.[agent.agentId] === windowKey) {
      deduped.push(agent.agentId);
      continue;
    }

    const priority = resolveNeonWakePriority({
      source: "interval",
      intent: "scheduled",
      reason: "interval"
    });
    emissions.push({
      agentId: agent.agentId,
      intent: "scheduled",
      source: "interval",
      reason: "interval",
      priority,
      dueMs,
      windowKey
    });
    emitted.push(agent.agentId);
    nextEmitted[agent.agentId] = windowKey;
  }

  const agentsById = new Map(options.agents.map((agent) => [agent.agentId, agent]));
  for (const wake of options.commitmentWakes ?? []) {
    const agent = agentsById.get(wake.agentId);
    if (!agent) {
      continue;
    }
    if (agent?.activeHours && !isWithinNeonHeartbeatActiveHours(agent.activeHours, nowMs)) {
      outsideActiveHours.push(wake.agentId);
      continue;
    }
    const windowKey = new Date(wake.dueMs).toISOString();
    const cursorKey = `commitment:${wake.agentId}:${wake.commitmentId}`;
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "event",
      reason: "commitment-due",
      now: nowMs,
      nextDueMs: wake.dueMs,
      ...(agent.lastRunStartedAtMs !== undefined
        ? { lastRunStartedAtMs: agent.lastRunStartedAtMs }
        : {}),
      ...(agent.recentRunStarts ? { recentRunStarts: agent.recentRunStarts } : {}),
      ...(options.minSpacingMs !== undefined ? { minSpacingMs: options.minSpacingMs } : {}),
      ...(options.floodWindowMs !== undefined ? { floodWindowMs: options.floodWindowMs } : {}),
      ...(options.floodThreshold !== undefined ? { floodThreshold: options.floodThreshold } : {})
    });
    if (decision.defer) {
      deferred.push({ agentId: wake.agentId, reason: decision.reason });
      continue;
    }
    if (options.alreadyEmitted?.[cursorKey] === windowKey) {
      deduped.push(cursorKey);
      continue;
    }
    const priority = resolveNeonWakePriority({
      source: "commitment",
      intent: "event",
      reason: "commitment-due"
    });
    emissions.push({
      agentId: wake.agentId,
      intent: "event",
      source: "commitment",
      reason: "commitment-due",
      priority,
      dueMs: wake.dueMs,
      windowKey,
      cursorKey,
      commitmentIds: [wake.commitmentId]
    });
    emitted.push(cursorKey);
    nextEmitted[cursorKey] = windowKey;
  }

  return {
    armed: true,
    gate: options.gate,
    evaluatedAt,
    emissions,
    emitted,
    deferred,
    outsideActiveHours,
    deduped,
    nextEmitted,
    safety: { executed: false, outboundSent: false },
    diagnostics: [
      `Heartbeat timer armed: evaluated ${options.agents.length} agent(s), emitted ${emitted.length} read-only wake intent(s), deferred ${deferred.length}, outside-active-hours ${outsideActiveHours.length}, deduped ${deduped.length}.`,
      "Timer emits shadow wake intents only; starting a run stays gated by the run-lifecycle gate (DP-4)."
    ]
  };
}

export function renderNeonHeartbeatTickReport(result: INeonHeartbeatTickResult): string {
  const lines = [
    `Neon Heartbeat Timer: ${result.armed ? "armed" : "disabled"} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Evaluated: ${result.evaluatedAt}`,
    `Emitted wake intents: ${result.emitted.length}${result.emitted.length ? ` (${result.emitted.join(", ")})` : ""}`,
    `Deferred: ${result.deferred.length}${result.deferred.length ? ` (${result.deferred.map((entry) => `${entry.agentId}:${entry.reason}`).join(", ")})` : ""}`,
    `Outside active-hours: ${result.outsideActiveHours.length}${result.outsideActiveHours.length ? ` (${result.outsideActiveHours.join(", ")})` : ""}`,
    `Deduped (same window): ${result.deduped.length}${result.deduped.length ? ` (${result.deduped.join(", ")})` : ""}`,
    `Safety: executed=${result.safety.executed} outboundSent=${result.safety.outboundSent}`
  ];

  for (const emission of result.emissions) {
    lines.push(`- ${emission.agentId}: ${emission.source}/${emission.intent} @ ${emission.windowKey} (priority ${emission.priority})`);
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}

function resolvePositiveInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : 1;
}
