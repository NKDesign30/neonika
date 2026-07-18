import { DatabaseSync } from "node:sqlite";

import { targetsRealNeonDb } from "./neonMemoryDbProvider.js";
import {
  resolveNeonMemoryDbWriteGate,
  type INeonMemoryDbWriteGate
} from "./neonMemoryDbWriter.js";

/**
 * Memory noise pruning for Neonika (memory autarky).
 *
 * Mirrors v2's `POST /api/memory/prune`: low-value, never-recalled entries are
 * removed from the hot `memory_entries` table. Crucially it does NOT hard-delete —
 * the project rule is "never delete data that can be repaired". Candidates are
 * copied into a `memory_archive` table first (with archived_at + reason), then
 * removed from `memory_entries`, inside one transaction. The archive is the repair
 * path: every archived entry can be restored. The prune criterion is deliberately
 * conservative: `importance_score <= maxScore` AND `access_count = 0` (unimportant
 * and never recalled). Same two gates as the writer; the real DB is plan-only
 * unless `allowRealDb` is set, and the scan/plan always runs.
 */

const defaultMaxScore = 35;

export interface INeonPruneOptions {
  readonly dbPath: string;
  readonly gate?: INeonMemoryDbWriteGate;
  readonly maxScore?: number;
  readonly allowRealDb?: boolean;
  readonly reason?: string;
  readonly now?: () => Date;
}

export interface INeonPruneResult {
  readonly state: "pruned" | "planned" | "blocked";
  readonly scanned: number;
  readonly candidates: number;
  readonly archived: number;
  readonly maxScore: number;
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

/**
 * Creates the `memory_archive` table that holds pruned entries for repair. Mirrors
 * the core `memory_entries` columns plus archive metadata. Idempotent.
 */
export function bootstrapNeonArchiveSchema(database: DatabaseSync): void {
  // Carries every restorable column from memory_entries (16 source columns) plus
  // archive metadata, so a pruned entry can be fully restored — created_at,
  // updated_at, last_accessed_at, valid_until, community_id and utility_score are
  // NOT dropped. "archive-not-delete" only holds if the archive is complete.
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_archive (
      id INTEGER PRIMARY KEY,
      source_file TEXT NOT NULL,
      content TEXT NOT NULL,
      entry_date TEXT,
      agent TEXT NOT NULL,
      category TEXT NOT NULL,
      embedding BLOB,
      content_hash TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      importance_score REAL NOT NULL DEFAULT 50.0,
      valid_until TEXT,
      community_id INTEGER,
      utility_score REAL,
      archived_at TEXT NOT NULL,
      archive_reason TEXT NOT NULL
    );
  `);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Archives then removes low-value, never-recalled entries. When gated, returns the
 * plan (scanned/candidates) without touching either table.
 */
export function pruneNeonMemory(options: INeonPruneOptions): INeonPruneResult {
  const gate = options.gate ?? resolveNeonMemoryDbWriteGate(process.env);
  const targetsRealDb = targetsRealNeonDb(options.dbPath);
  const maxScore = typeof options.maxScore === "number" ? options.maxScore : defaultMaxScore;
  const reason = options.reason ?? `prune:importance<=${maxScore}&access=0`;
  const archivedAt = (options.now?.() ?? new Date()).toISOString();

  const canWrite = gate.enabled && (!targetsRealDb || options.allowRealDb === true);
  const database = new DatabaseSync(options.dbPath, { readOnly: !canWrite });
  try {
    const scanned = readNumber(
      (database.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n?: number }).n
    );
    const candidateRows = database
      .prepare(
        `SELECT id FROM memory_entries WHERE importance_score <= ? AND access_count = 0`
      )
      .all(maxScore) as Array<Record<string, unknown>>;
    const candidates = candidateRows.length;

    if (targetsRealDb && options.allowRealDb !== true) {
      return result("planned", scanned, candidates, 0, maxScore, true, [
        `prune plan only: target is the real semantic-memory DB (set allowRealDb to archive)`
      ]);
    }
    if (!gate.enabled) {
      return result("blocked", scanned, candidates, 0, maxScore, targetsRealDb, [
        `prune plan only: ${gate.envKey} is not armed`
      ]);
    }

    bootstrapNeonArchiveSchema(database);

    let archived = 0;
    database.exec("BEGIN");
    try {
      const copy = database.prepare(
        `INSERT OR REPLACE INTO memory_archive (
            id, source_file, content, entry_date, agent, category, embedding,
            content_hash, created_at, updated_at, access_count, last_accessed_at,
            importance_score, valid_until, community_id, utility_score,
            archived_at, archive_reason
          )
          SELECT id, source_file, content, entry_date, agent, category, embedding,
            content_hash, created_at, updated_at, access_count, last_accessed_at,
            importance_score, valid_until, community_id, utility_score, ?, ?
          FROM memory_entries WHERE id = ?`
      );
      const remove = database.prepare("DELETE FROM memory_entries WHERE id = ?");
      for (const row of candidateRows) {
        const id = readNumber(row["id"]);
        copy.run(archivedAt, reason, id);
        remove.run(id);
        archived += 1;
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return result("pruned", scanned, candidates, archived, maxScore, targetsRealDb, [
      `archived + removed ${archived} low-value entr${archived === 1 ? "y" : "ies"} (repairable from memory_archive)`
    ]);
  } finally {
    database.close();
  }
}

function result(
  state: INeonPruneResult["state"],
  scanned: number,
  candidates: number,
  archived: number,
  maxScore: number,
  targetedRealMemoryDb: boolean,
  diagnostics: readonly string[]
): INeonPruneResult {
  return {
    state,
    scanned,
    candidates,
    archived,
    maxScore,
    safety: { targetedRealMemoryDb },
    diagnostics
  };
}

export function renderNeonPruneReport(result: INeonPruneResult): string {
  return [
    `Neonika Memory Prune: ${result.state}`,
    `Scanned: ${result.scanned}  Candidates: ${result.candidates}  Archived: ${result.archived}`,
    `Max score: ${result.maxScore}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
