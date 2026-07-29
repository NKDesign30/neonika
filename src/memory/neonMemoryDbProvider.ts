import { openNeonMemoryDatabase } from "./neonMemoryDbOpen.js";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  bufferToNeonVector,
  neonCosineSimilarity,
  type INeonEmbeddingProvider
} from "./neonEmbeddingProvider.js";
import type {
  INeonMemoryProvider,
  INeonMemorySearchHit,
  TNeonMemoryMatchType
} from "./neonMemory.js";
// Type-only import: no runtime cycle with the writer (which imports
// `targetsRealNeonDb` from this module).
import type { INeonMemoryDbWriteGate } from "./neonMemoryDbWriter.js";

/**
 * Direct SQLite memory search for Neonika (memory autarky).
 *
 * Neonika owns its memory: it never depends on a companion service's running
 * HTTP search endpoint. This module reads the semantic memory DB directly
 * through Node's built-in `node:sqlite` (no extra dependency) using FTS5 + bm25
 * ranking. The DB is opened read-only; nothing here ever writes. All text
 * crossing a boundary is run through `redactText` before it leaves this module.
 */

export const memoryDbPathEnvKey = "NEON_MEMORY_DB_PATH" as const;

/**
 * Where the semantic memory DB lives. Override with `NEON_MEMORY_DB_PATH` to
 * point Neonika at an existing store.
 */
export function resolveDefaultNeonMemoryDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = env[memoryDbPathEnvKey]?.trim();
  return configured !== undefined && configured !== ""
    ? configured
    : join(homedir(), ".neon", "memory", "semantic-memory.db");
}

export const defaultNeonMemoryDbPath = resolveDefaultNeonMemoryDbPath();

/**
 * True when `dbPath` resolves to the real canonical semantic-memory DB. A raw
 * `===` string compare is bypassable: `.../memory/./semantic-memory.db`,
 * trailing slashes, `..` segments or a symlink all point at the real DB while
 * differing as strings. Every memory mutator's real-DB hard-guard depends on this,
 * so the comparison is done on the realpath (canonical, symlink-resolved) and falls
 * back to `resolve` when a path does not exist yet (e.g. a fresh test DB).
 */
export function canonicalNeonDbPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function targetsRealNeonDb(dbPath: string): boolean {
  return canonicalNeonDbPath(dbPath) === canonicalNeonDbPath(defaultNeonMemoryDbPath);
}

const defaultSearchLimit = 20;
const maxSearchLimit = 100;
const maxContentLength = 260;

// Hybrid fusion weights mirror v2 (textWeight 0.4, vectorWeight 0.6). minVectorScore
// drops near-orthogonal vectors before fusion so the vector half adds signal, not noise.
const defaultTextWeight = 0.4;
const defaultVectorWeight = 0.6;
const defaultMinVectorScore = 0.08;

/**
 * Ambient categories are session bookkeeping, not knowledge: a live-index digest
 * records message counts, tool failures and the first ~100 characters of the last
 * message. Its preview quotes the session verbatim, so it matches a topic without
 * knowing anything about it — and being short, it scores high on bm25 density.
 *
 * Measured on 2026-07-25: a search for a real topic returned two such digests
 * above the actual session summary that discussed it. They are 1144 of 2351
 * entries, so they crowd out every content search. They stay in the DB and remain
 * reachable by asking for the category explicitly; they are just not what a
 * content query means.
 */
const ambientCategories: readonly string[] = ["live-index"];

/**
 * Importance as a rank multiplier, not an additive term.
 *
 * The live-index quality gate already derives importance from content and clamps
 * digests to 20-60, explicitly "always below real curated knowledge" — but that
 * work was inert, because fusion scored purely on text and vector similarity and
 * never read the column. Curated entries sit at 70-90, so the spread below keeps
 * a strong low-importance hit competitive while letting a weak high-importance
 * one win a close call. Deliberately linear and floored: squaring it would bury
 * good hits that simply never got a high score.
 *
 * Kalibrierung aus dem Roundtable vom 25.07.2026: 0.45/0.55 war zu aggressiv —
 * ein imp=30-Eintrag hätte nur 66% des Gewichts eines imp=88-Eintrags getragen
 * und wäre auch bei deutlich besserer Textnähe verloren. Mit 0.65/0.35 liegt das
 * Verhältnis bei 79%: importance entscheidet knappe Fälle, kippt aber keine
 * klare semantische Überlegenheit.
 */
const importanceFloor = 0.65;
const importanceSpan = 0.35;

function importanceFactor(importance: number): number {
  if (!Number.isFinite(importance) || importance <= 0) {
    return importanceFloor;
  }
  const normalized = Math.min(100, importance) / 100;
  return importanceFloor + importanceSpan * normalized;
}

export interface INeonMemoryDbRow {
  readonly id: number;
  readonly agent: string;
  readonly category: string;
  readonly content: string;
  readonly source: string;
  readonly importance: number;
  readonly score: number;
}

export interface INeonMemoryHybridRow extends INeonMemoryDbRow {
  readonly matchType: TNeonMemoryMatchType;
}

export interface INeonMemoryDbSearchOptions {
  readonly dbPath?: string;
  readonly limit?: number;
  readonly agent?: string;
  readonly category?: string;
}

export interface INeonHybridSearchOptions {
  readonly dbPath?: string;
  readonly limit?: number;
  readonly agent?: string;
  readonly category?: string;
  readonly textWeight?: number;
  readonly vectorWeight?: number;
  readonly minVectorScore?: number;
}

export interface INeonMemoryAccessTrackingResult {
  readonly state: "tracked" | "blocked" | "skipped";
  readonly updatedRows: number;
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

/**
 * Records a recall against memory entries: `access_count + 1` and a fresh
 * `last_accessed_at` for every hit id (memory cutover, Slice K2).
 *
 * This is the food for the Ebbinghaus retention model
 * (`neonMemoryImportance.ts` reads exactly these two columns) - without it,
 * never-recalled and often-recalled entries decay identically. The v2 pipeline
 * incremented these counters on every FTS hit; the neonika read path was
 * fully read-only until this seam.
 *
 * Write discipline mirrors `writeNeonMemoryDbEntry`: the shared
 * `NEON_MEMORY_WRITE_ENABLED` gate must be armed AND the target must not be
 * the real v2 DB (which is an archive - recall against it must never mutate
 * it) unless `allowRealDb` is explicitly set. Tracking failures must never
 * break a search, so this function reports errors as a blocked result instead
 * of throwing.
 */
export function recordNeonMemoryDbAccess(options: {
  readonly dbPath: string;
  readonly entryIds: readonly number[];
  readonly gate: INeonMemoryDbWriteGate;
  readonly allowRealDb?: boolean;
  readonly now?: () => Date;
}): INeonMemoryAccessTrackingResult {
  const targetedRealMemoryDb = targetsRealNeonDb(options.dbPath);
  const result = (
    state: INeonMemoryAccessTrackingResult["state"],
    updatedRows: number,
    diagnostics: readonly string[]
  ): INeonMemoryAccessTrackingResult => ({
    state,
    updatedRows,
    safety: { targetedRealMemoryDb },
    diagnostics
  });

  if (options.entryIds.length === 0) {
    return result("skipped", 0, ["access tracking skipped: no hits"]);
  }
  if (!options.gate.enabled) {
    return result("blocked", 0, [`access tracking blocked: ${options.gate.envKey} is not armed`]);
  }
  if (targetedRealMemoryDb && options.allowRealDb !== true) {
    return result("blocked", 0, [
      "access tracking refused: target is the real semantic-memory DB (archive stays untouched)"
    ]);
  }

  const nowIso = (options.now?.() ?? new Date()).toISOString();
  try {
    const database = openNeonMemoryDatabase(options.dbPath);
    try {
      const placeholders = options.entryIds.map(() => "?").join(", ");
      const update = database
        .prepare(
          `UPDATE memory_entries
             SET access_count = access_count + 1, last_accessed_at = ?
           WHERE id IN (${placeholders})`
        )
        .run(nowIso, ...options.entryIds);
      const updatedRows = Number(update.changes);
      return result("tracked", updatedRows, [`access tracking: ${updatedRows} row(s) updated`]);
    } finally {
      database.close();
    }
  } catch {
    // A tracking write must never break the read path (e.g. read-only mount).
    return result("blocked", 0, ["access tracking blocked: db not writable"]);
  }
}

export interface INeonMemoryDbProviderOptions {
  readonly dbPath?: string;
  readonly maxHits?: number;
  /**
   * Optional embedder. When set, the provider runs hybrid FTS5 + vector search and
   * gracefully falls back to FTS-only (with a diagnostic) if embedding fails (e.g.
   * Ollama unreachable). When omitted, the provider stays pure FTS5.
   */
  readonly embedder?: INeonEmbeddingProvider;
}

/**
 * Builds a safe FTS5 MATCH expression by quoting every token. Unquoted FTS5
 * tokens with punctuation (`-`, `/`, `.`) raise syntax errors, so each token is
 * wrapped in double quotes and OR-joined for a forgiving recall.
 */
export function buildNeonFtsMatchExpression(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, "").trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return "";
  }

  return tokens.map((token) => `"${token}"`).join(" OR ");
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return defaultSearchLimit;
  }
  return Math.min(Math.floor(limit), maxSearchLimit);
}

function readRowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readRowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Runs the raw FTS5 + bm25 query and returns redacted rows. Read-only; opens and
 * closes the DB per call so it never holds a long-lived handle on the shared DB.
 */
export function searchNeonMemoryDb(
  query: string,
  options: INeonMemoryDbSearchOptions = {}
): readonly INeonMemoryDbRow[] {
  const match = buildNeonFtsMatchExpression(query);
  if (!match) {
    return [];
  }

  const dbPath = options.dbPath ?? defaultNeonMemoryDbPath;
  const limit = clampLimit(options.limit);

  const conditions = ["memory_fts MATCH ?"];
  const parameters: Array<string | number> = [match];

  if (options.agent) {
    conditions.push("me.agent = ?");
    parameters.push(options.agent);
  }
  if (options.category) {
    conditions.push("me.category = ?");
    parameters.push(options.category);
  } else {
    // Nur im Default-Fall: wer die Kategorie ausdrücklich nennt, bekommt sie.
    conditions.push(
      `me.category NOT IN (${ambientCategories.map(() => "?").join(",")})`
    );
    parameters.push(...ambientCategories);
  }
  parameters.push(limit);

  const sql = `SELECT me.id AS id, me.agent AS agent, me.category AS category,
      me.content AS content, me.source_file AS source,
      me.importance_score AS importance, bm25(memory_fts) AS rank
    FROM memory_entries me
    JOIN memory_fts ON memory_fts.rowid = me.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank
    LIMIT ?`;

  const database = openNeonMemoryDatabase(dbPath, { readOnly: true });
  try {
    const rows = database.prepare(sql).all(...parameters) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: readRowNumber(row, "id"),
      agent: readRowString(row, "agent"),
      category: readRowString(row, "category"),
      content: redactText(readRowString(row, "content")),
      source: redactText(readRowString(row, "source")),
      importance: readRowNumber(row, "importance"),
      score: Math.abs(readRowNumber(row, "rank"))
    }));
  } finally {
    database.close();
  }
}

/**
 * Hybrid FTS5 + vector search over the semantic memory DB (read-only). The query
 * is embedded once (via the provider — canonically Ollama nomic-embed-text, 768d),
 * then scored two ways: FTS bm25 (normalized to 0..1) and brute-force cosine over
 * every same-dimension embedding BLOB. Mixed-dimension rows (the known 128/256-dim
 * data bug) are skipped by the `LENGTH(embedding) = dims*4` filter so a 768-dim
 * query never scores against an incompatible vector. Fusion follows v2:
 * `0.4*fts + 0.6*cosine` for rows hit by both, single-signal otherwise. Throws if
 * embedding fails so the caller can fall back to FTS-only rather than match noise.
 */
export async function hybridSearchNeonMemoryDb(
  query: string,
  embedder: INeonEmbeddingProvider,
  options: INeonHybridSearchOptions = {}
): Promise<readonly INeonMemoryHybridRow[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const dbPath = options.dbPath ?? defaultNeonMemoryDbPath;
  const limit = clampLimit(options.limit);
  const textWeight = options.textWeight ?? defaultTextWeight;
  const vectorWeight = options.vectorWeight ?? defaultVectorWeight;
  const minVectorScore = options.minVectorScore ?? defaultMinVectorScore;

  const queryVector = await embedder.embed(trimmed);
  const embeddingBytes = embedder.dimensions * 4;

  const database = openNeonMemoryDatabase(dbPath, { readOnly: true });
  try {
    const ftsScores = new Map<number, number>();
    const ftsImportance = new Map<number, number>();
    const match = buildNeonFtsMatchExpression(trimmed);
    if (match) {
      const conditions = ["memory_fts MATCH ?"];
      const parameters: Array<string | number> = [match];
      if (options.agent) {
        conditions.push("me.agent = ?");
        parameters.push(options.agent);
      }
      if (options.category) {
        conditions.push("me.category = ?");
        parameters.push(options.category);
      } else {
        conditions.push(
          `me.category NOT IN (${ambientCategories.map(() => "?").join(",")})`
        );
        parameters.push(...ambientCategories);
      }
      parameters.push(Math.max(limit * 4, 40));
      const ftsRows = database
        .prepare(
          `SELECT me.id AS id, me.importance_score AS importance, bm25(memory_fts) AS rank
            FROM memory_entries me
            JOIN memory_fts ON memory_fts.rowid = me.id
            WHERE ${conditions.join(" AND ")}
            ORDER BY rank
            LIMIT ?`
        )
        .all(...parameters) as Array<Record<string, unknown>>;
      let maxAbsRank = 0;
      for (const row of ftsRows) {
        maxAbsRank = Math.max(maxAbsRank, Math.abs(readRowNumber(row, "rank")));
      }
      if (maxAbsRank > 0) {
        for (const row of ftsRows) {
          ftsScores.set(readRowNumber(row, "id"), Math.abs(readRowNumber(row, "rank")) / maxAbsRank);
        }
      }
      for (const row of ftsRows) {
        ftsImportance.set(readRowNumber(row, "id"), readRowNumber(row, "importance"));
      }
    }

    const vectorScores = new Map<number, number>();
    const vectorConditions = ["embedding IS NOT NULL", "LENGTH(embedding) = ?"];
    const vectorParameters: Array<string | number> = [embeddingBytes];
    if (options.agent) {
      vectorConditions.push("agent = ?");
      vectorParameters.push(options.agent);
    }
    if (options.category) {
      vectorConditions.push("category = ?");
      vectorParameters.push(options.category);
    } else {
      vectorConditions.push(
        `category NOT IN (${ambientCategories.map(() => "?").join(",")})`
      );
      vectorParameters.push(...ambientCategories);
    }
    // importance kommt aus beiden Halbmengen, weil ein reiner Vektortreffer
    // sonst keinen Wert hätte, mit dem die Fusion gewichten könnte.
    const importanceById = new Map<number, number>(ftsImportance);
    const vectorRows = database
      .prepare(
        `SELECT id, embedding, importance_score AS importance
           FROM memory_entries WHERE ${vectorConditions.join(" AND ")}`
      )
      .all(...vectorParameters) as Array<Record<string, unknown>>;
    for (const row of vectorRows) {
      const blob = row["embedding"];
      if (!(blob instanceof Uint8Array)) {
        continue;
      }
      const cosine = neonCosineSimilarity(queryVector, bufferToNeonVector(blob));
      if (cosine >= minVectorScore) {
        const id = readRowNumber(row, "id");
        vectorScores.set(id, cosine);
        importanceById.set(id, readRowNumber(row, "importance"));
      }
    }

    const allIds = new Set<number>([...ftsScores.keys(), ...vectorScores.keys()]);
    if (allIds.size === 0) {
      return [];
    }

    const ranked: Array<{ id: number; score: number; matchType: TNeonMemoryMatchType }> = [];
    for (const id of allIds) {
      const fts = ftsScores.get(id) ?? 0;
      const vec = vectorScores.get(id) ?? 0;
      const weight = importanceFactor(importanceById.get(id) ?? 0);
      if (fts > 0 && vec > 0) {
        ranked.push({
          id,
          score: (textWeight * fts + vectorWeight * vec) * weight,
          matchType: "hybrid"
        });
      } else if (vec > 0) {
        ranked.push({ id, score: vectorWeight * vec * weight, matchType: "vector" });
      } else {
        ranked.push({ id, score: textWeight * fts * weight, matchType: "fts" });
      }
    }
    ranked.sort((left, right) => right.score - left.score);
    const top = ranked.slice(0, limit);

    const idList = top.map((entry) => entry.id);
    const placeholders = idList.map(() => "?").join(",");
    const fullRows = database
      .prepare(
        `SELECT id, agent, category, content, source_file AS source, importance_score AS importance
          FROM memory_entries WHERE id IN (${placeholders})`
      )
      .all(...idList) as Array<Record<string, unknown>>;
    const rowById = new Map<number, Record<string, unknown>>();
    for (const row of fullRows) {
      rowById.set(readRowNumber(row, "id"), row);
    }

    const results: INeonMemoryHybridRow[] = [];
    for (const entry of top) {
      const row = rowById.get(entry.id);
      if (!row) {
        continue;
      }
      results.push({
        id: entry.id,
        agent: readRowString(row, "agent"),
        category: readRowString(row, "category"),
        content: redactText(readRowString(row, "content")),
        source: redactText(readRowString(row, "source")),
        importance: readRowNumber(row, "importance"),
        score: entry.score,
        matchType: entry.matchType
      });
    }
    return results;
  } finally {
    database.close();
  }
}

/**
 * The wire shape a legacy `/api/memory/v3/search` returns per result, so Neon
 * Core can be a drop-in replacement on the same route. The `entry` nesting and
 * top-level `score`/`matchType` mirror v3's `ISemanticMemorySearchResult`. Only
 * the fields the real HTTP consumer (`~/.claude/bin/memory-search`: agent,
 * category, sourceFile, content + score) reads are projected — v3's `provenance`
 * is intentionally omitted (it carries channel/user/session ids and must not cross
 * this boundary), and timestamps are omitted because the search projection does
 * not load them. No fabricated defaults.
 */
export interface INeonV3SearchResult {
  readonly entry: {
    readonly id: number;
    readonly sourceFile: string;
    readonly content: string;
    readonly agent: string;
    readonly category: string;
    readonly importanceScore: number;
  };
  readonly score: number;
  readonly matchType: TNeonMemoryMatchType;
}

/**
 * Maps a flat memory row to the v3 `/api/memory/v3/search` wire result so the HTTP
 * endpoint is a drop-in for it. content/source are already redacted by the
 * search functions; this only re-nests them.
 */
export function toNeonV3SearchResult(
  row: INeonMemoryDbRow | INeonMemoryHybridRow
): INeonV3SearchResult {
  const matchType: TNeonMemoryMatchType = "matchType" in row ? row.matchType : "fts";
  return {
    entry: {
      id: row.id,
      sourceFile: row.source,
      content: row.content,
      agent: row.agent,
      category: row.category,
      importanceScore: row.importance
    },
    score: row.score,
    matchType
  };
}

function toHit(row: INeonMemoryDbRow | INeonMemoryHybridRow): INeonMemorySearchHit {
  const matchType = "matchType" in row ? row.matchType : undefined;
  return {
    source: redactText(`${row.agent}/${row.category}`),
    text: row.content.slice(0, maxContentLength),
    score: row.score,
    ...(matchType ? { matchType } : {})
  };
}

/**
 * Memory provider that reads the semantic memory DB directly, returning the same
 * `INeonMemoryProvider` shape the CLI provider does. This is the autarkic default
 * so Neonika's run memory attachment and Doctor health check no longer shell out
 * to a script that depends on an external service. With an `embedder` it runs hybrid
 * FTS5 + vector search; without one it stays pure FTS5.
 */
export function createNeonMemoryDbProvider(
  options: INeonMemoryDbProviderOptions = {}
): INeonMemoryProvider {
  const dbPath = options.dbPath ?? defaultNeonMemoryDbPath;
  const embedder = options.embedder;

  return {
    search: async (query, searchOptions = {}) => {
      const limit = searchOptions.maxHits;

      if (embedder) {
        try {
          const rows = await hybridSearchNeonMemoryDb(query, embedder, {
            dbPath,
            ...(limit ? { limit } : {})
          });
          return { query, hits: rows.map(toHit), diagnostics: [] };
        } catch (error) {
          const rows = searchNeonMemoryDb(query, { dbPath, ...(limit ? { limit } : {}) });
          const reason = error instanceof Error ? redactText(error.message) : "unknown error";
          return {
            query,
            hits: rows.map(toHit),
            diagnostics: [`vector search unavailable, fts-only fallback: ${reason}`]
          };
        }
      }

      const rows = searchNeonMemoryDb(query, { dbPath, ...(limit ? { limit } : {}) });
      return { query, hits: rows.map(toHit), diagnostics: [] };
    }
  };
}
