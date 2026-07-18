import { readReadyCutoverEnv } from "../core/cutover.js";
import type { TNeonChannel } from "../harness/types.js";

/**
 * In-flight run lifecycle (DP-4), source-backed by upstream
 * `src/channels/run-state-machine.ts`: a per-process status machine that counts
 * `activeRuns`, derives `busy = activeRuns > 0`, and stamps `lastRunActivityAt`
 * via `onRunStart()`/`onRunEnd()`. Stop/abort map to the real Neon interrupt
 * primitive `interruptCodexTurn(client, { threadId, turnId })`
 * (`harness/threadRun.ts`).
 *
 * Shadow-contract boundary: the run *store* stays terminal-only (it only
 * persists completed/failed runs) — this module does NOT touch that persistence.
 * It is an in-memory, default-off live-status overlay:
 * - `NEON_LIVE_RUN_LIFECYCLE_ENABLED` is off by default, so `onRunStart` is a
 *   no-op and `snapshot()` reports the terminal-only view (`activeRuns: 0`,
 *   `busy: false`). That is exactly the documented shadow posture.
 * - When armed it tracks in-flight runs in memory only (per-process, like
 *   Upstream's state machine) — never written to `runs.jsonl`.
 *
 * Live arming is fed through the real gateway -> Codex harness path when the
 * registry is injected and the gate is enabled. The remaining product step is a
 * live long-running turn proof for stop/abort against the tracked turnId.
 */

const inFlightRunEnabledEnvKey = "NEON_LIVE_RUN_LIFECYCLE_ENABLED";
const DEFAULT_IN_FLIGHT_RUN_MAX_ENTRIES = 5_000;

export type TNeonInFlightGateReason = "lifecycle-disabled" | "lifecycle-enabled";
export type TNeonInFlightRunState = "running" | "interrupting";
export type TNeonRunLifecycleAction = "stop" | "abort" | "resume" | "branch" | "label" | "delete";
export type TNeonRunLifecycleDecisionState = "blocked" | "interrupt-ready" | "plan-only";

export interface INeonInFlightRunGate {
  readonly enabled: boolean;
  readonly reason: TNeonInFlightGateReason;
  readonly envKey: typeof inFlightRunEnabledEnvKey;
}

export interface INeonInFlightRunStart {
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channel: TNeonChannel;
}

export interface INeonInFlightRunRecord {
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channel: TNeonChannel;
  readonly state: TNeonInFlightRunState;
  readonly startedAt: string;
  readonly lastActivityAt: string;
}

export interface INeonInFlightRunSnapshot {
  readonly activeRuns: number;
  readonly busy: boolean;
  readonly lastRunActivityAt: string | null;
  readonly running: readonly INeonInFlightRunRecord[];
}

export interface INeonInFlightRunRegistry {
  readonly gate: INeonInFlightRunGate;
  /** Registers a run as in-flight. Returns null when the gate is closed (no-op). */
  onRunStart(input: INeonInFlightRunStart): INeonInFlightRunRecord | null;
  /** Refreshes the activity timestamp for a tracked run (the heartbeat analog). */
  recordActivity(runId: string): void;
  /** Marks a run as interrupting after a stop/abort decision. */
  markInterrupting(runId: string): void;
  /** Removes a run from the in-flight set once it reaches a terminal outcome. */
  onRunEnd(runId: string): void;
  snapshot(): INeonInFlightRunSnapshot;
}

export interface INeonInFlightRunRegistryOptions {
  readonly gate: INeonInFlightRunGate;
  readonly now?: () => Date;
  readonly maxEntries?: number;
}

export interface INeonRunLifecycleDecisionSafety {
  readonly executed: false;
  readonly outboundSent: false;
}

export interface INeonRunLifecycleDecision {
  readonly action: TNeonRunLifecycleAction;
  readonly runId: string;
  readonly state: TNeonRunLifecycleDecisionState;
  readonly reason: string;
  /** For stop/abort: the threadId a caller passes to `interruptCodexTurn`. */
  readonly interruptThreadId?: string;
  /** For stop/abort: the turnId a caller passes to `interruptCodexTurn`. */
  readonly interruptTurnId?: string;
  readonly safety: INeonRunLifecycleDecisionSafety;
}

export interface IPlanNeonRunLifecycleActionOptions {
  readonly action: TNeonRunLifecycleAction;
  readonly runId: string;
  readonly gate: INeonInFlightRunGate;
  readonly record?: INeonInFlightRunRecord | undefined;
}

const INTERRUPT_ACTIONS = new Set<TNeonRunLifecycleAction>(["stop", "abort"]);

export function resolveNeonInFlightRunGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonInFlightRunGate {
  const enabled = readReadyCutoverEnv(env, inFlightRunEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "lifecycle-enabled" : "lifecycle-disabled",
    envKey: inFlightRunEnabledEnvKey
  };
}

export function createNeonInFlightRunRegistry(
  options: INeonInFlightRunRegistryOptions
): INeonInFlightRunRegistry {
  const now = options.now ?? ((): Date => new Date());
  const maxEntries = resolveInFlightRunMaxEntries(options.maxEntries);
  const records = new Map<string, INeonInFlightRunRecord>();
  let lastActivityAt: string | null = null;

  const stamp = (): string => {
    const iso = now().toISOString();
    lastActivityAt = iso;
    return iso;
  };

  return {
    gate: options.gate,
    onRunStart(input) {
      if (!options.gate.enabled) {
        return null;
      }
      const at = stamp();
      const record: INeonInFlightRunRecord = {
        runId: input.runId,
        threadId: input.threadId,
        turnId: input.turnId,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        channel: input.channel,
        state: "running",
        startedAt: at,
        lastActivityAt: at
      };
      records.set(input.runId, record);
      enforceMaxEntries(input.runId);
      return record;
    },
    recordActivity(runId) {
      const record = records.get(runId);
      if (!record) {
        return;
      }
      records.set(runId, { ...record, lastActivityAt: stamp() });
    },
    markInterrupting(runId) {
      const record = records.get(runId);
      if (!record) {
        return;
      }
      records.set(runId, { ...record, state: "interrupting", lastActivityAt: stamp() });
    },
    onRunEnd(runId) {
      if (records.delete(runId)) {
        stamp();
      }
    },
    snapshot() {
      const running = [...records.values()].sort((left, right) =>
        left.startedAt === right.startedAt
          ? left.runId.localeCompare(right.runId)
          : left.startedAt.localeCompare(right.startedAt)
      );

      return {
        activeRuns: running.length,
        busy: running.length > 0,
        lastRunActivityAt: lastActivityAt,
        running
      };
    }
  };

  function enforceMaxEntries(protectedRunId: string): void {
    if (records.size <= maxEntries) {
      return;
    }

    for (const runId of records.keys()) {
      if (records.size <= maxEntries) {
        return;
      }

      if (runId === protectedRunId && records.size > 1) {
        continue;
      }

      records.delete(runId);
    }
  }
}

function resolveInFlightRunMaxEntries(maxEntries: number | undefined): number {
  if (maxEntries === undefined || !Number.isFinite(maxEntries) || maxEntries <= 0) {
    return DEFAULT_IN_FLIGHT_RUN_MAX_ENTRIES;
  }

  return Math.max(1, Math.floor(maxEntries));
}

/**
 * Decides what a run-control action would do without executing it. Stop/abort
 * become `interrupt-ready` (carrying the turnId for `interruptCodexTurn`);
 * resume/branch/label/delete stay `plan-only`. A closed gate or an unknown run
 * is `blocked`. Never sends, never mutates — `safety` is literal false.
 */
export function planNeonRunLifecycleAction(
  options: IPlanNeonRunLifecycleActionOptions
): INeonRunLifecycleDecision {
  const safety: INeonRunLifecycleDecisionSafety = { executed: false, outboundSent: false };
  const base = { action: options.action, runId: options.runId, safety } as const;

  if (!options.gate.enabled) {
    return { ...base, state: "blocked", reason: "lifecycle-gate-disabled" };
  }

  if (!options.record) {
    return { ...base, state: "blocked", reason: "run-not-in-flight" };
  }

  if (INTERRUPT_ACTIONS.has(options.action)) {
    return {
      ...base,
      state: "interrupt-ready",
      reason: "would-call-interruptCodexTurn",
      interruptThreadId: options.record.threadId,
      interruptTurnId: options.record.turnId
    };
  }

  return { ...base, state: "plan-only", reason: `${options.action}-needs-session-runtime` };
}

export function renderNeonInFlightRunReport(snapshot: INeonInFlightRunSnapshot): string {
  const running = snapshot.running
    .slice(0, 10)
    .map(
      (record, index) =>
        `${index + 1}. [${record.state}] ${record.channel}/${record.agentId} run=${record.runId} thread=${record.threadId} turn=${record.turnId}`
    );

  return [
    "Neonika In-Flight Runs",
    `Active runs: ${snapshot.activeRuns}`,
    `Busy: ${snapshot.busy}`,
    `Last activity: ${snapshot.lastRunActivityAt ?? "none"}`,
    ...running
  ].join("\n");
}

export function renderNeonRunLifecycleDecisionReport(decision: INeonRunLifecycleDecision): string {
  return [
    `Action: ${decision.action} (${decision.runId})`,
    `State: ${decision.state} (${decision.reason})`,
    ...(decision.interruptThreadId ? [`Interrupt thread: ${decision.interruptThreadId}`] : []),
    ...(decision.interruptTurnId ? [`Interrupt turn: ${decision.interruptTurnId}`] : []),
    `Executed: ${decision.safety.executed}`,
    `Outbound sent: ${decision.safety.outboundSent}`
  ].join("\n");
}
