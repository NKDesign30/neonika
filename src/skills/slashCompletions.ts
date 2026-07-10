import type {
  INeonSkillCommandCatalog,
  INeonSkillCommandEntry
} from "./skillCommandCatalog.js";

/**
 * Slash-command autocomplete for the chat composer (Sessions/Chat-Surface).
 *
 * Pure read path over the existing `/skill:<name>` command namespace produced by
 * `createNeonSkillCommandCatalog`: no I/O, no dispatch, no side effect — so it
 * needs no gate. Mirrors upstream's slash-completion provider intent without an
 * execution path (completion only; invocation stays the existing command surface).
 *
 * Matching is tolerant of the forms a composer actually sends: `/skill:rev`,
 * `/rev`, or a bare `rev`. Ranking favors command-prefix hits, then name-prefix,
 * then substring; within a rank, active + model-invocable entries come first.
 */
type TNeonSlashCompletionState = INeonSkillCommandEntry["state"];
type TNeonSlashCompletionMatchKind = "command-prefix" | "name-prefix" | "substring";

export interface INeonSlashCompletion {
  readonly command: string;
  readonly toolName: string;
  readonly modelInvocable: boolean;
  readonly state: TNeonSlashCompletionState;
  readonly matchKind: TNeonSlashCompletionMatchKind;
}

export interface ICompleteNeonSlashCommandOptions {
  readonly limit?: number;
}

const DEFAULT_COMPLETION_LIMIT = 10;
const SKILL_COMMAND_PREFIX = "/skill:";

const MATCH_KIND_RANK: Record<TNeonSlashCompletionMatchKind, number> = {
  "command-prefix": 0,
  "name-prefix": 1,
  substring: 2
};

export function completeNeonSlashCommand(
  prefix: string,
  catalog: INeonSkillCommandCatalog,
  options: ICompleteNeonSlashCommandOptions = {}
): readonly INeonSlashCompletion[] {
  const normalized = prefix.trim().toLowerCase();
  const bareName = normalized.startsWith(SKILL_COMMAND_PREFIX)
    ? normalized.slice(SKILL_COMMAND_PREFIX.length)
    : normalized.replace(/^\//, "");
  const limit = clampLimit(options.limit);

  const matches: INeonSlashCompletion[] = [];

  for (const entry of catalog.entries) {
    const command = entry.command.toLowerCase();
    const toolName = entry.toolName.toLowerCase();
    const matchKind = resolveMatchKind(normalized, bareName, command, toolName);

    if (matchKind === undefined) {
      continue;
    }

    matches.push({
      command: entry.command,
      toolName: entry.toolName,
      modelInvocable: entry.modelInvocable,
      state: entry.state,
      matchKind
    });
  }

  matches.sort(compareCompletions);
  return matches.slice(0, limit);
}

export function renderNeonSlashCompletions(
  prefix: string,
  completions: readonly INeonSlashCompletion[]
): string {
  if (completions.length === 0) {
    return `Slash completions for "${prefix}": none`;
  }

  return [
    `Slash completions for "${prefix}": ${completions.length}`,
    ...completions.map((completion) => {
      const flags = [
        completion.matchKind,
        ...(completion.modelInvocable ? [] : ["not-model-invocable"]),
        ...(completion.state === "active" ? [] : [completion.state])
      ].join(", ");
      return `  ${completion.command} (${flags})`;
    })
  ].join("\n");
}

function resolveMatchKind(
  normalized: string,
  bareName: string,
  command: string,
  toolName: string
): TNeonSlashCompletionMatchKind | undefined {
  // Empty prefix lists everything (top-N after ranking).
  if (normalized.length === 0 || command.startsWith(normalized)) {
    return "command-prefix";
  }
  if (bareName.length > 0 && toolName.startsWith(bareName)) {
    return "name-prefix";
  }
  if (command.includes(normalized)) {
    return "substring";
  }
  return undefined;
}

function compareCompletions(a: INeonSlashCompletion, b: INeonSlashCompletion): number {
  const kindDelta = MATCH_KIND_RANK[a.matchKind] - MATCH_KIND_RANK[b.matchKind];
  if (kindDelta !== 0) {
    return kindDelta;
  }

  const activeDelta = activeRank(a.state) - activeRank(b.state);
  if (activeDelta !== 0) {
    return activeDelta;
  }

  const modelDelta = (a.modelInvocable ? 0 : 1) - (b.modelInvocable ? 0 : 1);
  if (modelDelta !== 0) {
    return modelDelta;
  }

  return a.command.localeCompare(b.command);
}

function activeRank(state: TNeonSlashCompletionState): number {
  return state === "active" ? 0 : 1;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
    return DEFAULT_COMPLETION_LIMIT;
  }
  return Math.floor(limit);
}
