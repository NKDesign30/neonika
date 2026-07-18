import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  createDefaultNeonMemoryProvider,
  type INeonMemoryProvider,
  type INeonMemorySearchHit,
  type INeonMemorySearchOptions,
  type INeonMemorySearchResult
} from "./neonMemory.js";
import { extractNeonQueryKeywords } from "./queryExpansion.js";

export interface INeonMergedMemoryFileRoot {
  readonly id: string;
  readonly path: string;
}

export interface INeonMergedMemoryProviderOptions {
  readonly primaryProvider?: INeonMemoryProvider;
  readonly fileRoots?: readonly INeonMergedMemoryFileRoot[];
  readonly homeDir?: string;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxFileHits?: number;
}

interface IFileCandidate {
  readonly root: INeonMergedMemoryFileRoot;
  readonly path: string;
}

const defaultMergedMaxFiles = 900;
const defaultMergedMaxFileBytes = 180_000;
const defaultMergedMaxFileHits = 6;
const defaultSearchMaxHits = 12;
const fileSnippetRadiusBefore = 260;
const fileSnippetRadiusAfter = 900;
const supportedMemoryFileExtensions: ReadonlySet<string> = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".txt"
]);

export function createMergedNeonMemoryProvider(
  options: INeonMergedMemoryProviderOptions = {}
): INeonMemoryProvider {
  const primaryProvider = options.primaryProvider ?? createDefaultNeonMemoryProvider();
  const fileRoots = options.fileRoots ?? createDefaultMergedMemoryRoots(options.homeDir);
  const maxFiles = resolvePositiveInteger(options.maxFiles, defaultMergedMaxFiles);
  const maxFileBytes = resolvePositiveInteger(options.maxFileBytes, defaultMergedMaxFileBytes);
  const maxFileHits = resolvePositiveInteger(options.maxFileHits, defaultMergedMaxFileHits);

  return {
    async search(query, searchOptions = {}) {
      const maxHits = resolvePositiveInteger(searchOptions.maxHits, defaultSearchMaxHits);
      const [primary, file] = await Promise.allSettled([
        primaryProvider.search(query, { maxHits }),
        searchMemoryFiles(query, {
          fileRoots,
          maxFiles,
          maxFileBytes,
          maxHits: Math.min(maxHits, maxFileHits)
        })
      ]);

      const diagnostics: string[] = [];
      const primaryResult = resultFromSettled(primary, query, "primary-memory", diagnostics);
      const fileResult = resultFromSettled(file, query, "file-memory", diagnostics);
      const hits = mergeMemoryHits(primaryResult.hits, fileResult.hits, maxHits);

      return {
        query,
        hits,
        diagnostics: [
          ...primaryResult.diagnostics,
          ...fileResult.diagnostics,
          ...diagnostics
        ]
      };
    }
  };
}

export const memorySharedRootsEnvKey = "NEON_MEMORY_SHARED_ROOTS" as const;

// Extra memory directories outside the known agent-tool layout, as an absolute
// path list. Each root is identified by its directory name, so two roots may not
// share a basename.
export function resolveNeonSharedMemoryRoots(
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly INeonMergedMemoryFileRoot[] {
  const configured = env[memorySharedRootsEnvKey]?.trim();
  if (configured === undefined || configured === "") {
    return [];
  }

  const seen = new Set<string>();
  const roots: INeonMergedMemoryFileRoot[] = [];
  for (const entry of configured.split(",")) {
    const path = entry.trim();
    if (path === "") {
      continue;
    }
    const id = basename(path).toLowerCase();
    if (id === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    roots.push({ id, path });
  }
  return roots;
}

export function createDefaultMergedMemoryRoots(
  homeDir = process.env["HOME"] ?? "",
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly INeonMergedMemoryFileRoot[] {
  if (!homeDir) {
    return [];
  }

  return [
    ...resolveNeonSharedMemoryRoots(env),
    { id: "codex-memory", path: join(homeDir, ".codex", "memories") },
    { id: "claude-global-memory", path: join(homeDir, ".claude", "global-memory") },
    { id: "claude-agent-memory", path: join(homeDir, ".claude", "agent-sdk", "memory") }
  ];
}

async function searchMemoryFiles(
  query: string,
  options: {
    readonly fileRoots: readonly INeonMergedMemoryFileRoot[];
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxHits: number;
  }
): Promise<INeonMemorySearchResult> {
  const keywords = extractNeonQueryKeywords(query);

  if (keywords.length === 0 || options.fileRoots.length === 0 || options.maxHits <= 0) {
    return { query, hits: [], diagnostics: [] };
  }

  const candidates = await collectMemoryFileCandidates(options.fileRoots, options.maxFiles);
  const hits: INeonMemorySearchHit[] = [];

  for (const candidate of candidates) {
    const hit = await matchMemoryFile(candidate, keywords, options.maxFileBytes);
    if (hit) {
      hits.push(hit);
    }
  }

  return {
    query,
    hits: selectDiverseFileHits(
      hits.sort((left, right) => (right.score ?? 0) - (left.score ?? 0)),
      options.maxHits
    ),
    diagnostics: []
  };
}

async function collectMemoryFileCandidates(
  roots: readonly INeonMergedMemoryFileRoot[],
  maxFiles: number
): Promise<readonly IFileCandidate[]> {
  const candidates: IFileCandidate[] = [];

  for (const root of roots) {
    await collectMemoryFileCandidatesForRoot(root, candidates, maxFiles);

    if (candidates.length >= maxFiles) {
      break;
    }
  }

  return candidates;
}

async function collectMemoryFileCandidatesForRoot(
  root: INeonMergedMemoryFileRoot,
  candidates: IFileCandidate[],
  maxFiles: number
): Promise<void> {
  const queue: string[] = [root.path];

  while (queue.length > 0 && candidates.length < maxFiles) {
    const dir = queue.shift();
    if (!dir) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!shouldSkipMemoryDirectory(entry.name)) {
          queue.push(path);
        }
        continue;
      }

      if (!entry.isFile() || !isSupportedMemoryFile(entry.name)) {
        continue;
      }

      candidates.push({ root, path });

      if (candidates.length >= maxFiles) {
        break;
      }
    }
  }
}

async function matchMemoryFile(
  candidate: IFileCandidate,
  keywords: readonly string[],
  maxFileBytes: number
): Promise<INeonMemorySearchHit | undefined> {
  const fileStat = await stat(candidate.path).catch(() => undefined);
  if (!fileStat?.isFile() || fileStat.size > maxFileBytes) {
    return undefined;
  }

  const raw = await readFile(candidate.path, "utf8").catch(() => undefined);
  if (!raw) {
    return undefined;
  }

  const lower = raw.toLocaleLowerCase("de-DE");
  const matchedKeywords = keywords.filter((keyword) => lower.includes(keyword));

  if (matchedKeywords.length === 0) {
    return undefined;
  }

  const firstIndex = Math.min(
    ...matchedKeywords.map((keyword) => lower.indexOf(keyword)).filter((index) => index >= 0)
  );
  const start = Math.max(0, firstIndex - fileSnippetRadiusBefore);
  const end = Math.min(raw.length, firstIndex + fileSnippetRadiusAfter);
  const snippet = raw.slice(start, end).replace(/\s+/gu, " ").trim();
  const relativePath = relative(candidate.root.path, candidate.path);

  return {
    source: redactText(`${candidate.root.id}:${relativePath}`),
    text: redactText(snippet),
    score: matchedKeywords.length
  };
}

function mergeMemoryHits(
  primaryHits: readonly INeonMemorySearchHit[],
  fileHits: readonly INeonMemorySearchHit[],
  maxHits: number
): readonly INeonMemorySearchHit[] {
  const fileBudget = Math.min(fileHits.length, Math.max(1, Math.floor(maxHits / 3)));
  const primaryBudget = Math.max(0, maxHits - fileBudget);
  const primaryWindow = primaryHits.slice(0, primaryBudget);
  const fileWindow = fileHits.slice(0, fileBudget);
  const interleavedHits = interleaveReservedFileHits(primaryWindow, fileWindow);
  const hits = [
    ...interleavedHits,
    ...primaryHits.slice(primaryBudget),
    ...fileHits.slice(fileBudget)
  ];
  const seen = new Set<string>();
  const deduped: INeonMemorySearchHit[] = [];

  for (const hit of hits) {
    const key = memoryHitDedupeKey(hit);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(hit);

    if (deduped.length >= maxHits) {
      break;
    }
  }

  return deduped;
}

function interleaveReservedFileHits(
  primaryHits: readonly INeonMemorySearchHit[],
  fileHits: readonly INeonMemorySearchHit[]
): readonly INeonMemorySearchHit[] {
  if (fileHits.length === 0) {
    return primaryHits;
  }

  if (primaryHits.length === 0) {
    return fileHits;
  }

  const stride = Math.max(1, Math.floor(primaryHits.length / (fileHits.length + 1)));
  const hits: INeonMemorySearchHit[] = [];
  let fileIndex = 0;

  for (let primaryIndex = 0; primaryIndex < primaryHits.length; primaryIndex += 1) {
    const primaryHit = primaryHits[primaryIndex];
    if (!primaryHit) {
      continue;
    }

    hits.push(primaryHit);

    const fileHit = fileHits[fileIndex];
    if ((primaryIndex + 1) % stride === 0 && fileHit) {
      hits.push(fileHit);
      fileIndex += 1;
    }
  }

  return [
    ...hits,
    ...fileHits.slice(fileIndex)
  ];
}

function selectDiverseFileHits(
  hits: readonly INeonMemorySearchHit[],
  maxHits: number
): readonly INeonMemorySearchHit[] {
  if (hits.length <= maxHits) {
    return hits;
  }

  const rootIds = Array.from(new Set(hits.map((hit) => resolveFileHitRootId(hit.source))));
  const maxPerRoot = Math.max(1, Math.ceil(maxHits / Math.max(1, rootIds.length)));
  const countsByRoot = new Map<string, number>();
  const selected = new Map<string, INeonMemorySearchHit>();

  for (const hit of hits) {
    if (selected.size >= maxHits) {
      break;
    }

    const rootId = resolveFileHitRootId(hit.source);
    const rootCount = countsByRoot.get(rootId) ?? 0;
    if (rootCount >= maxPerRoot) {
      continue;
    }

    selected.set(memoryHitDedupeKey(hit), hit);
    countsByRoot.set(rootId, rootCount + 1);
  }

  for (const hit of hits) {
    if (selected.size >= maxHits) {
      break;
    }

    selected.set(memoryHitDedupeKey(hit), hit);
  }

  return Array.from(selected.values());
}

function resolveFileHitRootId(source: string): string {
  const separatorIndex = source.indexOf(":");
  return separatorIndex > 0 ? source.slice(0, separatorIndex) : source;
}

function memoryHitDedupeKey(hit: INeonMemorySearchHit): string {
  return `${hit.source}\n${hit.text}`;
}

function resultFromSettled(
  result: PromiseSettledResult<INeonMemorySearchResult>,
  query: string,
  label: string,
  diagnostics: string[]
): INeonMemorySearchResult {
  if (result.status === "fulfilled") {
    return result.value;
  }

  diagnostics.push(`${label} unavailable: ${redactText(result.reason instanceof Error ? result.reason.message : "unknown error")}`);
  return { query, hits: [], diagnostics: [] };
}

function shouldSkipMemoryDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "assets";
}

function isSupportedMemoryFile(name: string): boolean {
  return supportedMemoryFileExtensions.has(name.slice(name.lastIndexOf(".")).toLocaleLowerCase("en-US"));
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}
