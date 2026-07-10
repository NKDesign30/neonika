import type { INeonLiveIndexRecord } from "./liveIndexSync.js";

/**
 * Quality gate for live-index digest records (memory cutover, Slice K3).
 *
 * Rebuild-native port of the v3 decision quality gate
 * (the previous runtime's decision quality gate),
 * adapted from decision candidates (title/rationale/alternatives) to live-index
 * session digests. Lesson from the v2 DB distillation: ungated digests with a
 * blanket importance of 72 drowned out real decisions (which live at 73-79).
 *
 * Two jobs, one seam:
 * 1. Reject slop before it reaches `writeNeonMemoryDbEntry` (placeholder
 *    templates, repetition loops, empty or noise-only previews, sessions with
 *    no real interaction).
 * 2. Derive importance from content instead of a fixed constant. Digests are
 *    ephemeral context, so scores are clamped to 20-60 - always below real
 *    curated knowledge.
 */

export type TNeonLiveIndexRejectClass =
  | "empty-preview"
  | "placeholder"
  | "repetition"
  | "noise-preview"
  | "trivial-session";

export interface INeonLiveIndexQualityVerdict {
  readonly passed: boolean;
  readonly rejectClass?: TNeonLiveIndexRejectClass;
  readonly importanceScore: number;
  readonly notes: readonly string[];
}

export interface INeonLiveIndexRejectedRecord {
  readonly record: INeonLiveIndexRecord;
  readonly verdict: INeonLiveIndexQualityVerdict;
}

export interface INeonLiveIndexQualitySummary {
  readonly evaluated: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly rejectClasses: Readonly<Partial<Record<TNeonLiveIndexRejectClass, number>>>;
}

export interface INeonLiveIndexQualityGateOutcome {
  readonly accepted: readonly INeonLiveIndexRecord[];
  readonly rejected: readonly INeonLiveIndexRejectedRecord[];
  readonly summary: INeonLiveIndexQualitySummary;
}

const MIN_IMPORTANCE = 20;
const MAX_IMPORTANCE = 60;
const MIN_PREVIEW_CHARS = 12;

const PREVIEW_LINE_RE = /^Latest preview:\s*(.*)$/m;
const MESSAGES_LINE_RE = /^Messages:\s*(\d+)\s*\((\d+)\s*user\s*\/\s*(\d+)\s*assistant\)/m;
const RUNS_LINE_RE = /^Runs:\s*(\d+)/m;
const TOOL_FAILURES_LINE_RE = /^Tool failures:\s*(\d+)/m;

// Narrower than the v3 placeholder regex on purpose: digest previews from
// coding sessions legitimately contain HTML/JSX tags (`<Text>`, `<summary>`,
// `<TodoItem>`), so only tokens that are unambiguous template placeholders
// count. The v2 April templates (`DECISION: <beschreibung ...>`) are covered
// by LEGACY_TEMPLATE_RE regardless of the token.
const PLACEHOLDER_RE = /<(beschreibung|platzhalter|placeholder|titel|inhalt)[^>]*>/i;
const LEGACY_TEMPLATE_RE = /\b(DECISION|RATIONALE|ALTERNATIVES):\s*</;

// Deliberately fail-closed: previews opening with `{"` (JSON-first assistant
// output) or `(no ` also get rejected. Known trade-off - a digest whose latest
// preview is raw JSON or an empty-result note carries no recall value anyway.
const NOISE_PREVIEW_RE =
  /^(caveat:|<system-reminder|\[?system-?reminder|tool_use\b|tool_result\b|\(no\s|no assistant (reply|response)|\{")/i;
const HAS_LETTERS_RE = /[a-zA-ZäöüÄÖÜß]/;

interface IParsedDigest {
  readonly preview: string;
  readonly messageCount: number | undefined;
  readonly userCount: number | undefined;
  readonly toolFailureCount: number | undefined;
  readonly runCount: number | undefined;
}

export function evaluateNeonLiveIndexRecord(record: INeonLiveIndexRecord): INeonLiveIndexQualityVerdict {
  const digest = parseDigest(record.content);
  const rejectClass = findRejectClass(digest);

  if (rejectClass) {
    return {
      passed: false,
      rejectClass,
      importanceScore: MIN_IMPORTANCE,
      notes: [`rejected: ${rejectClass}`]
    };
  }

  const { score, notes } = deriveImportance(digest);
  return { passed: true, importanceScore: score, notes };
}

export function applyNeonLiveIndexQualityGate(
  records: readonly INeonLiveIndexRecord[]
): INeonLiveIndexQualityGateOutcome {
  const accepted: INeonLiveIndexRecord[] = [];
  const rejected: INeonLiveIndexRejectedRecord[] = [];
  const rejectClasses: Partial<Record<TNeonLiveIndexRejectClass, number>> = {};

  for (const record of records) {
    const verdict = evaluateNeonLiveIndexRecord(record);
    if (verdict.passed) {
      accepted.push({ ...record, importanceScore: verdict.importanceScore });
      continue;
    }
    rejected.push({ record, verdict });
    if (verdict.rejectClass) {
      rejectClasses[verdict.rejectClass] = (rejectClasses[verdict.rejectClass] ?? 0) + 1;
    }
  }

  return {
    accepted,
    rejected,
    summary: {
      evaluated: records.length,
      accepted: accepted.length,
      rejected: rejected.length,
      rejectClasses
    }
  };
}

export function renderNeonLiveIndexQualitySummary(summary: INeonLiveIndexQualitySummary): string {
  const classes = Object.entries(summary.rejectClasses)
    .map(([rejectClass, count]) => `${rejectClass}=${count}`)
    .join(", ");
  const suffix = classes ? ` (${classes})` : "";
  return `quality gate: accepted=${summary.accepted} rejected=${summary.rejected}${suffix}`;
}

function parseDigest(content: string): IParsedDigest {
  const preview = PREVIEW_LINE_RE.exec(content)?.[1]?.trim() ?? "";
  const messages = MESSAGES_LINE_RE.exec(content);
  const runs = RUNS_LINE_RE.exec(content);
  const toolFailures = TOOL_FAILURES_LINE_RE.exec(content);

  return {
    preview,
    messageCount: messages?.[1] === undefined ? undefined : Number.parseInt(messages[1], 10),
    userCount: messages?.[2] === undefined ? undefined : Number.parseInt(messages[2], 10),
    toolFailureCount: toolFailures?.[1] === undefined ? undefined : Number.parseInt(toolFailures[1], 10),
    runCount: runs?.[1] === undefined ? undefined : Number.parseInt(runs[1], 10)
  };
}

function findRejectClass(digest: IParsedDigest): TNeonLiveIndexRejectClass | undefined {
  if (digest.preview.length < MIN_PREVIEW_CHARS) {
    return "empty-preview";
  }
  if (PLACEHOLDER_RE.test(digest.preview) || LEGACY_TEMPLATE_RE.test(digest.preview)) {
    return "placeholder";
  }
  if (NOISE_PREVIEW_RE.test(digest.preview) || !HAS_LETTERS_RE.test(digest.preview)) {
    return "noise-preview";
  }
  if (isRepetitive(digest.preview)) {
    return "repetition";
  }
  if (digest.messageCount !== undefined && digest.messageCount <= 1) {
    return "trivial-session";
  }
  return undefined;
}

/**
 * Catches the April-2026 v2 loop bug: extraction loops produced previews of
 * the same phrase repeated dozens of times.
 */
function isRepetitive(preview: string): boolean {
  const words = preview.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length < 12) {
    return false;
  }
  const uniqueRatio = new Set(words).size / words.length;
  return uniqueRatio < 0.35;
}

function deriveImportance(digest: IParsedDigest): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 25;
  notes.push("base=25");

  if (digest.messageCount !== undefined && digest.messageCount > 0) {
    const messageBonus = Math.min(15, Math.floor(4 * Math.log2(digest.messageCount + 1)));
    score += messageBonus;
    notes.push(`messages=${digest.messageCount} +${messageBonus}`);
  }
  if (digest.userCount !== undefined && digest.userCount >= 2) {
    score += 5;
    notes.push(`userTurns=${digest.userCount} +5`);
  }
  if (digest.runCount !== undefined && digest.runCount > 0) {
    const runBonus = Math.min(10, digest.runCount * 2);
    score += runBonus;
    notes.push(`runs=${digest.runCount} +${runBonus}`);
  }
  const previewBonus = digest.preview.length >= 300 ? 5 : digest.preview.length >= 120 ? 3 : 0;
  if (previewBonus > 0) {
    score += previewBonus;
    notes.push(`previewChars=${digest.preview.length} +${previewBonus}`);
  }
  if (digest.toolFailureCount !== undefined && digest.toolFailureCount > 0) {
    score += 3;
    notes.push(`toolFailures=${digest.toolFailureCount} +3`);
  }

  const clamped = Math.max(MIN_IMPORTANCE, Math.min(MAX_IMPORTANCE, score));
  if (clamped !== score) {
    notes.push(`clamped ${score} -> ${clamped}`);
  }
  return { score: clamped, notes };
}
