import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  evaluateNeonCronTick,
  resolveNeonCronTimerGate,
  type INeonCronTickResult,
  type INeonCronTimerGate
} from "./cronTimerRuntime.js";
import {
  createNeonAutomationSnapshot,
  type INeonAutomationJob,
  type INeonAutomationSnapshot
} from "./neonAutomation.js";

/**
 * Cron daemon tick driver (DP-8, runtime slice).
 *
 * Upstream's scheduler arms a real timer and executes agent runs:
 * `src/cron/service/timer.ts` (`armTimer`/`onTimer` setTimeout loop,
 * `runMissedJobs` catch-up, `executeJobCoreWithTimeout`), guarded by
 * `src/cron/active-jobs.ts` (`markCronJobActive`/`isCronJobActive` — an
 * in-flight job-id Set that prevents duplicate timers) and rearmed via
 * `computeNextRunAtMs` (`src/cron/schedule.ts`).
 *
 * Neon Core stops short of execution. This driver wraps the pure
 * `evaluateNeonCronTick` with three things upstream's runtime needs but Neon
 * keeps shadow-safe:
 *  1. A PERSISTED dedup cursor (`jobId -> last emitted due-window`) in an
 *     isolated state file — the no-execution, restart-safe analog of the
 *     active-jobs Set. It is never the run store; nothing in runs/activity is
 *     touched here.
 *  2. BOUNDED catch-up: when the daemon was down across several interval
 *     windows, the windows BETWEEN the cursor and the current window are
 *     back-filled as run intents, capped at `maxCatchupPerJob` (oldest dropped,
 *     logged — never silently). This is the bounded analog of `runMissedJobs`.
 *  3. DEFAULT-OFF: without a ready `NEON_CRON_TIMER_ENABLED` gate the tick does
 *     nothing — no emission, no catch-up, and (critically) no cursor write.
 *
 * intentionally-different vs upstream: nothing is executed, no run record /
 * delivery / workspace side effect is produced, no real wall-clock timer is
 * armed here (the clock is injected so the driver is deterministic). Wiring the
 * emitted intents into the run store / activity stream is a separate slice and
 * stays a primary-cutover decision behind the run-lifecycle gate (DP-4).
 */
export interface INeonCronDaemonCursor {
  readonly version: 1;
  readonly emitted: Readonly<Record<string, string>>;
  readonly lastTickAt?: string;
  readonly ticks: number;
}

export interface INeonCronCatchupEmission {
  readonly jobId: string;
  readonly window: string;
}

export interface INeonCronDaemonTickResult {
  readonly armed: boolean;
  readonly gate: INeonCronTimerGate;
  readonly tickAt: string;
  readonly tick: INeonCronTickResult;
  readonly catchup: readonly INeonCronCatchupEmission[];
  readonly catchupTruncated: number;
  readonly cursor: INeonCronDaemonCursor;
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

export interface INeonCronDaemonSnapshotFactoryInput {
  readonly now: Date;
  readonly previousCursor: INeonCronDaemonCursor;
}

export interface IRunNeonCronDaemonTickOptions {
  readonly cursorPath: string;
  readonly gate?: INeonCronTimerGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly snapshot?: INeonAutomationSnapshot;
  readonly createSnapshot?: (
    input: INeonCronDaemonSnapshotFactoryInput
  ) => INeonAutomationSnapshot | Promise<INeonAutomationSnapshot>;
  readonly forceJobIds?: readonly string[];
  readonly maxCatchupPerJob?: number;
}

const defaultMaxCatchupPerJob = 5;
const emptyCursor: INeonCronDaemonCursor = { version: 1, emitted: {}, ticks: 0 };

export function resolveNeonCronDaemonCursorPath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "cron-daemon-cursor.json");
}

export async function readNeonCronDaemonCursor(cursorPath: string): Promise<INeonCronDaemonCursor> {
  try {
    const raw = await readFile(cursorPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeCursor(parsed);
  } catch {
    return emptyCursor;
  }
}

export async function writeNeonCronDaemonCursor(
  cursorPath: string,
  cursor: INeonCronDaemonCursor
): Promise<void> {
  await mkdir(dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}

export async function runNeonCronDaemonTick(
  options: IRunNeonCronDaemonTickOptions
): Promise<INeonCronDaemonTickResult> {
  const now = (options.now ?? (() => new Date()))();
  const tickAt = now.toISOString();
  const gate = options.gate ?? resolveNeonCronTimerGate(options.env ?? process.env);
  const previousCursor = await readNeonCronDaemonCursor(options.cursorPath);
  const snapshot =
    options.snapshot ??
    (options.createSnapshot
      ? await options.createSnapshot({ now, previousCursor })
      : createNeonAutomationSnapshot({ generatedAt: now, lastRunAtByJobId: previousCursor.emitted }));
  const maxCatchupPerJob = Math.max(0, options.maxCatchupPerJob ?? defaultMaxCatchupPerJob);

  const tick = evaluateNeonCronTick({
    gate,
    snapshot,
    now: () => now,
    alreadyEmitted: previousCursor.emitted,
    ...(options.forceJobIds ? { forceJobIds: options.forceJobIds } : {})
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
        "Cron daemon tick is disabled (default). No intent emitted, no catch-up, no cursor write.",
        "Set NEON_CRON_TIMER_ENABLED to arm read-only run-intent evaluation; execution stays gated (DP-4)."
      ]
    };
  }

  const cronJobsById = new Map(
    snapshot.jobs.filter((job) => job.kind === "cron").map((job) => [job.id, job])
  );
  const catchup: INeonCronCatchupEmission[] = [];
  let catchupTruncated = 0;

  for (const jobId of tick.emitted) {
    const job = cronJobsById.get(jobId);
    const currentWindow = tick.nextEmitted[jobId];
    if (!job || !currentWindow) {
      continue;
    }

    const backfill = computeCatchupWindows({
      job,
      currentWindow,
      ...(previousCursor.emitted[jobId] ? { lastEmittedWindow: previousCursor.emitted[jobId] } : {}),
      maxCatchupPerJob
    });
    catchupTruncated += backfill.skipped;
    for (const window of backfill.windows) {
      catchup.push({ jobId, window });
    }
  }

  const cursor: INeonCronDaemonCursor = {
    version: 1,
    emitted: tick.nextEmitted,
    lastTickAt: tickAt,
    ticks: previousCursor.ticks + 1
  };

  await writeNeonCronDaemonCursor(options.cursorPath, cursor);

  const diagnostics = [
    `Cron daemon tick armed: ${tick.emitted.length} current window(s), ${catchup.length} catch-up window(s) back-filled, ${tick.deduped.length} deduped.`,
    "Run intents only; nothing executed, no run store / activity / outbound write. Cursor persisted to isolated state file."
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

export function renderNeonCronDaemonTickReport(result: INeonCronDaemonTickResult): string {
  const lines = [
    `Neon Cron Daemon Tick: ${result.armed ? "armed" : "disabled"} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Tick at: ${result.tickAt}`,
    `Current windows: ${result.tick.emitted.length}${result.tick.emitted.length ? ` (${result.tick.emitted.join(", ")})` : ""}`,
    `Catch-up windows: ${result.catchup.length}${result.catchupTruncated ? ` (+${result.catchupTruncated} dropped, bounded)` : ""}`,
    `Deduped: ${result.tick.deduped.length}`,
    `Cursor: ${result.cursorPersisted ? `persisted -> ${result.cursorPath} (tick #${result.cursor.ticks})` : "not written (gate closed)"}`,
    `Safety: executed=${result.safety.executed} outboundSent=${result.safety.outboundSent} wroteRunStore=${result.safety.wroteRunStore} cursorOnlyWrite=${result.safety.cursorOnlyWrite}`
  ];

  for (const emission of result.catchup) {
    lines.push(`- catch-up ${emission.jobId} @ ${emission.window}`);
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}

/**
 * Back-fill the interval windows strictly BETWEEN the cursor's last emitted
 * window and the current window (which `evaluateNeonCronTick` already emitted).
 * Bounded: at most `maxCatchupPerJob` windows are kept (the most recent),
 * older ones are dropped and counted so the daemon never falls endlessly behind.
 * Non-interval jobs and a missing cursor produce no back-fill (nothing to catch up).
 */
function computeCatchupWindows(params: {
  readonly job: INeonAutomationJob;
  readonly currentWindow: string;
  readonly lastEmittedWindow?: string;
  readonly maxCatchupPerJob: number;
}): { readonly windows: readonly string[]; readonly skipped: number } {
  const intervalMinutes = params.job.intervalMinutes;
  if (intervalMinutes === undefined || intervalMinutes <= 0 || !params.lastEmittedWindow) {
    return { windows: [], skipped: 0 };
  }

  const stepMs = intervalMinutes * 60_000;
  const currentMs = Date.parse(params.currentWindow);
  const lastMs = Date.parse(params.lastEmittedWindow);
  if (Number.isNaN(currentMs) || Number.isNaN(lastMs) || currentMs <= lastMs) {
    return { windows: [], skipped: 0 };
  }

  // Windows in (lastMs, currentMs), newest first, walking back from the current window.
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

function normalizeCursor(value: unknown): INeonCronDaemonCursor {
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
