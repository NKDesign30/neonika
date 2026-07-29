// Neonika Transcript Indexer — summary quality gate. Port of the battle-tested v3
// live-pass gate (the previous runtime's quality gate): sanitize what is safe to fix
// (boilerplate greetings, enclosing markdown codefences), reject what is
// structurally wrong (empty output, leaked template placeholders, missing
// required header). Pure and deterministic — no IO, no clock — so the gate
// itself is the test surface and callers stay thin.
//
// Lessons encoded from the v3/Python indexer history:
// - LLMs prepend boilerplate greetings ("Okay, hier ist eine Zusammenfassung…")
// - Template pseudo-tags like <titel> leak through as literal output
// - Whole summaries arrive wrapped in ```code fences```
// - Empty or format-less output must never be promoted
// - Models copy the prompt's example bullets instead of filling them in
//   ("Punkt 1 / Punkt 2 / Entscheidung 1") — added 2026-07-26, ported back from
//   the Python indexer where it was the rule that actually caught live damage:
//   because summaries dedupe by session_id, one skeleton entry blocks the real
//   content permanently. Both paths now read this rule from here.

const boilerplatePrefixes: readonly RegExp[] = [
  /^okay,?\s+hier\s+ist\s+(eine\s+)?(aktualisierte\s+)?zusammenfassung[^\n]*\n*/i,
  /^die\s+session-zusammenfassung\s+wurde\s+aktualisiert[^\n]*\n*/i,
  /^hier\s+ist\s+(deine|die)\s+(aktualisierte\s+)?(session-)?zusammenfassung[^\n]*\n*/i,
  /^sehr\s+(gut|gerne),?\s+/i,
  /^(natürlich|gerne|verstanden),?\s+/i
];

const templatePlaceholderPattern = /<[a-zäöüß][\w\s\-_äöüß]{0,80}>/i;

// Explicit "nothing happened" lines are a valid summary shape, not a failure.
const noopTokens: readonly string[] = ["_keine substantiellen aktivitäten._", "_no activity._"];

// Skeleton bullets copied from the prompt's format example rather than filled in.
const hollowBulletPattern =
  /^(punkt|entscheidung|learning|erkenntnis|detail)\s*\d*$|^name\/code\/zahl.*$|^(titel|rationale|alternativen?)$/i;

const bulletMarkers = ["-", "*", "•"] as const;

/**
 * True when the summary is mostly the format's own example lines.
 *
 * One skeleton bullet is not a failure — a model may legitimately name a point
 * "Detail 2". It only stops being a summary once a meaningful share of the
 * bullets is skeleton, so the threshold is two, or every bullet there is.
 * Prose without bullets is out of scope: this rule reads bullet shape, and
 * judging free text would need a different signal than a regex.
 */
function isHollowSummary(text: string): boolean {
  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => bulletMarkers.some((marker) => line.startsWith(marker)))
    .map((line) => line.slice(1).trim().replace(/[:.]+$/, ""));

  if (bullets.length === 0) {
    return false;
  }
  const hollow = bullets.filter((bullet) => hollowBulletPattern.test(bullet)).length;
  return hollow >= 2 || hollow === bullets.length;
}

export interface INeonSummaryQualityResult {
  readonly passed: boolean;
  readonly cleaned: string;
  readonly issues: readonly string[];
}

export interface IEvaluateNeonSummaryQualityOptions {
  /**
   * When set, the cleaned summary must start with this header (or be an
   * explicit no-op line). Leave unset while the prompt does not guarantee a
   * header shape.
   */
  readonly requiredHeader?: string;
}

export function evaluateNeonSummaryQuality(
  raw: string,
  options: IEvaluateNeonSummaryQualityOptions = {}
): INeonSummaryQualityResult {
  const issues: string[] = [];

  if (!raw || raw.trim().length === 0) {
    return { passed: false, cleaned: "", issues: ["empty output"] };
  }

  let cleaned = raw.trim();

  // Strip a codefence wrapping the entire summary (```md\n…\n```).
  if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
    cleaned = cleaned
      .slice(3, -3)
      .replace(/^[a-z]*\n/i, "")
      .trim();
    issues.push("stripped enclosing codefence");
  }

  for (const prefix of boilerplatePrefixes) {
    if (prefix.test(cleaned)) {
      cleaned = cleaned.replace(prefix, "");
      issues.push("stripped boilerplate prefix");
    }
  }
  cleaned = cleaned.trim();

  if (cleaned.length === 0) {
    return { passed: false, cleaned: "", issues: [...issues, "empty after sanitize"] };
  }

  if (options.requiredHeader !== undefined && options.requiredHeader.length > 0) {
    const startLc = cleaned.toLowerCase().slice(0, 200);
    const hasHeader = cleaned.startsWith(options.requiredHeader);
    const isNoop = noopTokens.some((token) => startLc.includes(token));
    if (!hasHeader && !isNoop) {
      return {
        passed: false,
        cleaned,
        issues: [...issues, `missing header "${options.requiredHeader}"`]
      };
    }
  }

  if (templatePlaceholderPattern.test(cleaned)) {
    return {
      passed: false,
      cleaned,
      issues: [...issues, "contains template placeholder like <xyz>"]
    };
  }

  if (isHollowSummary(cleaned)) {
    return {
      passed: false,
      cleaned,
      issues: [...issues, "hollow summary — bullets copied from the format example"]
    };
  }

  return { passed: true, cleaned, issues };
}
