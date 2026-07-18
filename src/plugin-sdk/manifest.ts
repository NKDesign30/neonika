/**
 * Neon Plugin Manifest contract.
 *
 * This is the Neon-native, source-backed projection of an OpenClaw extension
 * manifest (`openclaw.plugin.json`). It is a pure description: parsing a
 * manifest never loads, requires, or activates any plugin code. The richest
 * fields OpenClaw declares — command aliases, channels, skills, contract tools,
 * provider capabilities, activation/auto-load intent and install constraints —
 * are modelled as typed descriptors so the host can reason about a plugin
 * without executing it.
 *
 * OpenClaw references: `src/plugins/manifest-types.ts`,
 * `src/plugins/manifest.ts`, `extensions/<id>/openclaw.plugin.json`.
 */

import { isRecord, readBoolean, readOptionalText, readRecord, readString, readStringList } from "./records.js";

export type TNeonPluginManifestFormat = "openclaw" | "bundle" | "unknown";

/** A `/command` an OpenClaw plugin contributes via `commandAliases`. */
export interface INeonPluginCommandContribution {
  readonly name: string;
  readonly kind?: string;
  readonly cliCommand?: string;
}

/** A capability a plugin contributes (provider, contract group entry, etc.). */
export interface INeonPluginCapabilityContribution {
  readonly kind: string;
  readonly id: string;
}

/** Declared install constraints — read for auditing, never enforced by loading. */
export interface INeonPluginInstallConstraints {
  /** Well-formed `install.minHostVersion` semver floor (">=x.y.z"), if present. */
  readonly minHostVersion?: string;
  /** Declared dependency package names across dependency maps. */
  readonly declaredDependencies: readonly string[];
}

export interface INeonPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly format: TNeonPluginManifestFormat;
  readonly kinds: readonly string[];
  /** Activation flags declared by the plugin (`onStartup`, `onAgentHarnesses`, ...). */
  readonly activation: readonly string[];
  /**
   * Whether the manifest *asks* to be auto-loaded on startup
   * (`activation.onStartup` or `enabledByDefault`). Parsed for transparency;
   * Neon never honors it — see {@link INeonPluginManifest} doc and the trust gate.
   */
  readonly autoLoadOnStartup: boolean;
  readonly configSchemaPresent: boolean;
  readonly commands: readonly INeonPluginCommandContribution[];
  readonly channels: readonly string[];
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly capabilities: readonly INeonPluginCapabilityContribution[];
  readonly install: INeonPluginInstallConstraints;
  /** Structural manifest warnings (bad id, malformed minHostVersion, ...). */
  readonly warnings: readonly string[];
  /** Set when the raw manifest could not be parsed into a usable shape. */
  readonly parseError?: string;
}

export interface IParseNeonPluginManifestOptions {
  /** Fallback id when the manifest omits `id` (typically the directory name). */
  readonly fallbackId: string;
}

// Ported from OpenClaw `src/plugins/min-host-version.ts` (`MIN_HOST_VERSION_RE`):
// `install.minHostVersion` must be a semver floor ">=x.y.z[-pre][+build]".
// See THIRD_PARTY_NOTICES.md for attribution.
const minHostVersionPattern = /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const dependencyMapKeys = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * Parse an already-decoded manifest record into a {@link INeonPluginManifest}.
 * Pure and total: malformed input yields a manifest with `parseError` set rather
 * than throwing, so the catalog can surface every directory it scanned.
 */
export function parseNeonPluginManifest(
  raw: unknown,
  options: IParseNeonPluginManifestOptions
): INeonPluginManifest {
  if (!isRecord(raw)) {
    return invalidManifest(options.fallbackId, "manifest is not a JSON object");
  }

  const id = readString(raw, "id") ?? options.fallbackId;
  const warnings: string[] = [];

  if (readString(raw, "id") === undefined) {
    warnings.push("manifest is missing a string id; using directory name");
  }

  const activationRecord = readRecord(raw, "activation");
  const minHost = readMinHostVersion(raw);
  if (minHost.warning) {
    warnings.push(minHost.warning);
  }

  return {
    id,
    name: readString(raw, "name") ?? id,
    description: readString(raw, "description") ?? "",
    version: readString(raw, "version") ?? "",
    format: readManifestFormat(raw),
    kinds: readStringList(raw["kind"]),
    activation: summarizeActivation(activationRecord),
    autoLoadOnStartup: resolveAutoLoadIntent(raw, activationRecord),
    configSchemaPresent: isRecord(raw["configSchema"]),
    commands: readCommandContributions(raw["commandAliases"]),
    channels: readStringList(raw["channels"]),
    skills: readStringList(raw["skills"]),
    tools: readStringList(readRecord(raw, "contracts")?.["tools"]),
    capabilities: readCapabilityContributions(raw),
    install: {
      ...(minHost.value !== undefined ? { minHostVersion: minHost.value } : {}),
      declaredDependencies: readDeclaredDependencies(raw)
    },
    ...(warnings.length > 0 ? { warnings } : { warnings: [] })
  };
}

function invalidManifest(fallbackId: string, parseError: string): INeonPluginManifest {
  return {
    id: fallbackId,
    name: fallbackId,
    description: "",
    version: "",
    format: "unknown",
    kinds: [],
    activation: [],
    autoLoadOnStartup: false,
    configSchemaPresent: false,
    commands: [],
    channels: [],
    skills: [],
    tools: [],
    capabilities: [],
    install: { declaredDependencies: [] },
    warnings: [],
    parseError
  };
}

function readManifestFormat(raw: Readonly<Record<string, unknown>>): TNeonPluginManifestFormat {
  const declared = readString(raw, "format");
  if (declared === "bundle") {
    return "bundle";
  }
  return "openclaw";
}

function resolveAutoLoadIntent(
  raw: Readonly<Record<string, unknown>>,
  activation: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (readBoolean(raw["enabledByDefault"])) {
    return true;
  }
  return activation !== undefined && readBoolean(activation["onStartup"]);
}

function summarizeActivation(record: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (!record) {
    return [];
  }

  const summary: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === true || (Array.isArray(value) && value.length > 0)) {
      summary.push(key);
    }
  }

  return summary.sort((left, right) => left.localeCompare(right));
}

function readCommandContributions(value: unknown): readonly INeonPluginCommandContribution[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const commands: INeonPluginCommandContribution[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = readString(entry, "name");
    if (name === undefined) {
      continue;
    }
    const kind = readString(entry, "kind");
    const cliCommand = readString(entry, "cliCommand");
    commands.push({
      name,
      ...(kind !== undefined ? { kind } : {}),
      ...(cliCommand !== undefined ? { cliCommand } : {})
    });
  }

  return commands;
}

function readCapabilityContributions(
  raw: Readonly<Record<string, unknown>>
): readonly INeonPluginCapabilityContribution[] {
  const capabilities: INeonPluginCapabilityContribution[] = [];

  for (const providerId of readStringList(raw["providers"])) {
    capabilities.push({ kind: "provider", id: providerId });
  }

  const contracts = readRecord(raw, "contracts");
  if (contracts) {
    for (const [group, value] of Object.entries(contracts)) {
      for (const id of readStringList(value)) {
        capabilities.push({ kind: `contract:${group}`, id });
      }
    }
  }

  return capabilities;
}

function readDeclaredDependencies(raw: Readonly<Record<string, unknown>>): readonly string[] {
  const names = new Set<string>();
  for (const key of dependencyMapKeys) {
    const map = readRecord(raw, key);
    if (!map) {
      continue;
    }
    for (const name of Object.keys(map)) {
      const trimmed = readOptionalText(name);
      if (trimmed !== undefined) {
        names.add(trimmed);
      }
    }
  }
  return [...names].sort();
}

function readMinHostVersion(raw: Readonly<Record<string, unknown>>): {
  readonly value?: string;
  readonly warning?: string;
} {
  const install = readRecord(raw, "install");
  const value = install?.["minHostVersion"];

  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || !minHostVersionPattern.test(value.trim())) {
    return { warning: 'invalid install.minHostVersion (expected ">=x.y.z")' };
  }
  return { value: value.trim() };
}
