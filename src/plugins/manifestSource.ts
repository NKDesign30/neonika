import { opendir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isPathInside, realpathOrNull, statOrNull } from "../skills/neonSkillFs.js";

/**
 * Filesystem source for plugin manifests.
 *
 * This reads `openclaw.plugin.json` manifests as raw JSON records and hands them
 * to the Neon Plugin SDK ({@link ../plugin-sdk/manifest.ts}) for parsing. It is
 * the rich, descriptor-grade counterpart to the legacy count-summary scanner in
 * `skills/neonSkillExtensions.ts`: same directory layout and path-safety
 * (symlink-resolved, no traversal escape, size-capped), but it returns the raw
 * record so the SDK — not the FS layer — owns the manifest contract.
 *
 * Reading is read-only and never imports, requires, or executes plugin code.
 */

const referencePluginManifestFileName = "openclaw.plugin.json";
const maxPluginManifestBytes = 256 * 1024;

export interface INeonPluginManifestSource {
  readonly directoryName: string;
  readonly manifestPath: string;
  readonly rootDir: string;
  /** Parsed JSON manifest record, when the file was readable and valid JSON. */
  readonly raw?: unknown;
  /** Set when the manifest was missing, too large, or could not be parsed. */
  readonly readError?: string;
}

export interface INeonPluginManifestSourceScan {
  readonly extensionRoot: string;
  readonly sources: readonly INeonPluginManifestSource[];
  readonly issues: readonly string[];
}

export interface IReadNeonPluginManifestSourcesOptions {
  readonly maxManifests: number;
}

export async function readNeonPluginManifestSources(
  extensionRoot: string,
  options: IReadNeonPluginManifestSourcesOptions
): Promise<INeonPluginManifestSourceScan> {
  const resolvedRoot = resolve(extensionRoot);
  const rootStat = await statOrNull(resolvedRoot);
  if (!rootStat || !rootStat.isDirectory()) {
    return { extensionRoot: resolvedRoot, sources: [], issues: [`plugin manifest root unavailable: ${resolvedRoot}`] };
  }

  const rootRealPath = await realpathOrNull(resolvedRoot);
  if (!rootRealPath) {
    return { extensionRoot: resolvedRoot, sources: [], issues: [`plugin manifest root cannot be resolved: ${resolvedRoot}`] };
  }

  let directory;
  try {
    directory = await opendir(rootRealPath);
  } catch {
    return { extensionRoot: resolvedRoot, sources: [], issues: [`plugin manifest root is not readable: ${resolvedRoot}`] };
  }

  const sources: INeonPluginManifestSource[] = [];
  const issues: string[] = [];

  for await (const entry of directory) {
    if (sources.length >= options.maxManifests) {
      issues.push(`plugin manifest scan limit reached at ${options.maxManifests}`);
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

    const source = await readManifestSource(manifestRealPath, entry.name);
    sources.push(source);
    if (source.readError) {
      issues.push(`${entry.name}: ${source.readError}`);
    }
  }

  return {
    extensionRoot: resolvedRoot,
    sources: sources.sort((left, right) => left.directoryName.localeCompare(right.directoryName)),
    issues
  };
}

async function readManifestSource(
  manifestPath: string,
  directoryName: string
): Promise<INeonPluginManifestSource> {
  const rootDir = dirname(manifestPath);
  const manifestStat = await statOrNull(manifestPath);

  if (!manifestStat) {
    return { directoryName, manifestPath, rootDir, readError: "manifest missing" };
  }
  if (manifestStat.size > maxPluginManifestBytes) {
    return { directoryName, manifestPath, rootDir, readError: "manifest too large" };
  }

  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    return { directoryName, manifestPath, rootDir, raw };
  } catch (error) {
    return {
      directoryName,
      manifestPath,
      rootDir,
      readError: error instanceof Error ? error.message : "manifest parse failed"
    };
  }
}
