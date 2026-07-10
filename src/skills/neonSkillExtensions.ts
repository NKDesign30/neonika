import { opendir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  isPathInside,
  isRecord,
  normalizeOptionalText,
  realpathOrNull,
  statOrNull
} from "./neonSkillFs.js";
import type { TNeonInventoryTrust } from "./neonSkills.js";

/**
 * OpenClaw extension manifest scanning, split out of `neonSkills.ts` so each
 * file stays under the project size budget. Scanning is read-only and
 * reference-only: extensions are never executed or trusted, only catalogued
 * from their `openclaw.plugin.json` manifests for parity reporting.
 */

const referencePluginManifestFileName = "openclaw.plugin.json";
const maxPluginManifestBytes = 256 * 1024;

export type TNeonExtensionLoadState = "reference-only" | "invalid" | "unreadable";

export interface INeonExtensionCapabilityCounts {
  readonly channels: number;
  readonly providers: number;
  readonly skills: number;
  readonly tools: number;
  readonly contractGroups: number;
  readonly setupProviders: number;
}

export interface INeonExtensionSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly rootDir: string;
  readonly trust: TNeonInventoryTrust;
  readonly loadState: TNeonExtensionLoadState;
  readonly configSchemaPresent: boolean;
  readonly kinds: readonly string[];
  readonly activation: readonly string[];
  readonly capabilities: INeonExtensionCapabilityCounts;
  /** Declared `install.minHostVersion` semver floor, when present and well-formed. */
  readonly minHostVersion?: string;
  /** Read-only manifest warnings (bad min-host format, denylisted dependency). */
  readonly manifestWarnings?: readonly string[];
  readonly issue?: string;
}

export interface IExtensionScanResult {
  readonly extensions: readonly INeonExtensionSummary[];
  readonly issues: readonly string[];
}

export async function scanReferenceExtensions(
  extensionRoot: string,
  options: {
    readonly maxManifests: number;
  }
): Promise<IExtensionScanResult> {
  const resolvedRoot = resolve(extensionRoot);
  const rootStat = await statOrNull(resolvedRoot);
  if (!rootStat || !rootStat.isDirectory()) {
    return {
      extensions: [],
      issues: [`OpenClaw extension root unavailable: ${resolvedRoot}`]
    };
  }

  const rootRealPath = await realpathOrNull(resolvedRoot);
  if (!rootRealPath) {
    return {
      extensions: [],
      issues: [`OpenClaw extension root cannot be resolved: ${resolvedRoot}`]
    };
  }

  const extensions: INeonExtensionSummary[] = [];
  const issues: string[] = [];
  let directory;

  try {
    directory = await opendir(rootRealPath);
  } catch {
    return {
      extensions: [],
      issues: [`OpenClaw extension root is not readable: ${resolvedRoot}`]
    };
  }

  for await (const entry of directory) {
    if (extensions.length >= options.maxManifests) {
      issues.push(`OpenClaw extension scan limit reached at ${options.maxManifests}`);
      break;
    }
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const manifestPath = join(rootRealPath, entry.name, referencePluginManifestFileName);
    const manifestRealPath = await realpathOrNull(manifestPath);
    if (!manifestRealPath || !isPathInside(rootRealPath, manifestRealPath)) {
      continue;
    }

    const extension = await readExtensionManifest(manifestRealPath, entry.name);
    extensions.push(extension);
    if (extension.loadState !== "reference-only") {
      issues.push(`${entry.name}: ${extension.issue ?? extension.loadState}`);
    }
    for (const warning of extension.manifestWarnings ?? []) {
      issues.push(`${entry.name}: ${warning}`);
    }
  }

  return {
    extensions: extensions.sort((left, right) => left.id.localeCompare(right.id)),
    issues
  };
}

async function readExtensionManifest(
  manifestPath: string,
  directoryName: string
): Promise<INeonExtensionSummary> {
  const rootDir = dirname(manifestPath);
  const base = {
    manifestPath,
    rootDir,
    trust: "reference-only" as const
  };
  const manifestStat = await statOrNull(manifestPath);

  if (!manifestStat || manifestStat.size > maxPluginManifestBytes) {
    return {
      ...base,
      id: directoryName,
      name: directoryName,
      description: "",
      version: "",
      loadState: "invalid",
      configSchemaPresent: false,
      kinds: [],
      activation: [],
      capabilities: emptyExtensionCapabilityCounts(),
      issue: "manifest missing or too large"
    };
  }

  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return createInvalidExtension(base, directoryName, "manifest is not an object");
    }

    const id = readString(parsed, "id") ?? directoryName;
    const contracts = readRecord(parsed, "contracts");
    const setup = readRecord(parsed, "setup");
    const minHost = readExtensionMinHostVersion(parsed);
    const blockedDependencies = findBlockedExtensionDependencies(parsed);
    const manifestWarnings = [
      ...(minHost.warning ? [minHost.warning] : []),
      ...blockedDependencies.map((dependency) => `blocked dependency: ${dependency}`)
    ];

    return {
      ...base,
      id,
      name: readString(parsed, "name") ?? id,
      description: readString(parsed, "description") ?? "",
      version: readString(parsed, "version") ?? "",
      loadState: "reference-only",
      configSchemaPresent: isRecord(parsed["configSchema"]),
      kinds: readStringListOrSingle(parsed["kind"]),
      activation: summarizeActivation(readRecord(parsed, "activation")),
      capabilities: {
        channels: readStringList(parsed, "channels").length,
        providers: readStringList(parsed, "providers").length,
        skills: readStringList(parsed, "skills").length,
        tools: readStringList(contracts, "tools").length,
        contractGroups: countContractGroups(contracts),
        setupProviders: countSetupProviders(setup)
      },
      ...(minHost.value !== undefined ? { minHostVersion: minHost.value } : {}),
      ...(manifestWarnings.length > 0 ? { manifestWarnings } : {})
    };
  } catch (error) {
    return createInvalidExtension(
      base,
      directoryName,
      error instanceof Error ? error.message : "manifest parse failed"
    );
  }
}

function createInvalidExtension(
  base: {
    readonly manifestPath: string;
    readonly rootDir: string;
    readonly trust: "reference-only";
  },
  directoryName: string,
  issue: string
): INeonExtensionSummary {
  return {
    ...base,
    id: directoryName,
    name: directoryName,
    description: "",
    version: "",
    loadState: "invalid",
    configSchemaPresent: false,
    kinds: [],
    activation: [],
    capabilities: emptyExtensionCapabilityCounts(),
    issue
  };
}

// Ported from OpenClaw `src/plugins/dependency-denylist.ts`
// (`blockedInstallDependencyPackageNames`). OpenClaw uses it as an install gate;
// Neon scans reference manifests read-only and reports declarations as issues.
// See THIRD_PARTY_NOTICES.md for attribution.
const blockedExtensionDependencyNames: readonly string[] = ["plain-crypto-js"];

// Ported from OpenClaw `src/plugins/min-host-version.ts` (`MIN_HOST_VERSION_RE`):
// `install.minHostVersion` must be a semver floor ">=x.y.z[-pre][+build]".
const minHostVersionPattern = /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readExtensionMinHostVersion(parsed: Readonly<Record<string, unknown>>): {
  readonly value?: string;
  readonly warning?: string;
} {
  const install = readRecord(parsed, "install");
  const raw = install?.["minHostVersion"];

  if (raw === undefined) {
    return {};
  }

  if (typeof raw !== "string" || !minHostVersionPattern.test(raw.trim())) {
    return { warning: 'invalid install.minHostVersion (expected ">=x.y.z")' };
  }

  return { value: raw.trim() };
}

function findBlockedExtensionDependencies(parsed: Readonly<Record<string, unknown>>): readonly string[] {
  const blocked = new Set<string>();
  const name = readString(parsed, "name");

  if (name && blockedExtensionDependencyNames.includes(name)) {
    blocked.add(name);
  }

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencyMap = readRecord(parsed, field);

    if (!dependencyMap) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencyMap)) {
      if (blockedExtensionDependencyNames.includes(dependencyName)) {
        blocked.add(dependencyName);
      }
    }
  }

  return [...blocked].sort();
}

function summarizeActivation(record: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (!record) {
    return [];
  }

  const summary: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === true) {
      summary.push(key);
      continue;
    }
    if (Array.isArray(value) && value.length > 0) {
      summary.push(key);
    }
  }

  return summary.sort((left, right) => left.localeCompare(right));
}

function countContractGroups(record: Readonly<Record<string, unknown>> | undefined): number {
  if (!record) {
    return 0;
  }

  return Object.values(record).filter((value) => Array.isArray(value) && value.length > 0).length;
}

function countSetupProviders(record: Readonly<Record<string, unknown>> | undefined): number {
  const providers = record?.["providers"];
  return Array.isArray(providers) ? providers.length : 0;
}

function readRecord(
  record: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return normalizeOptionalText(record[key]);
}

function readStringList(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): readonly string[] {
  if (!record) {
    return [];
  }

  return readStringListOrSingle(record[key]);
}

function readStringListOrSingle(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const normalized = normalizeOptionalText(value);
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeOptionalText(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function emptyExtensionCapabilityCounts(): INeonExtensionCapabilityCounts {
  return {
    channels: 0,
    providers: 0,
    skills: 0,
    tools: 0,
    contractGroups: 0,
    setupProviders: 0
  };
}
