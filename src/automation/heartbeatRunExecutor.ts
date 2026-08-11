import type { INeonChannelRouteRef } from "../channels/routeProjection.js";
import { writeNeonGatewayRunLatest } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import type { INeonHeartbeatWakeEmission } from "./heartbeatTimerRuntime.js";
import {
  executeNeonScheduledAgentRun,
  type INeonScheduledAgentRuntime
} from "./scheduledAgentExecution.js";

/**
 * Heartbeat run executor.
 *
 * Default behavior remains a terminal shadow marker with suppressed delivery.
 * An explicitly armed scheduled-agent runtime invokes the selected harness,
 * attaches memory, persists running -> terminal through the latest writer, and
 * may ask the existing Canary sender to deliver to an explicit Discord target.
 */
export interface INeonHeartbeatExecutionResult {
  readonly createdRunIds: readonly string[];
  readonly createdRunCount: number;
  readonly executedRunCount: number;
  readonly failedRunCount: number;
  readonly retryCount: number;
  readonly deliveredRunCount: number;
  readonly safety: {
    readonly outboundSent: boolean;
    readonly sentDiscord: boolean;
    readonly wroteRunStore: boolean;
    readonly executed: boolean;
  };
  readonly diagnostics: readonly string[];
}

export interface IExecuteNeonHeartbeatWakeIntentsOptions {
  readonly projectRoot: string;
  readonly emissions: readonly INeonHeartbeatWakeEmission[];
  readonly tickAt: string;
  readonly agentRuntime?: INeonScheduledAgentRuntime;
  readonly deliveryTarget?: INeonChannelRouteRef;
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
 * Process one record per deduplicated wake emission. No emissions => no write.
 */
export async function executeNeonHeartbeatWakeIntents(
  options: IExecuteNeonHeartbeatWakeIntentsOptions
): Promise<INeonHeartbeatExecutionResult> {
  const writeRun = options.writeRun ?? writeNeonGatewayRunLatest;
  const createdRunIds: string[] = [];
  let executedRunCount = 0;
  let failedRunCount = 0;
  let retryCount = 0;
  let deliveredRunCount = 0;

  for (const emission of options.emissions) {
    const shadowRun = buildNeonHeartbeatWakeRun({
      projectRoot: options.projectRoot,
      emission,
      tickAt: options.tickAt
    });
    const scheduled = options.agentRuntime?.gate.enabled
      ? await executeNeonScheduledAgentRun({
          projectRoot: options.projectRoot,
          specification: {
            runId: shadowRun.runId,
            source: "heartbeat",
            sourceId: emission.cursorKey ?? emission.agentId,
            agentId: emission.agentId,
            goal: "heartbeat wake",
            content: buildHeartbeatAgentPrompt(emission),
            receivedAt: options.tickAt,
            ...(options.deliveryTarget ? { deliveryTarget: options.deliveryTarget } : {})
          },
          runtime: options.agentRuntime,
          writeRun
        })
      : undefined;
    const run = scheduled?.run ?? shadowRun;
    if (!scheduled) {
      await writeRun(options.projectRoot, run);
    } else {
      executedRunCount += scheduled.attempts > 0 ? 1 : 0;
      failedRunCount += scheduled.state === "failed" ? 1 : 0;
      retryCount += scheduled.retryCount;
      deliveredRunCount += scheduled.outboundSent ? 1 : 0;
    }
    createdRunIds.push(run.runId);
  }

  const wroteRunStore = createdRunIds.length > 0;
  const outboundSent = deliveredRunCount > 0;
  const executed = executedRunCount > 0;
  const scheduledAgentEnabled = options.agentRuntime?.gate.enabled === true;
  return {
    createdRunIds,
    createdRunCount: createdRunIds.length,
    executedRunCount,
    failedRunCount,
    retryCount,
    deliveredRunCount,
    safety: { outboundSent, sentDiscord: outboundSent, wroteRunStore, executed },
    diagnostics: [
      scheduledAgentEnabled && wroteRunStore
        ? `Processed ${createdRunIds.length} scheduled heartbeat run(s); ${executedRunCount} invoked a harness, ${failedRunCount} failed, ${retryCount} retry attempt(s), ${deliveredRunCount} delivered.`
        : wroteRunStore
          ? `Wrote ${createdRunIds.length} terminal shadow heartbeat run-record(s); delivery suppressed on every record.`
        : "No wake emissions to execute; no run-store write."
    ]
  };
}

function buildHeartbeatAgentPrompt(emission: INeonHeartbeatWakeEmission): string {
  const commitmentLine = emission.commitmentIds?.length
    ? `Due commitment ids: ${emission.commitmentIds.join(", ")}.`
    : undefined;
  return [
    `Perform the scheduled heartbeat review for agent ${emission.agentId}.`,
    `Wake source: ${emission.source}; intent: ${emission.intent}; reason: ${emission.reason}.`,
    `Window: ${emission.windowKey}.`,
    ...(commitmentLine ? [commitmentLine] : []),
    emission.source === "commitment"
      ? "Inspect the due commitment records and attached memory, then report the next safe action."
      : "Review current runtime health and open work, then report only actionable findings."
  ].join("\n");
}
