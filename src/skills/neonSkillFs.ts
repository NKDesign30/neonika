import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

/**
 * Shared filesystem and JSON helpers for the Neon skill and extension
 * inventories. Kept dependency-free so both `neonSkills.ts` (skill discovery)
 * and `neonSkillExtensions.ts` (extension manifest scanning) can import from
 * here without forming an import cycle.
 */

/** Narrow an unknown JSON value to a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim a candidate string value and drop empty results. */
export function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** True when targetPath is rootPath itself or nested below it (no traversal escape). */
export function isPathInside(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
