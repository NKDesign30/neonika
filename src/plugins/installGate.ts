import type { INeonPluginManifest } from "../plugin-sdk/index.js";
import type { INeonPluginCatalogEntry } from "./catalog.js";

/**
 * Gated install / enable / load planning for Neon plugins.
 *
 * This is where the read-only contract is enforced as behavior: every plan
 * carries `executed: false` and `autoLoadHonored: false` as structural
 * invariants. There is no code path that loads, requires, or runs a plugin.
 *
 * A double gate guards even *planning* an install:
 *  1. trust — the plugin must not be `blocked`, and must be operator-allowlisted.
 *  2. flag  — `NEON_PLUGIN_INSTALL_ENABLED` must be set (default off).
 *
 * When both gates pass, the result is still only a `plan-only` audit of what an
 * install *would* do. Actually performing it is a primary-cutover product
 * decision, never an autonomous one — matching the shadow contract used by the
 * outbound sender and memory-write seams.
 */

export type TNeonPluginGateAction = "install" | "enable" | "load";
export type TNeonPluginGateDecision = "blocked" | "gated" | "plan-only";

export interface INeonPluginGatePlanStep {
  readonly order: number;
  readonly description: string;
}

export interface INeonPluginGatePlan {
  readonly pluginId: string;
  readonly action: TNeonPluginGateAction;
  readonly decision: TNeonPluginGateDecision;
  /** Structural invariant: Neon never executes a plugin action. Always false. */
  readonly executed: false;
  /** Structural invariant: auto-load intent is never honored. Always false. */
  readonly autoLoadHonored: false;
  readonly reasons: readonly string[];
  /** Audit-only description of what the action would entail. Never run. */
  readonly steps: readonly INeonPluginGatePlanStep[];
}

export interface INeonPluginInstallGate {
  readonly enabled: boolean;
  readonly source: "env" | "default";
  readonly flag: string;
}

export const neonPluginInstallGateFlag = "NEON_PLUGIN_INSTALL_ENABLED";

export function resolveNeonPluginInstallGate(
  env: NodeJS.ProcessEnv = process.env
): INeonPluginInstallGate {
  const raw = env[neonPluginInstallGateFlag];
  const enabled = raw === "true" || raw === "1";
  return {
    enabled,
    source: raw === undefined ? "default" : "env",
    flag: neonPluginInstallGateFlag
  };
}

export function planNeonPluginAction(
  entry: INeonPluginCatalogEntry,
  action: TNeonPluginGateAction,
  gate: INeonPluginInstallGate
): INeonPluginGatePlan {
  const base = {
    pluginId: entry.manifest.id,
    action,
    executed: false as const,
    autoLoadHonored: false as const
  };

  if (entry.trust.level === "blocked") {
    return {
      ...base,
      decision: "blocked",
      reasons: [`trust=blocked`, ...entry.trust.reasons],
      steps: []
    };
  }

  const steps = buildAuditSteps(entry.manifest, action);

  if (!gate.enabled) {
    return {
      ...base,
      decision: "gated",
      reasons: [
        `${gate.flag} is not set; plugin ${action} stays planning-only`,
        ...(entry.trust.level === "allowlisted"
          ? []
          : ["plugin is not operator-allowlisted"])
      ],
      steps
    };
  }

  if (entry.trust.level !== "allowlisted") {
    return {
      ...base,
      decision: "gated",
      reasons: [`${gate.flag} is set, but plugin must be operator-allowlisted before any ${action} plan`],
      steps
    };
  }

  return {
    ...base,
    decision: "plan-only",
    reasons: [
      `operator-allowlisted and ${gate.flag} set: emitting audit plan only`,
      `executing ${action} remains a primary-cutover product decision, never autonomous`
    ],
    steps
  };
}

function buildAuditSteps(
  manifest: INeonPluginManifest,
  action: TNeonPluginGateAction
): readonly INeonPluginGatePlanStep[] {
  const descriptions: string[] = [
    `resolve manifest for ${manifest.id} (${manifest.format}) without loading code`,
    "run the Neon plugin security scan over declared sources"
  ];

  if (manifest.install.minHostVersion !== undefined) {
    descriptions.push(`verify host satisfies ${manifest.install.minHostVersion}`);
  }
  if (manifest.install.declaredDependencies.length > 0) {
    descriptions.push(`audit ${manifest.install.declaredDependencies.length} declared dependencies against the denylist`);
  }
  if (action === "install") {
    descriptions.push("stage manifest into the read-only plugin index (no activation)");
  }
  if (action === "enable" || action === "load") {
    if (manifest.commands.length > 0) {
      descriptions.push(`would register ${manifest.commands.length} command(s) — skipped`);
    }
    if (manifest.channels.length > 0) {
      descriptions.push(`would attach ${manifest.channels.length} channel(s) — skipped`);
    }
    if (manifest.tools.length > 0) {
      descriptions.push(`would expose ${manifest.tools.length} tool(s) — skipped`);
    }
    descriptions.push("activation is suppressed: no plugin entrypoint is invoked");
  }

  return descriptions.map((description, index) => ({ order: index + 1, description }));
}
