// Read-only slash-command catalog derived from the skill inventory.
//
// Upstream exposes skills as `/skill:<name>` commands (`src/skills/loading/
// session.ts`). Two skills that normalize to the same name collide in that
// command namespace; the inventory already resolves precedence by marking
// lower-precedence duplicates `shadowed`. This module aggregates the per-skill
// invocation surface (`skillInvocation.ts`) into the command namespace and
// surfaces those collisions read-only. It does NOT dispatch or execute anything —
// actual slash-command invocation stays out of scope.

import type { INeonSkillSummary, TNeonSkillLoadState } from "./neonSkills.js";
import type { TNeonSkillInvocationState } from "./skillInvocation.js";

export interface INeonSkillCommandCollision {
  readonly name: string;
  readonly rootId: string;
  readonly loadState: TNeonSkillLoadState;
}

export interface INeonSkillCommandEntry {
  /** Slash command form, `/skill:<toolName>`. */
  readonly command: string;
  /** Normalized skill name used as the stable command/tool id. */
  readonly toolName: string;
  /** Resolved owner skill (highest-precedence non-shadowed entry for the name). */
  readonly ownerName: string;
  readonly ownerRootId: string;
  readonly state: TNeonSkillInvocationState;
  readonly modelInvocable: boolean;
  /** Other skills that derive the same command (the lower-precedence duplicates). */
  readonly collisions: readonly INeonSkillCommandCollision[];
}

export interface INeonSkillCommandCatalogTotals {
  readonly commands: number;
  readonly modelInvocable: number;
  readonly collisions: number;
}

export interface INeonSkillCommandCatalog {
  readonly entries: readonly INeonSkillCommandEntry[];
  readonly totals: INeonSkillCommandCatalogTotals;
}

// Lower number wins ownership of a command when several skills share a name.
const INVOCATION_STATE_RANK: Record<TNeonSkillInvocationState, number> = {
  active: 0,
  "model-disabled": 1,
  shadowed: 2,
  unavailable: 3
};

/**
 * Aggregate the per-skill invocation surface into the `/skill:<name>` command
 * namespace. Pure: no I/O, no dispatch. Skills with an empty normalized name are
 * skipped (they cannot form a command). Entries are sorted by command name.
 */
export function createNeonSkillCommandCatalog(
  skills: readonly INeonSkillSummary[]
): INeonSkillCommandCatalog {
  const groups = new Map<string, INeonSkillSummary[]>();
  for (const skill of skills) {
    if (skill.normalizedName.length === 0) {
      continue;
    }
    const group = groups.get(skill.normalizedName);
    if (group) {
      group.push(skill);
    } else {
      groups.set(skill.normalizedName, [skill]);
    }
  }

  const entries: INeonSkillCommandEntry[] = [];
  for (const [toolName, group] of groups) {
    const ordered = orderByOwnership(group);
    const owner = ordered[0];
    if (!owner) {
      continue;
    }

    entries.push({
      command: `/skill:${toolName}`,
      toolName,
      ownerName: owner.name,
      ownerRootId: owner.rootId,
      state: owner.invocation.state,
      modelInvocable: owner.invocation.modelInvocable,
      collisions: ordered.slice(1).map((skill) => ({
        name: skill.name,
        rootId: skill.rootId,
        loadState: skill.loadState
      }))
    });
  }

  entries.sort((left, right) => left.command.localeCompare(right.command));

  return {
    entries,
    totals: {
      commands: entries.length,
      modelInvocable: entries.filter((entry) => entry.modelInvocable).length,
      collisions: entries.filter((entry) => entry.collisions.length > 0).length
    }
  };
}

export function renderNeonSkillCommandCatalogReport(catalog: INeonSkillCommandCatalog): string {
  const lines = [
    `Neon Skill Commands: ${catalog.totals.commands} command(s)`,
    `Model-invocable: ${catalog.totals.modelInvocable} / collisions: ${catalog.totals.collisions}`
  ];

  for (const entry of catalog.entries.slice(0, 16)) {
    const collision =
      entry.collisions.length > 0
        ? ` / collides: ${entry.collisions.map((other) => `${other.name}@${other.rootId}`).join(", ")}`
        : "";
    lines.push(
      `- ${entry.command}: ${entry.state} / owner ${entry.ownerName}@${entry.ownerRootId}${collision}`
    );
  }

  return lines.join("\n");
}

function orderByOwnership(group: readonly INeonSkillSummary[]): readonly INeonSkillSummary[] {
  return [...group]
    .map((skill, index) => ({ skill, index }))
    .sort((left, right) => {
      const rankDelta =
        INVOCATION_STATE_RANK[left.skill.invocation.state] -
        INVOCATION_STATE_RANK[right.skill.invocation.state];
      return rankDelta !== 0 ? rankDelta : left.index - right.index;
    })
    .map((entry) => entry.skill);
}
