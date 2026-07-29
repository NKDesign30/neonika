import type { DatabaseSync } from "node:sqlite";
import { openNeonMemoryDatabase } from "./neonMemoryDbOpen.js";

import {
  NEON_OLLAMA_EMBEDDING_DIMENSIONS,
  bufferToNeonVector,
  neonCosineSimilarity
} from "./neonEmbeddingProvider.js";
import { type INeonMemoryDbWriteGate } from "./neonMemoryDbWriter.js";
import {
  findNeonMemoryMaintenanceBlock,
  resolveNeonMemoryMaintenanceAccess
} from "./memoryMaintenanceGate.js";

/**
 * Vector relation discovery for Neonika (memory autarky).
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
 *
 * A pure threshold leaves islands. It asks "is this similarity high in absolute
 * terms?", so an entry whose nearest neighbour sits at 0.7 gets no edge at all —
 * measured on the live DB, every one of the 7214 existing edges was >= 0.85 and
 * 879 embedded entries had none. `minNeighbors` adds the missing half: each entry
 * also keeps its k nearest neighbours regardless of absolute score, so isolation
 * becomes structurally impossible while the threshold still contributes the
 * strong long-range edges a fixed k would miss.
 */

// Calibrated against the live DB (1219 embeddings, 9768 sampled pairs), because
// nomic-embed-text has a high similarity floor: two entirely unrelated entries
// already sit at a median cosine of 0.798. 0.85 therefore sits near the 67th
// percentile and matched 33% of all pairs — ~403 edges per entry, a hairball in
// which an edge carries no information. 0.97 keeps the top 0.5% (~6 edges per
// entry) as genuinely strong links; the k-NN pass below guarantees the floor.
// This number is a property of the embedding model — recalibrate if it changes.
const defaultThreshold = 0.97;
// The 200-row cap predates this DB: it bounded O(n^2) against v2's ~9k archive.
// Capping by importance is exactly what stranded the low-importance tail — and
// the same trap sprang again hours later at 2000: the DB grew to 2360 entries,
// 360 were never compared, and the run still reported success. A cap that
// truncates silently looks exactly like a complete pass.
//
// So two changes. The ceiling now sits far above any realistic size (20k entries
// are ~200M pairs, a couple of minutes in a nightly job — it exists to stop a
// runaway, not to trim a working set). And when it does bite, the report says so
// instead of quietly returning fewer edges.
const defaultMaxEntries = 20_000;
const defaultMinNeighbors = 5;

export interface INeonRelationDiscoveryOptions {
  readonly dbPath: string;
  readonly gate?: INeonMemoryDbWriteGate;
  readonly dimensions?: number;
  readonly threshold?: number;
  readonly maxEntries?: number;
  /**
   * Nearest neighbours kept per entry regardless of absolute similarity. 0 turns
   * the pass off and restores pure threshold behaviour.
   */
  readonly minNeighbors?: number;
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

interface INeighbourSlot {
  readonly id: number;
  readonly confidence: number;
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
  const access = resolveNeonMemoryMaintenanceAccess(options);
  const targetsRealDb = access.targetsRealDb;
  // Clamp the threshold to [0,1]: a caller-supplied threshold <= 0 would otherwise
  // let negative cosine values land in memory_relations as "confidence".
  const threshold = Math.max(0, Math.min(1, typeof options.threshold === "number" ? options.threshold : defaultThreshold));
  const maxEntries = options.maxEntries && options.maxEntries > 0 ? Math.floor(options.maxEntries) : defaultMaxEntries;
  const minNeighbors = Math.max(
    0,
    Math.floor(typeof options.minNeighbors === "number" ? options.minNeighbors : defaultMinNeighbors)
  );
  const dimensions = options.dimensions && options.dimensions > 0 ? options.dimensions : NEON_OLLAMA_EMBEDDING_DIMENSIONS;
  const embeddingBytes = dimensions * 4;

  const database = openNeonMemoryDatabase(options.dbPath, { readOnly: !access.canWrite });
  try {
    const rows = database
      .prepare(
        `SELECT id, embedding FROM memory_entries
          WHERE embedding IS NOT NULL AND LENGTH(embedding) = ?
          ORDER BY importance_score DESC
          LIMIT ?`
      )
      .all(embeddingBytes, maxEntries) as Array<Record<string, unknown>>;

    // Wie viele hätte es gegeben? Nur so lässt sich sagen, ob der Cap gegriffen
    // hat — sonst meldet ein abgeschnittener Lauf dasselbe wie ein vollständiger.
    const eligible = readNumber(
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_entries
            WHERE embedding IS NOT NULL AND LENGTH(embedding) = ?`
        )
        .get(embeddingBytes) as Record<string, unknown>,
      "n"
    );

    const vectors: Array<{ id: number; vector: Float32Array }> = [];
    for (const row of rows) {
      const blob = row["embedding"];
      if (!(blob instanceof Uint8Array)) {
        continue;
      }
      vectors.push({ id: readNumber(row, "id"), vector: bufferToNeonVector(blob) });
    }

    const candidates: IRelationCandidate[] = [];
    const pairKeys = new Set<string>();
    // Per-entry nearest neighbours, filled during the same O(n^2) sweep so the
    // k-NN half costs no extra similarity computations.
    const nearest: Array<INeighbourSlot[]> =
      minNeighbors > 0 ? vectors.map(() => []) : [];

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
          pairKeys.add(pairKey(sourceId, targetId));
        }
        if (minNeighbors > 0) {
          offerNeighbour(nearest[i], b.id, confidence, minNeighbors);
          offerNeighbour(nearest[j], a.id, confidence, minNeighbors);
        }
      }
    }

    // Promote each entry's nearest neighbours that the threshold rejected. This
    // is what removes islands: an entry only stays edgeless if it has no peer at
    // all in the scanned set.
    let neighbourPairs = 0;
    for (let i = 0; i < nearest.length; i += 1) {
      const slot = nearest[i];
      const self = vectors[i];
      if (!slot || !self) {
        continue;
      }
      for (const neighbour of slot) {
        // Floor at zero: a non-positive cosine means orthogonal or opposed, which
        // is an absence of relation, not a weak one. The threshold path gets this
        // from its [0,1] clamp; the k-NN path needs it explicitly.
        if (neighbour.confidence <= 0) {
          continue;
        }
        const sourceId = Math.min(self.id, neighbour.id);
        const targetId = Math.max(self.id, neighbour.id);
        const key = pairKey(sourceId, targetId);
        if (pairKeys.has(key)) {
          continue;
        }
        pairKeys.add(key);
        candidates.push({ sourceId, targetId, confidence: neighbour.confidence });
        neighbourPairs += 1;
      }
    }

    const block = findNeonMemoryMaintenanceBlock(access, database, {
      labels: { plan: "relation discovery" }
    });
    if (block) {
      return result(
        block.state,
        vectors.length,
        candidates.length,
        0,
        threshold,
        targetsRealDb || block.state === "planned",
        [block.diagnostic]
      );
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
      `discovered ${inserted} related pair(s) from ${vectors.length} embeddings`,
      `${inserted - neighbourPairs} above threshold ${threshold}, ${neighbourPairs} from the ${minNeighbors}-nearest-neighbour pass`,
      ...(eligible > vectors.length
        ? [
            `WARNING: cap reached - ${vectors.length} of ${eligible} embedded entries compared, ` +
              `${eligible - vectors.length} left without edges (raise maxEntries)`
          ]
        : [])
    ]);
  } finally {
    database.close();
  }
}

function pairKey(sourceId: number, targetId: number): string {
  return `${sourceId}:${targetId}`;
}

/**
 * Keeps the slot at the `capacity` strongest neighbours seen so far, best first.
 * Called twice per pair inside the similarity sweep, so it stays allocation-free
 * on the common path (a candidate weaker than the current worst is dropped).
 */
function offerNeighbour(
  slot: INeighbourSlot[] | undefined,
  id: number,
  confidence: number,
  capacity: number
): void {
  if (!slot) {
    return;
  }
  if (slot.length >= capacity) {
    const weakest = slot[slot.length - 1];
    if (!weakest || confidence <= weakest.confidence) {
      return;
    }
    slot.pop();
  }
  let index = slot.length;
  while (index > 0) {
    const previous = slot[index - 1];
    if (!previous || previous.confidence >= confidence) {
      break;
    }
    index -= 1;
  }
  slot.splice(index, 0, { id, confidence });
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
    `Neonika Memory Relation Discovery: ${result.state}`,
    `Scanned embeddings: ${result.scanned}  Candidates: ${result.candidates}  Inserted: ${result.inserted}`,
    `Threshold: ${result.threshold}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
