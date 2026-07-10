import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import type { INeonSkillReferenceMetadata } from "./skillMetadata.js";

// Read-only eligibility evaluation for a skill's declared requirements. Resolves
// binaries by scanning PATH with fs (NO process spawn, NO `which` exec), reads
// env presence, and checks config-path existence. Nothing is installed or run
// (parity gap row 181). Checks are injectable so the logic is unit-testable
// without touching the real PATH/env/filesystem.

export type TNeonSkillEligibilityState = "eligible" | "ineligible" | "unknown";

export type TNeonSkillEligibilityReasonKind =
  | "missing-bin"
  | "missing-any-bin"
  | "missing-env"
  | "missing-config"
  | "os-mismatch";

export interface INeonSkillEligibilityReason {
  readonly kind: TNeonSkillEligibilityReasonKind;
  readonly detail: string;
}

export interface INeonSkillEligibility {
  readonly state: TNeonSkillEligibilityState;
  readonly missing: readonly INeonSkillEligibilityReason[];
}

export interface INeonSkillEligibilityChecks {
  readonly hasBinary: (name: string) => boolean;
  readonly hasEnv: (name: string) => boolean;
  readonly hasConfigPath: (path: string) => boolean;
  readonly currentOs: string;
}

export function evaluateNeonSkillEligibility(
  metadata: INeonSkillReferenceMetadata | undefined,
  checks: INeonSkillEligibilityChecks,
): INeonSkillEligibility {
  // No upstream metadata block -> nothing to evaluate against.
  if (!metadata) return { state: "unknown", missing: [] };

  const missing: INeonSkillEligibilityReason[] = [];

  if (metadata.os && metadata.os.length > 0 && !metadata.os.includes(checks.currentOs)) {
    missing.push({ kind: "os-mismatch", detail: `needs ${metadata.os.join("/")}, running ${checks.currentOs}` });
  }

  const requires = metadata.requires;
  if (requires) {
    for (const bin of requires.bins ?? []) {
      if (!checks.hasBinary(bin)) missing.push({ kind: "missing-bin", detail: bin });
    }
    if (requires.anyBins && requires.anyBins.length > 0 && !requires.anyBins.some((bin) => checks.hasBinary(bin))) {
      missing.push({ kind: "missing-any-bin", detail: requires.anyBins.join("|") });
    }
    for (const envName of requires.env ?? []) {
      if (!checks.hasEnv(envName)) missing.push({ kind: "missing-env", detail: envName });
    }
    for (const configPath of requires.config ?? []) {
      if (!checks.hasConfigPath(configPath)) missing.push({ kind: "missing-config", detail: configPath });
    }
  }

  return { state: missing.length === 0 ? "eligible" : "ineligible", missing };
}

function resolveBinaryOnPath(name: string, pathDirs: readonly string[]): boolean {
  if (name.includes("/")) return existsSync(name);
  return pathDirs.some((dir) => existsSync(join(dir, name)));
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = env["HOME"] ?? homedir();
    return join(home, path.slice(1));
  }
  return path;
}

// Real read-only checks against the live PATH/env/filesystem. Binary lookup scans
// PATH directories with fs.existsSync — it never spawns `which` or executes the
// binary.
export function createDefaultNeonSkillEligibilityChecks(
  env: NodeJS.ProcessEnv = process.env,
): INeonSkillEligibilityChecks {
  const pathDirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir.length > 0);
  return {
    hasBinary: (name) => resolveBinaryOnPath(name, pathDirs),
    hasEnv: (name) => typeof env[name] === "string" && env[name] !== "",
    hasConfigPath: (path) => existsSync(expandHome(path, env)),
    currentOs: platform(),
  };
}
