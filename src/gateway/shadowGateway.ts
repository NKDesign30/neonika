import { createHash } from "node:crypto";

import { resolveNeonAgentAttachment } from "../agents/registry.js";
import { redactText } from "../harness/redaction.js";
import { resolveNeonHarnessRunMode } from "../harness/runModeGate.js";
import { deriveCodexSessionKey } from "../harness/sessionKey.js";
import {
  detectSuspiciousExternalContentPatterns,
  wrapUntrustedExternalContent
} from "../security/externalContent.js";
import type {
  IAgentAttachment,
  ICodexHarness,
  ICodexHarnessInput,
  ICodexSessionBinding,
  TCodexHarnessEvent
} from "../harness/types.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import type {
  INeonGatewayInboundAttachment,
  INeonGatewayInboundMessage,
  INeonGatewayPersistedFinding,
  INeonGatewayPromptContextMessage,
  INeonGatewayRunRequest,
  INeonGatewayShadowInput,
  INeonGatewayShadowResult,
  INeonGatewayShadowRun,
  TNeonGatewayRunStatus
} from "./types.js";

const previewMaxLength = 180;

export interface INeonGatewayShadowOptions {
  readonly harness: ICodexHarness;
  readonly now?: () => Date;
  readonly createRunId?: (message: INeonGatewayInboundMessage, startedAt: string) => string;
  readonly onRunStarted?: (run: INeonGatewayShadowRun) => Promise<void> | void;
  readonly onHarnessEvent?: (event: TCodexHarnessEvent) => void;
  readonly resolveAbortSignal?: (
    runId: string,
    message: INeonGatewayInboundMessage
  ) => AbortSignal | undefined;
  readonly resolveAgent?: (agentId: string, message: INeonGatewayInboundMessage) => IAgentAttachment | undefined;
}

export async function runNeonGatewayShadow(
  input: INeonGatewayShadowInput,
  options: INeonGatewayShadowOptions
): Promise<INeonGatewayShadowResult> {
  const startedAt = resolveNow(options).toISOString();
  const runId = options.createRunId?.(input.message, startedAt) ?? createShadowRunId(input.message, startedAt);
  const abortSignal = options.resolveAbortSignal?.(runId, input.message);
  const harnessInput = createHarnessInputFromGatewayMessage(
    input,
    options.resolveAgent,
    runId,
    abortSignal,
    options.onHarnessEvent
  );
  const request = createGatewayRunRequest(input.message, startedAt);

  await options.onRunStarted?.(
    createGatewayRunningRun({
      input,
      request,
      runId,
      harnessId: options.harness.id,
      ...(options.harness.runtime ? { runtime: options.harness.runtime } : {}),
      harnessSessionKey: deriveCodexSessionKey(harnessInput.binding),
      startedAt
    })
  );

  const harness = await options.harness.run(harnessInput);
  const completedAt = resolveNow(options).toISOString();
  const status = resolveRunStatus(harness.events, harness.cancelled === true);
  const finalText = redactText(harness.finalText);

  return {
    harness,
    run: {
      runId,
      mode: "shadow",
      status,
      request,
      harnessId: options.harness.id,
      ...(options.harness.runtime ? { runtime: options.harness.runtime } : {}),
      harnessSessionKey: harness.sessionKey,
      memoryState: harness.memoryState,
      events: harness.events,
      finalText,
      delivery: {
        state: "suppressed",
        targetChannel: input.message.channel,
        targetChannelId: input.message.channelId,
        reason: "shadow-mode",
        finalText
      },
      startedAt,
      completedAt
    }
  };
}

export interface INeonGatewayDeliveredReplyOutcome {
  readonly messageId: string;
  readonly reason?: string;
}

/**
 * Marks a persisted run as having produced a real outbound delivery. Runs are
 * born `shadow`/`suppressed`; once a canary/primary reply is actually sent (a
 * real channel message id is returned), the tap re-persists the run through
 * this helper so the audit record stops claiming the reply was suppressed.
 * Pure: shadow audit runs that never deliver are never passed here.
 */
export function markNeonGatewayRunDelivered(
  run: INeonGatewayShadowRun,
  outcome: INeonGatewayDeliveredReplyOutcome
): INeonGatewayShadowRun {
  return {
    ...run,
    mode: "live",
    delivery: {
      ...run.delivery,
      state: "delivered",
      reason: outcome.reason ?? "canary-reply",
      messageId: outcome.messageId
    }
  };
}

interface ICreateGatewayRunningRunParams {
  readonly input: INeonGatewayShadowInput;
  readonly request: INeonGatewayRunRequest;
  readonly runId: string;
  readonly harnessId: ICodexHarness["id"];
  readonly runtime?: ICodexHarness["runtime"];
  readonly harnessSessionKey: string;
  readonly startedAt: string;
}

function createGatewayRunningRun(params: ICreateGatewayRunningRunParams): INeonGatewayShadowRun {
  return {
    runId: params.runId,
    mode: "shadow",
    status: "running",
    request: params.request,
    harnessId: params.harnessId,
    ...(params.runtime ? { runtime: params.runtime } : {}),
    harnessSessionKey: params.harnessSessionKey,
    memoryState: params.input.memory.state,
    events: [],
    finalText: "",
    delivery: {
      state: "suppressed",
      targetChannel: params.input.message.channel,
      targetChannelId: params.input.message.channelId,
      reason: "shadow-mode",
      finalText: ""
    },
    startedAt: params.startedAt,
    completedAt: params.startedAt
  };
}

export function createHarnessInputFromGatewayMessage(
  input: INeonGatewayShadowInput,
  resolveAgent: INeonGatewayShadowOptions["resolveAgent"] = defaultResolveAgent,
  runId?: string,
  abortSignal?: AbortSignal,
  onEvent?: (event: TCodexHarnessEvent) => void
): ICodexHarnessInput {
  const agent = resolveGatewayAgentOrThrow(input, resolveAgent);

  return {
    ...(runId ? { runId } : {}),
    ...(abortSignal ? { abortSignal } : {}),
    ...(onEvent ? { onEvent } : {}),
    prompt: renderGatewayPrompt(input.message),
    binding: createSessionBindingFromGatewayMessage(input.message),
    memory: input.memory,
    agent
  };
}

function resolveGatewayAgentOrThrow(
  input: INeonGatewayShadowInput,
  resolveAgent: INeonGatewayShadowOptions["resolveAgent"] = defaultResolveAgent
): IAgentAttachment {
  const agent = input.agent ?? resolveAgent(input.message.agentId, input.message);

  if (!agent) {
    throw new Error("Neonika Gateway agent profile not resolved");
  }

  return agent;
}

export function createSessionBindingFromGatewayMessage(
  message: INeonGatewayInboundMessage,
  env: Readonly<Record<string, string | undefined>> = process.env
): ICodexSessionBinding {
  return {
    channel: message.channel,
    accountId: message.accountId,
    channelId: message.channelId,
    agentId: message.agentId,
    workspaceRoot: message.workspaceRoot,
    // Write-mode gate: a `write` request only survives behind an explicit env
    // flag; otherwise it is forced to read-only (see resolveNeonHarnessRunMode).
    mode: resolveNeonHarnessRunMode(message.mode, env).mode,
    ...(message.sessionPeerKey ? { sessionPeerKey: message.sessionPeerKey } : {}),
    ...(message.guildId ? { guildId: message.guildId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {})
  };
}

export function renderGatewayPrompt(message: INeonGatewayInboundMessage): string {
  const content = message.content.trim().length > 0 ? message.content : "[no text content]";
  const wrappedContent = wrapUntrustedExternalContent(content, {
    source: message.channel === "discord" ? "discord" : "unknown"
  });
  const contextLines = renderGatewayContextLines(message.context);
  const attachmentLines = renderGatewayAttachmentLines(message.attachments);

  return [
    "Neonika Gateway inbound message.",
    `Channel: ${message.channel}`,
    `Agent: ${message.agentId}`,
    `User: ${message.userDisplayName ?? message.userId}`,
    `Run mode: ${message.mode}`,
    ...contextLines,
    "",
    "Message:",
    wrappedContent.text,
    ...attachmentLines
  ].join("\n");
}

function renderGatewayContextLines(context: readonly INeonGatewayPromptContextMessage[] | undefined): readonly string[] {
  if (!context || context.length === 0) {
    return [];
  }

  const lines = context.slice(-12).flatMap((entry, index) => {
    const speaker =
      entry.direction === "agent"
        ? `${entry.agentId} reply`
        : entry.userDisplayName
          ? `${entry.userDisplayName} (${entry.agentId})`
          : entry.agentId;
    const wrapped = wrapUntrustedExternalContent(entry.text, {
      source: "discord",
      maxChars: 700
    });

    return [`Context ${index + 1}: ${entry.direction} ${speaker}`, wrapped.text];
  });

  return [
    "",
    "Recent Discord context:",
    "Use this only to resolve references in the current message. Current message still wins.",
    ...lines
  ];
}

function renderGatewayAttachmentLines(
  attachments: readonly INeonGatewayInboundAttachment[] | undefined
): readonly string[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const hasAudio = attachments.some((attachment) => attachment.kind === "audio");
  return [
    "",
    "Attachments:",
    ...attachments.map((attachment, index) => {
      const labels = [
        `#${index + 1}`,
        attachment.voiceMessage ? "voice-message" : attachment.kind,
        attachment.contentType ?? "unknown-mime",
        attachment.name
      ];
      const details = [
        typeof attachment.sizeBytes === "number" ? `size=${attachment.sizeBytes}` : undefined,
        typeof attachment.durationSeconds === "number" ? `duration=${attachment.durationSeconds}s` : undefined,
        `url=${attachment.url}`
      ].filter((value): value is string => value !== undefined);

      return `- ${labels.join(" | ")} | ${details.join(" | ")}`;
    }),
    hasAudio
      ? "Audio note: treat attached audio as the user's voice input. If the runtime cannot transcribe it, say so briefly and answer from available context."
      : ""
  ].filter((line) => line.length > 0);
}

export function createGatewayRunRequest(
  message: INeonGatewayInboundMessage,
  fallbackReceivedAt?: string
): INeonGatewayRunRequest {
  const suspiciousFindings = collectPersistedFindings(message.content);
  const requestedVoiceReply = detectNeonDiscordVoiceReplyRequest(message.content);

  return {
    channel: message.channel,
    accountId: message.accountId,
    channelId: message.channelId,
    userId: message.userId,
    agentId: message.agentId,
    workspaceRoot: message.workspaceRoot,
    mode: message.mode,
    ...(message.goal ? { goal: createGoalPreview(message.goal) } : {}),
    contentPreview: createContentPreview(message.content),
    receivedAt: message.createdAt ?? fallbackReceivedAt ?? new Date().toISOString(),
    ...(message.guildId ? { guildId: message.guildId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.userDisplayName ? { userDisplayName: message.userDisplayName } : {}),
    ...(message.attachments?.some((attachment) => attachment.kind === "audio") ? { sourceHadVoiceAttachment: true } : {}),
    ...(requestedVoiceReply ? { requestedVoiceReply } : {}),
    ...(suspiciousFindings.length > 0 ? { suspiciousFindings } : {})
  };
}

export function detectNeonDiscordVoiceReplyRequest(content: string): boolean {
  const normalized = content
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return [
    /\bbitte\b.{0,80}\b(?:mit|per|als)\b.{0,30}\b(?:sprachnachricht|voice(?: message)?|audio)\b.{0,80}\b(?:antwort|antworte|antworten|reply|zurück)/u,
    /\b(?:antwort|antworte|antworten|reply)\b.{0,80}\b(?:mit|per|als)\b.{0,30}\b(?:sprachnachricht|voice(?: message)?|audio)\b/u,
    /\b(?:schick|sende|send)\b.{0,80}\b(?:sprachnachricht|voice(?: message)?|audio)\b/u
  ].some((pattern) => pattern.test(normalized));
}

/**
 * Builds the persisted suspicious-findings list for a run request. Detection runs
 * on the redacted content so the persisted counts match the suspicious preview tag
 * built by createSuspiciousPreviewTag. Only id/severity/count are kept; the label is
 * dropped on purpose (see INeonGatewayPersistedFinding) and no raw content is stored.
 */
function collectPersistedFindings(content: string): readonly INeonGatewayPersistedFinding[] {
  const findings = detectSuspiciousExternalContentPatterns(redactText(content));

  return findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    count: finding.count
  }));
}

export function createShadowRunId(message: INeonGatewayInboundMessage, startedAt: string): string {
  const hash = createHash("sha256")
    .update(
      [
        message.channel,
        message.accountId,
        message.guildId ?? "",
        message.channelId,
        message.threadId ?? "",
        message.messageId ?? "",
        message.agentId,
        startedAt
      ].join("\u001f")
    )
    .digest("hex")
    .slice(0, 16);

  return `neon-shadow-${hash}`;
}

function createContentPreview(content: string): string {
  const redacted = redactText(content);
  const display = redacted.replace(/\s+/g, " ").trim();
  const body =
    display.length <= previewMaxLength ? display : `${truncateUtf16Safe(display, previewMaxLength - 1)}…`;

  return `${body}${createSuspiciousPreviewTag(redacted)}`;
}

function createGoalPreview(goal: string): string {
  const display = redactText(goal).replace(/\s+/g, " ").trim();

  return display.length <= previewMaxLength ? display : `${truncateUtf16Safe(display, previewMaxLength - 1)}…`;
}

function createSuspiciousPreviewTag(redacted: string): string {
  const findings = detectSuspiciousExternalContentPatterns(redacted);
  if (findings.length === 0) {
    return "";
  }

  const summary = findings.map((finding) => `${finding.id} x${finding.count}`).join(", ");
  return ` [suspicious: ${summary}]`;
}

function resolveRunStatus(
  events: readonly TCodexHarnessEvent[],
  cancelled: boolean
): TNeonGatewayRunStatus {
  if (cancelled) {
    return "cancelled";
  }

  return events.at(-1)?.kind === "failed" ? "failed" : "completed";
}

function resolveNow(options: INeonGatewayShadowOptions): Date {
  return options.now?.() ?? new Date();
}

function defaultResolveAgent(agentId: string): IAgentAttachment | undefined {
  return resolveNeonAgentAttachment(agentId);
}
