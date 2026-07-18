// Neonika Transcript Indexer — decision domain types. Shared vocabulary for the
// decision document, the quality gate, the voice detector and the importance
// scorer. Ported from the battle-tested v3 indexer type set.

/** Who produced a decision — steers importance scoring and the quality gate. */
export type TNeonDecisionActor = "operator" | "neo" | "subagent" | "unknown";

/** Decision scope — feeds the importance score. */
export type TNeonDecisionScope = "architecture" | "tooling" | "tactical" | "uiux" | "unknown";

/** Reject classes that must never reach memory. */
export type TNeonDecisionRejectClass =
  | "bug_fix_step"
  | "implementation_detail"
  | "subagent_report"
  | "status_update"
  | "todo"
  | "summary_heading"
  | "tautological_rationale"
  | "duplicate"
  | "diary_reflection"
  | "operator_rejected"
  | "invalid_source"
  | "placeholder";

/** A decision candidate as parsed from a model response, before gating. */
export interface INeonDecisionCandidate {
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly actor: TNeonDecisionActor;
  readonly scope: TNeonDecisionScope;
  readonly operatorConfirmed: boolean;
}

export const neonDecisionActors: readonly TNeonDecisionActor[] = [
  "operator",
  "neo",
  "subagent",
  "unknown"
];

export const neonDecisionScopes: readonly TNeonDecisionScope[] = [
  "architecture",
  "tooling",
  "tactical",
  "uiux",
  "unknown"
];
