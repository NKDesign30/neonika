import { access } from "node:fs/promises";

import {
  resolveNeonHeartbeatTimerGate,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatTimerGate
} from "../automation/heartbeatTimerRuntime.js";
import {
  readNeonHeartbeatDaemonCursor,
  resolveNeonHeartbeatDaemonCursorPath,
  type INeonHeartbeatDaemonCursor
} from "../automation/heartbeatDaemonRuntime.js";
import {
  isNeonHeartbeatDaemonStale,
  readNeonHeartbeatDaemonLiveState,
  resolveNeonHeartbeatDaemonLivePath,
  type INeonHeartbeatDaemonLiveState
} from "../automation/heartbeatDaemonService.js";

/**
 * Read-only Mission-Control panel for the heartbeat daemon tick driver
 * (`automation/heartbeatDaemonRuntime.ts`). Surfaces the POSTURE an operator
 * needs to trust it: the `NEON_HEARTBEAT_TIMER_ENABLED` gate, the persisted
 * dedup cursor (ticks / last tick / per-agent last emitted window) read from
 * its isolated state file, the known agents, and the static shadow-safety
 * invariants (never executes, never sends, never writes the run store).
 *
 * No fabricated state: heartbeat agents come from runtime config, not a static
 * catalog, so the panel derives its agent rows from the supplied agent list or,
 * when none is given, from the cursor's emitted keys (the agents that have
 * actually ticked). An absent cursor renders an honest "never ticked" state.
 */
export interface INeonHeartbeatDaemonStatusAgent {
  readonly agentId: string;
  readonly intervalMs?: number;
  readonly lastEmittedWindow?: string;
}

export interface INeonHeartbeatDaemonStatusSnapshot {
  readonly generatedAt: string;
  readonly gate: INeonHeartbeatTimerGate;
  readonly cursorPath: string;
  readonly cursorPresent: boolean;
  readonly cursor: INeonHeartbeatDaemonCursor;
  readonly agents: readonly INeonHeartbeatDaemonStatusAgent[];
  /** Liveness of the running daemon loop (absent when the daemon never ran). */
  readonly daemon?: INeonHeartbeatDaemonLiveState;
  /** True when the daemon claims alive but its next tick is overdue (crashed). */
  readonly daemonStale: boolean;
  /**
   * Daemon-level shadow invariants (always literal false). The autonomous
   * heartbeat daemon DOES write terminal shadow run-records (see `createdRuns`),
   * so a `wroteRunStore` claim would be misleading. What actually holds is: no
   * agent harness turn runs (records are terminal wake markers), outbound is
   * suppressed, and a live/in-flight run is never written.
   */
  readonly safety: {
    readonly agentExecuted: false;
    readonly outboundSent: false;
    readonly wroteLiveRun: false;
  };
}

export interface ICreateNeonHeartbeatDaemonStatusSnapshotOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly agents?: readonly INeonHeartbeatAgentState[];
}

export async function createNeonHeartbeatDaemonStatusSnapshot(
  projectRoot: string,
  options: ICreateNeonHeartbeatDaemonStatusSnapshotOptions = {}
): Promise<INeonHeartbeatDaemonStatusSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const gate = resolveNeonHeartbeatTimerGate(options.env ?? process.env);
  const cursorPath = resolveNeonHeartbeatDaemonCursorPath(projectRoot);
  const livePath = resolveNeonHeartbeatDaemonLivePath(projectRoot);
  const [cursorPresent, cursor, daemon] = await Promise.all([
    fileExists(cursorPath),
    readNeonHeartbeatDaemonCursor(cursorPath),
    readNeonHeartbeatDaemonLiveState(livePath)
  ]);
  const daemonStale = daemon ? isNeonHeartbeatDaemonStale(daemon, now.getTime()) : false;

  const agents: INeonHeartbeatDaemonStatusAgent[] = options.agents
    ? options.agents.map((agent) => ({
        agentId: agent.agentId,
        intervalMs: agent.intervalMs,
        ...(cursor.emitted[agent.agentId] ? { lastEmittedWindow: cursor.emitted[agent.agentId] } : {})
      }))
    : Object.keys(cursor.emitted)
        .sort()
        .map((agentId) => {
          const lastEmittedWindow = cursor.emitted[agentId];
          return {
            agentId,
            ...(lastEmittedWindow ? { lastEmittedWindow } : {})
          };
        });

  return {
    generatedAt: now.toISOString(),
    gate,
    cursorPath,
    cursorPresent,
    cursor,
    agents,
    ...(daemon ? { daemon } : {}),
    daemonStale,
    safety: { agentExecuted: false, outboundSent: false, wroteLiveRun: false }
  };
}

export function renderNeonHeartbeatDaemonStatusReport(
  snapshot: INeonHeartbeatDaemonStatusSnapshot
): string {
  const daemon = snapshot.daemon;
  const daemonLine = daemon
    ? `Daemon: ${daemon.alive ? (snapshot.daemonStale ? "alive (STALE — next tick overdue)" : "alive") : "stopped"} · daemonGate=${daemon.gateEnabled ? "armed" : "disabled"} · pid ${daemon.pid} · ticks ${daemon.tickCount} · lastTick ${daemon.lastTickAt ?? "none"} · nextTick ${daemon.nextTickAt ?? "none"} · dueIntents(lastTick) ${daemon.dueIntentsLastTick} · dueCommitments(lastTick) ${daemon.dueCommitmentsLastTick} · lifecycleCommitments(lastTick) ${daemon.lifecycleCommitmentsLastTick} · createdRuns ${daemon.createdRunsTotal}`
    : "Daemon: not running (no liveness state)";
  const lines = [
    `Neon Heartbeat Daemon Status: view gate ${snapshot.gate.enabled ? "armed" : "disabled"} (${snapshot.gate.reason}, env ${snapshot.gate.envKey})`,
    daemonLine,
    `Cursor: ${snapshot.cursorPresent ? `present @ ${snapshot.cursorPath} (tick #${snapshot.cursor.ticks}${snapshot.cursor.lastTickAt ? `, last ${snapshot.cursor.lastTickAt}` : ""})` : `absent @ ${snapshot.cursorPath} (never ticked)`}`,
    `Safety: agentExecuted=${snapshot.safety.agentExecuted} outboundSent=${snapshot.safety.outboundSent} wroteLiveRun=${snapshot.safety.wroteLiveRun} (run-records are terminal shadow)`,
    "Agents:"
  ];

  if (snapshot.agents.length === 0) {
    lines.push("- none");
  }

  for (const agent of snapshot.agents) {
    lines.push(
      `- ${agent.agentId}:${agent.intervalMs !== undefined ? ` interval=${agent.intervalMs}ms` : ""} last-emitted=${agent.lastEmittedWindow ?? "none"}`
    );
  }

  return lines.join("\n");
}

export function renderNeonMissionControlHeartbeatDaemonStatusPanel(
  snapshot?: INeonHeartbeatDaemonStatusSnapshot
): string {
  if (!snapshot) {
    return `<article class="panel" id="heartbeatDaemonPanel">
          <div class="panel-header">
            <h2 class="panel-title">Heartbeat Daemon</h2>
            <span class="tag muted">not loaded</span>
          </div>
          <div class="panel-body stack">
            <div class="line muted">Heartbeat daemon status is not loaded for this view.</div>
          </div>
        </article>`;
  }

  const gateTag = snapshot.gate.enabled
    ? '<span class="tag warn" id="heartbeatDaemonGate">ARMED</span>'
    : '<span class="tag shadow" id="heartbeatDaemonGate">shadow</span>';
  const cursorLine = snapshot.cursorPresent
    ? `present · tick #${snapshot.cursor.ticks}${snapshot.cursor.lastTickAt ? ` · last ${escapeHeartbeatDaemonHtml(snapshot.cursor.lastTickAt)}` : ""}`
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
    ? '<span class="tag ok" id="heartbeatDaemonAlive">alive</span>'
    : daemon && snapshot.daemonStale
      ? '<span class="tag warn" id="heartbeatDaemonAlive">stale</span>'
      : '<span class="tag muted" id="heartbeatDaemonAlive">stopped</span>';
  const daemonLine = daemon
    ? `${daemonStateLabel} · daemonGate ${daemon.gateEnabled ? "armed" : "disabled"} · pid ${daemon.pid} · ticks ${daemon.tickCount} · lastTick ${escapeHeartbeatDaemonHtml(daemon.lastTickAt ?? "none")} · nextTick ${escapeHeartbeatDaemonHtml(daemon.nextTickAt ?? "none")} · due(lastTick) ${daemon.dueIntentsLastTick} · commitments(lastTick) ${daemon.dueCommitmentsLastTick} · lifecycleCommitments(lastTick) ${daemon.lifecycleCommitmentsLastTick} · createdRuns ${daemon.createdRunsTotal}`
    : "not running (no liveness state)";
  const agentRows =
    snapshot.agents.length > 0
      ? snapshot.agents
          .map((agent) => {
            const intervalLabel =
              agent.intervalMs !== undefined ? ` <span class="muted">${agent.intervalMs}ms</span>` : "";
            return `<div class="line"><strong>${escapeHeartbeatDaemonHtml(
              agent.agentId
            )}</strong>${intervalLabel} last-emitted ${escapeHeartbeatDaemonHtml(
              agent.lastEmittedWindow ?? "none"
            )}</div>`;
          })
          .join("\n            ")
      : '<div class="line muted">No heartbeat agents have ticked yet.</div>';

  return `<article class="panel" id="heartbeatDaemonPanel">
          <div class="panel-header">
            <h2 class="panel-title">Heartbeat Daemon</h2>
            ${gateTag}
            ${daemonTag}
          </div>
          <div class="panel-body stack">
            <div class="line"><strong>view gate</strong> <span class="muted">${escapeHeartbeatDaemonHtml(snapshot.gate.envKey)} · ${escapeHeartbeatDaemonHtml(snapshot.gate.reason)}</span></div>
            <div class="line"><strong>daemon</strong> <span id="heartbeatDaemonLive">${daemonLine}</span></div>
            <div class="line"><strong>cursor</strong> <span id="heartbeatDaemonCursor">${cursorLine}</span></div>
            <div class="line"><strong>safety</strong> <span class="muted">agentExecuted=${snapshot.safety.agentExecuted} · outboundSent=${snapshot.safety.outboundSent} · wroteLiveRun=${snapshot.safety.wroteLiveRun} · run-records terminal shadow</span></div>
            ${agentRows}
          </div>
        </article>`;
}

function escapeHeartbeatDaemonHtml(value: string): string {
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
