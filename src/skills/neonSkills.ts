import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  scanReferenceExtensions,
  type INeonExtensionSummary
} from "./neonSkillExtensions.js";
import {
  isPathInside,
  normalizeOptionalText,
  realpathOrNull,
  statOrNull
} from "./neonSkillFs.js";
import {
  deriveNeonSkillInvocation,
  type INeonSkillInvocation
} from "./skillInvocation.js";
import {
  scanNeonSkillSource,
  summarizeNeonSkillFindings,
  unscannedNeonSkillSecuritySummary,
  type INeonSkillSecuritySummary
} from "./skillSecurityScan.js";
import { scanNeonSkillScripts } from "./skillScriptScan.js";
import {
  parseNeonSkillReferenceMetadata,
  type INeonSkillInstallSpec
} from "./skillMetadata.js";
import {
  createDefaultNeonSkillEligibilityChecks,
  evaluateNeonSkillEligibility,
  type INeonSkillEligibility,
  type INeonSkillEligibilityChecks
} from "./skillEligibility.js";

// Optional reference checkout scanned for importable skills/extensions. Never
// defaults to "" — `resolve("")` is the CWD, so an unset env would make a fresh
// clone inventory its own working tree. The fallback points at a conventional,
// normally absent directory, which the inventory reports as "missing".
export const referenceRootEnvKey = "NEON_SKILL_REFERENCE_ROOT" as const;

export function resolveDefaultReferenceRoot(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const raw = env[referenceRootEnvKey]?.trim();
  return raw === undefined || raw === "" ? join(homedir(), ".neon", "reference") : raw;
}

const skillFileName = "SKILL.md";
const maxSkillFileBytes = 128 * 1024;
const defaultSkillSearchDepth = 5;
const defaultSkillFileLimit = 400;
const defaultExtensionManifestLimit = 300;

export type TNeonInventoryTrust =
  | "trusted-local"
  | "trusted-project"
  | "reference-only"
  | "missing"
  | "invalid";

export type TNeonSkillInventoryState = "ready" | "partial" | "empty";
export type TNeonSkillRootKind =
  | "workspace"
  | "project-agent"
  | "codex"
  | "agents"
  | "claude-memory"
  | "upstream-reference"
  | "custom";
export type TNeonSkillLoadState = "available" | "shadowed" | "invalid" | "unreadable";

export interface INeonSkillRootConfig {
  readonly id: string;
  readonly label: string;
  readonly kind: TNeonSkillRootKind;
  readonly path: string;
  readonly trust: TNeonInventoryTrust;
}

export interface ICreateNeonSkillInventoryOptions {
  readonly generatedAt?: Date;
  readonly homeDir?: string;
  readonly referenceRoot?: string;
  readonly skillRoots?: readonly INeonSkillRootConfig[];
  readonly maxSkillDepth?: number;
  readonly maxSkillFilesPerRoot?: number;
  readonly maxExtensionManifests?: number;
  readonly eligibilityChecks?: INeonSkillEligibilityChecks;
}

export interface INeonSkillRootSnapshot {
  readonly id: string;
  readonly label: string;
  readonly kind: TNeonSkillRootKind;
  readonly path: string;
  readonly trust: TNeonInventoryTrust;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly discoveredSkillFiles: number;
  readonly omittedSkillFiles: number;
  readonly issues: readonly string[];
}

export interface INeonSkillSummary {
  readonly name: string;
  readonly normalizedName: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly rootId: string;
  readonly rootLabel: string;
  readonly sourceKind: TNeonSkillRootKind;
  readonly trust: TNeonInventoryTrust;
  readonly loadState: TNeonSkillLoadState;
  readonly disableModelInvocation: boolean;
  readonly invocation: INeonSkillInvocation;
  readonly security: INeonSkillSecuritySummary;
  readonly eligibility?: INeonSkillEligibility;
  readonly install?: readonly INeonSkillInstallSpec[];
  readonly shadowedBy?: string;
}

export interface INeonSkillInventoryTotals {
  readonly roots: number;
  readonly readableRoots: number;
  readonly skills: number;
  readonly availableSkills: number;
  readonly shadowedSkills: number;
  readonly invalidSkills: number;
  readonly referenceSkills: number;
  readonly modelInvocableSkills: number;
  readonly flaggedSkills: number;
  readonly criticalSkillFindings: number;
  readonly warnSkillFindings: number;
  readonly scannedSkillScripts: number;
  readonly extensionManifests: number;
  readonly invalidExtensionManifests: number;
  readonly referenceExtensions: number;
}

export interface INeonSkillInventorySource {
  readonly projectRoot: string;
  readonly homeDir: string;
  readonly referenceRoot: string;
  readonly extensionRoot: string;
}

export interface INeonSkillInventorySnapshot {
  readonly state: TNeonSkillInventoryState;
  readonly generatedAt: string;
  /** Deterministic hash over discovered skill file paths + mtimes for refresh detection. */
  readonly contentHash: string;
  readonly source: INeonSkillInventorySource;
  readonly roots: readonly INeonSkillRootSnapshot[];
  readonly skills: readonly INeonSkillSummary[];
  readonly extensions: readonly INeonExtensionSummary[];
  readonly totals: INeonSkillInventoryTotals;
  readonly issues: readonly string[];
}

export interface INeonExtensionInventorySnapshot {
  readonly state: TNeonSkillInventoryState;
  readonly generatedAt: string;
  readonly source: INeonSkillInventorySource;
  readonly extensions: readonly INeonExtensionSummary[];
  readonly totals: Pick<
    INeonSkillInventoryTotals,
    "extensionManifests" | "invalidExtensionManifests" | "referenceExtensions"
  >;
  readonly issues: readonly string[];
}

interface ISkillFileDiscoveryResult {
  readonly exists: boolean;
  readonly readable: boolean;
  readonly files: readonly string[];
  readonly omittedCount: number;
  readonly issues: readonly string[];
}

interface ISkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly disableModelInvocation: boolean;
}

export async function createNeonSkillInventorySnapshot(
  projectRoot: string,
  options: ICreateNeonSkillInventoryOptions = {}
): Promise<INeonSkillInventorySnapshot> {
  const source = createInventorySource(projectRoot, options);
  const skillRoots = options.skillRoots ?? createDefaultSkillRoots(projectRoot, source);
  const rootSnapshots: INeonSkillRootSnapshot[] = [];
  const skills: INeonSkillSummary[] = [];
  const issues: string[] = [];
  const seenSkills = new Map<string, string>();
  const eligibilityChecks = options.eligibilityChecks ?? createDefaultNeonSkillEligibilityChecks();

  for (const root of skillRoots) {
    const discovery = await discoverSkillFiles(root.path, {
      maxDepth: options.maxSkillDepth ?? defaultSkillSearchDepth,
      maxFiles: options.maxSkillFilesPerRoot ?? defaultSkillFileLimit
    });

    rootSnapshots.push({
      id: root.id,
      label: root.label,
      kind: root.kind,
      path: root.path,
      trust: discovery.exists ? root.trust : "missing",
      exists: discovery.exists,
      readable: discovery.readable,
      discoveredSkillFiles: discovery.files.length,
      omittedSkillFiles: discovery.omittedCount,
      issues: discovery.issues
    });
    issues.push(...discovery.issues);

    for (const filePath of discovery.files) {
      const skill = await readSkillSummary(filePath, root, seenSkills, eligibilityChecks);
      skills.push(skill);
      if (skill.loadState !== "invalid" && skill.loadState !== "unreadable") {
        seenSkills.set(skill.normalizedName, skill.name);
      }
      if (skill.loadState === "invalid" || skill.loadState === "unreadable") {
        issues.push(`${root.label}: ${skill.name} is ${skill.loadState}`);
      }
    }
  }

  const extensionScan = await scanReferenceExtensions(source.extensionRoot, {
    maxManifests: options.maxExtensionManifests ?? defaultExtensionManifestLimit
  });
  issues.push(...extensionScan.issues);

  const totals = summarizeSkillInventory(rootSnapshots, skills, extensionScan.extensions);
  const contentHash = await computeSkillInventoryContentHash(skills);

  return {
    state: resolveInventoryState(totals, issues),
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    contentHash,
    source,
    roots: rootSnapshots,
    skills,
    extensions: extensionScan.extensions,
    totals,
    issues
  };
}

/**
 * Deterministic content hash over the discovered skill files (sorted path +
 * mtime), mirroring upstream's snapshot-version approach for refresh detection.
 * Scope is the SKILL.md set: adding, removing, or editing a skill changes the
 * hash. Unreadable files contribute a zero mtime so they stay stable.
 */
async function computeSkillInventoryContentHash(
  skills: readonly INeonSkillSummary[]
): Promise<string> {
  const parts: string[] = [];
  for (const skill of [...skills].sort((left, right) => left.filePath.localeCompare(right.filePath))) {
    const fileStat = await statOrNull(skill.filePath);
    parts.push(`${skill.filePath}:${fileStat?.mtimeMs ?? 0}`);
  }

  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export async function createNeonExtensionInventorySnapshot(
  projectRoot: string,
  options: ICreateNeonSkillInventoryOptions = {}
): Promise<INeonExtensionInventorySnapshot> {
  const source = createInventorySource(projectRoot, options);
  const scan = await scanReferenceExtensions(source.extensionRoot, {
    maxManifests: options.maxExtensionManifests ?? defaultExtensionManifestLimit
  });
  const invalidExtensionManifests = scan.extensions.filter(
    (extension) => extension.loadState !== "reference-only"
  ).length;
  const totals = {
    extensionManifests: scan.extensions.length,
    invalidExtensionManifests,
    referenceExtensions: scan.extensions.filter((extension) => extension.trust === "reference-only")
      .length
  };

  return {
    state: resolveExtensionInventoryState(totals.extensionManifests, scan.issues),
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    source,
    extensions: scan.extensions,
    totals,
    issues: scan.issues
  };
}

export function renderNeonSkillInventoryReport(snapshot: INeonSkillInventorySnapshot): string {
  const lines = [
    `Neon Skills Inventory: ${snapshot.state}`,
    `Generated: ${snapshot.generatedAt}`,
    `Content hash: ${snapshot.contentHash.slice(0, 12)}`,
    `Roots: ${snapshot.totals.readableRoots}/${snapshot.totals.roots} readable`,
    `Skills: ${snapshot.totals.availableSkills} available / ${snapshot.totals.shadowedSkills} shadowed / ${snapshot.totals.referenceSkills} reference`,
    `Invocable: ${snapshot.totals.modelInvocableSkills} model-invocable`,
    `Security: ${snapshot.totals.flaggedSkills} flagged / ${snapshot.totals.criticalSkillFindings} critical / ${snapshot.totals.warnSkillFindings} warn / ${snapshot.totals.scannedSkillScripts} script(s) scanned`,
    `Extensions: ${snapshot.totals.referenceExtensions} reference manifests / ${snapshot.totals.invalidExtensionManifests} invalid`,
    `Eligibility: ${snapshot.skills.filter((skill) => skill.eligibility?.state === "eligible").length} eligible / ` +
      `${snapshot.skills.filter((skill) => skill.eligibility?.state === "ineligible").length} ineligible / ` +
      `${snapshot.skills.filter((skill) => skill.install && skill.install.length > 0).length} with install specs`,
    `upstream reference: ${snapshot.source.referenceRoot}`
  ];

  for (const root of snapshot.roots.slice(0, 8)) {
    lines.push(
      `- root ${root.id}: ${root.readable ? "readable" : "unavailable"} / ${root.discoveredSkillFiles} skill files / ${root.trust}`
    );
  }

  for (const skill of snapshot.skills.slice(0, 12)) {
    const security =
      skill.security.state === "flagged"
        ? ` / flagged: ${skill.security.findings.map((finding) => finding.ruleId).join(", ")}`
        : "";
    const eligibility = skill.eligibility
      ? skill.eligibility.state === "eligible"
        ? " / eligible"
        : ` / ineligible: ${skill.eligibility.missing.map((reason) => reason.detail).join(", ")}`
      : "";
    const install =
      skill.install && skill.install.length > 0
        ? ` / install: ${skill.install.map((spec) => spec.kind).join("/")}`
        : "";
    lines.push(
      `- skill ${skill.name}: ${skill.loadState} / ${skill.invocation.state} ${skill.invocation.slashCommand} / ${skill.sourceKind} / ${skill.description || "no description"}${security}${eligibility}${install}`
    );
  }

  return lines.join("\n");
}

export function renderNeonExtensionsReport(snapshot: INeonExtensionInventorySnapshot): string {
  const lines = [
    `Neon Extensions Inventory: ${snapshot.state}`,
    `Generated: ${snapshot.generatedAt}`,
    `Extension manifests: ${snapshot.totals.extensionManifests}`,
    `Reference-only: ${snapshot.totals.referenceExtensions}`,
    `Invalid: ${snapshot.totals.invalidExtensionManifests}`,
    `Source: ${snapshot.source.extensionRoot}`
  ];

  for (const extension of snapshot.extensions.slice(0, 16)) {
    lines.push(
      `- ${extension.id}: ${extension.loadState} / channels ${extension.capabilities.channels} / providers ${extension.capabilities.providers} / skills ${extension.capabilities.skills}`
    );
  }

  return lines.join("\n");
}

function createInventorySource(
  projectRoot: string,
  options: ICreateNeonSkillInventoryOptions
): INeonSkillInventorySource {
  const home = options.homeDir ?? homedir();
  const referenceRoot = options.referenceRoot ?? resolveDefaultReferenceRoot();

  return {
    projectRoot: resolve(projectRoot),
    homeDir: resolve(home),
    referenceRoot: resolve(referenceRoot),
    extensionRoot: join(resolve(referenceRoot), "extensions")
  };
}

function createDefaultSkillRoots(
  projectRoot: string,
  source: INeonSkillInventorySource
): readonly INeonSkillRootConfig[] {
  return [
    {
      id: "workspace-skills",
      label: "Workspace skills",
      kind: "workspace",
      path: join(resolve(projectRoot), "skills"),
      trust: "trusted-project"
    },
    {
      id: "workspace-agent-skills",
      label: "Workspace agent skills",
      kind: "project-agent",
      path: join(resolve(projectRoot), ".agents", "skills"),
      trust: "trusted-project"
    },
    {
      id: "codex-skills",
      label: "Codex skills",
      kind: "codex",
      path: join(source.homeDir, ".codex", "skills"),
      trust: "trusted-local"
    },
    {
      id: "agent-skills",
      label: "Agent skills",
      kind: "agents",
      path: join(source.homeDir, ".agents", "skills"),
      trust: "trusted-local"
    },
    {
      id: "claude-agent-memory",
      label: "Claude agent memory",
      kind: "claude-memory",
      path: join(source.homeDir, ".claude", "agent-sdk", "memory"),
      trust: "reference-only"
    },
    {
      id: "upstream-bundled-skills",
      label: "upstream bundled skills",
      kind: "upstream-reference",
      path: join(source.referenceRoot, "skills"),
      trust: "reference-only"
    }
  ];
}

async function discoverSkillFiles(
  rootPath: string,
  options: {
    readonly maxDepth: number;
    readonly maxFiles: number;
  }
): Promise<ISkillFileDiscoveryResult> {
  const resolvedRoot = resolve(rootPath);
  const rootStat = await statOrNull(resolvedRoot);

  if (!rootStat) {
    return {
      exists: false,
      readable: false,
      files: [],
      omittedCount: 0,
      issues: []
    };
  }

  if (!rootStat.isDirectory()) {
    return {
      exists: true,
      readable: false,
      files: [],
      omittedCount: 0,
      issues: [`${resolvedRoot} is not a directory`]
    };
  }

  const rootRealPath = await realpathOrNull(resolvedRoot);
  if (!rootRealPath) {
    return {
      exists: true,
      readable: false,
      files: [],
      omittedCount: 0,
      issues: [`${resolvedRoot} cannot be resolved`]
    };
  }
  const confirmedRootRealPath = rootRealPath;

  const files: string[] = [];
  const issues: string[] = [];
  let omittedCount = 0;

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (files.length >= options.maxFiles) {
      omittedCount += 1;
      return;
    }
    if (depth > options.maxDepth) {
      omittedCount += 1;
      return;
    }

    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      issues.push(`${directoryPath} is not readable`);
      return;
    }

    for await (const entry of directory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }

      const entryPath = join(directoryPath, entry.name);
      if (entry.isFile() && entry.name === skillFileName) {
        const realSkillPath = await realpathOrNull(entryPath);
        if (realSkillPath && isPathInside(confirmedRootRealPath, realSkillPath)) {
          files.push(realSkillPath);
        } else {
          omittedCount += 1;
        }
        continue;
      }

      if (entry.isDirectory()) {
        const entryStat = await lstatOrNull(entryPath);
        if (!entryStat || entryStat.isSymbolicLink()) {
          omittedCount += 1;
          continue;
        }
        await visit(entryPath, depth + 1);
      }
    }
  }

  await visit(confirmedRootRealPath, 0);

  return {
    exists: true,
    readable: true,
    files: files.sort((left, right) => left.localeCompare(right)),
    omittedCount,
    issues
  };
}

async function readSkillSummary(
  filePath: string,
  root: INeonSkillRootConfig,
  seenSkills: ReadonlyMap<string, string>,
  eligibilityChecks: INeonSkillEligibilityChecks
): Promise<INeonSkillSummary> {
  const fallbackName = basename(dirname(filePath));
  const base = {
    filePath,
    baseDir: dirname(filePath),
    rootId: root.id,
    rootLabel: root.label,
    sourceKind: root.kind,
    trust: root.trust
  };
  const fileStat = await statOrNull(filePath);

  if (!fileStat || fileStat.size > maxSkillFileBytes) {
    const normalizedName = normalizeNeonSkillName(fallbackName);
    return {
      ...base,
      name: fallbackName,
      normalizedName,
      description: "",
      loadState: "invalid",
      disableModelInvocation: false,
      invocation: deriveNeonSkillInvocation({
        normalizedName,
        available: false,
        shadowed: false,
        disableModelInvocation: false
      }),
      security: unscannedNeonSkillSecuritySummary()
    };
  }

  try {
    const source = await readFile(filePath, "utf8");
    const frontmatter = parseSkillFrontmatter(source, fallbackName);
    const name = frontmatter.name ?? fallbackName;
    const normalizedName = normalizeNeonSkillName(name);
    const shadowedBy = seenSkills.get(normalizedName);
    const scriptScan = await scanNeonSkillScripts(dirname(filePath));
    const security = summarizeNeonSkillFindings(scanNeonSkillSource(source, filePath), scriptScan);
    const referenceMetadata = parseNeonSkillReferenceMetadata(source);
    const eligibility = evaluateNeonSkillEligibility(referenceMetadata, eligibilityChecks);

    const summaryBase = {
      ...base,
      name,
      normalizedName,
      description: frontmatter.description ?? "",
      loadState: shadowedBy ? "shadowed" : "available",
      disableModelInvocation: frontmatter.disableModelInvocation,
      invocation: deriveNeonSkillInvocation({
        normalizedName,
        available: !shadowedBy,
        shadowed: Boolean(shadowedBy),
        disableModelInvocation: frontmatter.disableModelInvocation
      }),
      security,
      ...(eligibility.state !== "unknown" ? { eligibility } : {}),
      ...(referenceMetadata?.install ? { install: referenceMetadata.install } : {})
    } satisfies Omit<INeonSkillSummary, "shadowedBy">;

    if (shadowedBy) {
      return {
        ...summaryBase,
        shadowedBy
      };
    }

    return summaryBase;
  } catch {
    const normalizedName = normalizeNeonSkillName(fallbackName);
    return {
      ...base,
      name: fallbackName,
      normalizedName,
      description: "",
      loadState: "unreadable",
      disableModelInvocation: false,
      invocation: deriveNeonSkillInvocation({
        normalizedName,
        available: false,
        shadowed: false,
        disableModelInvocation: false
      }),
      security: unscannedNeonSkillSecuritySummary()
    };
  }
}

function parseSkillFrontmatter(source: string, fallbackName: string): ISkillFrontmatter {
  if (!source.startsWith("---")) {
    return {
      name: fallbackName,
      description: firstInstructionLine(source),
      disableModelInvocation: false
    };
  }

  const endIndex = source.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {
      name: fallbackName,
      description: firstInstructionLine(source),
      disableModelInvocation: false
    };
  }

  const block = source.slice(3, endIndex).split(/\r?\n/u);
  const values = new Map<string, string>();

  for (const line of block) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteYamlScalar(line.slice(separatorIndex + 1).trim());
    if (key) {
      values.set(key, value);
    }
  }

  return {
    name: normalizeOptionalText(values.get("name")) ?? fallbackName,
    description: normalizeOptionalText(values.get("description")) ?? firstInstructionLine(source),
    disableModelInvocation: parseBoolean(values.get("disableModelInvocation")) ?? false
  };
}

function firstInstructionLine(source: string): string {
  const body = source.startsWith("---")
    ? source.slice(Math.max(source.indexOf("\n---", 3) + 4, 0))
    : source;
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.slice(0, 180);
    }
  }
  return "";
}

function summarizeSkillInventory(
  roots: readonly INeonSkillRootSnapshot[],
  skills: readonly INeonSkillSummary[],
  extensions: readonly INeonExtensionSummary[]
): INeonSkillInventoryTotals {
  return {
    roots: roots.length,
    readableRoots: roots.filter((root) => root.readable).length,
    skills: skills.length,
    availableSkills: skills.filter((skill) => skill.loadState === "available").length,
    shadowedSkills: skills.filter((skill) => skill.loadState === "shadowed").length,
    invalidSkills: skills.filter(
      (skill) => skill.loadState === "invalid" || skill.loadState === "unreadable"
    ).length,
    referenceSkills: skills.filter((skill) => skill.trust === "reference-only").length,
    modelInvocableSkills: skills.filter((skill) => skill.invocation.modelInvocable).length,
    flaggedSkills: skills.filter((skill) => skill.security.state === "flagged").length,
    criticalSkillFindings: skills.reduce((sum, skill) => sum + skill.security.critical, 0),
    warnSkillFindings: skills.reduce((sum, skill) => sum + skill.security.warn, 0),
    scannedSkillScripts: skills.reduce((sum, skill) => sum + skill.security.scannedScripts, 0),
    extensionManifests: extensions.length,
    invalidExtensionManifests: extensions.filter(
      (extension) => extension.loadState !== "reference-only"
    ).length,
    referenceExtensions: extensions.filter((extension) => extension.trust === "reference-only")
      .length
  };
}

function resolveInventoryState(
  totals: INeonSkillInventoryTotals,
  issues: readonly string[]
): TNeonSkillInventoryState {
  if (totals.skills === 0 && totals.extensionManifests === 0) {
    return "empty";
  }
  if (issues.length > 0 || totals.invalidSkills > 0 || totals.invalidExtensionManifests > 0) {
    return "partial";
  }
  return "ready";
}

function resolveExtensionInventoryState(
  extensionCount: number,
  issues: readonly string[]
): TNeonSkillInventoryState {
  if (extensionCount === 0) {
    return "empty";
  }
  return issues.length > 0 ? "partial" : "ready";
}

export function normalizeNeonSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}
