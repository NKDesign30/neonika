import type { ICodexAppServerClient } from "./appServerProtocol.js";
import { createHash } from "node:crypto";

import {
  evaluateNeonBindingResume,
  readCodexThreadBinding,
  writeCodexThreadBinding,
  type ICodexThreadBinding
} from "./bindingStore.js";
import { redactHarnessEvent, redactText } from "./redaction.js";
import { wrapUntrustedExternalContent } from "../security/externalContent.js";
import { neonPeekabooDynamicToolSpec } from "../tools/peekabooDynamicTool.js";
import { resolveNeonDiscordWorkGovernanceInstruction } from "../gateway/discordPlanApproval.js";
import { deriveCodexSessionKey } from "./sessionKey.js";
import {
  projectCodexNotification,
  startCodexTurn,
  startOrResumeCodexThread,
  type TCodexApprovalPolicy,
  type TCodexReasoningEffort,
  type TCodexProgressItemType,
  type TCodexRunEvent,
  type TCodexSandboxMode,
  type TCodexTurnStatus
} from "./threadRun.js";
import type {
  ICodexHarness,
  ICodexHarnessInput,
  ICodexHarnessResult,
  TCodexHarnessEvent,
  THarnessRunMode
} from "./types.js";

export interface ICodexAppServerHarnessClientLease {
  readonly client: ICodexAppServerClient;
  release(): Promise<void>;
}

export type TCodexAppServerHarnessClientProvider = () =>
  | ICodexAppServerHarnessClientLease
  | Promise<ICodexAppServerHarnessClientLease>;

export interface ICodexAppServerHarnessOptions {
  readonly projectRoot: string;
  readonly acquireClient: TCodexAppServerHarnessClientProvider;
  readonly inFlightRuns?: ICodexAppServerHarnessLifecycleRegistry;
  readonly model?: string;
  readonly effort?: TCodexReasoningEffort;
  readonly enableCapacityUpgradeRequests?: boolean;
  readonly approvalPolicy?: TCodexApprovalPolicy;
  readonly sandbox?: TCodexSandboxMode;
  readonly turnCompletionTimeoutMs?: number;
}

export interface ICodexAppServerHarnessLifecycleRegistry {
  onRunStart(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly sessionKey: string;
    readonly agentId: string;
    readonly channel: ICodexHarnessInput["binding"]["channel"];
  }): unknown | null;
  recordActivity(runId: string): void;
  onRunEnd(runId: string): void;
}

export function createCodexAppServerHarness(options: ICodexAppServerHarnessOptions): ICodexHarness {
  return {
    id: "codex-app-server",
    run: async (input) => await runCodexAppServerHarnessTurn(options, input)
  };
}

async function runCodexAppServerHarnessTurn(
  options: ICodexAppServerHarnessOptions,
  input: ICodexHarnessInput
): Promise<ICodexHarnessResult> {
  const sessionKey = deriveCodexSessionKey(input.binding);
  const events: TCodexHarnessEvent[] = [];
  const assistantText: string[] = [];
  const lease = await options.acquireClient();
  const approvalPolicy = options.approvalPolicy ?? resolveApprovalPolicy(input.binding.mode);
  const sandbox = options.sandbox ?? resolveSandbox(input.binding.mode);
  const persistedBinding = await readCodexThreadBinding(options.projectRoot, sessionKey);
  let completionStatus: TCodexTurnStatus | undefined;
  let completionFailure: string | undefined;
  let lifecycleTrackedRunId: string | undefined;
  let lifecycleStartAttempted = false;
  const trackLifecycleRun = (threadId: string, turnId: string): void => {
    if (!input.runId || !options.inFlightRuns || lifecycleStartAttempted) {
      return;
    }

    lifecycleStartAttempted = true;
    const tracked = options.inFlightRuns.onRunStart({
      runId: input.runId,
      threadId,
      turnId,
      sessionKey,
      agentId: input.binding.agentId,
      channel: input.binding.channel
    });

    if (tracked !== null) {
      lifecycleTrackedRunId = input.runId;
      options.inFlightRuns.recordActivity(lifecycleTrackedRunId);
    }
  };
  // Reasoning deltas are buffered (never persisted per-token) and surface once
  // as the completed reasoning item's detail — the card's 🧠 line with content.
  const reasoningBuffers = new Map<string, string>();
  const REASONING_BUFFER_TAIL_CHARS = 400;
  const REASONING_DETAIL_CHARS = 120;
  const unsubscribe = lease.client.subscribe((notification) => {
    let projected = projectCodexNotification(notification);

    if (projected.type === "reasoning.delta") {
      const merged = `${reasoningBuffers.get(projected.itemId) ?? ""}${projected.text}`;
      reasoningBuffers.set(projected.itemId, merged.slice(-REASONING_BUFFER_TAIL_CHARS));
      return;
    }

    if (
      projected.type === "item.progress" &&
      projected.itemType === "reasoning" &&
      projected.phase === "completed"
    ) {
      const buffered = reasoningBuffers.get(projected.itemId)?.replace(/\s+/gu, " ").trim();
      reasoningBuffers.delete(projected.itemId);
      if (buffered) {
        projected = { ...projected, detail: buffered.slice(-REASONING_DETAIL_CHARS) };
      }
    }

    if (projected.type === "turn.completed") {
      completionStatus = projected.status;
    }

    if (projected.type === "error" && !projected.willRetry) {
      completionFailure = projected.message;
    }

    appendProjectedEvent(projected, events, assistantText, input.onEvent);

    if (projected.type === "turn.started") {
      trackLifecycleRun(projected.threadId, projected.turnId);
    }

    if (lifecycleTrackedRunId && projected.type !== "unknown") {
      options.inFlightRuns?.recordActivity(lifecycleTrackedRunId);
    }
  });

  try {
    await lease.client.initialize();
    const model = options.model ?? persistedBinding?.model;
    const baseInstructions = buildBaseInstructions(
      input,
      options.enableCapacityUpgradeRequests === true,
      options.model,
      options.effort
    );
    const baseInstructionsHash = hashNeonSessionStableBaseInstructions(baseInstructions);

    // Only resume the persisted thread when its binding still matches the current
    // turn spec (cwd / approval / sandbox / model). On drift, start fresh instead
    // of blindly resuming a thread created under a different configuration.
    const resumeThreadId =
      persistedBinding &&
      evaluateNeonBindingResume(persistedBinding, {
        cwd: input.binding.workspaceRoot,
        approvalPolicy,
        sandbox,
        model,
        baseInstructionsHash
      }).matches
        ? persistedBinding.threadId
        : undefined;

    const thread = await startOrResumeCodexThread({
      client: lease.client,
      cwd: input.binding.workspaceRoot,
      approvalPolicy,
      sandbox,
      ephemeral: false,
      baseInstructions,
      dynamicTools: [neonPeekabooDynamicToolSpec],
      ...(resumeThreadId ? { existingThreadId: resumeThreadId } : {}),
      ...(model ? { model } : {})
    });

    await persistThreadBinding(options.projectRoot, {
      sessionKey,
      threadId: thread.threadId,
      cwd: input.binding.workspaceRoot,
      approvalPolicy,
      sandbox,
      memoryState: input.memory.state,
      baseInstructionsHash,
      ...(model ? { model } : {}),
      ...(persistedBinding ? { createdAt: persistedBinding.createdAt } : {})
    });

    const turn = await startCodexTurn({
      client: lease.client,
      threadId: thread.threadId,
      prompt: buildPrompt(input),
      ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      cwd: input.binding.workspaceRoot,
      approvalPolicy,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {})
    });

    trackLifecycleRun(thread.threadId, turn.turnId);

    const finalStatus = await waitForTurnCompletion({
      events,
      turnId: turn.turnId,
      timeoutMs: options.turnCompletionTimeoutMs ?? 60_000,
      ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      getStatus: () => completionStatus ?? turn.status,
      getFailure: () => completionFailure
    });

    const finalText = assistantText.join("").trim() || buildFallbackFinalText(finalStatus);

    recordHarnessEvent(events, { kind: "final", text: finalText }, input.onEvent);

    return finalizeResult(sessionKey, input, events, finalText);
  } catch (error) {
    if (input.abortSignal?.aborted) {
      const message = "Codex app-server turn interrupted by local abort signal.";

      recordHarnessEvent(events, { kind: "final", text: message }, input.onEvent);

      return finalizeResult(sessionKey, input, events, message, true);
    }

    const message = redactText(error instanceof Error ? error.message : "Codex app-server harness failed");

    recordHarnessEvent(events, { kind: "failed", message }, input.onEvent);

    return finalizeResult(sessionKey, input, events, message);
  } finally {
    if (lifecycleTrackedRunId) {
      options.inFlightRuns?.onRunEnd(lifecycleTrackedRunId);
    }
    unsubscribe();
    await lease.release();
  }
}

function appendProjectedEvent(
  projected: TCodexRunEvent,
  events: TCodexHarnessEvent[],
  assistantText: string[],
  onEvent: ((event: TCodexHarnessEvent) => void) | undefined
): void {
  switch (projected.type) {
    case "thread.started":
      recordHarnessEvent(
        events,
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: `thread.started ${projected.threadId}`,
          hideFromChannelProgress: true
        },
        onEvent
      );
      return;
    case "turn.started":
      recordHarnessEvent(
        events,
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: `turn.started ${projected.turnId} status=${projected.status}`,
          hideFromChannelProgress: true
        },
        onEvent
      );
      return;
    case "assistant.delta":
      assistantText.push(projected.text);
      recordHarnessEvent(events, { kind: "assistant-delta", text: projected.text }, onEvent);
      return;
    case "turn.completed":
      if (projected.status === "failed") {
        recordHarnessEvent(
          events,
          {
            kind: "failed",
            message: `turn.completed ${projected.turnId} status=${projected.status}`
          },
          onEvent
        );

        return;
      }

      recordHarnessEvent(
        events,
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: `turn.completed ${projected.turnId} status=${projected.status}`,
          hideFromChannelProgress: true
        },
        onEvent
      );
      return;
    case "error":
      recordHarnessEvent(
        events,
        projected.willRetry
          ? {
              kind: "tool-output",
              toolName: "codex-app-server",
              output: `transient error; retrying: ${projected.message}`,
              hideFromChannelProgress: true
            }
          : { kind: "failed", message: projected.message },
        onEvent
      );
      return;
    case "item.progress":
      recordHarnessEvent(
        events,
        projected.phase === "started"
          ? {
              kind: "tool-start",
              toolName: progressToolNameForItemType(projected.itemType),
              ...(projected.detail ? { detail: projected.detail } : {})
            }
          : {
              kind: "tool-output",
              toolName: progressToolNameForItemType(projected.itemType),
              output: `item.completed ${projected.itemType}`,
              ...(projected.detail ? { detail: projected.detail } : {})
            },
        onEvent
      );
      return;
    case "reasoning.delta":
      // Buffered upstream in the subscribe handler; never persisted per-token.
      return;
    case "unknown":
      return;
    default: {
      const exhaustive: never = projected;
      return exhaustive;
    }
  }
}

// Category constants only — never raw commands, paths, or queries. The Discord
// progress card and run store treat these names as leak-safe labels.
function progressToolNameForItemType(itemType: TCodexProgressItemType): string {
  const names: Readonly<Record<TCodexProgressItemType, string>> = {
    commandExecution: "command",
    fileChange: "file-change",
    webSearch: "web-search",
    mcpToolCall: "mcp-tool",
    reasoning: "reasoning",
    imageView: "image-view"
  };
  return names[itemType];
}

function recordHarnessEvent(
  events: TCodexHarnessEvent[],
  event: TCodexHarnessEvent,
  onEvent: ((event: TCodexHarnessEvent) => void) | undefined
): void {
  events.push(event);
  onEvent?.(event);
}

async function waitForTurnCompletion(input: {
  readonly events: readonly TCodexHarnessEvent[];
  readonly turnId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly getStatus: () => TCodexTurnStatus;
  readonly getFailure: () => string | undefined;
}): Promise<TCodexTurnStatus> {
  const startedAt = Date.now();

  while (true) {
    const failure = input.getFailure() ?? readFailureMessage(input.events);

    if (failure) {
      throw new Error(failure);
    }

    const status = input.getStatus();

    if (status === "failed") {
      throw new Error(`Codex app-server turn ${input.turnId} failed`);
    }

    if (isTerminalTurnStatus(status) || hasTurnCompletion(input.events, input.turnId)) {
      return status;
    }

    if (input.signal?.aborted) {
      throw new Error(`Codex app-server turn ${input.turnId} interrupted by local abort signal`);
    }

    if (Date.now() - startedAt > input.timeoutMs) {
      throw new Error(`Codex app-server turn ${input.turnId} did not complete within ${input.timeoutMs}ms`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function readFailureMessage(events: readonly TCodexHarnessEvent[]): string | undefined {
  return events.find((event) => event.kind === "failed")?.message;
}

function isTerminalTurnStatus(status: TCodexTurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function hasTurnCompletion(events: readonly TCodexHarnessEvent[], turnId: string): boolean {
  return events.some((event) => {
    if (event.kind === "tool-output") {
      return event.toolName === "codex-app-server" && event.output.includes(`turn.completed ${turnId}`);
    }

    if (event.kind === "failed") {
      return event.message.includes(`turn.completed ${turnId}`);
    }

    return false;
  });
}

function buildPrompt(input: ICodexHarnessInput): string {
  return [
    ...renderAgentPrompt(input.agent),
    `Neonika Memory: ${input.memory.state}; hits=${input.memory.hitCount}; note=${input.memory.note}`,
    ...renderMemoryExcerpts(input.memory),
    "",
    input.prompt
  ].join("\n");
}

function renderMemoryExcerpts(memory: ICodexHarnessInput["memory"]): readonly string[] {
  if (!memory.excerpts || memory.excerpts.length === 0) {
    return [];
  }

  const renderedExcerpts = memory.excerpts.flatMap((excerpt, index) => {
    const wrapped = wrapUntrustedExternalContent(excerpt.text, { source: "memory" });

    return [`${index + 1}. [${excerpt.source}]`, wrapped.text];
  });

  return ["Neonika Memory excerpts:", ...renderedExcerpts];
}

function renderAgentPrompt(agent: ICodexHarnessInput["agent"]): readonly string[] {
  if (!agent) {
    return [];
  }

  return [
    `Neonika Agent: ${agent.displayName} (${agent.id})`,
    `Role: ${agent.role}`,
    `Runtime: ${agent.runtime}`,
    "Agent instructions:",
    ...agent.instructions.map((instruction) => `- ${instruction}`),
    ""
  ];
}

function buildBaseInstructions(
  input: ICodexHarnessInput,
  enableCapacityUpgradeRequests: boolean,
  model: string | undefined,
  effort: TCodexReasoningEffort | undefined
): string {
  const capacityTier = resolveCapacityTier(model);
  return [
    "You are running inside Neonika's Codex app-server harness.",
    `Agent: ${input.binding.agentId}.`,
    ...(input.agent ? [`Agent profile: ${input.agent.displayName} - ${input.agent.role}`] : []),
    ...(input.agent ? input.agent.instructions.map((instruction) => `Agent instruction: ${instruction}`) : []),
    `Channel: ${input.binding.channel}.`,
    "Reply like a normal private chat message: concise, direct, and in the user's language.",
    "For Discord replies, prefer one to three short conversational sentences. Avoid markdown tables, code fences, citations, raw URLs, and heavy visual formatting unless the user explicitly asks or the task truly needs it.",
    "For Discord numbered points, use real newline-separated Markdown list items like `1. ...`; never leave bare inline numbers after a colon such as `Kernidee: 1. ... 2. ...`.",
    "For German and English words, use normal Latin characters only; do not emit Cyrillic homoglyphs such as `Gemerk\u0442`.",
    "Do not include source links, raw URLs, or citation-style link text unless the user explicitly asks for sources or a link is necessary.",
    "When the user asks to inspect or control the local Mac UI, use the `peekaboo` dynamic tool when it is available. Prefer `permissions`, `list apps`, `see`, or `image` through that tool before clicks or typing; only fall back to the peekaboo CLI via $PEEKABOO_BIN in local CLI sessions where no dynamic tool exists. Never claim Screen Recording or Accessibility is missing from memory or stale context; only say it when the current command output reports it.",
    "For ordinary Discord chat or Mac UI checks, do not announce a Neonika Slice plan, do not print acceptance criteria, and do not run project planning workflows. Act directly and then answer with the result.",
    ...(model && effort
      ? [
          `Current runtime truth: model=${model}; effort=${effort}. When asked which model or reasoning effort is active, answer from this runtime truth, never from memory or earlier conversation turns.`
        ]
      : []),
    ...(enableCapacityUpgradeRequests
      ? buildCapacityUpgradeInstructions(capacityTier)
      : []),
    ...(input.binding.channel === "discord"
      ? [
          NEON_DISCORD_POLL_MARKER_INSTRUCTION,
          NEON_DISCORD_CARD_MARKER_INSTRUCTION,
          NEON_DISCORD_BUTTONS_MARKER_INSTRUCTION,
          NEON_DISCORD_FILE_DELIVERY_INSTRUCTION,
          resolveNeonDiscordWorkGovernanceInstruction(input.binding.channelId)
        ]
      : []),
    "You may invoke credential CLIs such as op (1Password) when a task genuinely needs a credential (for example a deploy token); never print or disclose the secret values themselves.",
    "Do not disclose secrets."
  ].join("\n");
}

/**
 * Shared Discord poll capability instruction for agent-facing base
 * instructions (Codex + Claude lanes). Marker grammar must stay in sync with
 * parseNeonDiscordPollMarker (gateway/discordPollMarker.ts).
 */
export const NEON_DISCORD_POLL_MARKER_INSTRUCTION =
  'You can attach a native Discord poll to your final answer. Only when a vote or group decision genuinely helps (the user asks for a poll, or several options need the group\'s pick), append exactly one marker on its own line at the very end of your final answer: <NEON_POLL question="..." duration_hours="24" multi="false">Option A|Option B|Option C</NEON_POLL>. Rules: 2-10 options separated by |, question up to 300 characters, each option up to 55 characters, duration_hours 1-768 (default 24), multi="true" allows selecting several options. Never use a poll for ordinary answers and never emit the marker anywhere except the end of the final answer.';

/**
 * Shared Discord rich-card capability instruction. Marker grammar must stay in
 * sync with parseNeonDiscordCardMarker (gateway/discordCardMarker.ts).
 */
/**
 * Shared Discord quick-reply buttons instruction. Marker grammar must stay in
 * sync with parseNeonDiscordButtonsMarker (gateway/discordAgentButtons.ts).
 */
export const NEON_DISCORD_BUTTONS_MARKER_INSTRUCTION =
  'You can offer quick-reply buttons under your final answer. Only when an obvious next step exists (continue/abort, pick one of a few follow-ups), append exactly one marker on its own line at the very end of your final answer: <NEON_BUTTONS>Weiter|Abbrechen|Details zeigen</NEON_BUTTONS>. Rules: 1-5 labels separated by |, each label up to 80 characters; clicking a button sends that label back to you as the user\'s next message, so each label must work as a standalone instruction. Never use buttons for ordinary answers and never emit the marker anywhere except the end of the final answer.';

export const NEON_DISCORD_FILE_DELIVERY_INSTRUCTION =
  "Whenever a task creates or updates user deliverable files, the final reply must include every deliverable file as a project-local path wrapped in backticks. This includes PDFs, Word documents, spreadsheets, slide decks, archives, images, audio, and video. Neonika converts supported paths into real Discord attachments in the originating thread. Never claim the file is finished while omitting its path. For PDFs, include only the verified published PDF path and keep the PDF review/finalization gate intact.";

export const NEON_DISCORD_CARD_MARKER_INSTRUCTION =
  'You can attach one rich Discord card (an embed with a colored accent bar) to your final answer. Only when a structured summary genuinely helps (a report, a status overview, a result the user will want to screenshot), append exactly one marker at the very end of your final answer: <NEON_CARD title="..." color="emerald" image="https://...">card body text, may span multiple lines</NEON_CARD>. Rules: title up to 256 characters, body up to 4096 characters, color is one of emerald|red|orange|blurple (default emerald; red only for failures, orange for warnings), image is optional and must be a public https URL. Never use a card for ordinary answers and never emit the marker anywhere except the end of the final answer.';

function resolveCapacityTier(model: string | undefined): "luna" | "terra" | undefined {
  if (model === "gpt-5.6-luna") {
    return "luna";
  }
  return model === "gpt-5.6-terra" ? "terra" : undefined;
}

function buildCapacityUpgradeInstructions(
  currentTier: "luna" | "terra" | undefined
): readonly string[] {
  if (currentTier === "terra") {
    return [
      "Current capacity tier: Terra. Before using tools or changing external state, assess whether Terra can complete the task reliably. If Sol is genuinely needed, do not start the work: return exactly one marker and nothing else: <NEON_CAPACITY_UPGRADE tier=\"sol\">short reason</NEON_CAPACITY_UPGRADE>. Terra is already active, so never request Terra. Never request an upgrade for ordinary chat or routine single-workflow tasks."
    ];
  }
  if (currentTier === "luna") {
    return [
      "Current capacity tier: Luna. Before using tools or changing external state, assess whether Luna can complete the task reliably. If more capacity is genuinely needed, do not start the work: return exactly one marker and nothing else, either <NEON_CAPACITY_UPGRADE tier=\"terra\">short reason</NEON_CAPACITY_UPGRADE> or <NEON_CAPACITY_UPGRADE tier=\"sol\">short reason</NEON_CAPACITY_UPGRADE>. Never request an upgrade for ordinary chat or routine single-workflow tasks."
    ];
  }
  return [];
}

const sessionVolatileBaseInstructionPrefixes = [
  "Runtime context:",
  "Mention state:",
  "Group context:",
  "Tool scope:"
] as const;

export function hashNeonSessionStableBaseInstructions(baseInstructions: string): string {
  return createHash("sha256")
    .update(normalizeSessionStableBaseInstructions(baseInstructions))
    .digest("hex")
    .slice(0, 16);
}

function normalizeSessionStableBaseInstructions(baseInstructions: string): string {
  return baseInstructions
    .split(/\r?\n/u)
    .filter((line) => !isSessionVolatileBaseInstructionLine(line))
    .join("\n")
    .trim();
}

function isSessionVolatileBaseInstructionLine(line: string): boolean {
  const trimmed = line.trimStart();

  return sessionVolatileBaseInstructionPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

function buildFallbackFinalText(status: TCodexTurnStatus): string {
  return `Codex app-server turn completed with status ${status}.`;
}

async function persistThreadBinding(
  projectRoot: string,
  input: {
    readonly sessionKey: string;
    readonly threadId: string;
    readonly cwd: string;
    readonly model?: string;
    readonly approvalPolicy: TCodexApprovalPolicy;
    readonly sandbox: TCodexSandboxMode;
    readonly memoryState: ICodexHarnessInput["memory"]["state"];
    readonly baseInstructionsHash?: string;
    readonly createdAt?: string;
  }
): Promise<ICodexThreadBinding> {
  return await writeCodexThreadBinding(projectRoot, input);
}

function resolveApprovalPolicy(mode: THarnessRunMode): TCodexApprovalPolicy {
  return mode === "read-only" ? "never" : "on-request";
}

function resolveSandbox(mode: THarnessRunMode): TCodexSandboxMode {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function finalizeResult(
  sessionKey: string,
  input: ICodexHarnessInput,
  events: readonly TCodexHarnessEvent[],
  finalText: string,
  cancelled = false
): ICodexHarnessResult {
  const redactedEvents = events.map(redactHarnessEvent);

  return {
    sessionKey,
    memoryState: input.memory.state,
    events: redactedEvents,
    finalText: redactText(finalText),
    ...(cancelled ? { cancelled: true } : {})
  };
}
