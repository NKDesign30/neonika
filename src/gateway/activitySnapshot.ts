import { resolveGatewayStatePaths, readNeonGatewayRuns } from "./runStore.js";
import { isHarnessEventHiddenFromChannelProgress, type TCodexHarnessEvent, type TNeonChannel } from "../harness/types.js";
import type {
  INeonGatewayShadowRun,
  TNeonGatewayDeliveryState,
  TNeonGatewayRunStatus
} from "./types.js";
import { redactSnapshotText } from "../harness/redaction.js";

export type TNeonActivitySnapshotState = "ready" | "empty";
export type TNeonActivityEntryKind =
  | "inbound"
  | "run"
  | "assistant"
  | "tool"
  | "file"
  | "command"
  | "usage"
  | "delivery"
  | "memory";
export type TNeonActivityStatus = "running" | "done" | "error";

export interface ICreateNeonActivitySnapshotOptions {
  readonly maxRuns?: number;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export interface INeonActivityTotals {
  readonly entries: number;
  readonly runs: number;
  readonly running: number;
  readonly done: number;
  readonly errors: number;
}

export interface INeonActivityEntry {
  readonly id: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly channel: TNeonChannel;
  readonly channelId: string;
  readonly threadId?: string;
  readonly agentId: string;
  readonly kind: TNeonActivityEntryKind;
  readonly status: TNeonActivityStatus;
  readonly title: string;
  readonly summary: string;
  readonly preview?: string;
  readonly toolCallId?: string;
  readonly deliveryState?: TNeonGatewayDeliveryState;
  readonly runStatus: TNeonGatewayRunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly durationMs: number;
  readonly sequence: number;
}

export interface INeonActivitySnapshot {
  readonly state: TNeonActivitySnapshotState;
  readonly generatedAt: string;
  readonly totals: INeonActivityTotals;
  readonly source: ReturnType<typeof resolveGatewayStatePaths>;
  readonly entries: readonly INeonActivityEntry[];
}

interface IActivityBase {
  readonly id?: string;
  readonly run: INeonGatewayShadowRun;
  readonly kind: TNeonActivityEntryKind;
  readonly status: TNeonActivityStatus;
  readonly title: string;
  readonly summary: string;
  readonly preview?: string;
  readonly toolCallId?: string;
  readonly deliveryState?: TNeonGatewayDeliveryState;
  readonly sequence: number;
}

type TToolActivityHarnessEvent = Extract<TCodexHarnessEvent, { readonly kind: "tool-start" | "tool-output" }>;

const PREVIEW_LIMIT = 1_200;

export async function createNeonActivitySnapshot(
  projectRoot: string,
  options: ICreateNeonActivitySnapshotOptions = {}
): Promise<INeonActivitySnapshot> {
  const runs = await readNeonGatewayRuns(projectRoot, options.maxRuns ? { maxRuns: options.maxRuns } : {});
  const entries = createNeonActivityEntries(runs, options.maxEntries ?? 100);

  return {
    state: entries.length > 0 ? "ready" : "empty",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    totals: {
      entries: entries.length,
      runs: runs.length,
      running: entries.filter((entry) => entry.status === "running").length,
      done: entries.filter((entry) => entry.status === "done").length,
      errors: entries.filter((entry) => entry.status === "error").length
    },
    source: resolveGatewayStatePaths(projectRoot),
    entries
  };
}

export function renderNeonActivityReport(snapshot: INeonActivitySnapshot): string {
  const lines = snapshot.entries.slice(0, 20).map((entry, index) => {
    return [
      `${index + 1}. ${entry.title}`,
      `   kind: ${entry.kind}`,
      `   status: ${entry.status}`,
      `   run: ${entry.runId}`,
      `   session: ${entry.sessionKey}`,
      `   summary: ${entry.summary}`
    ].join("\n");
  });

  return [
    `Neon Activity: ${snapshot.state}`,
    `Entries: ${snapshot.totals.entries}`,
    `Runs: ${snapshot.totals.runs}`,
    `Errors: ${snapshot.totals.errors}`,
    ...lines
  ].join("\n");
}

export function createNeonActivityEntries(
  runs: readonly INeonGatewayShadowRun[],
  maxEntries: number
): readonly INeonActivityEntry[] {
  const entries = runs.flatMap((run) => createEntriesForRun(run));

  return entries
    .sort((left, right) => {
      const timeDelta = timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
      return timeDelta === 0 ? right.sequence - left.sequence : timeDelta;
    })
    .slice(0, Math.max(1, maxEntries));
}

function createEntriesForRun(run: INeonGatewayShadowRun): readonly INeonActivityEntry[] {
  const entries: INeonActivityEntry[] = [
    createActivityEntry({
      run,
      kind: "inbound",
      status: "done",
      title: "Inbound message",
      summary: `${run.request.channel} message accepted for ${run.request.agentId}`,
      preview: run.request.contentPreview,
      sequence: 0
    }),
    createActivityEntry({
      run,
      kind: "memory",
      status: run.memoryState === "failed" ? "error" : "done",
      title: "Memory attachment",
      summary: `Memory ${run.memoryState}`,
      sequence: 1
    }),
    createActivityEntry({
      run,
      kind: "run",
      status: activityStatusFromRunStatus(run.status),
      title: "Agent run",
      summary: `${run.harnessId} ${run.status}`,
      preview: run.finalText,
      sequence: 2
    })
  ];

  entries.push(...createEventActivityEntries(run, run.events, 3));

  entries.push(
    createActivityEntry({
      run,
      kind: "delivery",
      status: "done",
      title: "Delivery policy",
      summary: `Delivery ${run.delivery.state}${run.delivery.reason ? `: ${run.delivery.reason}` : ""}`,
      preview: run.delivery.finalText,
      deliveryState: run.delivery.state,
      sequence: entries.length + 3
    })
  );

  return entries;
}

function createEventActivityEntries(
  run: INeonGatewayShadowRun,
  events: readonly TCodexHarnessEvent[],
  firstSequence: number
): readonly INeonActivityEntry[] {
  const entries: INeonActivityEntry[] = [];
  const toolEntryIndexes = new Map<string, number>();

  events.forEach((event, index) => {
    const sequence = firstSequence + index;

    if (isHarnessEventHiddenFromChannelProgress(event)) {
      return;
    }

    if (isToolActivityHarnessEvent(event) && event.toolCallId) {
      const toolCallId = event.toolCallId;
      const id = createStableToolActivityId(run.runId, toolCallId);
      const entry = createToolActivityEntry(run, event, toolCallId, sequence, id);
      const existingIndex = toolEntryIndexes.get(id);

      if (existingIndex === undefined) {
        toolEntryIndexes.set(id, entries.length);
        entries.push(entry);
      } else {
        entries[existingIndex] = entry;
      }

      return;
    }

    entries.push(createEventActivityEntry(run, event, sequence));
  });

  return entries;
}

function createEventActivityEntry(
  run: INeonGatewayShadowRun,
  event: TCodexHarnessEvent,
  sequence: number
): INeonActivityEntry {
  switch (event.kind) {
    case "assistant-delta":
      return createActivityEntry({
        run,
        kind: "assistant",
        status: run.status === "failed" ? "error" : "done",
        title: "Assistant stream",
        summary: "Assistant streamed a response delta.",
        preview: event.text,
        sequence
      });
    case "tool-start":
      return createActivityEntry({
        run,
        kind: "tool",
        status: run.status === "failed" ? "error" : "running",
        title: `Tool ${event.toolName}`,
        summary: `${event.toolName} started.`,
        sequence
      });
    case "tool-output":
      return createActivityEntry({
        run,
        kind: "tool",
        status: "done",
        title: `Tool ${event.toolName}`,
        summary: `${event.toolName} returned output.`,
        preview: event.output,
        sequence
      });
    case "file-write":
      return createActivityEntry({
        run,
        kind: "file",
        status: "done",
        title: "File write",
        summary: "A worker reported a file write.",
        preview: event.path,
        sequence
      });
    case "command-exit":
      return createActivityEntry({
        run,
        kind: "command",
        status: event.exitCode === 0 ? "done" : "error",
        title: "Command exit",
        summary: `${event.command} exited ${event.exitCode}.`,
        sequence
      });
    case "token-usage":
      return createActivityEntry({
        run,
        kind: "usage",
        status: "done",
        title: "Token usage",
        summary: `${event.totalTokens} token(s): ${event.inputTokens} input, ${event.outputTokens} output.`,
        sequence
      });
    case "final":
      return createActivityEntry({
        run,
        kind: "assistant",
        status: "done",
        title: "Final response",
        summary: "Agent produced a final response.",
        preview: event.text,
        sequence
      });
    case "failed":
      return createActivityEntry({
        run,
        kind: "assistant",
        status: "error",
        title: "Run failed",
        summary: event.message,
        preview: event.message,
        sequence
      });
  }
}

function createToolActivityEntry(
  run: INeonGatewayShadowRun,
  event: TToolActivityHarnessEvent,
  toolCallId: string,
  sequence: number,
  id: string
): INeonActivityEntry {
  const returnedOutput = event.kind === "tool-output";

  // A tool-call with a tool-start but no later tool-output for the same toolCallId
  // stays "running": the merge is last-event-wins over chronological events, so a
  // returned-output event replaces the start and marks it done. A failed run
  // surfaces the dangling start as an error instead.
  return createActivityEntry({
    id,
    run,
    kind: "tool",
    status: returnedOutput ? "done" : run.status === "failed" ? "error" : "running",
    title: `Tool ${event.toolName}`,
    summary: returnedOutput ? `${event.toolName} returned output.` : `${event.toolName} started.`,
    ...(returnedOutput ? { preview: event.output } : {}),
    toolCallId,
    sequence
  });
}

function createActivityEntry(input: IActivityBase): INeonActivityEntry {
  const updatedAt = input.run.completedAt;

  return {
    id: input.id ?? `${input.run.runId}:${String(input.sequence).padStart(3, "0")}:${input.kind}`,
    runId: input.run.runId,
    sessionKey: input.run.harnessSessionKey,
    channel: input.run.request.channel,
    channelId: input.run.request.channelId,
    ...(input.run.request.threadId ? { threadId: input.run.request.threadId } : {}),
    agentId: input.run.request.agentId,
    kind: input.kind,
    status: input.status,
    title: input.title,
    summary: redactActivityText(input.summary),
    ...(input.preview ? { preview: redactActivityText(input.preview) } : {}),
    ...(input.toolCallId ? { toolCallId: redactActivityText(input.toolCallId) } : {}),
    ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
    runStatus: input.run.status,
    startedAt: input.run.startedAt,
    updatedAt,
    durationMs: Math.max(0, timestampMs(updatedAt) - timestampMs(input.run.startedAt)),
    sequence: input.sequence
  };
}

function isToolActivityHarnessEvent(event: TCodexHarnessEvent): event is TToolActivityHarnessEvent {
  return event.kind === "tool-start" || event.kind === "tool-output";
}

function createStableToolActivityId(runId: string, toolCallId: string): string {
  const segment = redactActivityText(toolCallId)
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return `${runId}:tool:${segment || "unknown"}`;
}

function activityStatusFromRunStatus(status: TNeonGatewayRunStatus): TNeonActivityStatus {
  if (status === "running") {
    return "running";
  }

  if (status === "failed") {
    return "error";
  }

  return "done";
}

function redactActivityText(value: string): string {
  return redactSnapshotText(value, { previewLimit: PREVIEW_LIMIT });
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : 0;
}
