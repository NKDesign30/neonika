import { normalizeNeonSkillName, type INeonSkillSummary } from "./neonSkills.js";

/**
 * Pure, side-effect-free enable/deny policy for Neon skills.
 *
 * This module decides, per agent, which reference-only skills are allowed and
 * which are denied. It NEVER loads or executes skill or plugin code. It only
 * reasons over the already-scanned skill inventory (names + trust) plus a
 * declarative policy config.
 *
 * The default behaviour is allow-everything: with an empty or absent config no
 * skill is filtered, so the current Neon baseline (skills reference-only,
 * Plugin Trust PASS) stays stable until explicit rules are configured.
 *
 * Precedence (matching upstream's reference resolver):
 *   1. master switch off  -> everything denied
 *   2. explicit deny       -> denied (deny wins over allow)
 *   3. non-empty allowlist -> only allowlisted skills allowed
 *   4. otherwise           -> allowed (default-allow)
 *
 * Deny/allow scopes are layered global -> per-agent, where per-agent rules win
 * over global rules for the same skill.
 */

export const neonSkillPolicyWildcard = "*";

export type TNeonSkillPolicyDecision = "allow" | "deny";

export type TNeonSkillPolicyReason =
  | "default-allow"
  | "wildcard-allow"
  | "allowlisted"
  | "unknown-agent-default-allow"
  | "master-disabled"
  | "denied-global"
  | "denied-agent"
  | "not-in-allowlist";

export interface INeonSkillPolicyAgentRules {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface INeonSkillPolicyConfig {
  /**
   * Master switch. When false, every skill is denied for every agent.
   * Defaults to true (enabled) when omitted.
   */
  readonly enabled?: boolean;
  /** Global allowlist applied to every agent. Empty/absent = no allowlist gate. */
  readonly allow?: readonly string[];
  /** Global denylist applied to every agent. */
  readonly deny?: readonly string[];
  /** Per-agent rule overrides, keyed by agent id or alias. */
  readonly byAgent?: Readonly<Record<string, INeonSkillPolicyAgentRules>>;
}

export interface INeonSkillPolicyDecision {
  readonly name: string;
  readonly normalizedName: string;
  readonly trust: INeonSkillSummary["trust"];
  readonly decision: TNeonSkillPolicyDecision;
  readonly reason: TNeonSkillPolicyReason;
}

export interface INeonAgentSkillPolicyResult {
  readonly agentId: string;
  readonly normalizedAgentId: string;
  readonly agentResolved: boolean;
  readonly policyEnabled: boolean;
  readonly decisions: readonly INeonSkillPolicyDecision[];
  readonly allowed: readonly INeonSkillPolicyDecision[];
  readonly denied: readonly INeonSkillPolicyDecision[];
}

export interface IResolveAgentSkillPolicyOptions {
  /**
   * Optional resolver that maps an agent id/alias to a canonical agent id.
   * When provided and it returns a value, the canonical id is used to look up
   * per-agent rules and the agent counts as resolved. When it returns
   * undefined the agent is treated as unknown (still default-allow).
   */
  readonly resolveAgentId?: (agentId: string) => string | undefined;
}

interface IResolvedPolicyRules {
  readonly enabled: boolean;
  readonly globalAllow: ReadonlySet<string>;
  readonly globalDeny: ReadonlySet<string>;
  readonly agentAllow: ReadonlySet<string>;
  readonly agentDeny: ReadonlySet<string>;
}

/**
 * Resolve which skills are allowed/denied for a single agent.
 *
 * Pure: no I/O, no code loading, deterministic for given inputs.
 */
export function resolveAgentSkillPolicy(
  agentId: string,
  skills: readonly INeonSkillSummary[],
  policyConfig: INeonSkillPolicyConfig = {},
  options: IResolveAgentSkillPolicyOptions = {}
): INeonAgentSkillPolicyResult {
  const requestedNormalizedAgentId = normalizeNeonSkillName(agentId);
  const canonicalAgentId = options.resolveAgentId?.(agentId);
  const agentResolved = canonicalAgentId !== undefined;
  const lookupAgentId = canonicalAgentId ?? agentId;
  const normalizedAgentId = canonicalAgentId
    ? normalizeNeonSkillName(canonicalAgentId)
    : requestedNormalizedAgentId;

  const rules = resolvePolicyRules(policyConfig, lookupAgentId);

  const decisions = skills.map((skill) =>
    decideSkill(skill, rules, agentResolved)
  );

  return {
    agentId,
    normalizedAgentId,
    agentResolved,
    policyEnabled: rules.enabled,
    decisions,
    allowed: decisions.filter((decision) => decision.decision === "allow"),
    denied: decisions.filter((decision) => decision.decision === "deny")
  };
}

function decideSkill(
  skill: INeonSkillSummary,
  rules: IResolvedPolicyRules,
  agentResolved: boolean
): INeonSkillPolicyDecision {
  const base = {
    name: skill.name,
    normalizedName: skill.normalizedName,
    trust: skill.trust
  } as const;
  const key = skill.normalizedName;

  if (!rules.enabled) {
    return { ...base, decision: "deny", reason: "master-disabled" };
  }

  // Deny wins over allow. Per-agent deny is the most specific signal.
  if (matches(rules.agentDeny, key)) {
    return { ...base, decision: "deny", reason: "denied-agent" };
  }
  if (matches(rules.globalDeny, key)) {
    return { ...base, decision: "deny", reason: "denied-global" };
  }

  // Wildcard allow short-circuits any allowlist gate.
  if (rules.agentAllow.has(neonSkillPolicyWildcard) || rules.globalAllow.has(neonSkillPolicyWildcard)) {
    return { ...base, decision: "allow", reason: "wildcard-allow" };
  }

  // A non-empty allowlist (global or agent) becomes an exclusive gate.
  const hasAllowGate = rules.globalAllow.size > 0 || rules.agentAllow.size > 0;
  if (hasAllowGate) {
    if (matches(rules.agentAllow, key) || matches(rules.globalAllow, key)) {
      return { ...base, decision: "allow", reason: "allowlisted" };
    }
    return { ...base, decision: "deny", reason: "not-in-allowlist" };
  }

  // No deny match and no allowlist gate -> default allow.
  return {
    ...base,
    decision: "allow",
    reason: agentResolved ? "default-allow" : "unknown-agent-default-allow"
  };
}

function resolvePolicyRules(
  policyConfig: INeonSkillPolicyConfig,
  lookupAgentId: string
): IResolvedPolicyRules {
  const normalizedAgentId = normalizeNeonSkillName(lookupAgentId);
  const agentRules = findAgentRules(policyConfig.byAgent, normalizedAgentId);

  return {
    enabled: policyConfig.enabled ?? true,
    globalAllow: toNameSet(policyConfig.allow),
    globalDeny: toNameSet(policyConfig.deny),
    agentAllow: toNameSet(agentRules?.allow),
    agentDeny: toNameSet(agentRules?.deny)
  };
}

function findAgentRules(
  byAgent: Readonly<Record<string, INeonSkillPolicyAgentRules>> | undefined,
  normalizedAgentId: string
): INeonSkillPolicyAgentRules | undefined {
  if (!byAgent || !normalizedAgentId) {
    return undefined;
  }

  for (const [key, value] of Object.entries(byAgent)) {
    if (normalizeNeonSkillName(key) === normalizedAgentId) {
      return value;
    }
  }

  return undefined;
}

function toNameSet(values: readonly string[] | undefined): ReadonlySet<string> {
  if (!values) {
    return new Set<string>();
  }

  const set = new Set<string>();
  for (const value of values) {
    if (value === neonSkillPolicyWildcard) {
      set.add(neonSkillPolicyWildcard);
      continue;
    }
    const normalized = normalizeNeonSkillName(value);
    if (normalized) {
      set.add(normalized);
    }
  }

  return set;
}

function matches(set: ReadonlySet<string>, normalizedName: string): boolean {
  return normalizedName.length > 0 && set.has(normalizedName);
}
