// Neon Transcript Indexer — decision importance scorer. Port of the v3 dynamic
// score (the fix for "everything is importance 85/72"): base 50, scope bonus,
// confirmation and trade-off bonuses, subagent and bug-prefix penalties.
// Distinct from src/memory/neonMemoryImportance.ts, which handles Ebbinghaus
// retention of existing entries — this scores a NEW decision at extraction time.

import type { TNeonDecisionActor, TNeonDecisionScope } from "./decisionTypes.js";

const scopeBonus: Record<TNeonDecisionScope, number> = {
  architecture: 15,
  tooling: 10,
  tactical: 5,
  uiux: 0,
  unknown: 0
};

const tradeOffMarkers: readonly string[] = [
  " statt ",
  " vs ",
  " vs. ",
  " weil ",
  " anstelle ",
  " instead of "
];

const implementationPrefixPattern = /^(bug\s+\d|bug\s|fix\s|refactor\s|implement\s)/i;

export interface INeonDecisionScoreInput {
  readonly scope: TNeonDecisionScope;
  readonly actor: TNeonDecisionActor;
  readonly operatorConfirmed: boolean;
  readonly alternatives: string | null;
  readonly title: string;
  readonly rationale: string;
  readonly distinctQueryCount?: number;
}

function queryDiversityBonus(distinctQueryCount: number | undefined): number {
  if (typeof distinctQueryCount !== "number" || !Number.isFinite(distinctQueryCount)) {
    return 0;
  }
  const beyondFirstQuery = Math.max(0, Math.floor(distinctQueryCount) - 1);
  return Math.min(10, beyondFirstQuery * 2);
}

export function scoreNeonDecisionImportance(input: INeonDecisionScoreInput): number {
  let score = 50;

  score += scopeBonus[input.scope];

  if (input.operatorConfirmed) {
    score += 10;
  }

  if (input.alternatives !== null && input.alternatives.trim().length >= 5) {
    score += 5;
  }

  const rationaleLc = input.rationale.toLowerCase();
  if (tradeOffMarkers.some((marker) => rationaleLc.includes(marker))) {
    score += 5;
  }

  score += queryDiversityBonus(input.distinctQueryCount);

  if (input.actor === "subagent") {
    score -= 20;
  }

  if (implementationPrefixPattern.test(input.title.trim())) {
    score -= 10;
  }

  const wordCount = input.rationale.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 10) {
    score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}
