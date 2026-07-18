// Read-only derivation of how a discovered skill would be invoked.
//
// Mirrors upstream's skill resolution (`src/skills/loading/*`): a skill is
// offered to the model only when `disableModelInvocation` is false
// (`includeInAvailableSkillsPrompt = !disableModelInvocation`,
// `workspace.ts`); skills with model-invocation disabled stay reachable only via
// the explicit `/skill:<name>` slash command (`session.ts`). This module derives
// that surface read-only — it never dispatches a tool or runs a command. Actual
// tool/slash dispatch is deliberately out of scope (a separate, non-read-only
// slice).

export type TNeonSkillInvocationState =
  | "active"
  | "model-disabled"
  | "shadowed"
  | "unavailable";

export interface INeonSkillInvocation {
  /** Stable tool identifier (the normalized skill name). */
  readonly toolName: string;
  /** Explicit slash command form, matching upstream's `/skill:<name>`. */
  readonly slashCommand: string;
  /** Whether the model sees the skill as an available tool (active state only). */
  readonly modelInvocable: boolean;
  readonly state: TNeonSkillInvocationState;
}

export interface INeonSkillInvocationInput {
  readonly normalizedName: string;
  /** Highest-precedence, readable skill for this name (loadState "available"). */
  readonly available: boolean;
  /** A higher-precedence skill already owns this name (loadState "shadowed"). */
  readonly shadowed: boolean;
  readonly disableModelInvocation: boolean;
}

/**
 * Derive the read-only invocation surface for one skill. Pure: no I/O, no
 * dispatch. `available`/`shadowed` are both false for invalid/unreadable skills,
 * which resolve to the `unavailable` state.
 */
export function deriveNeonSkillInvocation(
  input: INeonSkillInvocationInput
): INeonSkillInvocation {
  const state = resolveInvocationState(input);

  return {
    toolName: input.normalizedName,
    slashCommand: `/skill:${input.normalizedName}`,
    modelInvocable: state === "active",
    state
  };
}

function resolveInvocationState(input: INeonSkillInvocationInput): TNeonSkillInvocationState {
  if (input.shadowed) {
    return "shadowed";
  }
  if (!input.available) {
    return "unavailable";
  }
  if (input.disableModelInvocation) {
    return "model-disabled";
  }
  return "active";
}
