import { existsSync } from "node:fs";

import {
  canonicalNeonDbPath,
  defaultNeonMemoryDbPath,
  hybridSearchNeonMemoryDb,
  recordNeonMemoryDbAccess,
  searchNeonMemoryDb,
  toNeonV3SearchResult,
  type INeonMemoryAccessTrackingResult,
  type INeonV3SearchResult
} from "./neonMemoryDbProvider.js";
import type { INeonEmbeddingProvider } from "./neonEmbeddingProvider.js";
import type { INeonMemoryDbWriteGate } from "./neonMemoryDbWriter.js";

/**
 * The single recall seam over the semantic memory DBs (memory cutover, Slice K1).
 *
 * One deep module answers "recall X" for every consumer (HTTP v3 contract,
 * CLI, chat context) instead of each caller hand-wiring FTS/hybrid/fallback:
 *
 * - Primary DB (canonically the neonika `data/semantic-memory.db`, resolved
 *   via `NEON_MEMORY_DB_PATH`): hybrid FTS5+vector when an embedder is given,
 *   FTS-only fallback when embedding fails.
 * - Archive DB (the frozen v2 `semantic-memory.db`): FTS-only, read-only,
 *   best-effort. Recall sees the full 8k-entry history without re-embedding
 *   the query twice, and an archive failure never breaks recall.
 * - Access tracking feeds Ebbinghaus retention - primary hits only. The
 *   archive is immutable by definition; `recordNeonMemoryDbAccess` hard-blocks
 *   it anyway.
 *
 * Every result carries `origin: "primary" | "archive"` (primary first, both
 * halves bm25/fusion-sorted internally - cross-corpus scores are not
 * comparable, so they are never interleaved by score).
 *
 * Deliberate fail-loud: an absent/unreadable PRIMARY throws (503 at the HTTP
 * seam) even when the archive would be healthy - a misconfigured
 * NEON_MEMORY_DB_PATH must scream, not silently degrade to archive-only.
 */

export const NEON_MEMORY_DB_PATH_ENV = "NEON_MEMORY_DB_PATH";

/** Recall target: `NEON_MEMORY_DB_PATH` when set, else the v2 default. */
export function resolveNeonMemoryRecallDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return env[NEON_MEMORY_DB_PATH_ENV]?.trim() || defaultNeonMemoryDbPath;
}

export type TNeonMemoryRecallOrigin = "primary" | "archive";
export type TNeonMemoryRecallMode = "hybrid" | "fts" | "fts-fallback";

export interface INeonMemoryRecallHit extends INeonV3SearchResult {
  readonly origin: TNeonMemoryRecallOrigin;
}

export interface INeonMemoryRecallOptions {
  readonly primaryDbPath: string;
  /**
   * Archive DB searched read-only alongside the primary. Ignored when it equals
   * the primary path or does not exist. Pass `undefined` for primary-only recall.
   */
  readonly archiveDbPath?: string;
  readonly limit?: number;
  readonly agent?: string;
  readonly category?: string;
  /** When set, the primary search runs hybrid FTS5+vector; archive stays FTS. */
  readonly embedder?: INeonEmbeddingProvider;
  /** When set, primary hits are access-tracked (Ebbinghaus feed). */
  readonly trackingGate?: INeonMemoryDbWriteGate;
  readonly now?: () => Date;
}

export interface INeonMemoryRecallResult {
  readonly results: readonly INeonMemoryRecallHit[];
  readonly mode: TNeonMemoryRecallMode;
  readonly primaryHits: number;
  readonly archiveHits: number;
  readonly accessTracking?: INeonMemoryAccessTrackingResult;
  readonly diagnostics: readonly string[];
}

export async function recallNeonMemory(
  query: string,
  options: INeonMemoryRecallOptions
): Promise<INeonMemoryRecallResult> {
  const diagnostics: string[] = [];
  const searchOptions = {
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.category ? { category: options.category } : {})
  };

  let mode: TNeonMemoryRecallMode = "fts";
  let primaryRows: readonly { readonly id: number }[] = [];
  let primaryResults: INeonMemoryRecallHit[] = [];

  if (options.embedder) {
    try {
      const hybrid = await hybridSearchNeonMemoryDb(query, options.embedder, {
        ...searchOptions,
        dbPath: options.primaryDbPath
      });
      mode = "hybrid";
      primaryRows = hybrid;
      primaryResults = hybrid.map((row) => ({ ...toNeonV3SearchResult(row), origin: "primary" as const }));
    } catch {
      mode = "fts-fallback";
      diagnostics.push("primary hybrid search degraded to FTS (embedding unavailable)");
    }
  }
  if (mode !== "hybrid") {
    const rows = searchNeonMemoryDb(query, { ...searchOptions, dbPath: options.primaryDbPath });
    primaryRows = rows;
    primaryResults = rows.map((row) => ({ ...toNeonV3SearchResult(row), origin: "primary" as const }));
  }

  let archiveResults: INeonMemoryRecallHit[] = [];
  const archiveDbPath = options.archiveDbPath;
  // Realpath comparison: `.../dir/./file.db`, symlinks or `..` segments must not
  // load the same DB as primary AND archive (every hit would appear twice).
  const archiveIsPrimary =
    archiveDbPath !== undefined &&
    canonicalNeonDbPath(archiveDbPath) === canonicalNeonDbPath(options.primaryDbPath);
  if (archiveDbPath && !archiveIsPrimary && existsSync(archiveDbPath)) {
    try {
      archiveResults = searchNeonMemoryDb(query, { ...searchOptions, dbPath: archiveDbPath }).map(
        (row) => ({ ...toNeonV3SearchResult(row), origin: "archive" as const })
      );
    } catch {
      // Best-effort: a broken/missing archive must never break recall.
      diagnostics.push("archive search unavailable (skipped)");
    }
  }

  const accessTracking = options.trackingGate
    ? recordNeonMemoryDbAccess({
        dbPath: options.primaryDbPath,
        entryIds: primaryRows.map((row) => row.id),
        gate: options.trackingGate,
        ...(options.now ? { now: options.now } : {})
      })
    : undefined;

  // `limit` applies per source (both searches are already capped): primary
  // hits must never be crowded out by the archive and vice versa - during the
  // cutover the young primary DB is small while the archive holds 8k entries.
  // `primaryHits`/`archiveHits` keep the split transparent for consumers.
  const results = [...primaryResults, ...archiveResults];

  return {
    results,
    mode,
    primaryHits: primaryResults.length,
    archiveHits: results.length - primaryResults.length,
    ...(accessTracking ? { accessTracking } : {}),
    diagnostics
  };
}
