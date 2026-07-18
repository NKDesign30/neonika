// Neon Transcript Indexer — summary quality gate. Port of the battle-tested v3
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

  return { passed: true, cleaned, issues };
}
