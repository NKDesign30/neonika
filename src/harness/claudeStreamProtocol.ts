import { redactText } from "./redaction.js";
import type { TCodexHarnessEvent } from "./types.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";

/**
 * Pure projection of the Claude Code stream-json protocol onto Neon harness
 * events. This is the Claude-side counterpart to `projectCodexNotification`:
 * the transport spawns `claude --input-format stream-json --output-format
 * stream-json` and emits newline-delimited JSON objects on stdout; each parsed
 * line is handed to `projectClaudeStreamMessage`, which maps it onto the
 * backend-agnostic `TCodexHarnessEvent` union the rest of Neon already consumes.
 *
 * Message shapes are verified against the Claude Code headless docs
 * (https://code.claude.com/docs/en/headless) and the upstream reference
 * implementation (src/agents/cli-runner/claude-live-session.ts). They are
 * parsed defensively: an unrecognised or malformed line projects to no events
 * rather than throwing, so a single odd frame never aborts a turn.
 */

export type TClaudeStreamCompletion = "completed" | "failed";

export interface IClaudeStreamProjection {
  /** Harness events to record/stream for this message (already redacted). */
  readonly events: readonly TCodexHarnessEvent[];
  /** Set when this message terminates the turn (`result` message). */
  readonly completion?: TClaudeStreamCompletion;
  /** Final assistant text carried by a `result` message. */
  readonly finalText?: string;
  /** Session id advertised by any message that carries one. */
  readonly sessionId?: string;
  /** Request id of a `can_use_tool` control request awaiting a response. */
  readonly controlRequestId?: string;
}

const EMPTY_PROJECTION: IClaudeStreamProjection = { events: [] };
const TOOL_RESULT_MAX_CHARS = 8_000;
const TOOL_CALL_CONTENT_TYPES = new Set(["tool_use", "tooluse", "tool_call", "toolcall"]);
const TOOL_CALL_ID_FIELDS = ["id", "tool_use_id", "toolUseId", "tool_call_id", "toolCallId"] as const;
const INLINE_DATA_URI_VALUE_PATTERN =
  /^data:(?:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+)?(?:;[a-z0-9.+-]+(?:=[^,;"'\s]+)?)*,/i;

/**
 * Build the stream-json line written to the `claude` process stdin to start a
 * turn. Matches the upstream live-session input frame exactly so the same
 * `claude` binary accepts it.
 */
export function buildClaudeUserInputLine(prompt: string): string {
  const message = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: prompt
    }
  };

  return `${JSON.stringify(message)}\n`;
}

/**
 * Build the control_response line that answers a `can_use_tool` control
 * request. Read-only runs deny native tool use; write runs can approve it after
 * the gateway run-mode gate has already admitted the side effect.
 */
export function buildClaudeDenyControlResponse(requestId: string, reason: string): string {
  const message = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "deny",
        decisionClassification: "user_reject",
        message: reason
      }
    }
  };

  return `${JSON.stringify(message)}\n`;
}

export function buildClaudeAllowControlResponse(requestId: string): string {
  const message = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput: {}
      }
    }
  };

  return `${JSON.stringify(message)}\n`;
}

export function projectClaudeStreamMessage(raw: unknown): IClaudeStreamProjection {
  const message = asRecord(raw);

  if (!message) {
    return EMPTY_PROJECTION;
  }

  const type = readString(message["type"]);
  const sessionId = readSessionId(message);

  switch (type) {
    case "system":
      return withSessionId(EMPTY_PROJECTION, sessionId);
    case "assistant":
      return withSessionId(projectAssistantMessage(message), sessionId);
    case "user":
      return withSessionId(projectUserMessage(message), sessionId);
    case "result":
      return withSessionId(projectResultMessage(message), sessionId);
    case "control_request":
      return withSessionId(projectControlRequest(message), sessionId);
    default:
      return withSessionId(EMPTY_PROJECTION, sessionId);
  }
}

function projectAssistantMessage(message: IRecord): IClaudeStreamProjection {
  const events: TCodexHarnessEvent[] = [];

  for (const block of readMessageContent(message)) {
    const blockType = readString(block["type"]);

    if (blockType === "text") {
      const text = readString(block["text"]);

      if (text) {
        events.push({ kind: "assistant-delta", text: redactText(text) });
      }

      continue;
    }

    if (isToolCallContentType(blockType)) {
      const toolName = readString(block["name"])?.trim();

      if (!toolName) {
        continue;
      }

      const toolCallId = readToolCallId(block);

      events.push({
        kind: "tool-start",
        toolName,
        ...(toolCallId ? { toolCallId: redactText(toolCallId) } : {})
      });
    }
  }

  return events.length > 0 ? { events } : EMPTY_PROJECTION;
}

function projectUserMessage(message: IRecord): IClaudeStreamProjection {
  const events: TCodexHarnessEvent[] = [];

  for (const block of readMessageContent(message)) {
    if (readString(block["type"]) !== "tool_result") {
      continue;
    }

    const toolCallId = readString(block["tool_use_id"])?.trim();

    events.push({
      kind: "tool-output",
      toolName: "claude-cli",
      ...(toolCallId ? { toolCallId: redactText(toolCallId) } : {}),
      output: redactText(readToolResultText(block["content"]))
    });
  }

  return events.length > 0 ? { events } : EMPTY_PROJECTION;
}

function projectResultMessage(message: IRecord): IClaudeStreamProjection {
  const events: TCodexHarnessEvent[] = [];
  const usage = readUsage(message["usage"]);

  if (usage) {
    events.push(usage);
  }

  const isError = message["is_error"] === true;
  const resultText = readString(message["result"]) ?? "";

  if (isError) {
    const reason = resultText.trim() || "Claude CLI reported an error result.";

    events.push({ kind: "failed", message: redactText(reason) });

    return { events, completion: "failed", finalText: redactText(reason) };
  }

  return { events, completion: "completed", finalText: redactText(resultText) };
}

function projectControlRequest(message: IRecord): IClaudeStreamProjection {
  const request = asRecord(message["request"]);

  if (!request || readString(request["subtype"]) !== "can_use_tool") {
    return EMPTY_PROJECTION;
  }

  const requestId = readString(message["request_id"])?.trim();

  return requestId ? { events: [], controlRequestId: requestId } : EMPTY_PROJECTION;
}

function readUsage(raw: unknown): TCodexHarnessEvent | undefined {
  const usage = asRecord(raw);

  if (!usage) {
    return undefined;
  }

  const inputTokens = readNonNegativeInt(usage["input_tokens"]);
  const outputTokens = readNonNegativeInt(usage["output_tokens"]);

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  const resolvedInput = inputTokens ?? 0;
  const resolvedOutput = outputTokens ?? 0;

  return {
    kind: "token-usage",
    inputTokens: resolvedInput,
    outputTokens: resolvedOutput,
    totalTokens: resolvedInput + resolvedOutput
  };
}

function readMessageContent(message: IRecord): readonly IRecord[] {
  const inner = asRecord(message["message"]);

  if (!inner) {
    return [];
  }

  const content = inner["content"];

  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter((entry): entry is IRecord => asRecord(entry) !== undefined);
}

function readToolResultText(content: unknown): string {
  const primitive = readPrimitiveToolResultText(content);

  if (primitive !== undefined) {
    return normalizeToolResultText(primitive);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];

  for (const entry of content) {
    const text = readStructuredToolResultEntryText(entry);

    if (text !== undefined && text.length > 0) {
      parts.push(normalizeToolResultText(text));
    }
  }

  return parts.join("\n");
}

function readStructuredToolResultEntryText(entry: unknown): string | undefined {
  const record = asRecord(entry);

  if (!record) {
    return readPrimitiveToolResultText(entry);
  }

  const text = readString(record["text"]);
  if (text !== undefined) {
    return text;
  }

  const type = readString(record["type"]);
  if (type !== "tool_result" && type !== "toolResult") {
    return undefined;
  }

  return readPrimitiveToolResultText(record["content"]);
}

function readPrimitiveToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (typeof content === "number" && Number.isFinite(content)) {
    return String(content);
  }

  if (typeof content === "boolean") {
    return String(content);
  }

  if (content === null) {
    return "null";
  }

  return undefined;
}

function isToolCallContentType(value: unknown): boolean {
  const type = readString(value)?.toLowerCase();

  return type !== undefined && TOOL_CALL_CONTENT_TYPES.has(type);
}

function readToolCallId(block: IRecord): string | undefined {
  for (const field of TOOL_CALL_ID_FIELDS) {
    const value = readString(block[field])?.trim();

    if (value) {
      return redactText(value);
    }
  }

  return undefined;
}

function normalizeToolResultText(text: string): string {
  const withoutInlineData = redactInlineDataUriValue(text);

  if (withoutInlineData.length <= TOOL_RESULT_MAX_CHARS) {
    return withoutInlineData;
  }

  return `${truncateUtf16Safe(withoutInlineData, TOOL_RESULT_MAX_CHARS)}\n...(truncated)...`;
}

function redactInlineDataUriValue(value: string): string {
  const trimmed = value.trimStart();

  if (!INLINE_DATA_URI_VALUE_PATTERN.test(trimmed)) {
    return value;
  }

  return `[inline data URI: ${value.length} chars]`;
}

function readSessionId(message: IRecord): string | undefined {
  return (
    readString(message["session_id"])?.trim() ||
    readString(message["sessionId"])?.trim() ||
    undefined
  );
}

function withSessionId(
  projection: IClaudeStreamProjection,
  sessionId: string | undefined
): IClaudeStreamProjection {
  if (!sessionId || projection.sessionId) {
    return projection;
  }

  return { ...projection, sessionId };
}

type IRecord = Record<string, unknown>;

function asRecord(value: unknown): IRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as IRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
