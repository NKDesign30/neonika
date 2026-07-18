// Copied from OpenClaw `packages/markdown-core/src/chunk-text.ts` (MIT).
// See THIRD_PARTY_NOTICES.md for the full licence and attribution.
// Markdown Core module implements chunk text behavior.
function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }
  return undefined;
}

function scanParenAwareBreakpoints(text: string): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Parenthesized spans often contain rewritten links or file references;
    // avoid splitting them unless the window has no safer outside break.
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "\n") {
      lastNewline = i;
    } else if (char && /\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}

/**
 * Keeps UTF-16 chunk boundaries from separating a supplementary-plane character.
 * A one-unit positive limit still needs to emit an entire surrogate pair.
 */
export function avoidTrailingHighSurrogateBreak(text: string, start: number, end: number): number {
  if (
    end >= text.length ||
    text.charCodeAt(end - 1) < 0xd800 ||
    text.charCodeAt(end - 1) > 0xdbff ||
    text.charCodeAt(end) < 0xdc00 ||
    text.charCodeAt(end) > 0xdfff
  ) {
    return end;
  }
  return end - 1 > start ? end - 1 : end + 1;
}

/**
 * Splits text into bounded chunks using caller-owned soft-break selection.
 *
 * The resolver sees each limit-sized window and returns an in-window break index;
 * invalid indexes fall back to the hard limit so chunking always makes progress.
 */
export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidateBreak = resolveBreakIndex(window);
    // Invalid or zero-width soft breaks would stall the loop, so fall back to the hard limit.
    const breakIdx =
      Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
        ? candidateBreak
        : limit;
    const safeBreakIdx = avoidTrailingHighSurrogateBreak(remaining, 0, breakIdx);
    const rawChunk = remaining.slice(0, safeBreakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    // Keep separator ownership with the boundary: one matched separator is
    // consumed here, and any adjacent whitespace is trimmed before the next window.
    const brokeOnSeparator = safeBreakIdx < remaining.length && /\s/.test(remaining[safeBreakIdx] ?? "");
    const nextStart = Math.min(remaining.length, safeBreakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Splits plain text into size-bounded chunks at readable boundaries.
 *
 * Returns the original text as one chunk when the limit is non-positive.
 */
export function chunkText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= limit) {
      chunks.push(text.slice(cursor));
      break;
    }
    const windowEnd = Math.min(text.length, cursor + limit);
    const window = text.slice(cursor, windowEnd);
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window);
    // Prefer block boundaries, then spaces, then a hard size cut when no
    // readable breakpoint exists inside this window.
    const breakOffset = lastNewline > 0 ? lastNewline : lastWhitespace;
    const end = avoidTrailingHighSurrogateBreak(
      text,
      cursor,
      breakOffset > 0 ? cursor + breakOffset : windowEnd,
    );
    chunks.push(text.slice(cursor, end));
    cursor = end;
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
      cursor += 1;
    }
  }
  return chunks;
}
