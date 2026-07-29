// Read-only static scan of a skill's sibling scripts.
//
// Upstream's skill scanner walks the skill *directory* and scans bundled code
// files (`.js`/`.ts`/...) — not the SKILL.md prose (`src/skills/security/
// scanner.ts`, `SCANNABLE_EXTENSIONS`). The Neon body scan covered SKILL.md;
// this module covers the sibling scripts, applying the same `scanNeonSkillSource`
// pattern set to each script. Bounded and read-only: depth/file/byte caps, no
// symlink traversal, realpath containment to the skill directory, no execution.

import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { scanNeonSkillSource, type INeonSkillScanFinding } from "./skillSecurityScan.js";

const SCANNABLE_SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".sh",
  ".bash",
  ".zsh",
  ".py"
]);

const defaultMaxScriptDepth = 3;
const defaultMaxScriptFiles = 25;
const defaultMaxScriptBytes = 256 * 1024;

export interface IScanNeonSkillScriptsOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

export interface INeonSkillScriptScanResult {
  readonly scannedFiles: number;
  readonly truncated: boolean;
  readonly findings: readonly INeonSkillScanFinding[];
}

/**
 * Scan the scannable script files inside a skill directory. Read-only and
 * bounded: walks at most `maxFiles` files up to `maxDepth`, skipping hidden
 * entries, `node_modules`, `dist`, and symlinked directories, and never reads a
 * file larger than `maxFileBytes`. Findings carry no script source text.
 */
export async function scanNeonSkillScripts(
  skillDir: string,
  options: IScanNeonSkillScriptsOptions = {}
): Promise<INeonSkillScriptScanResult> {
  const maxDepth = options.maxDepth ?? defaultMaxScriptDepth;
  const maxFiles = options.maxFiles ?? defaultMaxScriptFiles;
  const maxFileBytes = options.maxFileBytes ?? defaultMaxScriptBytes;

  const rootRealPath = await realpathOrNull(resolve(skillDir));
  if (!rootRealPath) {
    return { scannedFiles: 0, truncated: false, findings: [] };
  }
  const confirmedRoot = rootRealPath;

  const files: string[] = [];
  let truncated = false;

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (truncated || files.length >= maxFiles || depth > maxDepth) {
      return;
    }

    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      return;
    }

    for await (const entry of directory) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }

      const entryPath = join(directoryPath, entry.name);
      if (entry.isFile() && SCANNABLE_SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const realFilePath = await realpathOrNull(entryPath);
        if (realFilePath && isPathInside(confirmedRoot, realFilePath)) {
          files.push(realFilePath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
        if (truncated) {
          break;
        }
      }
    }
  }

  await visit(rootRealPath, 0);
  files.sort((left, right) => left.localeCompare(right));

  const findings: INeonSkillScanFinding[] = [];
  let scannedFiles = 0;
  for (const filePath of files) {
    const fileStat = await statOrNull(filePath);
    if (!fileStat || !fileStat.isFile() || fileStat.size > maxFileBytes) {
      continue;
    }
    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanNeonSkillSource(source, filePath));
  }

  return { scannedFiles, truncated, findings };
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
