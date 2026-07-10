import { writeNeonGatewayRun } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import type { INeonHeartbeatWakeEmission } from "./heartbeatTimerRuntime.js";

/**
 * Heartbeat run executor (shadow).
 *
 * Translates the read-only `INeonHeartbeatWakeEmission`s a daemon tick produced
 * into real, terminal run-store records so an autonomous heartbeat becomes
 * visible in Mission Control (chat/replay/activity/run projections) WITHOUT
 * breaking the shadow contract:
 *  - every record is `mode: "shadow"`, `status: "completed"` (terminal-only),
 *  - `delivery.state` is hard-coded `"suppressed"` — nothing is ever sent,
 *  - no harness is invoked, no LLM call, no outbound; the record documents that
 *    the heartbeat WOULD wake the agent at that phase window.
 *
 * The literal-typed safety flags (`outboundSent: false`, `sentDiscord: false`)
 * make it a compile-time guarantee that this executor never delivers. Flipping
 * to a real agent run + real send stays a canary-cutover decision (DP-4),
 * unchanged by this slice.
 */
export interface INeonHeartbeatExecutionResult {
  readonly createdRunIds: readonly string[];
  readonly createdRunCount: number;
  readonly safety: {
    readonly outboundSent: false;
    readonly sentDiscord: false;
    readonly wroteRunStore: boolean;
  };
  readonly diagnostics: readonly string[];
}

export interface IExecuteNeonHeartbeatWakeIntentsOptions {
  readonly projectRoot: string;
  readonly emissions: readonly INeonHeartbeatWakeEmission[];
  readonly tickAt: string;
  /** Injectable writer for tests; defaults to the real gateway run store. */
  readonly writeRun?: (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;
}

const heartbeatRunChannel = "cli" as const;
const heartbeatRunChannelId = "heartbeat-wake";

/**
 * Pure builder: a terminal shadow run-record for one heartbeat wake emission.
 * runId is deterministic (`heartbeat-<agentId>-<windowKey>`) so re-running the
 * same window is idempotent if a latest-writer is used. Outbound is suppressed
 * by construction.
 */
export function buildNeonHeartbeatWakeRun(params: {
  readonly projectRoot: string;
  readonly emission: INeonHeartbeatWakeEmission;
  readonly tickAt: string;
}): INeonGatewayShadowRun {
  const { emission } = params;
  const commitmentLabel = emission.commitmentIds?.length
    ? `, commitments=${emission.commitmentIds.join(",")}`
    : "";
  return {
    runId: `heartbeat-${emission.cursorKey ?? emission.agentId}-${emission.windowKey}`,
    mode: "shadow",
    status: "completed",
    request: {
      channel: heartbeatRunChannel,
      accountId: "heartbeat",
      channelId: heartbeatRunChannelId,
      userId: "system",
      agentId: emission.agentId,
      workspaceRoot: params.projectRoot,
      mode: "read-only",
      goal: "heartbeat wake",
      contentPreview: `heartbeat wake (${emission.source}/${emission.intent}, ${emission.reason}${commitmentLabel})`,
      receivedAt: params.tickAt
    },
    harnessId: "claude-cli",
    harnessSessionKey: `heartbeat:${emission.agentId}`,
    memoryState: "skipped",
    events: [],
    finalText: "",
    delivery: {
      state: "suppressed",
      targetChannel: heartbeatRunChannel,
      targetChannelId: heartbeatRunChannelId,
      reason: "heartbeat shadow wake — outbound suppressed",
      finalText: ""
    },
    startedAt: emission.windowKey,
    completedAt: params.tickAt
  };
}

/**
 * Write one terminal shadow run-record per wake emission to the gateway run
 * store. No emissions => no write (honest, gate-closed ticks produce none).
 * Outbound stays suppressed on every record.
 */
export async function executeNeonHeartbeatWakeIntents(
  options: IExecuteNeonHeartbeatWakeIntentsOptions
): Promise<INeonHeartbeatExecutionResult> {
  const writeRun = options.writeRun ?? writeNeonGatewayRun;
  const createdRunIds: string[] = [];

  for (const emission of options.emissions) {
    const run = buildNeonHeartbeatWakeRun({
      projectRoot: options.projectRoot,
      emission,
      tickAt: options.tickAt
    });
    await writeRun(options.projectRoot, run);
    createdRunIds.push(run.runId);
  }

  const wroteRunStore = createdRunIds.length > 0;
  return {
    createdRunIds,
    createdRunCount: createdRunIds.length,
    safety: { outboundSent: false, sentDiscord: false, wroteRunStore },
    diagnostics: [
      wroteRunStore
        ? `Wrote ${createdRunIds.length} terminal shadow heartbeat run-record(s); delivery suppressed on every record.`
        : "No wake emissions to execute; no run-store write."
    ]
  };
}
