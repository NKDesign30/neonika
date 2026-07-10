import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  evaluateNeonHeartbeatTick,
  resolveNeonHeartbeatTimerGate,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatCommitmentWakeInput,
  type INeonHeartbeatTickResult,
  type INeonHeartbeatTimerGate
} from "./heartbeatTimerRuntime.js";

/**
 * Heartbeat daemon tick driver (gated, default-off).
 *
 * Mirrors `cronDaemonRuntime` exactly. Upstream's heartbeat scheduler arms a
 * recursive `setTimeout` (`src/infra/heartbeat-runner.ts` `startHeartbeatRunner`/
 * `scheduleNext`) and keeps per-agent `nextDueMs` in memory. Neon Core stops
 * short of execution and replaces the live timer with a deterministic,
 * restart-safe driver around the pure `evaluateNeonHeartbeatTick`:
 *  1. A PERSISTED dedup cursor (`agentId -> last emitted phase window`) in an
 *     isolated state file — the no-execution analog of the in-memory schedule.
 *  2. BOUNDED catch-up: phase windows between the cursor and the current window
 *     are back-filled as wake intents, capped at `maxCatchupPerJob` (oldest
 *     dropped, counted, never silent).
 *  3. DEFAULT-OFF: without a ready `NEON_HEARTBEAT_TIMER_ENABLED` gate the tick
 *     does nothing — no emission, no catch-up, and no cursor write.
 *
 * intentionally-different vs upstream: nothing is executed, no run record /
 * delivery / prompt is produced, no real wall-clock timer is armed (the clock is
 * injected). Wiring the emitted intents into a real run lifecycle stays a
 * primary-cutover decision behind DP-4.
 */
export interface INeonHeartbeatDaemonCursor {
  readonly version: 1;
  readonly emitted: Readonly<Record<string, string>>;
  readonly lastTickAt?: string;
  readonly ticks: number;
}

export interface INeonHeartbeatCatchupEmission {
  readonly agentId: string;
  readonly window: string;
}

export interface INeonHeartbeatDaemonTickResult {
  readonly armed: boolean;
  readonly gate: INeonHeartbeatTimerGate;
  readonly tickAt: string;
  readonly tick: INeonHeartbeatTickResult;
  readonly catchup: readonly INeonHeartbeatCatchupEmission[];
  readonly catchupTruncated: number;
  readonly cursor: INeonHeartbeatDaemonCursor;
  readonly cursorPath: string;
  readonly cursorPersisted: boolean;
  readonly safety: {
    readonly executed: false;
    readonly outboundSent: false;
    readonly wroteRunStore: false;
    readonly cursorOnlyWrite: boolean;
  };
  readonly diagnostics: readonly string[];
}

export interface IRunNeonHeartbeatDaemonTickOptions {
  readonly cursorPath: string;
  readonly schedulerSeed: string;
  readonly agents: readonly INeonHeartbeatAgentState[];
  readonly commitmentWakes?: readonly INeonHeartbeatCommitmentWakeInput[];
  readonly gate?: INeonHeartbeatTimerGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly maxCatchupPerJob?: number;
  readonly minSpacingMs?: number;
  readonly floodWindowMs?: number;
  readonly floodThreshold?: number;
}

const defaultMaxCatchupPerJob = 5;
const emptyCursor: INeonHeartbeatDaemonCursor = { version: 1, emitted: {}, ticks: 0 };

export function resolveNeonHeartbeatDaemonCursorPath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "heartbeat-daemon-cursor.json");
}

export async function readNeonHeartbeatDaemonCursor(
  cursorPath: string
): Promise<INeonHeartbeatDaemonCursor> {
  try {
    const raw = await readFile(cursorPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeCursor(parsed);
  } catch {
    return emptyCursor;
  }
}

export async function writeNeonHeartbeatDaemonCursor(
  cursorPath: string,
  cursor: INeonHeartbeatDaemonCursor
): Promise<void> {
  await mkdir(dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}

export async function runNeonHeartbeatDaemonTick(
  options: IRunNeonHeartbeatDaemonTickOptions
): Promise<INeonHeartbeatDaemonTickResult> {
  const now = (options.now ?? (() => new Date()))();
  const tickAt = now.toISOString();
  const gate = options.gate ?? resolveNeonHeartbeatTimerGate(options.env ?? process.env);
  const previousCursor = await readNeonHeartbeatDaemonCursor(options.cursorPath);
  const maxCatchupPerJob = Math.max(0, options.maxCatchupPerJob ?? defaultMaxCatchupPerJob);

  const tick = evaluateNeonHeartbeatTick({
    gate,
    schedulerSeed: options.schedulerSeed,
    agents: options.agents,
    ...(options.commitmentWakes ? { commitmentWakes: options.commitmentWakes } : {}),
    now: () => now,
    alreadyEmitted: previousCursor.emitted,
    ...(options.minSpacingMs !== undefined ? { minSpacingMs: options.minSpacingMs } : {}),
    ...(options.floodWindowMs !== undefined ? { floodWindowMs: options.floodWindowMs } : {}),
    ...(options.floodThreshold !== undefined ? { floodThreshold: options.floodThreshold } : {})
  });

  if (!gate.enabled) {
    // Default-off: no emission, no catch-up, and no cursor write at all.
    return {
      armed: false,
      gate,
      tickAt,
      tick,
      catchup: [],
      catchupTruncated: 0,
      cursor: previousCursor,
      cursorPath: options.cursorPath,
      cursorPersisted: false,
      safety: { executed: false, outboundSent: false, wroteRunStore: false, cursorOnlyWrite: false },
      diagnostics: [
        "Heartbeat daemon tick is disabled (default). No intent emitted, no catch-up, no cursor write.",
        "Set NEON_HEARTBEAT_TIMER_ENABLED to arm read-only wake-intent evaluation; starting a run stays gated (DP-4)."
      ]
    };
  }

  const agentsById = new Map(options.agents.map((agent) => [agent.agentId, agent]));
  const catchup: INeonHeartbeatCatchupEmission[] = [];
  let catchupTruncated = 0;

  for (const agentId of tick.emitted) {
    const agent = agentsById.get(agentId);
    const currentWindow = tick.nextEmitted[agentId];
    if (!agent || !currentWindow) {
      continue;
    }

    const backfill = computeCatchupWindows({
      intervalMs: agent.intervalMs,
      currentWindow,
      ...(previousCursor.emitted[agentId] ? { lastEmittedWindow: previousCursor.emitted[agentId] } : {}),
      maxCatchupPerJob
    });
    catchupTruncated += backfill.skipped;
    for (const window of backfill.windows) {
      catchup.push({ agentId, window });
    }
  }

  const cursor: INeonHeartbeatDaemonCursor = {
    version: 1,
    emitted: tick.nextEmitted,
    lastTickAt: tickAt,
    ticks: previousCursor.ticks + 1
  };

  await writeNeonHeartbeatDaemonCursor(options.cursorPath, cursor);

  const diagnostics = [
    `Heartbeat daemon tick armed: ${tick.emitted.length} current window(s), ${catchup.length} catch-up window(s) back-filled, ${tick.deferred.length} deferred, ${tick.deduped.length} deduped.`,
    "Wake intents only; nothing executed, no run store / activity / outbound write. Cursor persisted to isolated state file."
  ];
  if (catchupTruncated > 0) {
    diagnostics.push(
      `Catch-up bounded: ${catchupTruncated} older missed window(s) dropped beyond maxCatchupPerJob=${maxCatchupPerJob}.`
    );
  }

  return {
    armed: true,
    gate,
    tickAt,
    tick,
    catchup,
    catchupTruncated,
    cursor,
    cursorPath: options.cursorPath,
    cursorPersisted: true,
    safety: { executed: false, outboundSent: false, wroteRunStore: false, cursorOnlyWrite: true },
    diagnostics
  };
}

export function renderNeonHeartbeatDaemonTickReport(result: INeonHeartbeatDaemonTickResult): string {
  const lines = [
    `Neon Heartbeat Daemon Tick: ${result.armed ? "armed" : "disabled"} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Tick at: ${result.tickAt}`,
    `Current windows: ${result.tick.emitted.length}${result.tick.emitted.length ? ` (${result.tick.emitted.join(", ")})` : ""}`,
    `Catch-up windows: ${result.catchup.length}${result.catchupTruncated ? ` (+${result.catchupTruncated} dropped, bounded)` : ""}`,
    `Deferred: ${result.tick.deferred.length}`,
    `Deduped: ${result.tick.deduped.length}`,
    `Cursor: ${result.cursorPersisted ? `persisted -> ${result.cursorPath} (tick #${result.cursor.ticks})` : "not written (gate closed)"}`,
    `Safety: executed=${result.safety.executed} outboundSent=${result.safety.outboundSent} wroteRunStore=${result.safety.wroteRunStore} cursorOnlyWrite=${result.safety.cursorOnlyWrite}`
  ];

  for (const emission of result.catchup) {
    lines.push(`- catch-up ${emission.agentId} @ ${emission.window}`);
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}

/**
 * Back-fill the phase windows strictly BETWEEN the cursor's last emitted window
 * and the current window (which `evaluateNeonHeartbeatTick` already emitted).
 * Bounded: at most `maxCatchupPerJob` windows are kept (the most recent), older
 * ones dropped and counted so the daemon never falls endlessly behind. A missing
 * cursor or non-finite window produces no back-fill.
 */
function computeCatchupWindows(params: {
  readonly intervalMs: number;
  readonly currentWindow: string;
  readonly lastEmittedWindow?: string;
  readonly maxCatchupPerJob: number;
}): { readonly windows: readonly string[]; readonly skipped: number } {
  if (!params.lastEmittedWindow) {
    return { windows: [], skipped: 0 };
  }
  const stepMs = resolvePositiveInterval(params.intervalMs);
  const currentMs = Date.parse(params.currentWindow);
  const lastMs = Date.parse(params.lastEmittedWindow);
  if (Number.isNaN(currentMs) || Number.isNaN(lastMs) || currentMs <= lastMs) {
    return { windows: [], skipped: 0 };
  }

  // Windows in (lastMs, currentMs), newest first, walking back from current.
  const missedNewestFirst: string[] = [];
  for (let windowMs = currentMs - stepMs; windowMs > lastMs; windowMs -= stepMs) {
    missedNewestFirst.push(new Date(windowMs).toISOString());
  }

  if (params.maxCatchupPerJob === 0) {
    return { windows: [], skipped: missedNewestFirst.length };
  }

  const kept = missedNewestFirst.slice(0, params.maxCatchupPerJob);
  const skipped = missedNewestFirst.length - kept.length;
  // Emit oldest-first so consumers see chronological catch-up order.
  return { windows: kept.reverse(), skipped };
}

function resolvePositiveInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : 1;
}

function normalizeCursor(value: unknown): INeonHeartbeatDaemonCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyCursor;
  }
  const record = value as Record<string, unknown>;
  const emittedRaw = record["emitted"];
  const emitted: Record<string, string> = {};
  if (typeof emittedRaw === "object" && emittedRaw !== null && !Array.isArray(emittedRaw)) {
    for (const [key, windowValue] of Object.entries(emittedRaw as Record<string, unknown>)) {
      if (typeof windowValue === "string" && windowValue.length > 0) {
        emitted[key] = windowValue;
      }
    }
  }
  const ticksRaw = record["ticks"];
  const ticks =
    typeof ticksRaw === "number" && Number.isInteger(ticksRaw) && ticksRaw >= 0 ? ticksRaw : 0;
  const lastTickAt = typeof record["lastTickAt"] === "string" ? record["lastTickAt"] : undefined;

  return {
    version: 1,
    emitted,
    ...(lastTickAt ? { lastTickAt } : {}),
    ticks
  };
}
