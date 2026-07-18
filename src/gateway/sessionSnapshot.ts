import { basename } from "node:path";

import { createNeonChatConversationId } from "./chatTranscript.js";
import { resolveGatewayStatePaths, readNeonGatewayRuns } from "./runStore.js";
import type {
  INeonGatewayRunRequest,
  INeonGatewayShadowRun,
  TNeonGatewayDeliveryState,
  TNeonGatewayRunMode,
  TNeonGatewayRunStatus
} from "./types.js";
import type { TMemoryAttachmentState, TNeonChannel } from "../harness/types.js";

export type TNeonSessionsSnapshotState = "ready" | "empty";
export type TNeonSessionStatus = "running" | "done" | "failed" | "cancelled";

export interface INeonSessionTokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface INeonSessionTranscriptRef {
  readonly conversationId: string;
  readonly chatPath: string;
  readonly replayPath: string;
  readonly apiPath: string;
}

export interface ICreateNeonSessionsSnapshotOptions {
  readonly maxRuns?: number;
  readonly now?: () => Date;
}

export interface INeonSessionsTotals {
  readonly sessions: number;
  readonly runs: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly cancelledRuns: number;
  readonly runningRuns: number;
  readonly suppressedDeliveries: number;
  readonly tokenTotals: INeonSessionTokenTotals;
}

export interface INeonSessionSummary {
  readonly key: string;
  readonly title: string;
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly agentId: string;
  readonly mode: TNeonGatewayRunMode;
  readonly workspaceName: string;
  readonly goal?: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runCount: number;
  readonly messageCount: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly cancelledRuns: number;
  readonly runningRuns: number;
  readonly sessionStatus: TNeonSessionStatus;
  readonly tokenTotals: INeonSessionTokenTotals;
  readonly transcript: INeonSessionTranscriptRef;
  readonly latestRunId: string;
  readonly latestRunStatus: TNeonGatewayRunStatus;
  readonly latestMemoryState: TMemoryAttachmentState;
  readonly latestDeliveryState: TNeonGatewayDeliveryState;
  readonly latestPreview: string;
}

export interface INeonSessionsSnapshot {
  readonly state: TNeonSessionsSnapshotState;
  readonly generatedAt: string;
  readonly totals: INeonSessionsTotals;
  readonly source: ReturnType<typeof resolveGatewayStatePaths>;
  readonly sessions: readonly INeonSessionSummary[];
}

interface ISessionAccumulator {
  readonly key: string;
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly workspaceName: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  messageCount: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  runningRuns: number;
  tokenTotals: INeonSessionTokenTotals;
  latestRun: INeonGatewayShadowRun;
}

export async function createNeonSessionsSnapshot(
  projectRoot: string,
  options: ICreateNeonSessionsSnapshotOptions = {}
): Promise<INeonSessionsSnapshot> {
  const runs = await readNeonGatewayRuns(projectRoot, options.maxRuns ? { maxRuns: options.maxRuns } : {});
  const sessions = createNeonSessionSummaries(runs);

  const completedRuns = runs.filter((run) => run.status === "completed").length;
  const failedRuns = runs.filter((run) => run.status === "failed").length;
  const cancelledRuns = runs.filter((run) => run.status === "cancelled").length;

  return {
    state: sessions.length > 0 ? "ready" : "empty",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    totals: {
      sessions: sessions.length,
      runs: runs.length,
      completedRuns,
      failedRuns,
      cancelledRuns,
      runningRuns: runs.length - completedRuns - failedRuns - cancelledRuns,
      suppressedDeliveries: runs.filter((run) => run.delivery.state === "suppressed").length,
      tokenTotals: sumRunTokenTotals(runs)
    },
    source: resolveGatewayStatePaths(projectRoot),
    sessions
  };
}

export function renderNeonSessionsReport(snapshot: INeonSessionsSnapshot): string {
  const lines = snapshot.sessions.map((session, index) => {
    return [
      `${index + 1}. ${session.title}`,
      `   key: ${session.key}`,
      `   agent: ${session.agentId}`,
      `   runs: ${session.runCount}`,
      `   status: ${session.sessionStatus} (latest=${session.latestRunStatus})`,
      `   memory: ${session.latestMemoryState}`,
      `   delivery: ${session.latestDeliveryState}`,
      `   tokens: ${session.tokenTotals.totalTokens} (${session.tokenTotals.inputTokens} in / ${session.tokenTotals.outputTokens} out)`,
      ...(session.goal ? [`   goal: ${session.goal}`] : []),
      `   transcript: ${session.transcript.replayPath}`,
      `   latest: ${session.latestRunId}`
    ].join("\n");
  });

  return [
    `Neonika Sessions: ${snapshot.state}`,
    `Sessions: ${snapshot.totals.sessions}`,
    `Runs: ${snapshot.totals.runs}`,
    ...lines
  ].join("\n");
}

function createNeonSessionSummaries(
  runs: readonly INeonGatewayShadowRun[]
): readonly INeonSessionSummary[] {
  const sessions = new Map<string, ISessionAccumulator>();

  for (const run of runs) {
    const key = run.harnessSessionKey;
    const existing = sessions.get(key);

    if (!existing) {
      sessions.set(key, createSessionAccumulator(key, run));
      continue;
    }

    existing.runCount += 1;
    existing.messageCount += 2;
    existing.completedRuns += run.status === "completed" ? 1 : 0;
    existing.failedRuns += run.status === "failed" ? 1 : 0;
    existing.cancelledRuns += run.status === "cancelled" ? 1 : 0;
    existing.runningRuns += isRunningGatewayRun(run) ? 1 : 0;
    existing.tokenTotals = addTokenTotals(existing.tokenTotals, extractRunTokenTotals(run));
    existing.createdAt = earliestTimestamp(existing.createdAt, run.startedAt);
    existing.updatedAt = latestTimestamp(existing.updatedAt, run.completedAt);
    existing.latestRun = isRunNewer(run, existing.latestRun) ? run : existing.latestRun;
  }

  return Array.from(sessions.values())
    .map(freezeSession)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function createSessionAccumulator(key: string, run: INeonGatewayShadowRun): ISessionAccumulator {
  return {
    key,
    channel: run.request.channel,
    accountId: run.request.accountId,
    ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
    channelId: run.request.channelId,
    ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
    workspaceName: workspaceName(run.request),
    createdAt: run.startedAt,
    updatedAt: run.completedAt,
    runCount: 1,
    messageCount: 2,
    completedRuns: run.status === "completed" ? 1 : 0,
    failedRuns: run.status === "failed" ? 1 : 0,
    cancelledRuns: run.status === "cancelled" ? 1 : 0,
    runningRuns: isRunningGatewayRun(run) ? 1 : 0,
    tokenTotals: extractRunTokenTotals(run),
    latestRun: run
  };
}

function freezeSession(accumulator: ISessionAccumulator): INeonSessionSummary {
  const latest = accumulator.latestRun;

  return {
    key: accumulator.key,
    title: createSessionTitle(accumulator, latest.request),
    channel: accumulator.channel,
    accountId: accumulator.accountId,
    ...(accumulator.guildId ? { guildId: accumulator.guildId } : {}),
    channelId: accumulator.channelId,
    ...(accumulator.threadId ? { threadId: accumulator.threadId } : {}),
    agentId: latest.request.agentId,
    mode: latest.mode,
    workspaceName: accumulator.workspaceName,
    ...(latest.request.goal ? { goal: latest.request.goal } : {}),
    userId: latest.request.userId,
    ...(latest.request.userDisplayName ? { userDisplayName: latest.request.userDisplayName } : {}),
    createdAt: accumulator.createdAt,
    updatedAt: accumulator.updatedAt,
    runCount: accumulator.runCount,
    messageCount: accumulator.messageCount,
    completedRuns: accumulator.completedRuns,
    failedRuns: accumulator.failedRuns,
    cancelledRuns: accumulator.cancelledRuns,
    runningRuns: accumulator.runningRuns,
    sessionStatus: resolveSessionStatus(accumulator, latest),
    tokenTotals: accumulator.tokenTotals,
    transcript: createSessionTranscriptRef(latest.request, accumulator.key),
    latestRunId: latest.runId,
    latestRunStatus: latest.status,
    latestMemoryState: latest.memoryState,
    latestDeliveryState: latest.delivery.state,
    latestPreview: latest.request.contentPreview
  };
}

function resolveSessionStatus(
  accumulator: ISessionAccumulator,
  latest: INeonGatewayShadowRun
): TNeonSessionStatus {
  if (accumulator.runningRuns > 0) {
    return "running";
  }

  if (latest.status === "failed") {
    return "failed";
  }

  return latest.status === "cancelled" ? "cancelled" : "done";
}

function isRunningGatewayRun(run: INeonGatewayShadowRun): boolean {
  return run.status === "running";
}

function sumRunTokenTotals(runs: readonly INeonGatewayShadowRun[]): INeonSessionTokenTotals {
  return runs.reduce(
    (totals, run) => addTokenTotals(totals, extractRunTokenTotals(run)),
    createEmptyTokenTotals()
  );
}

export function extractRunTokenTotals(run: INeonGatewayShadowRun): INeonSessionTokenTotals {
  return run.events.reduce((totals, event) => {
    if (event.kind !== "token-usage") {
      return totals;
    }

    return addTokenTotals(totals, {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens
    });
  }, createEmptyTokenTotals());
}

function createSessionTranscriptRef(
  request: INeonGatewayRunRequest,
  sessionKey: string
): INeonSessionTranscriptRef {
  const conversationId = createNeonChatConversationId(request);
  const sessionKeyQuery = encodeQueryParam(sessionKey);
  const conversationIdQuery = encodeQueryParam(conversationId);
  const channelIdQuery = encodeQueryParam(request.channelId);

  return {
    conversationId,
    chatPath: `/mission-control/chat?replayConversationId=${conversationIdQuery}&replayChannelId=${channelIdQuery}`,
    replayPath: `/mission-control/activity?sessionKey=${sessionKeyQuery}`,
    apiPath: `/api/neon-replay?sessionKey=${sessionKeyQuery}&conversationId=${conversationIdQuery}&channelId=${channelIdQuery}`
  };
}

function encodeQueryParam(value: string): string {
  return encodeURIComponent(value);
}

export function addTokenTotals(
  left: INeonSessionTokenTotals,
  right: INeonSessionTokenTotals
): INeonSessionTokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

export function createEmptyTokenTotals(): INeonSessionTokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function createSessionTitle(accumulator: ISessionAccumulator, request: INeonGatewayRunRequest): string {
  const thread = accumulator.threadId ? ` / thread ${accumulator.threadId}` : "";
  const user = request.userDisplayName ?? request.userId;

  return `${accumulator.channel} / ${accumulator.channelId}${thread} / ${user}`;
}

function workspaceName(request: INeonGatewayRunRequest): string {
  return basename(request.workspaceRoot) || "workspace";
}

function isRunNewer(left: INeonGatewayShadowRun, right: INeonGatewayShadowRun): boolean {
  return timestampMs(left.completedAt) >= timestampMs(right.completedAt);
}

function earliestTimestamp(left: string, right: string): string {
  return timestampMs(left) <= timestampMs(right) ? left : right;
}

function latestTimestamp(left: string, right: string): string {
  return timestampMs(left) >= timestampMs(right) ? left : right;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : 0;
}
