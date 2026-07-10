// Copied from OpenClaw `extensions/discord/src/chunk.ts` (MIT).
// See THIRD_PARTY_NOTICES.md for the full licence and attribution.
// Ported from OpenClaw extensions/discord/src/chunk.ts for Discord outbound parity.
import { chunkMarkdownTextWithMode, type ChunkMode } from "./replyChunking.js";

type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 2000. */
  readonly maxChars?: number;
  /**
   * Soft max line count per message. Default: 17.
   *
   * Discord clients can clip/collapse very tall messages in the UI; splitting
   * by lines keeps long multi-paragraph replies readable.
   */
  readonly maxLines?: number;
};

type OpenFence = {
  readonly indent: string;
  readonly markerChar: string;
  readonly markerLen: number;
  readonly openLine: string;
};

export interface INeonDiscordChunkOptions extends ChunkDiscordTextOpts {
  readonly chunkMode?: TNeonDiscordChunkMode;
}

export type TNeonDiscordChunkMode = ChunkMode;

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CJK_PUNCTUATION_BREAK_AFTER_RE = /[、。，．！？；：）］｝〉》」』】〕〗〙]/u;

function resolveDiscordChunkLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line
  };
}

function closeFenceLine(openFence: OpenFence): string {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null): string {
  if (!openFence) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}\n${closeLine}`;
  }
  return `${text}${closeLine}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clampToCodePointBoundary(text: string, index: number): number {
  const boundary = Math.min(Math.max(0, index), text.length);
  if (boundary <= 0 || boundary >= text.length) {
    return boundary;
  }
  const previous = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);
  if (isHighSurrogate(previous) && isLowSurrogate(next)) {
    return boundary > 1 ? boundary - 1 : boundary + 1;
  }
  return boundary;
}

function findWhitespaceBreak(window: string): number {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(window[index] ?? "")) {
      // Return the separator index so whitespace stays with the next segment.
      return index;
    }
  }
  return -1;
}

function findCjkPunctuationBreak(window: string): number {
  for (let end = window.length; end > 0; ) {
    const code = window.charCodeAt(end - 1);
    const start = isLowSurrogate(code) && end > 1 ? end - 2 : end - 1;
    const char = window.slice(start, end);
    if (start > 0 && CJK_PUNCTUATION_BREAK_AFTER_RE.test(char)) {
      // Return the exclusive end so CJK punctuation stays with the current segment.
      return end;
    }
    end = start;
  }
  return -1;
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { readonly preserveWhitespace: boolean }
): string[] {
  const limit = resolveDiscordChunkLimit(maxChars, DEFAULT_MAX_CHARS);
  if (line.length <= limit) {
    return [line];
  }
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > limit) {
    if (opts.preserveWhitespace) {
      const breakIdx = clampToCodePointBoundary(remaining, limit);
      out.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx);
      continue;
    }
    const window = remaining.slice(0, limit);
    let breakIdx = findWhitespaceBreak(window);
    if (breakIdx <= 0) {
      breakIdx = findCjkPunctuationBreak(window);
    }
    if (breakIdx <= 0) {
      breakIdx = clampToCodePointBoundary(remaining, limit);
    }
    out.push(remaining.slice(0, breakIdx));
    // Keep the separator for the next segment so words don't get glued together.
    remaining = remaining.slice(breakIdx);
  }
  if (remaining.length) {
    out.push(remaining);
  }
  return out;
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxLines = resolveDiscordChunkLimit(opts.maxLines, DEFAULT_MAX_LINES);

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

  const lines = body.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
    current = "";
    currentLines = 0;
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
    }
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    // A flush can fire mid-line, before `openFence` advances to `nextOpenFence` below, so it closes
    // against the still-open `openFence`. A fence-closing line that also carries trailing text would
    // otherwise reserve 0 yet still get a closing fence appended on flush, overflowing maxChars.
    const fenceToReserve = nextOpenFence ?? openFence;
    const reserveChars = fenceToReserve ? closeFenceLine(fenceToReserve).length + 1 : 0;
    const reserveLines = fenceToReserve ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - prefixLen);
    const segments = splitLongLine(originalLine, segmentLimit, {
      preserveWhitespace: wasInsideFence
    });

    for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
      const segment = segments[segIndex] ?? "";
      const isLineContinuation = segIndex > 0;
      const delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
      const addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation) {
          currentLines += 1;
        }
      } else {
        current = segment;
        currentLines = 1;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
  }

  return rebalanceReasoningItalics(text, chunks);
}

export function chunkDiscordTextWithMode(
  text: string,
  opts: ChunkDiscordTextOpts & { readonly chunkMode?: ChunkMode }
): string[] {
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    resolveDiscordChunkLimit(opts.maxChars, DEFAULT_MAX_CHARS),
    "newline"
  );
  const chunks: string[] = [];
  for (const line of lineChunks) {
    const nested = chunkDiscordText(line, opts);
    if (!nested.length && line) {
      chunks.push(line);
      continue;
    }
    chunks.push(...nested);
  }
  return chunks;
}

export function chunkNeonDiscordText(
  text: string,
  options: INeonDiscordChunkOptions = {}
): string[] {
  return chunkDiscordTextWithMode(text, options);
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next so every chunk renders
// consistently.
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const opensWithReasoningItalics =
    /^(?:Reasoning:|Thinking\.{0,3})\n+_/u.test(source) && source.trimEnd().endsWith("_");
  if (!opensWithReasoningItalics) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let index = 0; index < adjusted.length; index += 1) {
    const isLast = index === adjusted.length - 1;
    const current = adjusted[index] ?? "";

    // Ensure current chunk closes italics so Discord renders it italicized.
    const needsClosing = !current.trimEnd().endsWith("_");
    if (needsClosing) {
      adjusted[index] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    // Re-open italics on the next chunk if needed.
    const next = adjusted[index + 1] ?? "";
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (!nextBody.startsWith("_")) {
      adjusted[index + 1] = `${leadingWhitespace}_${nextBody}`;
    }
  }

  return adjusted;
}
