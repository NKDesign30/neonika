import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  listNeonDueCommitments,
  readNeonCommitments,
  resolveNeonCommitmentStorePath
} from "../commitments/commitmentStore.js";
import {
  markNeonCommitmentsHeartbeatObserved,
  type INeonCommitmentLifecycleGate,
  type INeonCommitmentLifecycleResult
} from "../commitments/commitmentLifecycle.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import type { INeonChannelRouteRef } from "../channels/routeProjection.js";
import {
  resolveNeonHeartbeatDaemonCursorPath,
  runNeonHeartbeatDaemonTick,
  type INeonHeartbeatDaemonTickResult
} from "./heartbeatDaemonRuntime.js";
import {
  executeNeonHeartbeatWakeIntents,
  type INeonHeartbeatExecutionResult
} from "./heartbeatRunExecutor.js";
import {
  resolveNeonHeartbeatTimerGate,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatCommitmentWakeInput,
  type INeonHeartbeatTimerGate
} from "./heartbeatTimerRuntime.js";
import type { INeonScheduledAgentRuntime } from "./scheduledAgentExecution.js";

/**
 * Heartbeat daemon service.
 *
 * The autonomous loop upstream runs via `startHeartbeatRunner` (recursive
 * setTimeout) and Neonika deliberately left out of the pure runtime. This
 * service wires a real `setInterval` to the pure tick runtime and persists a
 * liveness state file so a separate process (CLI status / Doctor / HTTP) can see
 * `alive / lastTick / nextTick / dueIntents / createdRuns`.
 *
 * Default-off invariants remain: emission requires `NEON_HEARTBEAT_TIMER_ENABLED`,
 * agent work independently requires `NEON_SCHEDULED_AGENT_EXECUTION_ENABLED`,
 * and delivery still goes through the Canary sender policy. `tickOnce` keeps
 * deterministic service verification possible without a wall-clock timer.
 */
export interface INeonHeartbeatDaemonLiveState {
  readonly version: 1;
  readonly pid: number;
  readonly alive: boolean;
  readonly gateEnabled: boolean;
  readonly intervalMs: number;
  readonly startedAt: string;
  readonly lastTickAt?: string;
  readonly nextTickAt?: string;
  readonly tickCount: number;
  readonly dueIntentsLastTick: number;
  readonly dueCommitmentsLastTick: number;
  readonly lifecycleCommitmentsLastTick: number;
  readonly createdRunsTotal: number;
  readonly executedRunsTotal: number;
  readonly failedRunsTotal: number;
  readonly retryAttemptsTotal: number;
  readonly deliveredRunsTotal: number;
  readonly stoppedAt?: string;
}

export interface INeonHeartbeatDaemonTickOutcome {
  readonly tick: INeonHeartbeatDaemonTickResult;
  readonly execution: INeonHeartbeatExecutionResult;
  readonly commitmentLifecycle: INeonCommitmentLifecycleResult;
  readonly state: INeonHeartbeatDaemonLiveState;
}

export interface INeonHeartbeatDaemonService {
  start(): Promise<void>;
  stop(): Promise<void>;
  tickOnce(): Promise<INeonHeartbeatDaemonTickOutcome>;
  getState(): INeonHeartbeatDaemonLiveState;
}

export interface ICreateNeonHeartbeatDaemonServiceOptions {
  readonly projectRoot: string;
  readonly schedulerSeed: string;
  readonly agents: readonly INeonHeartbeatAgentState[];
  readonly intervalMs: number;
  readonly gate?: INeonHeartbeatTimerGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly cursorPath?: string;
  readonly commitmentStorePath?: string;
  readonly commitmentLifecycle?:
    | false
    | {
        readonly gate?: INeonCommitmentLifecycleGate;
        readonly env?: Readonly<Record<string, string | undefined>>;
        readonly snoozeMs?: number;
      };
  readonly livePath?: string;
  readonly maxCatchupPerJob?: number;
  readonly unrefTimer?: boolean;
  readonly agentRuntime?: INeonScheduledAgentRuntime;
  readonly deliveryTarget?: INeonChannelRouteRef;
  readonly writeRun?: (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;
}

export function resolveNeonHeartbeatDaemonLivePath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "heartbeat-daemon-live.json");
}

export async function readNeonHeartbeatDaemonLiveState(
  livePath: string
): Promise<INeonHeartbeatDaemonLiveState | undefined> {
  try {
    const raw = await readFile(livePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeLiveState(parsed);
  } catch {
    return undefined;
  }
}

export async function writeNeonHeartbeatDaemonLiveState(
  livePath: string,
  state: INeonHeartbeatDaemonLiveState
): Promise<void> {
  await mkdir(dirname(livePath), { recursive: true });
  await writeFile(livePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * A liveness state is considered stale (daemon likely dead) when its predicted
 * next tick is more than `graceMs` in the past. Pure so the status/doctor view
 * can flag a crashed daemon without trusting the `alive` flag alone.
 */
export function isNeonHeartbeatDaemonStale(
  state: INeonHeartbeatDaemonLiveState,
  nowMs: number,
  graceMs = 60_000
): boolean {
  if (!state.alive) {
    return false; // cleanly stopped, not stale
  }
  if (!state.nextTickAt) {
    return false;
  }
  const nextMs = Date.parse(state.nextTickAt);
  if (Number.isNaN(nextMs)) {
    return false;
  }
  return nowMs > nextMs + Math.max(0, graceMs);
}

export function createNeonHeartbeatDaemonService(
  options: ICreateNeonHeartbeatDaemonServiceOptions
): INeonHeartbeatDaemonService {
  const now = options.now ?? (() => new Date());
  const intervalMs = Math.max(1, Math.floor(options.intervalMs));
  const cursorPath = options.cursorPath ?? resolveNeonHeartbeatDaemonCursorPath(options.projectRoot);
  const commitmentStorePath =
    options.commitmentStorePath ?? resolveNeonCommitmentStorePath(options.projectRoot);
  const livePath = options.livePath ?? resolveNeonHeartbeatDaemonLivePath(options.projectRoot);
  const gate = options.gate ?? resolveNeonHeartbeatTimerGate(options.env ?? process.env);

  let state: INeonHeartbeatDaemonLiveState = {
    version: 1,
    pid: process.pid,
    alive: false,
    gateEnabled: gate.enabled,
    intervalMs,
    startedAt: now().toISOString(),
    tickCount: 0,
    dueIntentsLastTick: 0,
    dueCommitmentsLastTick: 0,
    lifecycleCommitmentsLastTick: 0,
    createdRunsTotal: 0,
    executedRunsTotal: 0,
    failedRunsTotal: 0,
    retryAttemptsTotal: 0,
    deliveredRunsTotal: 0
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function tickOnce(): Promise<INeonHeartbeatDaemonTickOutcome> {
    const tickNow = now();
    const commitmentWakes = await loadHeartbeatCommitmentWakes({
      storePath: commitmentStorePath,
      nowMs: tickNow.getTime(),
      agents: options.agents
    });
    const tick = await runNeonHeartbeatDaemonTick({
      cursorPath,
      schedulerSeed: options.schedulerSeed,
      agents: options.agents,
      gate,
      now: () => tickNow,
      ...(commitmentWakes.length > 0 ? { commitmentWakes } : {}),
      ...(options.maxCatchupPerJob !== undefined ? { maxCatchupPerJob: options.maxCatchupPerJob } : {})
    });
    const execution = await executeNeonHeartbeatWakeIntents({
      projectRoot: options.projectRoot,
      emissions: tick.tick.emissions,
      tickAt: tick.tickAt,
      ...(options.agentRuntime ? { agentRuntime: options.agentRuntime } : {}),
      ...(options.deliveryTarget ? { deliveryTarget: options.deliveryTarget } : {}),
      ...(options.writeRun ? { writeRun: options.writeRun } : {})
    });
    const commitmentLifecycle =
      options.commitmentLifecycle === false
        ? {
            state: "blocked" as const,
            gate: {
              enabled: false,
              envKey: "NEON_COMMITMENT_LIFECYCLE_ENABLED" as const,
              reason: "lifecycle-disabled" as const
            },
            updatedIds: [],
            skippedIds: [],
            diagnostics: ["commitment-lifecycle disabled by service options"]
          }
        : await markNeonCommitmentsHeartbeatObserved({
            storePath: commitmentStorePath,
            commitmentIds: collectEmittedCommitmentIds(tick.tick.emissions),
            nowMs: tickNow.getTime(),
            ...(options.commitmentLifecycle?.gate ? { gate: options.commitmentLifecycle.gate } : {}),
            ...(options.commitmentLifecycle?.env ? { env: options.commitmentLifecycle.env } : {}),
            ...(options.commitmentLifecycle?.snoozeMs !== undefined
              ? { snoozeMs: options.commitmentLifecycle.snoozeMs }
              : {})
          });

    state = {
      ...state,
      lastTickAt: tick.tickAt,
      nextTickAt: new Date(tickNow.getTime() + intervalMs).toISOString(),
      tickCount: state.tickCount + 1,
      dueIntentsLastTick: tick.tick.emitted.length,
      dueCommitmentsLastTick: commitmentWakes.length,
      lifecycleCommitmentsLastTick: commitmentLifecycle.updatedIds.length,
      createdRunsTotal: state.createdRunsTotal + execution.createdRunCount,
      executedRunsTotal: state.executedRunsTotal + execution.executedRunCount,
      failedRunsTotal: state.failedRunsTotal + execution.failedRunCount,
      retryAttemptsTotal: state.retryAttemptsTotal + execution.retryCount,
      deliveredRunsTotal: state.deliveredRunsTotal + execution.deliveredRunCount
    };
    await writeNeonHeartbeatDaemonLiveState(livePath, state);
    return { tick, execution, commitmentLifecycle, state };
  }

  async function start(): Promise<void> {
    if (timer) {
      return;
    }
    const startNow = now();
    state = {
      ...state,
      alive: true,
      startedAt: startNow.toISOString(),
      nextTickAt: new Date(startNow.getTime() + intervalMs).toISOString()
    };
    await writeNeonHeartbeatDaemonLiveState(livePath, state);

    timer = setInterval(() => {
      if (ticking) {
        return; // re-entrancy guard: a slow tick must not overlap the next
      }
      ticking = true;
      void tickOnce().finally(() => {
        ticking = false;
      });
    }, intervalMs);
    if (options.unrefTimer !== false) {
      timer.unref?.();
    }
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    state = { ...state, alive: false, stoppedAt: now().toISOString() };
    await writeNeonHeartbeatDaemonLiveState(livePath, state);
  }

  function getState(): INeonHeartbeatDaemonLiveState {
    return state;
  }

  return { start, stop, tickOnce, getState };
}

function normalizeLiveState(value: unknown): INeonHeartbeatDaemonLiveState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const pid = record["pid"];
  const intervalMs = record["intervalMs"];
  const startedAt = record["startedAt"];
  if (typeof pid !== "number" || typeof intervalMs !== "number" || typeof startedAt !== "string") {
    return undefined;
  }
  const lastTickAt = typeof record["lastTickAt"] === "string" ? record["lastTickAt"] : undefined;
  const nextTickAt = typeof record["nextTickAt"] === "string" ? record["nextTickAt"] : undefined;
  const stoppedAt = typeof record["stoppedAt"] === "string" ? record["stoppedAt"] : undefined;

  return {
    version: 1,
    pid,
    alive: record["alive"] === true,
    gateEnabled: record["gateEnabled"] === true,
    intervalMs,
    startedAt,
    ...(lastTickAt ? { lastTickAt } : {}),
    ...(nextTickAt ? { nextTickAt } : {}),
    tickCount: toCount(record["tickCount"]),
    dueIntentsLastTick: toCount(record["dueIntentsLastTick"]),
    dueCommitmentsLastTick: toCount(record["dueCommitmentsLastTick"]),
    lifecycleCommitmentsLastTick: toCount(record["lifecycleCommitmentsLastTick"]),
    createdRunsTotal: toCount(record["createdRunsTotal"]),
    executedRunsTotal: toCount(record["executedRunsTotal"]),
    failedRunsTotal: toCount(record["failedRunsTotal"]),
    retryAttemptsTotal: toCount(record["retryAttemptsTotal"]),
    deliveredRunsTotal: toCount(record["deliveredRunsTotal"]),
    ...(stoppedAt ? { stoppedAt } : {})
  };
}

function collectEmittedCommitmentIds(
  emissions: readonly { readonly commitmentIds?: readonly string[] }[]
): readonly string[] {
  return emissions.flatMap((emission) => emission.commitmentIds ?? []);
}

async function loadHeartbeatCommitmentWakes(options: {
  readonly storePath: string;
  readonly nowMs: number;
  readonly agents: readonly INeonHeartbeatAgentState[];
}): Promise<readonly INeonHeartbeatCommitmentWakeInput[]> {
  const commitments = await readNeonCommitments({ storePath: options.storePath });
  const knownAgents = new Set(options.agents.map((agent) => agent.agentId));
  return listNeonDueCommitments(commitments, options.nowMs)
    .filter((commitment) => knownAgents.has(commitment.agentId))
    .map((commitment) => ({
      agentId: commitment.agentId,
      commitmentId: commitment.id,
      dueMs: commitment.dueWindow.earliestMs
    }));
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
