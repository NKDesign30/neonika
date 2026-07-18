import { createHash } from "node:crypto";

import { redactText } from "../harness/redaction.js";
import {
  isHarnessEventHiddenFromChannelProgress,
  type TCodexHarnessEvent,
  type TMemoryAttachmentState,
  type TNeonChannel
} from "../harness/types.js";
import {
  readNeonGatewayRuns,
  resolveGatewayStatePaths,
  type INeonGatewayStatePaths
} from "./runStore.js";
import type {
  INeonGatewayRunRequest,
  INeonGatewayShadowRun,
  TNeonGatewayDeliveryState,
  TNeonGatewayRunStatus
} from "./types.js";

export type TNeonChatMessageDirection = "inbound" | "agent";
export type TNeonChatSnapshotState = "ready" | "empty" | "not-found";
export type TNeonChatToolEventKind = "tool-start" | "tool-output" | "file-write" | "command-exit";
export type TNeonChatToolEventStatus = "started" | "done" | "error";

export interface INeonChatToolEvent {
  readonly id: string;
  readonly kind: TNeonChatToolEventKind;
  readonly status: TNeonChatToolEventStatus;
  readonly title: string;
  readonly summary: string;
  readonly preview?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly exitCode?: number;
  readonly sequence: number;
}

export interface INeonChatMessage {
  readonly messageId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly direction: TNeonChatMessageDirection;
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly agentId: string;
  readonly textPreview: string;
  readonly toolEvents: readonly INeonChatToolEvent[];
  readonly status: TNeonGatewayRunStatus;
  readonly memoryState: TMemoryAttachmentState;
  readonly deliveryState: TNeonGatewayDeliveryState;
  readonly createdAt: string;
}

export interface INeonChatConversation {
  readonly conversationId: string;
  readonly title: string;
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly latestAt: string;
  readonly runCount: number;
  readonly messageCount: number;
  readonly agents: readonly string[];
  readonly users: readonly string[];
  readonly messages: readonly INeonChatMessage[];
}

export interface INeonChatTotals {
  readonly conversations: number;
  readonly filteredRuns: number;
  readonly messages: number;
  readonly runs: number;
  readonly sourceRuns: number;
}

export interface INeonChatFilters {
  readonly channelId?: string;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly sessionKey?: string;
  readonly agentId?: string;
}

export interface INeonChatSnapshot {
  readonly filters: INeonChatFilters;
  readonly state: TNeonChatSnapshotState;
  readonly generatedAt: string;
  readonly totals: INeonChatTotals;
  readonly conversations: readonly INeonChatConversation[];
  readonly source: INeonGatewayStatePaths;
}

export interface ICreateNeonChatSnapshotOptions {
  readonly channelId?: string;
  readonly conversationId?: string;
  readonly maxRuns?: number;
  readonly now?: () => Date;
  readonly runId?: string;
  readonly sessionKey?: string;
  readonly agentId?: string;
}

interface IConversationAccumulator {
  readonly conversationId: string;
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  latestAt: string;
  runCount: number;
  readonly agents: Set<string>;
  readonly users: Set<string>;
  readonly messages: INeonChatMessage[];
}

export async function createNeonChatSnapshot(
  projectRoot: string,
  options: ICreateNeonChatSnapshotOptions = {}
): Promise<INeonChatSnapshot> {
  const filters = createChatFilters(options);
  const sourceReadOptions =
    options.maxRuns && !hasActiveChatFilters(filters)
      ? { maxRuns: options.maxRuns }
      : {};
  const runs = await readNeonGatewayRuns(projectRoot, sourceReadOptions);
  const filteredRuns = runs
    .filter((run) => runMatchesChatFilters(run, filters))
    .slice(-(options.maxRuns ?? runs.length));
  const conversations = createNeonChatConversations(filteredRuns);
  const messages = conversations.reduce((count, conversation) => count + conversation.messageCount, 0);

  return {
    filters,
    state: conversations.length > 0 ? "ready" : hasActiveChatFilters(filters) ? "not-found" : "empty",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    totals: {
      conversations: conversations.length,
      filteredRuns: filteredRuns.length,
      messages,
      runs: filteredRuns.length,
      sourceRuns: runs.length
    },
    conversations,
    source: resolveGatewayStatePaths(projectRoot)
  };
}

const chatToolCardLimit = 6;
const chatToolCardMessageLimit = 3;

/**
 * Renders one normalized tool event as a leak-safe text card. Every field
 * (`title`/`summary`/`preview`) is already redacted at snapshot build time
 * (`createChatToolEvent` -> `createPreview` -> `redactText`); this only formats,
 * it never re-derives raw values. The preview is the bounded redacted excerpt.
 */
export function renderNeonChatToolCard(event: INeonChatToolEvent): string {
  const detail = [
    event.toolName ? `tool=${event.toolName}` : "",
    typeof event.exitCode === "number" ? `exit=${event.exitCode}` : "",
    event.toolCallId ? `call=${event.toolCallId}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return [
    `  - [${event.kind}] ${event.title} (${event.status})`,
    detail ? `      ${detail}` : "",
    event.preview ? `      ${event.preview}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Tool-card block for the latest conversation's most recent agent messages.
 * Bounded by message + per-message card limits so a long run cannot flood the
 * report. Read-only over already-redacted snapshot data.
 */
function renderChatToolCardBlock(snapshot: INeonChatSnapshot): readonly string[] {
  const latest = snapshot.conversations[0];
  if (!latest) {
    return [];
  }

  const lines: string[] = [];
  for (const message of latest.messages.slice(-chatToolCardMessageLimit)) {
    if (message.direction !== "agent" || message.toolEvents.length === 0) {
      continue;
    }

    lines.push(`Tools [${message.agentId} ${message.runId}]:`);
    for (const event of message.toolEvents.slice(0, chatToolCardLimit)) {
      lines.push(renderNeonChatToolCard(event));
    }
  }

  return lines;
}

export function renderNeonChatReport(snapshot: INeonChatSnapshot): string {
  const latest = snapshot.conversations[0];
  const filters = Object.entries(snapshot.filters)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  const toolCards = renderChatToolCardBlock(snapshot);

  return [
    `Neon Chat: ${snapshot.state}`,
    `Conversations: ${snapshot.totals.conversations}`,
    `Messages: ${snapshot.totals.messages}`,
    `Runs: ${snapshot.totals.filteredRuns}/${snapshot.totals.sourceRuns}`,
    `Filters: ${filters || "none"}`,
    `Latest: ${latest ? `${latest.title} ${latest.latestAt}` : "none"}`,
    `Source: ${snapshot.source.runsPath}`,
    ...(toolCards.length > 0 ? ["", ...toolCards] : [])
  ].join("\n");
}

function createChatFilters(options: ICreateNeonChatSnapshotOptions): INeonChatFilters {
  const channelId = normalizeChatFilter(options.channelId);
  const conversationId = normalizeChatFilter(options.conversationId);
  const runId = normalizeChatFilter(options.runId);
  const sessionKey = normalizeChatFilter(options.sessionKey);
  const agentId = normalizeChatFilter(options.agentId);

  return {
    ...(channelId ? { channelId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {})
  };
}

function runMatchesChatFilters(run: INeonGatewayShadowRun, filters: INeonChatFilters): boolean {
  return (
    (!filters.channelId || run.request.channelId === filters.channelId) &&
    (!filters.agentId || run.request.agentId === filters.agentId) &&
    (!filters.conversationId || createNeonChatConversationId(run.request) === filters.conversationId) &&
    (!filters.runId || run.runId === filters.runId) &&
    (!filters.sessionKey || run.harnessSessionKey === filters.sessionKey)
  );
}

function hasActiveChatFilters(filters: INeonChatFilters): boolean {
  return Boolean(
    filters.channelId || filters.conversationId || filters.runId || filters.sessionKey || filters.agentId
  );
}

function normalizeChatFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized && normalized.length > 0 ? normalized : undefined;
}

function createNeonChatConversations(
  runs: readonly INeonGatewayShadowRun[]
): readonly INeonChatConversation[] {
  const conversations = new Map<string, IConversationAccumulator>();

  for (const run of runs) {
    const conversationId = createNeonChatConversationId(run.request);
    let conversation = conversations.get(conversationId);

    if (!conversation) {
      conversation = createConversationAccumulator(conversationId, run.request);
      conversations.set(conversationId, conversation);
    }

    conversation.runCount += 1;
    conversation.latestAt = run.completedAt > conversation.latestAt ? run.completedAt : conversation.latestAt;
    conversation.agents.add(run.request.agentId);
    conversation.users.add(run.request.userDisplayName ?? run.request.userId);
    conversation.messages.push(createInboundChatMessage(conversationId, run));
    conversation.messages.push(createAgentChatMessage(conversationId, run));
  }

  return Array.from(conversations.values())
    .map(freezeConversation)
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

function createConversationAccumulator(
  conversationId: string,
  request: INeonGatewayRunRequest
): IConversationAccumulator {
  const base = {
    conversationId,
    channel: request.channel,
    accountId: request.accountId,
    channelId: request.channelId,
    latestAt: request.receivedAt,
    runCount: 0,
    agents: new Set<string>(),
    users: new Set<string>(),
    messages: []
  };

  return {
    ...base,
    ...(request.guildId ? { guildId: request.guildId } : {}),
    ...(request.threadId ? { threadId: request.threadId } : {})
  };
}

function freezeConversation(accumulator: IConversationAccumulator): INeonChatConversation {
  return {
    conversationId: accumulator.conversationId,
    title: createConversationTitle(accumulator),
    channel: accumulator.channel,
    accountId: accumulator.accountId,
    ...(accumulator.guildId ? { guildId: accumulator.guildId } : {}),
    channelId: accumulator.channelId,
    ...(accumulator.threadId ? { threadId: accumulator.threadId } : {}),
    latestAt: accumulator.latestAt,
    runCount: accumulator.runCount,
    messageCount: accumulator.messages.length,
    agents: Array.from(accumulator.agents).sort(),
    users: Array.from(accumulator.users).sort(),
    messages: accumulator.messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  };
}

function createInboundChatMessage(
  conversationId: string,
  run: INeonGatewayShadowRun
): INeonChatMessage {
  const request = run.request;

  return {
    messageId: request.messageId ?? `${run.runId}:inbound`,
    runId: run.runId,
    conversationId,
    direction: "inbound",
    channel: request.channel,
    accountId: request.accountId,
    ...(request.guildId ? { guildId: request.guildId } : {}),
    channelId: request.channelId,
    ...(request.threadId ? { threadId: request.threadId } : {}),
    userId: request.userId,
    ...(request.userDisplayName ? { userDisplayName: request.userDisplayName } : {}),
    agentId: request.agentId,
    textPreview: request.contentPreview,
    toolEvents: [],
    status: run.status,
    memoryState: run.memoryState,
    deliveryState: run.delivery.state,
    createdAt: request.receivedAt
  };
}

function createAgentChatMessage(
  conversationId: string,
  run: INeonGatewayShadowRun
): INeonChatMessage {
  const request = run.request;

  return {
    messageId: `${run.runId}:agent`,
    runId: run.runId,
    conversationId,
    direction: "agent",
    channel: request.channel,
    accountId: request.accountId,
    ...(request.guildId ? { guildId: request.guildId } : {}),
    channelId: request.channelId,
    ...(request.threadId ? { threadId: request.threadId } : {}),
    userId: "neonika",
    userDisplayName: request.agentId,
    agentId: request.agentId,
    textPreview: run.finalText,
    toolEvents: createChatToolEvents(run),
    status: run.status,
    memoryState: run.memoryState,
    deliveryState: run.delivery.state,
    createdAt: run.completedAt
  };
}

function createChatToolEvents(run: INeonGatewayShadowRun): readonly INeonChatToolEvent[] {
  return run.events.flatMap((event, index) => {
    if (isHarnessEventHiddenFromChannelProgress(event)) {
      return [];
    }

    const sequence = index + 1;
    const id = `${run.runId}:tool-event:${String(sequence).padStart(3, "0")}`;

    return createChatToolEvent(id, event, sequence);
  });
}

function createChatToolEvent(
  id: string,
  event: TCodexHarnessEvent,
  sequence: number
): readonly INeonChatToolEvent[] {
  switch (event.kind) {
    case "tool-start":
      return [
        {
          id,
          kind: "tool-start",
          status: "started",
          title: `Tool ${event.toolName}`,
          summary: `${event.toolName} started.`,
          toolName: event.toolName,
          ...(event.toolCallId ? { toolCallId: redactChatText(event.toolCallId) } : {}),
          sequence
        }
      ];
    case "tool-output":
      return [
        {
          id,
          kind: "tool-output",
          status: "done",
          title: `Tool ${event.toolName}`,
          summary: `${event.toolName} returned output.`,
          preview: redactChatText(event.output),
          toolName: event.toolName,
          ...(event.toolCallId ? { toolCallId: redactChatText(event.toolCallId) } : {}),
          sequence
        }
      ];
    case "file-write":
      return [
        {
          id,
          kind: "file-write",
          status: "done",
          title: "File write",
          summary: "A worker reported a file write.",
          preview: redactChatText(event.path),
          sequence
        }
      ];
    case "command-exit":
      return [
        {
          id,
          kind: "command-exit",
          status: event.exitCode === 0 ? "done" : "error",
          title: "Command exit",
          summary: `${redactChatText(event.command)} exited ${event.exitCode}.`,
          exitCode: event.exitCode,
          sequence
        }
      ];
    case "assistant-delta":
    case "token-usage":
    case "final":
    case "failed":
      return [];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function redactChatText(value: string): string {
  return redactText(value)
    .replace(/(^|[\s"'`=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)[^\s"'`,;]+/g, "$1[REDACTED_PATH]")
    .trim();
}

function createConversationTitle(conversation: IConversationAccumulator): string {
  const thread = conversation.threadId ? ` / thread ${conversation.threadId}` : "";

  return `${conversation.channel} / ${conversation.channelId}${thread}`;
}

export function createNeonChatConversationId(request: INeonGatewayRunRequest): string {
  const key = [
    request.channel,
    request.accountId,
    request.guildId ?? "dm",
    request.channelId,
    request.threadId ?? "main"
  ].join(":");

  return `chat-${createHash("sha256").update(key).digest("hex").slice(0, 18)}`;
}
