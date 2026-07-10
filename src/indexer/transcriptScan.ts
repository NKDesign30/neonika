import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Neon Transcript Indexer — scan stage. A read-only walk of the Claude Code
// transcript store (~/.claude/projects/<dir>/<sessionId>.jsonl), the same source
// a live session indexer ingests. No writes, no LLM, no clock side
// effects: the wall-clock `now` is injected so tests are deterministic and CI
// never reads the real machine dir. Mirrors v3's sessionScanner filters (12h age
// cutoff, 200-byte floor, ghost-bucket rejection, live/wrapping/final mode) but
// derives a username-safe project label so no home path leaks across a boundary.

export type TNeonTranscriptMode = "live" | "wrapping" | "final";

export interface INeonTranscriptSessionFile {
  readonly sessionId: string;
  /** Username-safe project label (home prefix stripped). */
  readonly project: string;
  /** Absolute path — used only to read the file, never placed in a snapshot. */
  readonly jsonlPath: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly mode: TNeonTranscriptMode;
  readonly isSubagent: boolean;
}

export interface IScanNeonTranscriptsOptions {
  /** Defaults to ~/.claude/projects. Tests inject an mkdtemp fixture. */
  readonly projectsDir?: string;
  /** Wall-clock in ms; defaults to Date.now(). Injected for deterministic mode classification. */
  readonly now?: number;
  /** Skip files older than this (default 12h), matching v3. */
  readonly maxAgeMs?: number;
  /** Skip files smaller than this (default 200 bytes), matching v3. */
  readonly minBytes?: number;
  /** Home prefix to strip from project labels; defaults to the real homedir. Injected in tests. */
  readonly homePrefix?: string;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const MIN_FILE_BYTES = 200;
const LIVE_THRESHOLD_MS = 15 * 60 * 1000;
const WRAPPING_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export function defaultTranscriptsDir(): string {
  return join(homedir(), ".claude", "projects");
}

// Claude Code names a transcript dir after its cwd with non-alphanumerics -> '-'.
// The home prefix is derived from the real homedir the SAME way, so a username
// with internal hyphens (e.g. /Users/ada-lovelace) is stripped whole instead of
// leaking its tail. Pass an explicit homePrefix in tests for determinism.
export function transcriptHomePrefix(home: string = homedir()): string {
  return home.replace(/[^A-Za-z0-9]+/gu, "-").replace(/-+$/u, "");
}

// Strip the home prefix so the returned label carries no username, and reject the
// ghost buckets v3 also drops. Returns null to skip.
export function transcriptProjectLabel(dirName: string, homePrefix: string = transcriptHomePrefix()): string | null {
  if (dirName === "-" || dirName.startsWith("-private-") || dirName.startsWith("-worktrees-")) {
    return null;
  }
  if (dirName === homePrefix) {
    return "global";
  }
  if (dirName.startsWith(`${homePrefix}-`)) {
    const stripped = dirName.slice(homePrefix.length + 1);
    return stripped.length > 0 ? stripped : "global";
  }
  // Fallback for an unrecognized prefix: drop the leading -Users/-home- segment
  // up to the next path component without leaking a hyphenated username tail.
  const stripped = dirName.replace(/^-(?:Users|home)-[^-]+-?/u, "");
  return stripped.length > 0 ? stripped : "global";
}

export function classifyTranscriptMode(mtimeMs: number, now: number): TNeonTranscriptMode {
  const ageMs = now - mtimeMs;
  if (ageMs < LIVE_THRESHOLD_MS) {
    return "live";
  }
  if (ageMs < WRAPPING_THRESHOLD_MS) {
    return "wrapping";
  }
  return "final";
}

function isSubagentTranscript(dirName: string, sessionId: string): boolean {
  return dirName.includes("subagents") || sessionId.startsWith("agent-");
}

// Read-only scan. Any missing/unreadable dir or file is skipped, never thrown:
// a non-existent projects dir yields an empty list (the empty-state floor).
export async function scanNeonTranscripts(
  options: IScanNeonTranscriptsOptions = {}
): Promise<INeonTranscriptSessionFile[]> {
  const projectsDir = options.projectsDir ?? defaultTranscriptsDir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? TWELVE_HOURS_MS;
  const minBytes = options.minBytes ?? MIN_FILE_BYTES;
  const homePrefix = options.homePrefix ?? transcriptHomePrefix();

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const results: INeonTranscriptSessionFile[] = [];

  for (const dirName of projectDirs) {
    const project = transcriptProjectLabel(dirName, homePrefix);
    if (project === null) {
      continue;
    }

    const subdir = join(projectsDir, dirName);
    let files: string[];
    try {
      files = await readdir(subdir);
    } catch {
      continue;
    }

    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) {
        continue;
      }

      const jsonlPath = join(subdir, fileName);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(jsonlPath);
      } catch {
        continue;
      }

      if (!info.isFile() || info.size < minBytes || now - info.mtimeMs > maxAgeMs) {
        continue;
      }

      const sessionId = fileName.replace(/\.jsonl$/u, "");
      results.push({
        sessionId,
        project,
        jsonlPath,
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        mode: classifyTranscriptMode(info.mtimeMs, now),
        isSubagent: isSubagentTranscript(dirName, sessionId)
      });
    }
  }

  return results.sort((left, right) => right.mtimeMs - left.mtimeMs);
}
