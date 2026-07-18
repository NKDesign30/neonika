import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createDefaultNeonPluginTrustPolicy, NEON_PLUGIN_HOST_VERSION } from "../plugin-sdk/index.js";
import { resolveDefaultReferenceRoot } from "../skills/neonSkills.js";
import { buildNeonPluginCatalog, type INeonPluginCatalogTotals } from "./catalog.js";
import {
  planNeonPluginAction,
  resolveNeonPluginInstallGate,
  type INeonPluginGatePlan,
  type INeonPluginInstallGate,
  type TNeonPluginGateAction,
  type TNeonPluginGateDecision
} from "./installGate.js";

/**
 * Read-only Neon plugin inventory snapshot.
 *
 * Ties the catalog (manifest descriptors + trust) to the install gate so a
 * single API/CLI/dashboard surface can show what plugins exist, how Neon trusts
 * them, and exactly why none of them are executed. Building this snapshot never
 * loads plugin code.
 */

export type TNeonPluginInventoryState = "ready" | "partial" | "empty";
export type TNeonPluginPackageJsonState = "present" | "missing" | "malformed" | "unreadable";
export type TNeonPluginPackageRuntimeEntryState = "compiled" | "source-only" | "missing" | "unknown";
export type TNeonPluginPackageLiveProofState =
  | "package-ready"
  | "source-only"
  | "needs-package-json"
  | "needs-package-review";

export interface INeonPluginPackageProof {
  readonly packageJson: TNeonPluginPackageJsonState;
  readonly runtimeDependencies: number;
  readonly optionalDependencies: number;
  readonly shrinkwrap: "present" | "missing";
  readonly runtimeEntry: TNeonPluginPackageRuntimeEntryState;
  readonly liveProof: TNeonPluginPackageLiveProofState;
}

export interface INeonPluginInventoryEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly format: string;
  readonly trustLevel: string;
  readonly autoLoadOnStartup: boolean;
  readonly autoLoadHonored: false;
  readonly installDecision: TNeonPluginGateDecision;
  readonly counts: {
    readonly commands: number;
    readonly channels: number;
    readonly skills: number;
    readonly tools: number;
    readonly capabilities: number;
    readonly declaredDependencies: number;
  };
  readonly minHostVersion?: string;
  readonly reasons: readonly string[];
  readonly packageProof: INeonPluginPackageProof;
  readonly manifestPath: string;
}

export interface INeonPluginInventorySnapshot {
  readonly generatedFrom: "upstream-extensions";
  readonly state: TNeonPluginInventoryState;
  readonly hostVersion: string;
  readonly installGate: INeonPluginInstallGate;
  readonly trustPolicy: {
    readonly allowlist: readonly string[];
    readonly denylist: readonly string[];
    readonly blockedDependencies: readonly string[];
  };
  readonly source: {
    readonly projectRoot: string;
    readonly referenceRoot: string;
    readonly extensionRoot: string;
  };
  readonly totals: INeonPluginCatalogTotals;
  readonly plugins: readonly INeonPluginInventoryEntry[];
  readonly issues: readonly string[];
}

export interface ICreateNeonPluginInventoryOptions {
  readonly referenceRoot?: string;
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
  readonly hostVersion?: string;
  readonly maxManifests?: number;
  readonly env?: NodeJS.ProcessEnv;
}

interface IPluginRuntimeContext {
  readonly referenceRoot: string;
  readonly extensionRoot: string;
  readonly policy: ReturnType<typeof createDefaultNeonPluginTrustPolicy>;
  readonly gate: INeonPluginInstallGate;
  readonly catalogOptions: { readonly maxManifests?: number };
}

function resolvePluginRuntimeContext(options: ICreateNeonPluginInventoryOptions): IPluginRuntimeContext {
  const referenceRoot = resolve(options.referenceRoot ?? resolveDefaultReferenceRoot());
  return {
    referenceRoot,
    extensionRoot: join(referenceRoot, "extensions"),
    policy: createDefaultNeonPluginTrustPolicy({
      hostVersion: options.hostVersion ?? NEON_PLUGIN_HOST_VERSION,
      ...(options.allowlist !== undefined ? { allowlist: options.allowlist } : {}),
      ...(options.denylist !== undefined ? { denylist: options.denylist } : {})
    }),
    gate: resolveNeonPluginInstallGate(options.env ?? process.env),
    catalogOptions: options.maxManifests !== undefined ? { maxManifests: options.maxManifests } : {}
  };
}

export async function createNeonPluginInventorySnapshot(
  projectRoot: string,
  options: ICreateNeonPluginInventoryOptions = {}
): Promise<INeonPluginInventorySnapshot> {
  const { referenceRoot, extensionRoot, policy, gate, catalogOptions } = resolvePluginRuntimeContext(options);
  const catalog = await buildNeonPluginCatalog(extensionRoot, policy, catalogOptions);

  const plugins: INeonPluginInventoryEntry[] = await Promise.all(catalog.entries.map(async (entry) => {
    const installPlan = planNeonPluginAction(entry, "install", gate);
    const packageProof = await createNeonPluginPackageProof(entry.rootDir);
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      format: entry.manifest.format,
      trustLevel: entry.trust.level,
      autoLoadOnStartup: entry.manifest.autoLoadOnStartup,
      autoLoadHonored: false,
      installDecision: installPlan.decision,
      counts: {
        commands: entry.manifest.commands.length,
        channels: entry.manifest.channels.length,
        skills: entry.manifest.skills.length,
        tools: entry.manifest.tools.length,
        capabilities: entry.manifest.capabilities.length,
        declaredDependencies: entry.manifest.install.declaredDependencies.length
      },
      ...(entry.manifest.install.minHostVersion !== undefined
        ? { minHostVersion: entry.manifest.install.minHostVersion }
        : {}),
      reasons: summarizeReasons(entry.trust.reasons, installPlan),
      packageProof,
      manifestPath: entry.manifestPath
    };
  }));

  return {
    generatedFrom: "upstream-extensions",
    state: resolveInventoryState(catalog.totals, catalog.issues),
    hostVersion: catalog.hostVersion,
    installGate: gate,
    trustPolicy: {
      allowlist: policy.allowlist,
      denylist: policy.denylist,
      blockedDependencies: policy.blockedDependencies
    },
    source: {
      projectRoot: resolve(projectRoot),
      referenceRoot,
      extensionRoot
    },
    totals: catalog.totals,
    plugins,
    issues: catalog.issues
  };
}

export function renderNeonPluginsReport(snapshot: INeonPluginInventorySnapshot): string {
  const lines = [
    `Neonika Plugins Inventory: ${snapshot.state}`,
    `Host version: ${snapshot.hostVersion}`,
    `Install gate: ${snapshot.installGate.enabled ? "enabled" : "disabled"} (${snapshot.installGate.flag}, ${snapshot.installGate.source})`,
    `Plugins: ${snapshot.totals.plugins} (${snapshot.totals.referenceOnly} reference-only / ${snapshot.totals.allowlisted} allowlisted / ${snapshot.totals.blocked} blocked)`,
    `Auto-load declared: ${snapshot.totals.autoLoadDeclared} / honored: ${snapshot.totals.autoLoadHonored}`,
    `Commands: ${snapshot.totals.withCommands} plugins / Channels: ${snapshot.totals.withChannels} plugins / Invalid manifests: ${snapshot.totals.invalidManifests}`,
    `Source: ${snapshot.source.extensionRoot}`
  ];

  for (const plugin of snapshot.plugins.slice(0, 16)) {
    lines.push(
      `- ${plugin.id}: ${plugin.trustLevel} / install=${plugin.installDecision} / ` +
        `cmds ${plugin.counts.commands} / channels ${plugin.counts.channels} / tools ${plugin.counts.tools}` +
        ` / package=${plugin.packageProof.liveProof}` +
        (plugin.autoLoadOnStartup ? " / auto-load IGNORED" : "")
    );
  }

  if (snapshot.plugins.length > 16) {
    lines.push(`... ${snapshot.plugins.length - 16} more`);
  }

  return lines.join("\n");
}

async function createNeonPluginPackageProof(rootDir: string): Promise<INeonPluginPackageProof> {
  const packagePath = join(rootDir, "package.json");
  const shrinkwrap = (await pathExists(join(rootDir, "npm-shrinkwrap.json"))) ? "present" : "missing";
  let parsedPackage: unknown;

  try {
    parsedPackage = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    const packageJson = isNodeErrorWithCode(error, "ENOENT")
      ? "missing"
      : error instanceof SyntaxError
        ? "malformed"
        : "unreadable";

    return {
      packageJson,
      runtimeDependencies: 0,
      optionalDependencies: 0,
      shrinkwrap,
      runtimeEntry: "unknown",
      liveProof: "needs-package-json"
    };
  }

  if (!isJsonRecord(parsedPackage)) {
    return {
      packageJson: "malformed",
      runtimeDependencies: 0,
      optionalDependencies: 0,
      shrinkwrap,
      runtimeEntry: "unknown",
      liveProof: "needs-package-json"
    };
  }

  const runtimeEntry = resolvePackageRuntimeEntryState(parsedPackage);

  return {
    packageJson: "present",
    runtimeDependencies: countJsonRecordKeys(parsedPackage["dependencies"]),
    optionalDependencies: countJsonRecordKeys(parsedPackage["optionalDependencies"]),
    shrinkwrap,
    runtimeEntry,
    liveProof: resolvePackageLiveProof("present", runtimeEntry)
  };
}

function resolvePackageRuntimeEntryState(packageJson: Readonly<Record<string, unknown>>): TNeonPluginPackageRuntimeEntryState {
  const referenceConfig = isJsonRecord(packageJson["openclaw"]) ? packageJson["openclaw"] : {};
  const entryValues = [
    packageJson["main"],
    packageJson["module"],
    packageJson["exports"],
    packageJson["bin"],
    referenceConfig["extensions"]
  ];
  const entryStrings = entryValues.flatMap((value) => collectStringValues(value));

  if (entryStrings.length === 0) {
    return "missing";
  }
  if (entryStrings.some((value) => /(?:^|\/)dist\/|\.m?js$|\.cjs$/u.test(value))) {
    return "compiled";
  }
  if (entryStrings.some((value) => /\.tsx?$/u.test(value))) {
    return "source-only";
  }

  return "unknown";
}

function resolvePackageLiveProof(
  packageJson: TNeonPluginPackageJsonState,
  runtimeEntry: TNeonPluginPackageRuntimeEntryState
): TNeonPluginPackageLiveProofState {
  if (packageJson !== "present") {
    return "needs-package-json";
  }
  if (runtimeEntry === "compiled") {
    return "package-ready";
  }
  if (runtimeEntry === "source-only") {
    return "source-only";
  }

  return "needs-package-review";
}

function collectStringValues(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry));
  }
  if (isJsonRecord(value)) {
    return Object.values(value).flatMap((entry) => collectStringValues(entry));
  }

  return [];
}

function countJsonRecordKeys(value: unknown): number {
  return isJsonRecord(value) ? Object.keys(value).length : 0;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface IResolveNeonPluginInstallPlanOptions extends ICreateNeonPluginInventoryOptions {
  readonly pluginId: string;
  readonly action?: TNeonPluginGateAction;
}

export interface INeonPluginInstallPlanResult {
  readonly found: boolean;
  readonly pluginId: string;
  readonly action: TNeonPluginGateAction;
  readonly installGate: INeonPluginInstallGate;
  readonly source: { readonly extensionRoot: string };
  /** The gated audit plan, when the plugin id was found in the catalog. */
  readonly plan?: INeonPluginGatePlan;
  readonly issue?: string;
}

/**
 * Resolve a single gated install/enable/load plan for one plugin id. Always
 * read-only: the returned plan describes what an action would entail and carries
 * `executed: false`. Shared by the CLI `plugin-install-plan` command and the
 * `/api/neon-plugins/install-plan` endpoint.
 */
export async function resolveNeonPluginInstallPlan(
  options: IResolveNeonPluginInstallPlanOptions
): Promise<INeonPluginInstallPlanResult> {
  const action: TNeonPluginGateAction = options.action ?? "install";
  const { extensionRoot, policy, gate, catalogOptions } = resolvePluginRuntimeContext(options);
  const catalog = await buildNeonPluginCatalog(extensionRoot, policy, catalogOptions);
  const entry = catalog.entries.find((candidate) => candidate.manifest.id === options.pluginId);

  if (!entry) {
    return {
      found: false,
      pluginId: options.pluginId,
      action,
      installGate: gate,
      source: { extensionRoot },
      issue: `no catalogued plugin with id "${options.pluginId}"`
    };
  }

  return {
    found: true,
    pluginId: entry.manifest.id,
    action,
    installGate: gate,
    source: { extensionRoot },
    plan: planNeonPluginAction(entry, action, gate)
  };
}

export function renderNeonPluginInstallPlanReport(result: INeonPluginInstallPlanResult): string {
  if (!result.found || !result.plan) {
    return [
      `Neonika Plugin Install Plan: ${result.pluginId}`,
      `Action: ${result.action}`,
      `Result: not found`,
      result.issue ? `Issue: ${result.issue}` : ""
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  const plan = result.plan;
  const lines = [
    `Neonika Plugin Install Plan: ${plan.pluginId}`,
    `Action: ${plan.action}`,
    `Decision: ${plan.decision} (executed=${plan.executed}, autoLoadHonored=${plan.autoLoadHonored})`,
    `Install gate: ${result.installGate.enabled ? "enabled" : "disabled"} (${result.installGate.flag})`,
    "Reasons:"
  ];
  for (const reason of plan.reasons) {
    lines.push(`  - ${reason}`);
  }
  if (plan.steps.length > 0) {
    lines.push("Audit steps (not executed):");
    for (const step of plan.steps) {
      lines.push(`  ${step.order}. ${step.description}`);
    }
  }
  return lines.join("\n");
}

function summarizeReasons(
  trustReasons: readonly string[],
  installPlan: INeonPluginGatePlan
): readonly string[] {
  // The install decision reasons are the most operator-relevant; trust reasons
  // add the "why" behind a blocked/allowlisted level. De-duplicate the union.
  return [...new Set([...installPlan.reasons, ...trustReasons])];
}

function resolveInventoryState(
  totals: INeonPluginCatalogTotals,
  issues: readonly string[]
): TNeonPluginInventoryState {
  if (totals.plugins === 0) {
    return "empty";
  }
  if (issues.length > 0 || totals.invalidManifests > 0) {
    return "partial";
  }
  return "ready";
}
