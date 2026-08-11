import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { INeonGatewayShadowRun } from "../gateway/types.js";
import {
  resolveNeonCronDaemonCursorPath,
  runNeonCronDaemonTick,
  type INeonCronDaemonTickResult
} from "./cronDaemonRuntime.js";
import {
  executeNeonCronRunIntents,
  type INeonCronExecutionResult
} from "./cronRunExecutor.js";
import { createNeonCronStoreAutomationSnapshot } from "./cronStoreSnapshot.js";
import {
  projectNeonCronStoreJobs,
  readNeonCronStoreEvents
} from "./cronStore.js";
import {
  resolveNeonCronTimerGate,
  type INeonCronTimerGate
} from "./cronTimerRuntime.js";
import type { INeonAutomationSnapshot } from "./neonAutomation.js";
import {
  resolveNeonWorkspaceNotesGate,
  type INeonWorkspaceNotesGate
} from "../workspace/workspaceNotes.js";
import type { INeonScheduledAgentRuntime } from "./scheduledAgentExecution.js";

export interface INeonCronDaemonLiveState {
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
  readonly catchupIntentsLastTick: number;
  readonly createdRunsTotal: number;
  readonly createdWorkspaceNotesTotal: number;
  readonly executedRunsTotal: number;
  readonly failedRunsTotal: number;
  readonly retryAttemptsTotal: number;
  readonly deliveredRunsTotal: number;
  readonly stoppedAt?: string;
}

export interface INeonCronDaemonTickOutcome {
  readonly tick: INeonCronDaemonTickResult;
  readonly execution: INeonCronExecutionResult;
  readonly state: INeonCronDaemonLiveState;
}

export interface INeonCronDaemonService {
  start(): Promise<void>;
  stop(): Promise<void>;
  tickOnce(): Promise<INeonCronDaemonTickOutcome>;
  getState(): INeonCronDaemonLiveState;
}

export interface ICreateNeonCronDaemonServiceOptions {
  readonly projectRoot: string;
  readonly intervalMs: number;
  readonly gate?: INeonCronTimerGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly cursorPath?: string;
  readonly livePath?: string;
  readonly maxCatchupPerJob?: number;
  readonly unrefTimer?: boolean;
  readonly agentId?: string;
  readonly workspaceNotesGate?: INeonWorkspaceNotesGate;
  readonly agentRuntime?: INeonScheduledAgentRuntime;
  readonly snapshot?: INeonAutomationSnapshot;
  readonly writeRun?: (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;
}

export function resolveNeonCronDaemonLivePath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "cron-daemon-live.json");
}

export async function readNeonCronDaemonLiveState(
  livePath: string
): Promise<INeonCronDaemonLiveState | undefined> {
  try {
    const raw = await readFile(livePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeCronLiveState(parsed);
  } catch {
    return undefined;
  }
}

export async function writeNeonCronDaemonLiveState(
  livePath: string,
  state: INeonCronDaemonLiveState
): Promise<void> {
  await mkdir(dirname(livePath), { recursive: true });
  await writeFile(livePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function isNeonCronDaemonStale(
  state: INeonCronDaemonLiveState,
  nowMs: number,
  graceMs = 60_000
): boolean {
  if (!state.alive || !state.nextTickAt) {
    return false;
  }
  const nextMs = Date.parse(state.nextTickAt);
  if (Number.isNaN(nextMs)) {
    return false;
  }
  return nowMs > nextMs + Math.max(0, graceMs);
}

export function createNeonCronDaemonService(
  options: ICreateNeonCronDaemonServiceOptions
): INeonCronDaemonService {
  const now = options.now ?? (() => new Date());
  const intervalMs = Math.max(1, Math.floor(options.intervalMs));
  const cursorPath = options.cursorPath ?? resolveNeonCronDaemonCursorPath(options.projectRoot);
  const livePath = options.livePath ?? resolveNeonCronDaemonLivePath(options.projectRoot);
  const gate = options.gate ?? resolveNeonCronTimerGate(options.env ?? process.env);
  const workspaceNotesGate =
    options.workspaceNotesGate ?? resolveNeonWorkspaceNotesGate(options.env ?? process.env);

  let state: INeonCronDaemonLiveState = {
    version: 1,
    pid: process.pid,
    alive: false,
    gateEnabled: gate.enabled,
    intervalMs,
    startedAt: now().toISOString(),
    tickCount: 0,
    dueIntentsLastTick: 0,
    catchupIntentsLastTick: 0,
    createdRunsTotal: 0,
    createdWorkspaceNotesTotal: 0,
    executedRunsTotal: 0,
    failedRunsTotal: 0,
    retryAttemptsTotal: 0,
    deliveredRunsTotal: 0
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function tickOnce(): Promise<INeonCronDaemonTickOutcome> {
    const tickNow = now();
    const tick = await runNeonCronDaemonTick({
      cursorPath,
      gate,
      now: () => tickNow,
      ...(options.snapshot
        ? { snapshot: options.snapshot }
        : {
            createSnapshot: ({ now: snapshotNow, previousCursor }) =>
              createNeonCronStoreAutomationSnapshot(options.projectRoot, {
                generatedAt: snapshotNow,
                lastRunAtByJobId: previousCursor.emitted
              })
          }),
      ...(options.maxCatchupPerJob !== undefined ? { maxCatchupPerJob: options.maxCatchupPerJob } : {})
    });
    const jobs = options.agentRuntime?.gate.enabled
      ? projectNeonCronStoreJobs(await readNeonCronStoreEvents(options.projectRoot))
      : undefined;
    const execution = await executeNeonCronRunIntents({
      projectRoot: options.projectRoot,
      tick,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      workspaceNotesGate,
      ...(options.agentRuntime ? { agentRuntime: options.agentRuntime } : {}),
      ...(jobs ? { jobs } : {}),
      ...(options.writeRun ? { writeRun: options.writeRun } : {})
    });

    state = {
      ...state,
      lastTickAt: tick.tickAt,
      nextTickAt: new Date(tickNow.getTime() + intervalMs).toISOString(),
      tickCount: state.tickCount + 1,
      dueIntentsLastTick: tick.tick.emitted.length,
      catchupIntentsLastTick: tick.catchup.length,
      createdRunsTotal: state.createdRunsTotal + execution.createdRunCount,
      createdWorkspaceNotesTotal: state.createdWorkspaceNotesTotal + execution.createdWorkspaceNoteCount,
      executedRunsTotal: state.executedRunsTotal + execution.executedRunCount,
      failedRunsTotal: state.failedRunsTotal + execution.failedRunCount,
      retryAttemptsTotal: state.retryAttemptsTotal + execution.retryCount,
      deliveredRunsTotal: state.deliveredRunsTotal + execution.deliveredRunCount
    };
    await writeNeonCronDaemonLiveState(livePath, state);
    return { tick, execution, state };
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
    await writeNeonCronDaemonLiveState(livePath, state);

    timer = setInterval(() => {
      if (ticking) {
        return;
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
    await writeNeonCronDaemonLiveState(livePath, state);
  }

  function getState(): INeonCronDaemonLiveState {
    return state;
  }

  return { start, stop, tickOnce, getState };
}

function normalizeCronLiveState(value: unknown): INeonCronDaemonLiveState | undefined {
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
    catchupIntentsLastTick: toCount(record["catchupIntentsLastTick"]),
    createdRunsTotal: toCount(record["createdRunsTotal"]),
    createdWorkspaceNotesTotal: toCount(record["createdWorkspaceNotesTotal"]),
    executedRunsTotal: toCount(record["executedRunsTotal"]),
    failedRunsTotal: toCount(record["failedRunsTotal"]),
    retryAttemptsTotal: toCount(record["retryAttemptsTotal"]),
    deliveredRunsTotal: toCount(record["deliveredRunsTotal"]),
    ...(stoppedAt ? { stoppedAt } : {})
  };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
