import {
  buildClaudeAllowControlResponse,
  buildClaudeDenyControlResponse,
  buildClaudeUserInputLine,
  projectClaudeStreamMessage,
  type TClaudeStreamCompletion
} from "./claudeStreamProtocol.js";
import { redactHarnessEvent, redactText } from "./redaction.js";
import {
  NEON_DISCORD_BUTTONS_MARKER_INSTRUCTION,
  NEON_DISCORD_CARD_MARKER_INSTRUCTION,
  NEON_DISCORD_FILE_DELIVERY_INSTRUCTION,
  NEON_DISCORD_POLL_MARKER_INSTRUCTION
} from "./codexAppServerHarness.js";
import { deriveCodexSessionKey } from "./sessionKey.js";
import { wrapUntrustedExternalContent } from "../security/externalContent.js";
import { resolveNeonDiscordWorkGovernanceInstruction } from "../gateway/discordPlanApproval.js";
import type { IClaudeStreamTransport } from "./claudeStreamTransport.js";
import type {
  ICodexHarness,
  ICodexHarnessInput,
  ICodexHarnessResult,
  TCodexHarnessEvent,
  THarnessRunMode
} from "./types.js";

/**
 * Claude Code agent backend for Neonika.
 *
 * This is the Claude-side sibling of `createCodexAppServerHarness`: it satisfies
 * the same `ICodexHarness` contract, emits the same `TCodexHarnessEvent` union,
 * and applies the same redaction so Mission Control, replay, and chat snapshots
 * treat a Claude turn exactly like a Codex turn.
 *
 * The transport (a `claude --input-format stream-json --output-format
 * stream-json` process, or a scripted stand-in for tests/dry runs) is injected
 * via `acquireTransport`, mirroring the Codex harness's `acquireClient` seam.
 * The harness owns the protocol mapping and stays read-only by default. Write
 * runs only happen after the gateway run-mode gate admits them; in that mode the
 * same control bridge can approve Claude's native tool requests.
 */

export type TClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type TClaudeCliPermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions";

export interface IClaudeCliTurnSpec {
  readonly args: readonly string[];
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly mode: THarnessRunMode;
  readonly model?: string;
  readonly effort?: TClaudeCliEffort;
  readonly permissionMode?: TClaudeCliPermissionMode;
  readonly addDirs?: readonly string[];
  readonly tools?: string;
}

export interface IClaudeCliHarnessTransportLease {
  readonly transport: IClaudeStreamTransport;
  release(): Promise<void>;
}

export type TClaudeCliHarnessTransportProvider = (
  spec: IClaudeCliTurnSpec
) => IClaudeCliHarnessTransportLease | Promise<IClaudeCliHarnessTransportLease>;

export interface IClaudeCliHarnessOptions {
  readonly acquireTransport: TClaudeCliHarnessTransportProvider;
  readonly model?: string;
  readonly effort?: TClaudeCliEffort;
  readonly permissionMode?: TClaudeCliPermissionMode;
  readonly addDirs?: readonly string[];
  readonly tools?: string;
  readonly turnCompletionTimeoutMs?: number;
  readonly firstEventTimeoutMs?: number;
}

const TOOL_DENY_REASON =
  "Neonika runs the Claude harness read-only; native tool execution is gated behind the cutover.";
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;

export function createClaudeCliHarness(options: IClaudeCliHarnessOptions): ICodexHarness {
  return {
    id: "claude-cli",
    run: async (input) => await runClaudeCliHarnessTurn(options, input)
  };
}

async function runClaudeCliHarnessTurn(
  options: IClaudeCliHarnessOptions,
  input: ICodexHarnessInput
): Promise<ICodexHarnessResult> {
  const sessionKey = deriveCodexSessionKey(input.binding);
  const events: TCodexHarnessEvent[] = [];
  const assistantText: string[] = [];
  const systemPrompt = buildClaudeBaseInstructions(input);
  const spec: IClaudeCliTurnSpec = {
    args: buildClaudeStreamArgs({
      mode: input.binding.mode,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.addDirs ? { addDirs: options.addDirs } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      systemPrompt
    }),
    systemPrompt,
    cwd: input.binding.workspaceRoot,
    mode: input.binding.mode,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(options.addDirs ? { addDirs: options.addDirs } : {}),
    ...(options.tools ? { tools: options.tools } : {})
  };
  const lease = await options.acquireTransport(spec);

  let completion: TClaudeStreamCompletion | undefined;
  let finalText: string | undefined;
  let transportError: string | undefined;
  let transportClosed = false;
  let firstEventReceived = false;

  const unsubscribeMessage = lease.transport.onMessage((raw) => {
    firstEventReceived = true;
    const projection = projectClaudeStreamMessage(raw);

    for (const event of projection.events) {
      if (event.kind === "assistant-delta") {
        assistantText.push(event.text);
      }

      recordHarnessEvent(events, event, input.onEvent);
    }

    if (projection.finalText !== undefined) {
      finalText = projection.finalText;
    }

    if (projection.completion) {
      completion = projection.completion;
    }

    if (projection.controlRequestId) {
      const response =
        input.binding.mode === "read-only"
          ? buildClaudeDenyControlResponse(projection.controlRequestId, TOOL_DENY_REASON)
          : buildClaudeAllowControlResponse(projection.controlRequestId);

      void lease.transport
        .send(response)
        .catch(() => undefined);
    }
  });

  const unsubscribeClose = lease.transport.onClose((error) => {
    if (error) {
      transportError = redactText(error.message);
    }

    transportClosed = true;
  });

  try {
    await lease.transport.send(buildClaudeUserInputLine(buildClaudePrompt(input)));
    const timeoutMs = options.turnCompletionTimeoutMs ?? 60_000;

    const status = await waitForClaudeCompletion({
      timeoutMs,
      firstEventTimeoutMs: resolveClaudeFirstEventTimeoutMs(options.firstEventTimeoutMs, timeoutMs),
      ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      hasFirstEvent: () => firstEventReceived,
      getCompletion: () => completion,
      getTransportError: () => transportError,
      isTransportClosed: () => transportClosed
    });

    if (status === "completed") {
      const text = finalText ?? (assistantText.join("").trim() || "Claude CLI turn completed.");

      recordHarnessEvent(events, { kind: "final", text }, input.onEvent);

      return finalizeResult(sessionKey, input, events, text);
    }

    const failureText = finalText ?? "Claude CLI turn failed.";

    return finalizeResult(sessionKey, input, events, failureText);
  } catch (error) {
    if (input.abortSignal?.aborted) {
      const message = "Claude CLI turn interrupted by local abort signal.";

      recordHarnessEvent(events, { kind: "final", text: message }, input.onEvent);

      return finalizeResult(sessionKey, input, events, message, true);
    }

    const message = redactText(error instanceof Error ? error.message : "Claude CLI harness failed");

    recordHarnessEvent(events, { kind: "failed", message }, input.onEvent);

    return finalizeResult(sessionKey, input, events, message);
  } finally {
    unsubscribeMessage();
    unsubscribeClose();
    await lease.release();
  }
}

async function waitForClaudeCompletion(input: {
  readonly timeoutMs: number;
  readonly firstEventTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly hasFirstEvent: () => boolean;
  readonly getCompletion: () => TClaudeStreamCompletion | undefined;
  readonly getTransportError: () => string | undefined;
  readonly isTransportClosed: () => boolean;
}): Promise<TClaudeStreamCompletion> {
  const startedAt = Date.now();

  while (true) {
    const transportError = input.getTransportError();

    if (transportError) {
      throw new Error(transportError);
    }

    const completion = input.getCompletion();

    if (completion) {
      return completion;
    }

    if (input.isTransportClosed()) {
      throw new Error("Claude CLI stream closed before completing the turn");
    }

    if (input.signal?.aborted) {
      throw new Error("Claude CLI turn interrupted by local abort signal");
    }

    if (
      !input.hasFirstEvent() &&
      input.firstEventTimeoutMs > 0 &&
      Date.now() - startedAt >= input.firstEventTimeoutMs
    ) {
      throw new Error(`Claude CLI stream did not emit a first event within ${input.firstEventTimeoutMs}ms`);
    }

    if (Date.now() - startedAt > input.timeoutMs) {
      throw new Error(`Claude CLI turn did not complete within ${input.timeoutMs}ms`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function resolveClaudeFirstEventTimeoutMs(
  firstEventTimeoutMs: number | undefined,
  turnCompletionTimeoutMs: number
): number {
  if (firstEventTimeoutMs !== undefined) {
    if (!Number.isFinite(firstEventTimeoutMs) || firstEventTimeoutMs <= 0) {
      return 0;
    }

    return Math.min(Math.floor(firstEventTimeoutMs), turnCompletionTimeoutMs);
  }

  return Math.min(DEFAULT_FIRST_EVENT_TIMEOUT_MS, turnCompletionTimeoutMs);
}

export function buildClaudeStreamArgs(input: {
  readonly mode: THarnessRunMode;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly effort?: TClaudeCliEffort;
  readonly permissionMode?: TClaudeCliPermissionMode;
  readonly addDirs?: readonly string[];
  readonly tools?: string;
}): readonly string[] {
  // Built from the upstream live-session arg set (claude-live-session.ts
  // buildClaudeLiveArgs) plus `--verbose`: piped stdin runs claude in print
  // mode, where `--output-format stream-json` is rejected without `--verbose`
  // (verified live against claude 2.1.162). `--permission-prompt-tool stdio`
  // routes `can_use_tool` requests as control_request frames the harness answers.
  const permissionMode = input.permissionMode ?? resolveClaudePermissionMode(input.mode);

  return [
    ...(permissionMode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    permissionMode,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.tools ? ["--tools", input.tools] : []),
    ...(input.addDirs?.flatMap((dir) => ["--add-dir", dir]) ?? []),
    "--append-system-prompt",
    input.systemPrompt
  ];
}

function resolveClaudePermissionMode(mode: THarnessRunMode): TClaudeCliPermissionMode {
  // read-only chat: every can_use_tool control request is denied by the harness,
  // so no tool runs. write mode (only reachable once the run-mode gate is open)
  // lets Claude apply edits without prompting.
  return mode === "read-only" ? "default" : "acceptEdits";
}

function recordHarnessEvent(
  events: TCodexHarnessEvent[],
  event: TCodexHarnessEvent,
  onEvent: ((event: TCodexHarnessEvent) => void) | undefined
): void {
  events.push(event);
  onEvent?.(event);
}

function buildClaudePrompt(input: ICodexHarnessInput): string {
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

function buildClaudeBaseInstructions(input: ICodexHarnessInput): string {
  return [
    "You are running inside Neonika's Claude CLI harness.",
    `Agent: ${input.binding.agentId}.`,
    ...(input.agent ? [`Agent profile: ${input.agent.displayName} - ${input.agent.role}`] : []),
    ...(input.agent ? input.agent.instructions.map((instruction) => `Agent instruction: ${instruction}`) : []),
    `Channel: ${input.binding.channel}.`,
    "Reply like a normal private chat message: concise, direct, and in the user's language.",
    "For Discord replies, prefer one to three short conversational sentences. Avoid markdown tables, code fences, citations, raw URLs, and heavy visual formatting unless the user explicitly asks or the task truly needs it.",
    "For Discord numbered points, use real newline-separated Markdown list items like `1. ...`; never leave bare inline numbers after a colon such as `Kernidee: 1. ... 2. ...`.",
    "For German and English words, use normal Latin characters only; do not emit Cyrillic homoglyphs such as `Gemerk\u0442`.",
    "Do not include source links, raw URLs, or citation-style link text unless the user explicitly asks for sources or a link is necessary.",
    "For ordinary chat, do not announce a Neonika Slice plan, do not print acceptance criteria, and do not run project planning workflows. Act directly and then answer with the result.",
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
