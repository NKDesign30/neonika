// Mirrors upstream's Discord outbound text preparation:
// sanitize internal runtime scaffolding, then render markdown tables in Discord-safe mode.
import { convertMarkdownTables } from "./markdownCore/tables.js";
import type { MarkdownTableMode } from "./markdownCore/types.js";

const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE =
  /<\s*(system-reminder|previous_response)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE =
  /<\s*(?:system-reminder|previous_response)\b[^>]*\/\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE =
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*>/gi;
const DISCORD_INTERNAL_CHANNEL_LINE_RE =
  /^(?:>\s*)?(?:analysis|commentary|thinking|reasoning)\s*[:=]/i;
const DISCORD_MARKDOWN_TABLE_MODE: MarkdownTableMode = "code";
const ASCII_LATIN_LETTER_RE = /[A-Za-z]/u;
const CYRILLIC_LATIN_HOMOGLYPHS: Readonly<Record<string, string>> = {
  "\u0410": "A",
  "\u0412": "B",
  "\u0415": "E",
  "\u041a": "K",
  "\u041c": "M",
  "\u041d": "H",
  "\u041e": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0425": "X",
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0442": "t",
  "\u0445": "x",
  "\u0443": "y",
  "\u0456": "i"
};

export function formatNeonDiscordReplyText(text: string): string {
  return convertMarkdownTables(
    collapseExcessDiscordBlankLines(
      normalizeDiscordLatinHomoglyphs(
        stripDiscordInternalChannelLines(stripDiscordInternalRuntimeScaffolding(text ?? ""))
      )
    ).trim(),
    DISCORD_MARKDOWN_TABLE_MODE
  );
}

function stripDiscordInternalRuntimeScaffolding(text: string): string {
  return text
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "")
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "")
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
}

function stripDiscordInternalChannelLines(text: string): string {
  let inFence = false;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (!inFence && DISCORD_INTERNAL_CHANNEL_LINE_RE.test(line.trim())) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function collapseExcessDiscordBlankLines(text: string): string {
  return text.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n");
}

function normalizeDiscordLatinHomoglyphs(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/u.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : normalizeLatinNeighborHomoglyphs(line);
    })
    .join("\n");
}

function normalizeLatinNeighborHomoglyphs(text: string): string {
  let normalized = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const replacement = CYRILLIC_LATIN_HOMOGLYPHS[char];
    if (!replacement) {
      normalized += char;
      continue;
    }
    const previous = text[index - 1] ?? "";
    const next = text[index + 1] ?? "";
    normalized +=
      ASCII_LATIN_LETTER_RE.test(previous) || ASCII_LATIN_LETTER_RE.test(next)
        ? replacement
        : char;
  }
  return normalized;
}
