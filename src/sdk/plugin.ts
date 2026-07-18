// Neon SDK — Plugin surface.
//
// Curated, stable contract for plugin/extension/skill authors: skill + extension
// discovery and inventory shapes, the per-agent enable/deny policy resolver, and
// the read-only skill-body security scan (SAST findings). This is the Neon analog
// of upstream `packages/plugin-sdk` — a thin re-export facade over
// `skills/neonSkills.ts`, `skills/neonSkillExtensions.ts`, `skills/skillPolicy.ts`,
// and `skills/skillSecurityScan.ts`. No behavior, no code moved.
//
// Install / dispatch / code-execution are deliberately out of scope (Neon stays
// read-only here); the SDK exposes the declarative + analysis contracts only.

// Skill + extension discovery / inventory.
export {
  createNeonExtensionInventorySnapshot,
  createNeonSkillInventorySnapshot,
  normalizeNeonSkillName,
  referenceRootEnvKey,
  renderNeonSkillInventoryReport,
  resolveDefaultReferenceRoot
} from "../skills/neonSkills.js";

export type {
  ICreateNeonSkillInventoryOptions,
  INeonExtensionInventorySnapshot,
  INeonSkillInventorySnapshot,
  INeonSkillInventorySource,
  INeonSkillInventoryTotals,
  INeonSkillRootConfig,
  INeonSkillRootSnapshot,
  INeonSkillSummary,
  TNeonInventoryTrust,
  TNeonSkillInventoryState,
  TNeonSkillLoadState,
  TNeonSkillRootKind
} from "../skills/neonSkills.js";

export type {
  INeonExtensionCapabilityCounts,
  INeonExtensionSummary,
  TNeonExtensionLoadState
} from "../skills/neonSkillExtensions.js";

// Per-agent enable/deny policy resolver.
export {
  neonSkillPolicyWildcard,
  resolveAgentSkillPolicy
} from "../skills/skillPolicy.js";

export type {
  INeonAgentSkillPolicyResult,
  INeonSkillPolicyAgentRules,
  INeonSkillPolicyConfig,
  INeonSkillPolicyDecision,
  IResolveAgentSkillPolicyOptions,
  TNeonSkillPolicyDecision,
  TNeonSkillPolicyReason
} from "../skills/skillPolicy.js";

// Read-only skill-body security scan (SAST).
export {
  scanNeonSkillSource,
  summarizeNeonSkillFindings
} from "../skills/skillSecurityScan.js";

export type {
  INeonSkillScanFinding,
  INeonSkillSecurityFinding,
  INeonSkillSecuritySummary,
  TNeonSkillScanRuleId,
  TNeonSkillScanSeverity,
  TNeonSkillSecurityState
} from "../skills/skillSecurityScan.js";

// Plugin-manifest + trust domain (parse a plugin manifest, evaluate trust
// without loading code). Bundled wholesale from the plugin-sdk domain barrel so
// this surface is the one plugin contract import alongside the skill contracts.
export * from "../plugin-sdk/index.js";
