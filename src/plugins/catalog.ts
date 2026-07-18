import {
  evaluateNeonPluginTrust,
  parseNeonPluginManifest,
  type INeonPluginManifest,
  type INeonPluginTrustDecision,
  type INeonPluginTrustPolicy
} from "../plugin-sdk/index.js";
import { readNeonPluginManifestSources } from "./manifestSource.js";

/**
 * The Neon plugin catalog: a source-backed, read-only projection of upstream
 * extension manifests into SDK descriptors plus a trust decision per plugin.
 * Building the catalog never loads or executes plugin code — it reads manifests,
 * parses them with the pure SDK, and evaluates trust against an operator policy.
 */

export interface INeonPluginCatalogEntry {
  readonly directoryName: string;
  readonly manifestPath: string;
  readonly rootDir: string;
  readonly manifest: INeonPluginManifest;
  readonly trust: INeonPluginTrustDecision;
  /** Set when the manifest file itself could not be read (missing/too large/invalid). */
  readonly readError?: string;
}

export interface INeonPluginCatalogTotals {
  readonly plugins: number;
  readonly referenceOnly: number;
  readonly allowlisted: number;
  readonly blocked: number;
  /** How many manifests *ask* to auto-load. Always honored zero times. */
  readonly autoLoadDeclared: number;
  readonly autoLoadHonored: number;
  readonly withCommands: number;
  readonly withChannels: number;
  readonly invalidManifests: number;
}

export interface INeonPluginCatalog {
  readonly extensionRoot: string;
  readonly hostVersion: string;
  readonly entries: readonly INeonPluginCatalogEntry[];
  readonly totals: INeonPluginCatalogTotals;
  readonly issues: readonly string[];
}

export interface IBuildNeonPluginCatalogOptions {
  readonly maxManifests?: number;
}

export const defaultPluginManifestLimit = 300;

export async function buildNeonPluginCatalog(
  extensionRoot: string,
  policy: INeonPluginTrustPolicy,
  options: IBuildNeonPluginCatalogOptions = {}
): Promise<INeonPluginCatalog> {
  const scan = await readNeonPluginManifestSources(extensionRoot, {
    maxManifests: options.maxManifests ?? defaultPluginManifestLimit
  });

  const entries: INeonPluginCatalogEntry[] = scan.sources.map((source) => {
    const manifest = parseNeonPluginManifest(source.raw, { fallbackId: source.directoryName });
    const trust = evaluateNeonPluginTrust(manifest, policy);
    return {
      directoryName: source.directoryName,
      manifestPath: source.manifestPath,
      rootDir: source.rootDir,
      manifest,
      trust,
      ...(source.readError !== undefined ? { readError: source.readError } : {})
    };
  });

  return {
    extensionRoot: scan.extensionRoot,
    hostVersion: policy.hostVersion,
    entries,
    totals: summarizeCatalog(entries),
    issues: scan.issues
  };
}

function summarizeCatalog(entries: readonly INeonPluginCatalogEntry[]): INeonPluginCatalogTotals {
  let referenceOnly = 0;
  let allowlisted = 0;
  let blocked = 0;
  let autoLoadDeclared = 0;
  let withCommands = 0;
  let withChannels = 0;
  let invalidManifests = 0;

  for (const entry of entries) {
    switch (entry.trust.level) {
      case "reference-only":
        referenceOnly += 1;
        break;
      case "allowlisted":
        allowlisted += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
    }
    if (entry.manifest.autoLoadOnStartup) {
      autoLoadDeclared += 1;
    }
    if (entry.manifest.commands.length > 0) {
      withCommands += 1;
    }
    if (entry.manifest.channels.length > 0) {
      withChannels += 1;
    }
    if (entry.manifest.parseError !== undefined || entry.readError !== undefined) {
      invalidManifests += 1;
    }
  }

  return {
    plugins: entries.length,
    referenceOnly,
    allowlisted,
    blocked,
    autoLoadDeclared,
    autoLoadHonored: 0,
    withCommands,
    withChannels,
    invalidManifests
  };
}
