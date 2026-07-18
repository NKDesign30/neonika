import { access } from "node:fs/promises";

import type { INeonAutomationJob } from "../automation/neonAutomation.js";
import { createNeonCronStoreAutomationSnapshot } from "../automation/cronStoreSnapshot.js";
import {
  resolveNeonCronTimerGate,
  type INeonCronTimerGate
} from "../automation/cronTimerRuntime.js";
import {
  readNeonCronDaemonCursor,
  resolveNeonCronDaemonCursorPath,
  type INeonCronDaemonCursor
} from "../automation/cronDaemonRuntime.js";
import {
  isNeonCronDaemonStale,
  readNeonCronDaemonLiveState,
  resolveNeonCronDaemonLivePath,
  type INeonCronDaemonLiveState
} from "../automation/cronDaemonService.js";

/**
 * Read-only Mission-Control panel for the cron daemon tick driver
 * (`automation/cronDaemonRuntime.ts`). Surfaces the daemon POSTURE an operator
 * needs to trust it: the `NEON_CRON_TIMER_ENABLED` gate, the persisted dedup
 * cursor (ticks / last tick / per-job last emitted window) read from its
 * isolated state file, the cron-job catalog with its scheduler state, and the
 * static shadow-safety invariants (never executes, never sends, never writes a
 * live run; autonomous ticks may write terminal shadow run-record markers).
 *
 * The snapshot builder is read-only: it reads the gate from env, the cursor
 * from disk (honest empty state when absent), and the automation catalog — it
 * never arms the gate, runs a tick, or writes anything. The panel renderer is
 * pure over that snapshot and contains no fabricated data; when no snapshot is
 * supplied the dashboard renders an explicit "not loaded" empty state.
 */
export interface INeonCronDaemonStatusJob {
  readonly id: string;
  readonly schedule: string;
  readonly intervalMinutes?: number;
  readonly state: INeonAutomationJob["state"];
  readonly nextRunAt?: string;
  readonly lastEmittedWindow?: string;
}

export interface INeonCronDaemonStatusSnapshot {
  readonly generatedAt: string;
  readonly gate: INeonCronTimerGate;
  readonly cursorPath: string;
  readonly cursorPresent: boolean;
  readonly cursor: INeonCronDaemonCursor;
  readonly jobs: readonly INeonCronDaemonStatusJob[];
  readonly daemon?: INeonCronDaemonLiveState;
  readonly daemonStale: boolean;
  readonly safety: {
    readonly agentExecuted: false;
    readonly outboundSent: false;
    readonly wroteLiveRun: false;
  };
}

export interface ICreateNeonCronDaemonStatusSnapshotOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export async function createNeonCronDaemonStatusSnapshot(
  projectRoot: string,
  options: ICreateNeonCronDaemonStatusSnapshotOptions = {}
): Promise<INeonCronDaemonStatusSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const gate = resolveNeonCronTimerGate(options.env ?? process.env);
  const cursorPath = resolveNeonCronDaemonCursorPath(projectRoot);
  const livePath = resolveNeonCronDaemonLivePath(projectRoot);
  const [cursorPresent, cursor, daemon] = await Promise.all([
    fileExists(cursorPath),
    readNeonCronDaemonCursor(cursorPath),
    readNeonCronDaemonLiveState(livePath)
  ]);
  const daemonStale = daemon ? isNeonCronDaemonStale(daemon, now.getTime()) : false;
  const automation = await createNeonCronStoreAutomationSnapshot(projectRoot, {
    generatedAt: now,
    lastRunAtByJobId: cursor.emitted
  });
  const jobs: INeonCronDaemonStatusJob[] = automation.jobs
    .filter((job) => job.kind === "cron")
    .map((job) => ({
      id: job.id,
      schedule: job.schedule,
      ...(job.intervalMinutes !== undefined ? { intervalMinutes: job.intervalMinutes } : {}),
      state: job.state,
      ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
      ...(cursor.emitted[job.id] ? { lastEmittedWindow: cursor.emitted[job.id] } : {})
    }));

  return {
    generatedAt: now.toISOString(),
    gate,
    cursorPath,
    cursorPresent,
    cursor,
    jobs,
    ...(daemon ? { daemon } : {}),
    daemonStale,
    safety: { agentExecuted: false, outboundSent: false, wroteLiveRun: false }
  };
}

export function renderNeonCronDaemonStatusReport(snapshot: INeonCronDaemonStatusSnapshot): string {
  const daemon = snapshot.daemon;
  const daemonLine = daemon
    ? `Daemon: ${daemon.alive ? (snapshot.daemonStale ? "alive (STALE — next tick overdue)" : "alive") : "stopped"} · daemonGate=${daemon.gateEnabled ? "armed" : "disabled"} · pid ${daemon.pid} · ticks ${daemon.tickCount} · lastTick ${daemon.lastTickAt ?? "none"} · nextTick ${daemon.nextTickAt ?? "none"} · dueIntents(lastTick) ${daemon.dueIntentsLastTick} · catchup(lastTick) ${daemon.catchupIntentsLastTick} · createdRuns ${daemon.createdRunsTotal} · workspaceNotes ${daemon.createdWorkspaceNotesTotal}`
    : "Daemon: not running (no liveness state)";
  const lines = [
    `Neonika Cron Daemon Status: view gate ${snapshot.gate.enabled ? "armed" : "disabled"} (${snapshot.gate.reason}, env ${snapshot.gate.envKey})`,
    daemonLine,
    `Cursor: ${snapshot.cursorPresent ? `present @ ${snapshot.cursorPath} (tick #${snapshot.cursor.ticks}${snapshot.cursor.lastTickAt ? `, last ${snapshot.cursor.lastTickAt}` : ""})` : `absent @ ${snapshot.cursorPath} (never ticked)`}`,
    `Safety: agentExecuted=${snapshot.safety.agentExecuted} outboundSent=${snapshot.safety.outboundSent} wroteLiveRun=${snapshot.safety.wroteLiveRun} (run-records are terminal shadow)`,
    "Cron jobs:"
  ];

  if (snapshot.jobs.length === 0) {
    lines.push("- none");
  }

  for (const job of snapshot.jobs) {
    lines.push(
      `- ${job.id}: ${job.state} / schedule=${job.schedule}${job.intervalMinutes !== undefined ? `(${job.intervalMinutes}m)` : ""} / last-emitted=${job.lastEmittedWindow ?? "none"}`
    );
  }

  return lines.join("\n");
}

export function renderNeonMissionControlCronDaemonStatusPanel(
  snapshot?: INeonCronDaemonStatusSnapshot
): string {
  if (!snapshot) {
    return `<article class="panel" id="cronDaemonPanel">
          <div class="panel-header">
            <h2 class="panel-title">Cron Daemon</h2>
            <span class="tag muted">not loaded</span>
          </div>
          <div class="panel-body stack">
            <div class="line muted">Cron daemon status is not loaded for this view.</div>
          </div>
        </article>`;
  }

  const gateTag = snapshot.gate.enabled
    ? '<span class="tag warn" id="cronDaemonGate">ARMED</span>'
    : '<span class="tag shadow" id="cronDaemonGate">shadow</span>';
  const cursorLine = snapshot.cursorPresent
    ? `present · tick #${snapshot.cursor.ticks}${snapshot.cursor.lastTickAt ? ` · last ${escapeCronDaemonHtml(snapshot.cursor.lastTickAt)}` : ""}`
    : "absent · never ticked";
  const daemon = snapshot.daemon;
  const daemonStateLabel = daemon
    ? daemon.alive
      ? snapshot.daemonStale
        ? "alive · STALE"
        : "alive"
      : "stopped"
    : "not running";
  const daemonTag = daemon && daemon.alive && !snapshot.daemonStale
    ? '<span class="tag ok" id="cronDaemonAlive">alive</span>'
    : daemon && snapshot.daemonStale
      ? '<span class="tag warn" id="cronDaemonAlive">stale</span>'
      : '<span class="tag muted" id="cronDaemonAlive">stopped</span>';
  const daemonLine = daemon
    ? `${daemonStateLabel} · daemonGate ${daemon.gateEnabled ? "armed" : "disabled"} · pid ${daemon.pid} · ticks ${daemon.tickCount} · lastTick ${escapeCronDaemonHtml(daemon.lastTickAt ?? "none")} · nextTick ${escapeCronDaemonHtml(daemon.nextTickAt ?? "none")} · due(lastTick) ${daemon.dueIntentsLastTick} · catchup(lastTick) ${daemon.catchupIntentsLastTick} · createdRuns ${daemon.createdRunsTotal} · workspaceNotes ${daemon.createdWorkspaceNotesTotal}`
    : "not running (no liveness state)";
  const jobRows =
    snapshot.jobs.length > 0
      ? snapshot.jobs
          .map((job) => {
            const stateTag =
              job.state === "ready"
                ? '<span class="tag ok">ready</span>'
                : '<span class="tag shadow">disabled</span>';
            return `<div class="line">${stateTag} <strong>${escapeCronDaemonHtml(
              job.id
            )}</strong> <span class="muted">${escapeCronDaemonHtml(job.schedule)}${
              job.intervalMinutes !== undefined ? ` (${job.intervalMinutes}m)` : ""
            }</span> last-emitted ${escapeCronDaemonHtml(job.lastEmittedWindow ?? "none")}</div>`;
          })
          .join("\n            ")
      : '<div class="line muted">No cron jobs in the catalog.</div>';

  return `<article class="panel" id="cronDaemonPanel">
          <div class="panel-header">
            <h2 class="panel-title">Cron Daemon</h2>
            ${gateTag}
            ${daemonTag}
          </div>
          <div class="panel-body stack">
            <div class="line"><strong>view gate</strong> <span class="muted">${escapeCronDaemonHtml(snapshot.gate.envKey)} · ${escapeCronDaemonHtml(snapshot.gate.reason)}</span></div>
            <div class="line"><strong>daemon</strong> <span id="cronDaemonLive">${daemonLine}</span></div>
            <div class="line"><strong>cursor</strong> <span id="cronDaemonCursor">${cursorLine}</span></div>
            <div class="line"><strong>safety</strong> <span class="muted">agentExecuted=${snapshot.safety.agentExecuted} · outboundSent=${snapshot.safety.outboundSent} · wroteLiveRun=${snapshot.safety.wroteLiveRun} · run-records terminal shadow</span></div>
            ${jobRows}
          </div>
        </article>`;
}

function escapeCronDaemonHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
