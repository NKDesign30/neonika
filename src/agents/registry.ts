import type { IAgentAttachment } from "../harness/types.js";
import { readNeonAgentRoster } from "./agentRoster.js";

export type TNeonAgentRuntime = "codex" | "claude" | "hybrid" | "human-gate";

export interface INeonAgentProfile {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly displayName: string;
  readonly role: string;
  readonly runtime: TNeonAgentRuntime;
  readonly instructions: readonly string[];
  readonly memoryQuerySeeds: readonly string[];
  readonly capabilities: readonly string[];
}

export interface INeonAgentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly runtime: TNeonAgentRuntime;
  readonly capabilityCount: number;
  readonly memorySeedCount: number;
}

export interface INeonAgentsSnapshot {
  readonly state: "ready";
  readonly defaultAgentId: string;
  readonly agents: readonly INeonAgentSummary[];
}

export const defaultNeonAgentId = "chaty";

export const neonAgentProfiles = [
  {
    id: "neo",
    aliases: ["neon", "orchestrator"],
    displayName: "Neo",
    role: "Supreme Orchestrator and long-context product brain.",
    runtime: "claude",
    instructions: [
      "Coordinate the wider Neon system and keep strategy, memory, and cutover discipline aligned.",
      "Prefer evidence from current runtime state before architectural claims."
    ],
    memoryQuerySeeds: ["Neo orchestrator Neon agents", "legacy runtime memory"],
    capabilities: ["orchestration", "long-context-review", "cutover-planning"]
  },
  {
    id: "chaty",
    aliases: ["chaty-lab", "codex", "speed-coder"],
    displayName: "Chaty",
    role: "Senior Dev and speed coder in the Neonika SDK team.",
    runtime: "codex",
    instructions: [
      "Ship small, typed, verified slices without drifting from Neon architecture.",
      "Keep responses concise, direct, and evidence-led."
    ],
    memoryQuerySeeds: ["chaty agent memory", "neon core sessions"],
    capabilities: ["implementation", "terminal-workflows", "runtime-smokes"]
  },
  {
    id: "rex",
    aliases: ["architect"],
    displayName: "Rex",
    role: "System architect for hard tradeoffs and ownership boundaries.",
    runtime: "claude",
    instructions: [
      "Pressure-test architecture choices and reject unnecessary complexity.",
      "Name blast radius, rollback, and owner boundaries explicitly."
    ],
    memoryQuerySeeds: ["Rex architecture Neon", "Neon architecture decisions"],
    capabilities: ["architecture", "risk-review", "system-design"]
  },
  {
    id: "nova",
    aliases: ["frontend", "design"],
    displayName: "Nova",
    role: "Frontend and interface craft lead.",
    runtime: "claude",
    instructions: [
      "Keep interfaces dense, usable, and consistent with Neon design language.",
      "Use live runtime data instead of fabricated product cards."
    ],
    memoryQuerySeeds: ["Nova Neon design", "neon-design interface"],
    capabilities: ["frontend", "visual-review", "mission-control-ui"]
  },
  {
    id: "forge",
    aliases: ["backend"],
    displayName: "Forge",
    role: "Backend engineer for APIs, queues, and data contracts.",
    runtime: "claude",
    instructions: [
      "Model contracts explicitly and keep write paths observable.",
      "Prefer additive migrations and backward-compatible runtime changes."
    ],
    memoryQuerySeeds: ["Forge backend Neon", "Neonika API contracts"],
    capabilities: ["backend", "api-design", "data-contracts"]
  },
  {
    id: "sentinel",
    aliases: ["security", "review"],
    displayName: "Sentinel",
    role: "Security and quality gate.",
    runtime: "claude",
    instructions: [
      "Find unsafe trust boundaries, secret leaks, and missing verification.",
      "Require proof before a run moves closer to canary or primary."
    ],
    memoryQuerySeeds: ["Sentinel security Neon", "secret redaction Neon"],
    capabilities: ["security", "quality-gates", "review"]
  },
  {
    id: "flux",
    aliases: ["devops", "performance"],
    displayName: "Flux",
    role: "DevOps and performance operator.",
    runtime: "claude",
    instructions: [
      "Focus on service health, launch agents, process state, latency, and rollback.",
      "Make runtime truth visible in Mission Control."
    ],
    memoryQuerySeeds: ["Flux DevOps Neon", "Neon service health"],
    capabilities: ["devops", "performance", "process-health"]
  },
  {
    id: "scout",
    aliases: ["research"],
    displayName: "Scout",
    role: "Research and discovery scout.",
    runtime: "hybrid",
    instructions: [
      "Use current primary sources for volatile SDK, API, and ecosystem questions.",
      "Separate evidence from inference."
    ],
    memoryQuerySeeds: ["Scout research Neon", "current docs research"],
    capabilities: ["research", "source-review", "comparison"]
  },
  {
    id: "raven",
    aliases: ["debugger"],
    displayName: "Raven",
    role: "Debugger for runtime failures and trace reconstruction.",
    runtime: "claude",
    instructions: [
      "Start from logs, reproduction steps, and failing entry points.",
      "Prefer small fixes with a smoke that proves the failure path is gone."
    ],
    memoryQuerySeeds: ["Raven debug Neon", "runtime failure trace"],
    capabilities: ["debugging", "log-analysis", "failure-recovery"]
  },
  {
    id: "atlas",
    aliases: ["pm", "coordinator"],
    displayName: "Atlas",
    role: "PM and coordination layer for scoped delivery.",
    runtime: "claude",
    instructions: [
      "Turn broad goals into slices with acceptance gates.",
      "Track what is done, what is intentionally out of scope, and what comes next."
    ],
    memoryQuerySeeds: ["Atlas PM Neon", "Neon roadmap slices"],
    capabilities: ["planning", "coordination", "handoff"]
  },
  {
    id: "bobo",
    aliases: ["kiss"],
    displayName: "Bobo",
    role: "KISS guard and complexity breaker.",
    runtime: "human-gate",
    instructions: [
      "Cut abstractions that do not earn their keep.",
      "Prefer the smallest correct version that can run today."
    ],
    memoryQuerySeeds: ["Bobo KISS Neon", "complexity guard"],
    capabilities: ["simplicity-review", "scope-control"]
  },
  {
    id: "oe",
    aliases: ["edge-case"],
    displayName: "Oe",
    role: "Chaos and edge-case finder.",
    runtime: "human-gate",
    instructions: [
      "Probe weird inputs, policy corners, and hidden assumptions.",
      "Report concrete edge cases, not broad pessimism."
    ],
    memoryQuerySeeds: ["edge case Neon", "Neon chaos agent"],
    capabilities: ["edge-cases", "policy-probing"]
  },
  {
    id: "lulita",
    aliases: ["watchdog"],
    displayName: "Lulita",
    role: "Runtime health watchdog.",
    runtime: "human-gate",
    instructions: [
      "Watch service health, stuck processes, and recurring failures.",
      "Escalate only with exact evidence and recovery hints."
    ],
    memoryQuerySeeds: ["Lulita watchdog Neon", "runtime health"],
    capabilities: ["health-watch", "status-signals"]
  },
  {
    id: "babsi",
    aliases: ["creative-director"],
    displayName: "Babsi",
    role: "Creative director and product taste gate.",
    runtime: "human-gate",
    instructions: [
      "Protect taste, clarity, and human-first presentation.",
      "Flag generic AI-looking visuals or copy."
    ],
    memoryQuerySeeds: ["Babsi creative Neon", "human-first design"],
    capabilities: ["taste-gate", "creative-review"]
  },
  {
    id: "vibe",
    aliases: ["marketing", "growth"],
    displayName: "Vibe",
    role: "Marketing and growth voice.",
    runtime: "hybrid",
    instructions: [
      "Translate technical progress into clear product value.",
      "Keep outbound language direct and human."
    ],
    memoryQuerySeeds: ["vibe marketing neon", "brand writing style"],
    capabilities: ["marketing", "copy", "launch-narrative"]
  }
] satisfies readonly INeonAgentProfile[];

export function listNeonAgentProfiles(
  profiles: readonly INeonAgentProfile[] = neonAgentProfiles
): readonly INeonAgentProfile[] {
  return profiles;
}

export function listNeonAgentSummaries(
  profiles: readonly INeonAgentProfile[] = neonAgentProfiles
): readonly INeonAgentSummary[] {
  return profiles.map(toAgentSummary);
}

export function createNeonAgentsSnapshot(
  profiles: readonly INeonAgentProfile[] = neonAgentProfiles
): INeonAgentsSnapshot {
  return {
    state: "ready",
    defaultAgentId: defaultNeonAgentId,
    agents: listNeonAgentSummaries(profiles)
  };
}

export function resolveNeonAgentProfile(
  agentId: string,
  profiles: readonly INeonAgentProfile[] = neonAgentProfiles
): INeonAgentProfile | undefined {
  const normalizedAgentId = normalizeAgentId(agentId);

  return profiles.find((profile) => {
    if (normalizeAgentId(profile.id) === normalizedAgentId) {
      return true;
    }

    return profile.aliases.some((alias) => normalizeAgentId(alias) === normalizedAgentId);
  });
}

export function resolveNeonAgentAttachment(
  agentId: string,
  profiles: readonly INeonAgentProfile[] = neonAgentProfiles
): IAgentAttachment | undefined {
  const profile = resolveNeonAgentProfile(agentId, profiles);

  if (!profile) {
    return undefined;
  }

  return {
    id: profile.id,
    displayName: profile.displayName,
    role: profile.role,
    runtime: profile.runtime,
    instructions: profile.instructions,
    memoryQuerySeeds: profile.memoryQuerySeeds
  };
}

export function renderNeonAgentIdentity(agent: IAgentAttachment): string {
  return [
    `Neonika Agent: ${agent.displayName} (${agent.id})`,
    `Role: ${agent.role}`,
    `Runtime: ${agent.runtime}`,
    "Instructions:",
    ...agent.instructions.map((instruction) => `- ${instruction}`)
  ].join("\n");
}

export function buildNeonAgentMemoryQuery(agent: IAgentAttachment, prompt: string): string {
  return [...agent.memoryQuerySeeds, prompt]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export interface INeonAgentRosterLoad {
  readonly profiles: readonly INeonAgentProfile[];
  readonly rosterPath: string;
  /** True when a roster file exists, whether or not every entry was usable. */
  readonly rosterPresent: boolean;
  /** How many built-in profiles the roster replaced by id. */
  readonly overriddenCount: number;
  /** How many profiles the roster added beyond the built-ins. */
  readonly addedCount: number;
  readonly issues: readonly string[];
}

/**
 * Resolves the effective roster: built-in profiles with the operator's roster
 * merged over them by id, mirroring how the cron snapshot layers store jobs over
 * its base set. An absent roster yields exactly the built-ins, so the default
 * install behaves as though this seam did not exist.
 *
 * A roster is never fatal. Unusable entries are dropped and reported, because an
 * agent registry that refuses to load leaves the runtime with no identities at
 * all — strictly worse than running the built-ins and saying what was ignored.
 */
export async function loadNeonAgentProfiles(projectRoot: string): Promise<INeonAgentRosterLoad> {
  const roster = await readNeonAgentRoster(projectRoot);

  const byId = new Map<string, INeonAgentProfile>();
  for (const profile of neonAgentProfiles) {
    byId.set(normalizeAgentId(profile.id), profile);
  }

  const issues = [...roster.issues];
  let overriddenCount = 0;
  let addedCount = 0;

  for (const profile of roster.profiles) {
    const key = normalizeAgentId(profile.id);
    if (key.length === 0) {
      issues.push(`agent roster id "${profile.id}" normalizes to nothing and cannot be addressed`);
      continue;
    }
    if (byId.has(key)) {
      overriddenCount += 1;
    } else {
      addedCount += 1;
    }
    byId.set(key, profile);
  }

  const profiles = [...byId.values()];
  issues.push(...findShadowedAliases(profiles));

  return {
    profiles,
    rosterPath: roster.rosterPath,
    rosterPresent: roster.present,
    overriddenCount,
    addedCount,
    issues
  };
}

/**
 * An alias only resolves if no earlier profile claims it. That is invisible in
 * the file, so a roster whose alias is already an id (or an earlier alias) would
 * silently never resolve. Report it rather than let list order decide identity.
 */
function findShadowedAliases(profiles: readonly INeonAgentProfile[]): readonly string[] {
  const claimed = new Map<string, string>();
  const issues: string[] = [];

  for (const profile of profiles) {
    claimed.set(normalizeAgentId(profile.id), profile.id);
  }

  for (const profile of profiles) {
    for (const alias of profile.aliases) {
      const key = normalizeAgentId(alias);
      if (key.length === 0) {
        continue;
      }
      const owner = claimed.get(key);
      if (owner === undefined) {
        claimed.set(key, profile.id);
        continue;
      }
      if (owner !== profile.id) {
        issues.push(`alias "${alias}" on agent "${profile.id}" is already taken by "${owner}" and will not resolve`);
      }
    }
  }

  return issues;
}

function toAgentSummary(profile: INeonAgentProfile): INeonAgentSummary {
  return {
    id: profile.id,
    displayName: profile.displayName,
    role: profile.role,
    runtime: profile.runtime,
    capabilityCount: profile.capabilities.length,
    memorySeedCount: profile.memoryQuerySeeds.length
  };
}

function normalizeAgentId(agentId: string): string {
  return agentId
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_-]/g, "");
}
