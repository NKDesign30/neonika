import { DatabaseSync } from "node:sqlite";

import {
  NEON_OLLAMA_EMBEDDING_DIMENSIONS,
  bufferToNeonVector,
  neonCosineSimilarity
} from "./neonEmbeddingProvider.js";
import { targetsRealNeonDb } from "./neonMemoryDbProvider.js";
import {
  resolveNeonMemoryDbWriteGate,
  type INeonMemoryDbWriteGate
} from "./neonMemoryDbWriter.js";

/**
 * Vector relation discovery for Neon Core (memory autarky).
 *
 * Mirrors v2's `relations/discover`: brute-force cosine similarity over entry
 * embeddings, persisting pairs above a threshold as `related` rows in
 * `memory_relations` (confidence = cosine). To bound the O(n^2) cost it considers
 * only the top `maxEntries` rows by importance and a single embedding dimension
 * (768 / Ollama nomic-embed-text by default), skipping the known mixed-dimension
 * data bug. Pairs are undirected (source_id < target_id) and de-duplicated by the
 * `UNIQUE(source_id, target_id, relation_type)` index. Same two gates as the
 * writer: `NEON_MEMORY_WRITE_ENABLED` must be armed and the real DB is hard-refused
 * unless `allowRealDb` is set. The scan/plan always runs.
 */

const defaultThreshold = 0.85;
const defaultMaxEntries = 200;

export interface INeonRelationDiscoveryOptions {
  readonly dbPath: string;
  readonly gate?: INeonMemoryDbWriteGate;
  readonly dimensions?: number;
  readonly threshold?: number;
  readonly maxEntries?: number;
  readonly allowRealDb?: boolean;
}

export interface INeonRelationDiscoveryResult {
  readonly state: "discovered" | "planned" | "blocked";
  readonly scanned: number;
  readonly candidates: number;
  readonly inserted: number;
  readonly threshold: number;
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

interface IRelationCandidate {
  readonly sourceId: number;
  readonly targetId: number;
  readonly confidence: number;
}

/**
 * Creates the `memory_relations` schema (mirrors the canonical DB). Idempotent.
 */
export function bootstrapNeonRelationsSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT,
      UNIQUE(source_id, target_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_id);
  `);
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Discovers `related` relations by cosine similarity and (when armed) persists
 * them. Returns scanned/candidates/inserted whether or not the write happened.
 */
export function discoverNeonMemoryRelations(
  options: INeonRelationDiscoveryOptions
): INeonRelationDiscoveryResult {
  const gate = options.gate ?? resolveNeonMemoryDbWriteGate(process.env);
  const targetsRealDb = targetsRealNeonDb(options.dbPath);
  // Clamp the threshold to [0,1]: a caller-supplied threshold <= 0 would otherwise
  // let negative cosine values land in memory_relations as "confidence".
  const threshold = Math.max(0, Math.min(1, typeof options.threshold === "number" ? options.threshold : defaultThreshold));
  const maxEntries = options.maxEntries && options.maxEntries > 0 ? Math.floor(options.maxEntries) : defaultMaxEntries;
  const dimensions = options.dimensions && options.dimensions > 0 ? options.dimensions : NEON_OLLAMA_EMBEDDING_DIMENSIONS;
  const embeddingBytes = dimensions * 4;

  const canWrite = gate.enabled && (!targetsRealDb || options.allowRealDb === true);
  const database = new DatabaseSync(options.dbPath, { readOnly: !canWrite });
  try {
    const rows = database
      .prepare(
        `SELECT id, embedding FROM memory_entries
          WHERE embedding IS NOT NULL AND LENGTH(embedding) = ?
          ORDER BY importance_score DESC
          LIMIT ?`
      )
      .all(embeddingBytes, maxEntries) as Array<Record<string, unknown>>;

    const vectors: Array<{ id: number; vector: Float32Array }> = [];
    for (const row of rows) {
      const blob = row["embedding"];
      if (!(blob instanceof Uint8Array)) {
        continue;
      }
      vectors.push({ id: readNumber(row, "id"), vector: bufferToNeonVector(blob) });
    }

    const candidates: IRelationCandidate[] = [];
    for (let i = 0; i < vectors.length; i += 1) {
      for (let j = i + 1; j < vectors.length; j += 1) {
        const a = vectors[i];
        const b = vectors[j];
        if (!a || !b) {
          continue;
        }
        const confidence = neonCosineSimilarity(a.vector, b.vector);
        if (confidence >= threshold) {
          const sourceId = Math.min(a.id, b.id);
          const targetId = Math.max(a.id, b.id);
          candidates.push({ sourceId, targetId, confidence });
        }
      }
    }

    if (targetsRealDb && options.allowRealDb !== true) {
      return result("planned", vectors.length, candidates.length, 0, threshold, true, [
        "relation discovery plan only: target is the real semantic-memory DB (set allowRealDb to write)"
      ]);
    }
    if (!gate.enabled) {
      return result("blocked", vectors.length, candidates.length, 0, threshold, targetsRealDb, [
        `relation discovery plan only: ${gate.envKey} is not armed`
      ]);
    }

    bootstrapNeonRelationsSchema(database);
    const insert = database.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, confidence)
        VALUES (?, ?, 'related', ?)
        ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET confidence = excluded.confidence`
    );
    let inserted = 0;
    for (const candidate of candidates) {
      insert.run(candidate.sourceId, candidate.targetId, candidate.confidence);
      inserted += 1;
    }

    return result("discovered", vectors.length, candidates.length, inserted, threshold, targetsRealDb, [
      `discovered ${inserted} related pair(s) above ${threshold} from ${vectors.length} embeddings`
    ]);
  } finally {
    database.close();
  }
}

function result(
  state: INeonRelationDiscoveryResult["state"],
  scanned: number,
  candidates: number,
  inserted: number,
  threshold: number,
  targetedRealMemoryDb: boolean,
  diagnostics: readonly string[]
): INeonRelationDiscoveryResult {
  return {
    state,
    scanned,
    candidates,
    inserted,
    threshold,
    safety: { targetedRealMemoryDb },
    diagnostics
  };
}

export function renderNeonRelationDiscoveryReport(result: INeonRelationDiscoveryResult): string {
  return [
    `Neon Memory Relation Discovery: ${result.state}`,
    `Scanned embeddings: ${result.scanned}  Candidates: ${result.candidates}  Inserted: ${result.inserted}`,
    `Threshold: ${result.threshold}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
