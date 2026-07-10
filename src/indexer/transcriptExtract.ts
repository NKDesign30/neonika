import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { redactSnapshotText } from "../harness/redaction.js";

// Neon Transcript Indexer — extract stage. Streams one transcript jsonl line by
// line (never a full read), isolates user/assistant turns, and folds them into a
// deterministic digest. The ONLY text that survives is the redacted preview of
// the last qualifying turn — the raw transcript source is never redacted at rest,
// so redactSnapshotText here is the sole first boundary. No write, no LLM.

const MIN_TEXT_CHARS = 10;
const TRANSCRIPT_PREVIEW_LIMIT = 200;
const MESSAGE_TEXT_LIMIT = 500;
const MAX_KEPT_MESSAGES = 80;
const RAW_MESSAGE_CAP = 4_000;

/**
 * One qualifying transcript turn. `messageIndex` is the ABSOLUTE 1-based
 * position across all qualifying turns of the session (not the position inside
 * the kept window), so a model echoing an index back stays resolvable even
 * when only the most recent turns are kept.
 */
export interface INeonTranscriptMessage {
  readonly messageIndex: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface INeonTranscriptExtract {
  readonly messageCount: number;
  readonly userCount: number;
  readonly assistantCount: number;
  readonly toolFailureCount: number;
  /** Redacted + truncated text of the last qualifying turn, or "" when none. */
  readonly latestPreview: string;
  /** Total jsonl lines read (cursor candidate for a later gated incremental slice). */
  readonly linesRead: number;
  /**
   * Redacted per-turn texts (last 80 turns, 500 chars each) — only present
   * when requested via `includeMessages`, so the default digest/HTTP paths
   * stay byte-identical and cheap.
   */
  readonly messages?: readonly INeonTranscriptMessage[];
}

export interface IExtractNeonTranscriptOptions {
  readonly includeMessages?: boolean;
}

interface IMutableMessage {
  readonly messageIndex: number;
  readonly role: "user" | "assistant";
  readonly rawText: string;
}

interface IMutableExtract {
  messageCount: number;
  userCount: number;
  assistantCount: number;
  toolFailureCount: number;
  latestRawText: string;
  linesRead: number;
  collectMessages: boolean;
  rawMessages: IMutableMessage[];
}

export async function extractNeonTranscript(
  jsonlPath: string,
  options: IExtractNeonTranscriptOptions = {}
): Promise<INeonTranscriptExtract> {
  const acc: IMutableExtract = {
    messageCount: 0,
    userCount: 0,
    assistantCount: 0,
    toolFailureCount: 0,
    latestRawText: "",
    linesRead: 0,
    collectMessages: options.includeMessages === true,
    rawMessages: []
  };

  let stream;
  try {
    stream = createReadStream(jsonlPath, { encoding: "utf8" });
  } catch {
    return freeze(acc);
  }

  try {
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      acc.linesRead += 1;
      foldLine(line, acc);
    }
  } catch {
    // Partial reads still return what was folded so far; never throw upward.
  }

  return freeze(acc);
}

function freeze(acc: IMutableExtract): INeonTranscriptExtract {
  return {
    messageCount: acc.messageCount,
    userCount: acc.userCount,
    assistantCount: acc.assistantCount,
    toolFailureCount: acc.toolFailureCount,
    latestPreview:
      acc.latestRawText.length > 0
        ? redactSnapshotText(acc.latestRawText, { previewLimit: TRANSCRIPT_PREVIEW_LIMIT })
        : "",
    linesRead: acc.linesRead,
    ...(acc.collectMessages
      ? {
          messages: acc.rawMessages.map(
            (message): INeonTranscriptMessage => ({
              messageIndex: message.messageIndex,
              role: message.role,
              text: redactSnapshotText(message.rawText, { previewLimit: MESSAGE_TEXT_LIMIT })
            })
          )
        }
      : {})
  };
}

function foldLine(line: string, acc: IMutableExtract): void {
  if (line.trim().length === 0) {
    return;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }

  acc.toolFailureCount += countToolFailures(entry);

  if (!isRecord(entry)) {
    return;
  }

  const role = entry["type"];
  if (role !== "user" && role !== "assistant") {
    return;
  }

  const text = extractTurnText(entry["message"]);
  if (text.length < MIN_TEXT_CHARS) {
    return;
  }

  acc.messageCount += 1;
  if (role === "user") {
    acc.userCount += 1;
  } else {
    acc.assistantCount += 1;
  }
  acc.latestRawText = text;

  if (acc.collectMessages) {
    acc.rawMessages.push({
      messageIndex: acc.messageCount,
      role,
      rawText: text.slice(0, RAW_MESSAGE_CAP)
    });
    if (acc.rawMessages.length > MAX_KEPT_MESSAGES) {
      acc.rawMessages.shift();
    }
  }
}

// message is a string, or { content: string }, or { content: [{type:"text", text}] }.
// Only text blocks count as turn text (tool-result blocks are not turn content).
function extractTurnText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (!isRecord(message)) {
    return "";
  }

  const content = message["content"];
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.join("\n");
}

// Counts content blocks that are tool_result with is_error === true, in both the
// message.content array and a top-level toolResult entry shape.
function countToolFailures(entry: unknown): number {
  if (!isRecord(entry)) {
    return 0;
  }

  let failures = 0;

  if (entry["type"] === "toolResult" && entry["isError"] === true) {
    failures += 1;
  }

  const message = entry["message"];
  if (isRecord(message) && Array.isArray(message["content"])) {
    for (const block of message["content"]) {
      if (isRecord(block) && block["type"] === "tool_result" && block["is_error"] === true) {
        failures += 1;
      }
    }
  }

  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
