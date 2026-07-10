/**
 * Concept-tag derivation (Memory/Dreaming plane): a focused keyword extractor
 * adapted from OpenClaw `extensions/memory-core/src/concept-vocabulary.ts`
 * (`deriveConceptTags` / `MAX_CONCEPT_TAGS`). Pure: no I/O, no gate, cannot
 * recurse into the doctor/cutover snapshot chain.
 *
 * Scope decision (rebuild-native, not a 1:1 copy): neon-core memory content is
 * German/English prose, so this intentionally drops OpenClaw's CJK segmentation,
 * `Intl.Segmenter`, protected glossary, and script-coverage telemetry
 * (`summarizeConceptTagScriptCoverage`) — none have a neon-core consumer (YAGNI).
 * It keeps the real idea: strip stop words, keep meaningful tokens, rank by
 * frequency, cap at a small top-N.
 *
 * The only consumer is the dreaming deep phase: `deriveNeonConceptTags` powers an
 * opt-in (`NEON_DREAMING_ENABLED` + `conceptMerge`) near-duplicate grouping that
 * clusters concept-equal entries the lead-words prefix key in
 * `dreamingRuntime.groupByNormalizedPrefix` misses. Tags are ephemeral grouping
 * keys only — they are never serialized into a proposal (the summary is the
 * redacted source content), so no redaction pass is needed here.
 * See THIRD_PARTY_NOTICES.md for attribution.
 */

export const NEON_MAX_CONCEPT_TAGS = 8;

const MIN_CONCEPT_TOKEN_LENGTH = 3;
const MAX_CONCEPT_TOKEN_LENGTH = 32;

/**
 * EN + DE stop words plus a few shared agent/file-noise words from OpenClaw's
 * shared list. Latin-only by design (see the scope note above). Kept compact and
 * lowercase; matched after `normalizeConceptToken` lowercases the token.
 */
const NEON_CONCEPT_STOP_WORDS: ReadonlySet<string> = new Set([
  // shared agent / file noise
  "about", "after", "again", "agent", "also", "assistant", "because", "before",
  "being", "between", "build", "called", "could", "daily", "default", "deploy",
  "during", "every", "file", "files", "from", "have", "into", "just", "line",
  "lines", "long", "main", "make", "memory", "month", "more", "most", "move",
  "much", "next", "note", "notes", "over", "part", "past", "port", "same",
  "score", "search", "session", "sessions", "short", "should", "since", "some",
  "subagent", "system", "than", "that", "their", "there", "these", "they",
  "this", "through", "today", "user", "using", "with", "work", "workspace",
  "year",
  // english function words
  "all", "and", "any", "are", "but", "can", "did", "does", "done", "for", "get",
  "had", "has", "her", "him", "his", "how", "its", "let", "may", "new", "not",
  "now", "off", "old", "one", "our", "out", "per", "say", "see", "set", "she",
  "the", "then", "two", "use", "very", "via", "was", "way", "were", "what",
  "when", "which", "while", "who", "why", "will", "would", "yes", "you", "your",
  // german function words
  "aber", "alle", "alles", "auch", "auf", "aus", "beim", "bei", "dann", "das",
  "dem", "den", "der", "des", "die", "dies", "diese", "doch", "dort", "ein",
  "eine", "einem", "einen", "einer", "für", "haben", "hier", "ist", "jede",
  "jeder", "kann", "mit", "muss", "müssen", "nach", "noch", "nur", "oder",
  "ohne", "schon", "sehr", "sein", "sich", "sind", "soll", "über", "und", "vom",
  "von", "war", "waren", "werden", "wird", "zum", "zur"
]);

const TOKEN_SPLIT_RE = /[^\p{L}\p{N}._/-]+/u;
const TRIM_EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const DIGITS_ONLY_RE = /^\d+$/u;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;

interface IConceptTagTally {
  count: number;
  firstIndex: number;
}

function normalizeConceptToken(rawToken: string): string | undefined {
  const normalized = rawToken
    .normalize("NFKC")
    .toLowerCase()
    .replace(TRIM_EDGE_RE, "")
    .replaceAll("_", "-");

  if (
    normalized.length < MIN_CONCEPT_TOKEN_LENGTH ||
    normalized.length > MAX_CONCEPT_TOKEN_LENGTH ||
    DIGITS_ONLY_RE.test(normalized) ||
    DATE_ONLY_RE.test(normalized) ||
    NEON_CONCEPT_STOP_WORDS.has(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

/**
 * Derive up to `limit` concept tags from free text, ranked by frequency (ties
 * broken by first appearance for deterministic output). Compound tokens keep
 * their shape (`gateway/server`, `neon-core`) because the split preserves
 * `._/-`; only the surrounding punctuation is trimmed.
 */
export function deriveNeonConceptTags(
  content: string,
  limit: number = NEON_MAX_CONCEPT_TAGS
): readonly string[] {
  if (limit <= 0) {
    return [];
  }

  const tallies = new Map<string, IConceptTagTally>();
  let index = 0;

  for (const rawToken of content.split(TOKEN_SPLIT_RE)) {
    const token = normalizeConceptToken(rawToken);
    index += 1;
    if (!token) {
      continue;
    }
    const existing = tallies.get(token);
    if (existing) {
      existing.count += 1;
    } else {
      tallies.set(token, { count: 1, firstIndex: index });
    }
  }

  return [...tallies.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].firstIndex - right[1].firstIndex)
    .slice(0, limit)
    .map(([token]) => token);
}

/** The single highest-ranked concept tag, or `undefined` for all-stop-word/empty text. */
export function neonTopConceptTag(content: string): string | undefined {
  return deriveNeonConceptTags(content, 1)[0];
}
