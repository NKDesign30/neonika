// Adapted from NK Design's Neon runtime for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { neonVectorToBuffer, type INeonEmbeddingProvider } from "./neonEmbeddingProvider.js";
import { openNeonMemoryDatabase } from "./neonMemoryDbOpen.js";
import { type INeonMemoryDbWriteGate } from "./neonMemoryDbWriter.js";
import {
  findNeonMemoryMaintenanceBlock,
  resolveNeonMemoryMaintenanceAccess
} from "./memoryMaintenanceGate.js";
import { redactText } from "../harness/redaction.js";

/**
 * Backfills embeddings for entries that never got one.
 *
 * The writer deliberately keeps a row when embedding fails ("row written
 * FTS-only") — losing the entry would be worse than losing its vector. But
 * nothing ever came back for it, so a moment of Ollama being down left an entry
 * permanently invisible to semantic recall *and* to relation discovery, which
 * only considers rows that have a vector. Measured on the live DB: 19 entries,
 * among them NeoQuill meeting notes and voice sessions.
 *
 * Runs as part of memory maintenance, before relation discovery, so an entry
 * repaired here is linked up in the same pass. Same two gates as every other
 * mutating memory pass; the scan/plan always runs.
 */

const defaultLimit = 500;

export interface INeonEmbeddingBackfillOptions {
  readonly dbPath: string;
  readonly embedder: INeonEmbeddingProvider;
  readonly gate?: INeonMemoryDbWriteGate;
  readonly limit?: number;
  readonly allowRealDb?: boolean;
}

export interface INeonEmbeddingBackfillResult {
  readonly state: "backfilled" | "planned" | "blocked";
  readonly missing: number;
  readonly embedded: number;
  readonly failed: number;
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

export async function backfillNeonMemoryEmbeddings(
  options: INeonEmbeddingBackfillOptions
): Promise<INeonEmbeddingBackfillResult> {
  const access = resolveNeonMemoryMaintenanceAccess(options);
  const targetsRealDb = access.targetsRealDb;
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : defaultLimit;

  const database = openNeonMemoryDatabase(options.dbPath, { readOnly: !access.canWrite });
  try {
    const rows = database
      .prepare(
        `SELECT id, content FROM memory_entries
          WHERE embedding IS NULL AND content IS NOT NULL AND LENGTH(content) > 0
          ORDER BY importance_score DESC
          LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    const missing = rows.length;

    const block = findNeonMemoryMaintenanceBlock(access, database, {
      labels: { plan: "embedding backfill" }
    });
    if (block) {
      return plan(block.state, missing, targetsRealDb || block.state === "planned", [
        block.diagnostic
      ]);
    }

    const update = database.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?");
    const failures: string[] = [];
    let embedded = 0;
    for (const row of rows) {
      const id = row["id"];
      const content = row["content"];
      if (typeof id !== "number" || typeof content !== "string") {
        continue;
      }
      // Per entry, so one unembeddable row cannot abort the batch — the same
      // failure mode that used to take the live indexer down with it.
      try {
        const vector = await options.embedder.embed(content);
        update.run(neonVectorToBuffer(vector), id);
        embedded += 1;
      } catch (error) {
        failures.push(redactText(error instanceof Error ? error.message : String(error)));
      }
    }

    const diagnostics = [
      `embedded ${embedded} of ${missing} entr${missing === 1 ? "y" : "ies"} that had no vector`
    ];
    if (failures.length > 0) {
      diagnostics.push(`${failures.length} failed: ${failures.slice(0, 3).join("; ")}`);
    }
    return {
      state: "backfilled",
      missing,
      embedded,
      failed: failures.length,
      safety: { targetedRealMemoryDb: targetsRealDb },
      diagnostics
    };
  } finally {
    database.close();
  }
}

function plan(
  state: "planned" | "blocked",
  missing: number,
  targetedRealMemoryDb: boolean,
  diagnostics: readonly string[]
): INeonEmbeddingBackfillResult {
  return {
    state,
    missing,
    embedded: 0,
    failed: 0,
    safety: { targetedRealMemoryDb },
    diagnostics
  };
}

export function renderNeonEmbeddingBackfillReport(result: INeonEmbeddingBackfillResult): string {
  return [
    `Neon Memory Embedding Backfill: ${result.state}`,
    `Missing: ${result.missing}  Embedded: ${result.embedded}  Failed: ${result.failed}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
