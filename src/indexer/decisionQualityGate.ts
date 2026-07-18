// Neonika Transcript Indexer — decision quality gate. Port of the v3 reject-class
// gate: a decision must have a real title (no bug-fix prefixes), a non-tautological
// rationale, honest alternatives (not a mere negation of the decision), a
// promotable scope, and must not be an unconfirmed subagent report. Rejected
// candidates never reach memory. Pure and deterministic.
//
// One deliberate difference to v3: the input candidate stays readonly. Where v3
// mutated `candidate.alternatives` to drop pseudo-alternatives, this gate returns
// the sanitized alternatives value on the verdict instead.

import type { INeonDecisionCandidate, TNeonDecisionRejectClass } from "./decisionTypes.js";

const implementationPrefixPattern =
  /^(bug\s+\d|bug\s|fix\s|refactor\s|implement\s|step\s+\d|punkt\s+\d|\d+\.?\s)/i;

const deferralMarkers: readonly string[] = ["todo", "fixme", "demnächst", "später", "eventuell"];

const statusMarkers: readonly string[] = [
  "status:",
  "fertig",
  "abgeschlossen",
  "geblockt",
  "in arbeit"
];

const diaryReflectionMarkers: readonly string[] = [
  "tagebuch",
  "diary",
  "reflexion",
  "reflection",
  "heute gelernt",
  "lesson learned",
  "notiz an mich",
  "ich habe gelernt",
  "ich fühle"
];

const tautologyPatterns: readonly RegExp[] = [
  // "Cleanup-Funktion wurde hinzugefügt um Cleanup zu machen"
  /(\w+)-?funktion\s+wurde\s+hinzugefügt[^.]*\1/i,
  // "X wurde durch Fixen von X behoben"
  /wurde\s+durch\s+(\w+)[^.]+\1/i
];

const templatePlaceholderPattern = /<[a-zäöüß][\w\s\-_äöüß]{0,80}>/i;

export interface INeonDecisionQualityVerdict {
  readonly passed: boolean;
  readonly rejectClass: TNeonDecisionRejectClass | null;
  readonly notes: readonly string[];
  /** Alternatives after sanitization — pseudo-negations are dropped to null. */
  readonly alternatives: string | null;
}

function isAlternativeJustNegation(decision: string, alternative: string): boolean {
  const decisionLc = decision.toLowerCase().trim();
  const alternativeLc = alternative.toLowerCase().trim();
  if (alternativeLc.length === 0) {
    return false;
  }
  const negationPhrases = ["nicht hinzugefügt", "entfernt", "wurde entfernt", "nicht implementiert"];
  if (negationPhrases.some((phrase) => alternativeLc.includes(phrase))) {
    if (
      decisionLc.includes("hinzugefügt") ||
      decisionLc.includes("implementiert") ||
      decisionLc.includes("eingebaut")
    ) {
      return true;
    }
  }
  return false;
}

function rationaleIsTautological(title: string, rationale: string): boolean {
  for (const pattern of tautologyPatterns) {
    if (pattern.test(rationale)) {
      return true;
    }
  }
  // Heuristic: a long title word appearing twice in the rationale without a
  // trade-off marker is a repeat of the decision, not a reason for it.
  const titleWords = title
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 5);
  const rationaleLc = rationale.toLowerCase();
  for (const word of titleWords) {
    const occurrences = rationaleLc.split(word).length - 1;
    if (occurrences >= 2 && !rationaleLc.includes(" statt ") && !rationaleLc.includes(" weil ")) {
      return true;
    }
  }
  return false;
}

export function evaluateNeonDecision(
  candidate: INeonDecisionCandidate
): INeonDecisionQualityVerdict {
  const notes: string[] = [];
  const title = candidate.title.trim();
  const rationale = candidate.rationale.trim();
  const alternativesRaw = candidate.alternatives?.trim() ?? null;
  let alternatives = alternativesRaw !== null && alternativesRaw.length > 0 ? alternativesRaw : null;

  const reject = (
    rejectClass: TNeonDecisionRejectClass,
    note: string
  ): INeonDecisionQualityVerdict => {
    return { passed: false, rejectClass, notes: [...notes, note], alternatives };
  };

  if (title.length < 5) {
    return reject("placeholder", "title too short");
  }

  if (templatePlaceholderPattern.test(title) || templatePlaceholderPattern.test(rationale)) {
    return reject("placeholder", "template placeholder leaked");
  }

  if (rationale.length < 15) {
    return reject("tautological_rationale", "rationale missing or trivial");
  }

  if (implementationPrefixPattern.test(title)) {
    return reject("bug_fix_step", `title prefix "${title.split(/\s+/)[0] ?? ""}"`);
  }

  const titleLc = title.toLowerCase();
  if (deferralMarkers.some((marker) => titleLc.startsWith(marker))) {
    return reject("todo", "title is a deferral marker");
  }
  if (statusMarkers.some((marker) => titleLc.includes(marker))) {
    return reject("status_update", "title is status");
  }

  const diaryText = `${titleLc}\n${rationale.toLowerCase()}`;
  if (diaryReflectionMarkers.some((marker) => diaryText.includes(marker))) {
    return reject("diary_reflection", "diary/reflection content is not a durable decision");
  }

  if (candidate.scope === "unknown") {
    return reject("invalid_source", "scope is not promotable");
  }

  if (rationaleIsTautological(title, rationale)) {
    return reject("tautological_rationale", "rationale repeats decision");
  }

  if (alternatives !== null && isAlternativeJustNegation(title, alternatives)) {
    notes.push("alternatives is mere negation — dropped");
    alternatives = null;
  }

  if (candidate.actor === "subagent" && !candidate.operatorConfirmed) {
    return reject("subagent_report", "subagent decision without operator confirmation");
  }

  return { passed: true, rejectClass: null, notes, alternatives };
}
