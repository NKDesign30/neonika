import { createHash } from "node:crypto";

import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import { isHarnessEventHiddenFromChannelProgress, type TCodexHarnessEvent } from "../harness/types.js";
import {
  type INeonGatewayPersistedFinding,
  type INeonGatewayRunRequest,
  type INeonGatewayShadowRun
} from "./types.js";
import { readNeonGatewayRuns, resolveGatewayStatePaths } from "./runStore.js";

export type TNeonReplaySnapshotState = "ready" | "empty" | "not-found";
export type TNeonReplayEventKind =
  | TCodexHarnessEvent["kind"]
  | "delivery"
  | "inbound"
  | "lifecycle"
  | "memory";
export type TNeonReplayEventStatus = "done" | "error" | "running";

export interface ICreateNeonReplaySnapshotOptions {
  readonly channelId?: string;
  readonly conversationId?: string;
  readonly maxEventsPerRun?: number;
  readonly maxRuns?: number;
  readonly now?: () => Date;
  readonly runId?: string;
  readonly sessionKey?: string;
}

export interface INeonReplayFilters {
  readonly channelId?: string;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly sessionKey?: string;
}

export interface INeonReplayEvent {
  readonly id: string;
  readonly exitCode?: number;
  readonly kind: TNeonReplayEventKind;
  readonly messageSeq: string;
  readonly preview?: string;
  readonly sequence: number;
  readonly status: TNeonReplayEventStatus;
  readonly summary: string;
  readonly title: string;
  readonly toolName?: string;
}

export interface INeonReplayRun {
  readonly agentId: string;
  readonly channel: INeonGatewayRunRequest["channel"];
  readonly channelId: string;
  readonly completedAt: string;
  readonly conversationId: string;
  readonly deliveryState: INeonGatewayShadowRun["delivery"]["state"];
  readonly durationMs: number;
  readonly eventCount: number;
  readonly events: readonly INeonReplayEvent[];
  readonly finalPreview: string;
  readonly inboundPreview: string;
  readonly memoryState: INeonGatewayShadowRun["memoryState"];
  readonly mode: INeonGatewayRunRequest["mode"];
  readonly runId: string;
  readonly sessionKey: string;
  readonly startedAt: string;
  readonly status: INeonGatewayShadowRun["status"];
  readonly suspiciousFindings: readonly INeonGatewayPersistedFinding[];
  readonly userDisplayName?: string;
  readonly userId: string;
}

export interface INeonReplayTotals {
  readonly events: number;
  readonly filteredRuns: number;
  readonly sourceRuns: number;
}

export interface INeonReplaySnapshot {
  readonly filters: INeonReplayFilters;
  readonly generatedAt: string;
  readonly runs: readonly INeonReplayRun[];
  readonly source: ReturnType<typeof resolveGatewayStatePaths>;
  readonly state: TNeonReplaySnapshotState;
  readonly totals: INeonReplayTotals;
}

const previewLimit = 900;

export async function createNeonReplaySnapshot(
  projectRoot: string,
  options: ICreateNeonReplaySnapshotOptions = {}
): Promise<INeonReplaySnapshot> {
  const filters = createReplayFilters(options);
  const sourceReadOptions = options.maxRuns && !hasActiveFilters(filters) ? { maxRuns: options.maxRuns } : {};
  const runs = await readNeonGatewayRuns(projectRoot, sourceReadOptions);
  const filteredRuns = runs
    .filter((run) => runMatchesFilters(run, filters))
    .slice(-(options.maxRuns ?? runs.length));
  const replayRuns = filteredRuns
    .map((run) => createReplayRun(run, options.maxEventsPerRun ?? 50))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));

  return {
    state: replayRuns.length > 0 ? "ready" : hasActiveFilters(filters) ? "not-found" : "empty",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    filters,
    totals: {
      sourceRuns: runs.length,
      filteredRuns: replayRuns.length,
      events: replayRuns.reduce((count, run) => count + run.events.length, 0)
    },
    source: resolveGatewayStatePaths(projectRoot),
    runs: replayRuns
  };
}

export function renderNeonReplayReport(snapshot: INeonReplaySnapshot): string {
  const latest = snapshot.runs[0];
  const filters = Object.entries(snapshot.filters)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  return [
    `Neonika Replay: ${snapshot.state}`,
    `Runs: ${snapshot.totals.filteredRuns}/${snapshot.totals.sourceRuns}`,
    `Events: ${snapshot.totals.events}`,
    `Filters: ${filters || "none"}`,
    `Latest: ${latest ? `${latest.runId} ${latest.status} ${latest.eventCount} events` : "none"}`
  ].join("\n");
}

export interface INeonReplayEventPageItem extends INeonReplayEvent {
  readonly conversationId: string;
  readonly position: number;
  readonly runId: string;
}

export type TNeonReplayPageState = "cursor-not-found" | "empty" | "ready";

export interface INeonReplayPageOptions {
  readonly afterMessageSeq?: string;
  readonly limit?: number;
}

export interface INeonReplayEventPage {
  readonly hasMore: boolean;
  readonly items: readonly INeonReplayEventPageItem[];
  readonly limit: number;
  readonly nextCursor?: string;
  readonly returned: number;
  readonly state: TNeonReplayPageState;
  readonly totalEvents: number;
}

const replayPageLimitDefault = 50;
const replayPageLimitMax = 200;

/**
 * Cursor pagination over the flattened replay event stream. The `messageSeq`
 * (`runId:NNNNNN`) acts as an opaque cursor: events keep the snapshot's
 * presentation order (runs newest-first, events sequence-ascending), so the
 * cursor is unique and stable for a given snapshot. Read-only — events are
 * already redacted by `createReplayEvent`, no mutation or outbound effect.
 */
export function paginateNeonReplayEvents(
  snapshot: INeonReplaySnapshot,
  options: INeonReplayPageOptions = {}
): INeonReplayEventPage {
  const limit = clampReplayPageLimit(options.limit);
  const ordered: INeonReplayEventPageItem[] = [];
  for (const run of snapshot.runs) {
    for (const event of run.events) {
      ordered.push({ ...event, runId: run.runId, conversationId: run.conversationId, position: ordered.length });
    }
  }

  const totalEvents = ordered.length;
  if (totalEvents === 0) {
    return { state: "empty", items: [], limit, returned: 0, totalEvents: 0, hasMore: false };
  }

  const cursor = normalizeFilter(options.afterMessageSeq);
  let start = 0;
  if (cursor) {
    const cursorIndex = ordered.findIndex((item) => item.messageSeq === cursor);
    if (cursorIndex < 0) {
      return { state: "cursor-not-found", items: [], limit, returned: 0, totalEvents, hasMore: false };
    }
    start = cursorIndex + 1;
  }

  const items = ordered.slice(start, start + limit);
  const hasMore = start + limit < totalEvents;
  const last = items[items.length - 1];

  return {
    state: "ready",
    items,
    limit,
    returned: items.length,
    totalEvents,
    hasMore,
    ...(hasMore && last ? { nextCursor: last.messageSeq } : {})
  };
}

export function renderNeonReplayEventPageReport(page: INeonReplayEventPage): string {
  const head = page.items[0];

  return [
    `Neonika Replay Page: ${page.state}`,
    `Events: ${page.returned}/${page.totalEvents} (limit ${page.limit})`,
    `HasMore: ${page.hasMore ? "yes" : "no"}`,
    `NextCursor: ${page.nextCursor ?? "none"}`,
    `First: ${head ? `${head.messageSeq} ${head.kind}` : "none"}`
  ].join("\n");
}

function clampReplayPageLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return replayPageLimitDefault;
  }

  return Math.max(1, Math.min(value, replayPageLimitMax));
}

function createReplayFilters(options: ICreateNeonReplaySnapshotOptions): INeonReplayFilters {
  const channelId = normalizeFilter(options.channelId);
  const conversationId = normalizeFilter(options.conversationId);
  const runId = normalizeFilter(options.runId);
  const sessionKey = normalizeFilter(options.sessionKey);

  return {
    ...(channelId ? { channelId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {})
  };
}

function runMatchesFilters(run: INeonGatewayShadowRun, filters: INeonReplayFilters): boolean {
  return (
    (!filters.channelId || run.request.channelId === filters.channelId) &&
    (!filters.conversationId || createReplayConversationId(run.request) === filters.conversationId) &&
    (!filters.runId || run.runId === filters.runId) &&
    (!filters.sessionKey || run.harnessSessionKey === filters.sessionKey)
  );
}

function hasActiveFilters(filters: INeonReplayFilters): boolean {
  return Boolean(filters.channelId || filters.conversationId || filters.runId || filters.sessionKey);
}

export function createReplayRun(run: INeonGatewayShadowRun, maxEventsPerRun: number): INeonReplayRun {
  const events = createReplayEvents(run);
  const boundedEvents = events.slice(0, Math.max(1, Math.min(maxEventsPerRun, 100)));

  return {
    runId: run.runId,
    sessionKey: run.harnessSessionKey,
    conversationId: createReplayConversationId(run.request),
    channel: run.request.channel,
    channelId: run.request.channelId,
    agentId: run.request.agentId,
    userId: run.request.userId,
    ...(run.request.userDisplayName ? { userDisplayName: run.request.userDisplayName } : {}),
    status: run.status,
    mode: run.request.mode,
    memoryState: run.memoryState,
    deliveryState: run.delivery.state,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: Math.max(0, timestampMs(run.completedAt) - timestampMs(run.startedAt)),
    inboundPreview: createPreview(run.request.contentPreview),
    finalPreview: createPreview(run.finalText),
    suspiciousFindings: run.request.suspiciousFindings ?? [],
    eventCount: events.length,
    events: boundedEvents
  };
}

function createReplayEvents(run: INeonGatewayShadowRun): readonly INeonReplayEvent[] {
  // Synthetic session-started lifecycle marker from existing run data (start time,
  // session key, agent). Neon runs have no session parent, so only started/agent is
  // synthesized; a session label/goal is surfaced separately in the sessions snapshot.
  const events: INeonReplayEvent[] = [
    createSyntheticReplayEvent(
      run,
      0,
      "lifecycle",
      "Session started",
      `Session ${run.harnessSessionKey} started for agent ${run.request.agentId}.`,
      run.startedAt
    ),
    createSyntheticReplayEvent(run, 1, "inbound", "Inbound message", "Gateway accepted inbound message.", run.request.contentPreview),
    createSyntheticReplayEvent(run, 2, "memory", "Memory", `Memory ${run.memoryState}.`)
  ];

  run.events.forEach((event) => {
    if (isHarnessEventHiddenFromChannelProgress(event)) {
      return;
    }

    events.push(createHarnessReplayEvent(run, event, events.length));
  });

  events.push(
    createSyntheticReplayEvent(
      run,
      events.length,
      "delivery",
      "Delivery",
      `Delivery ${run.delivery.state}${run.delivery.reason ? `: ${run.delivery.reason}` : ""}.`,
      run.delivery.finalText
    )
  );

  return events;
}

function createHarnessReplayEvent(
  run: INeonGatewayShadowRun,
  event: TCodexHarnessEvent,
  sequence: number
): INeonReplayEvent {
  switch (event.kind) {
    case "assistant-delta":
      return createReplayEvent(run, {
        kind: event.kind,
        preview: event.text,
        sequence,
        status: run.status === "failed" ? "error" : "done",
        summary: "Assistant streamed a response delta.",
        title: "Assistant stream"
      });
    case "tool-start":
      return createReplayEvent(run, {
        kind: event.kind,
        sequence,
        status: "running",
        summary: `${event.toolName} started.`,
        title: `Tool ${event.toolName}`,
        toolName: event.toolName
      });
    case "tool-output":
      return createReplayEvent(run, {
        kind: event.kind,
        preview: event.output,
        sequence,
        status: "done",
        summary: `${event.toolName} returned output.`,
        title: `Tool ${event.toolName}`,
        toolName: event.toolName
      });
    case "file-write":
      return createReplayEvent(run, {
        kind: event.kind,
        preview: event.path,
        sequence,
        status: "done",
        summary: "Worker reported a file write.",
        title: "File write"
      });
    case "command-exit":
      return createReplayEvent(run, {
        exitCode: event.exitCode,
        kind: event.kind,
        preview: event.command,
        sequence,
        status: event.exitCode === 0 ? "done" : "error",
        summary: `${event.command} exited ${event.exitCode}.`,
        title: "Command exit"
      });
    case "token-usage":
      return createReplayEvent(run, {
        kind: event.kind,
        sequence,
        status: "done",
        summary: `${event.totalTokens} token(s): ${event.inputTokens} input, ${event.outputTokens} output.`,
        title: "Token usage"
      });
    case "final":
      return createReplayEvent(run, {
        kind: event.kind,
        preview: event.text,
        sequence,
        status: "done",
        summary: "Agent produced a final response.",
        title: "Final response"
      });
    case "failed":
      return createReplayEvent(run, {
        kind: event.kind,
        preview: event.message,
        sequence,
        status: "error",
        summary: event.message,
        title: "Run failed"
      });
  }
}

function createSyntheticReplayEvent(
  run: INeonGatewayShadowRun,
  sequence: number,
  kind: "delivery" | "inbound" | "lifecycle" | "memory",
  title: string,
  summary: string,
  preview?: string
): INeonReplayEvent {
  return createReplayEvent(run, {
    kind,
    ...(preview ? { preview } : {}),
    sequence,
    status: kind === "memory" && run.memoryState === "failed" ? "error" : "done",
    summary,
    title
  });
}

function createReplayEvent(
  run: INeonGatewayShadowRun,
  input: {
    readonly exitCode?: number;
    readonly kind: TNeonReplayEventKind;
    readonly preview?: string;
    readonly sequence: number;
    readonly status: TNeonReplayEventStatus;
    readonly summary: string;
    readonly title: string;
    readonly toolName?: string;
  }
): INeonReplayEvent {
  return {
    id: `${run.runId}:${String(input.sequence).padStart(3, "0")}:${input.kind}`,
    kind: input.kind,
    messageSeq: createReplayMessageSeq(run.runId, input.sequence),
    sequence: input.sequence,
    status: input.status,
    title: input.title,
    summary: createPreview(input.summary),
    ...(input.preview ? { preview: createPreview(input.preview) } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {})
  };
}

function createReplayMessageSeq(runId: string, sequence: number): string {
  return `${runId}:${String(sequence).padStart(6, "0")}`;
}

function createReplayConversationId(request: INeonGatewayRunRequest): string {
  const key = [
    request.channel,
    request.accountId,
    request.guildId ?? "dm",
    request.channelId,
    request.threadId ?? "main"
  ].join(":");

  return `chat-${createHash("sha256").update(key).digest("hex").slice(0, 18)}`;
}

function createPreview(value: string): string {
  const redacted = redactText(value);

  return redacted.length > previewLimit ? `${truncateUtf16Safe(redacted, previewLimit - 3)}...` : redacted;
}

function normalizeFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : 0;
}
