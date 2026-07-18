import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  INeonSkillPolicyAgentRules,
  INeonSkillPolicyConfig
} from "./skillPolicy.js";

/**
 * Read-only loader for the declarative Neon skill-policy source.
 *
 * This module NEVER loads or executes skill or plugin code. It only reads a
 * single versioned JSON file and strictly validates it into the declarative
 * {@link INeonSkillPolicyConfig} shape that {@link resolveAgentSkillPolicy}
 * already consumes (allow/deny skill names, optional per-agent rules, master
 * switch).
 *
 * Baseline-stable by design: when the file is missing or invalid the loader
 * returns an empty config, so the default-allow baseline stays untouched. The
 * loader never throws on missing or malformed input.
 */

/** Versioned, repo-checked-in policy file relative to the project root. */
export const neonSkillPolicySourceRelativePath = ".agents/skill-policy.json";

export type TNeonSkillPolicySourceState = "loaded" | "absent" | "invalid";

export interface INeonSkillPolicySourceResult {
  /** Whether the file was loaded, absent, or present-but-invalid. */
  readonly state: TNeonSkillPolicySourceState;
  /** Repo-relative path of the policy file (never an absolute path). */
  readonly relativePath: string;
  /**
   * The validated declarative config. Always usable: an empty object for the
   * absent/invalid states, which yields default-allow.
   */
  readonly config: INeonSkillPolicyConfig;
}

/** Resolve the absolute path of the declarative policy source. */
export function resolveNeonSkillPolicySourcePath(projectRoot: string): string {
  return join(resolve(projectRoot), ".agents", "skill-policy.json");
}

/**
 * Load and strictly validate the declarative skill-policy source.
 *
 * Read-only: opens the file, parses JSON, validates declarative fields. Any
 * failure mode (missing file, unreadable, malformed JSON, wrong top-level type)
 * resolves to an empty config so the baseline stays default-allow.
 */
export async function loadNeonSkillPolicySource(
  projectRoot: string
): Promise<INeonSkillPolicySourceResult> {
  const path = resolveNeonSkillPolicySourcePath(projectRoot);
  const raw = await readPolicyFile(path);

  if (raw === undefined) {
    return {
      state: "absent",
      relativePath: neonSkillPolicySourceRelativePath,
      config: {}
    };
  }

  const parsed = parsePolicyJson(raw);
  if (parsed === undefined) {
    return {
      state: "invalid",
      relativePath: neonSkillPolicySourceRelativePath,
      config: {}
    };
  }

  const config = validatePolicyConfig(parsed);
  if (config === undefined) {
    return {
      state: "invalid",
      relativePath: neonSkillPolicySourceRelativePath,
      config: {}
    };
  }

  return {
    state: "loaded",
    relativePath: neonSkillPolicySourceRelativePath,
    config
  };
}

async function readPolicyFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // Missing, unreadable, or any other I/O failure -> treat as absent.
    return undefined;
  }
}

function parsePolicyJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Validate a parsed value into a declarative policy config.
 *
 * Strict but tolerant: unknown or malformed fields are dropped (so they fall
 * back to defaults) rather than throwing. A non-record top level is rejected.
 */
function validatePolicyConfig(value: unknown): INeonSkillPolicyConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config: {
    enabled?: boolean;
    allow?: readonly string[];
    deny?: readonly string[];
    byAgent?: Readonly<Record<string, INeonSkillPolicyAgentRules>>;
  } = {};

  const enabled = value["enabled"];
  if (typeof enabled === "boolean") {
    config.enabled = enabled;
  }

  const allow = toStringList(value["allow"]);
  if (allow !== undefined) {
    config.allow = allow;
  }

  const deny = toStringList(value["deny"]);
  if (deny !== undefined) {
    config.deny = deny;
  }

  const byAgent = toAgentRulesMap(value["byAgent"]);
  if (byAgent !== undefined) {
    config.byAgent = byAgent;
  }

  return config;
}

function toAgentRulesMap(
  value: unknown
): Readonly<Record<string, INeonSkillPolicyAgentRules>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const map: Record<string, INeonSkillPolicyAgentRules> = {};
  for (const [agentId, rawRules] of Object.entries(value)) {
    const rules = toAgentRules(rawRules);
    if (rules !== undefined) {
      map[agentId] = rules;
    }
  }

  return Object.keys(map).length > 0 ? map : undefined;
}

function toAgentRules(value: unknown): INeonSkillPolicyAgentRules | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rules: { allow?: readonly string[]; deny?: readonly string[] } = {};

  const allow = toStringList(value["allow"]);
  if (allow !== undefined) {
    rules.allow = allow;
  }

  const deny = toStringList(value["deny"]);
  if (deny !== undefined) {
    rules.deny = deny;
  }

  return rules.allow === undefined && rules.deny === undefined ? undefined : rules;
}

function toStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        list.push(trimmed);
      }
    }
  }

  return list;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
