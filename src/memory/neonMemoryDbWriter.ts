import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import { targetsRealNeonDb } from "./neonMemoryDbProvider.js";
import {
  neonVectorToBuffer,
  type INeonEmbeddingProvider
} from "./neonEmbeddingProvider.js";

/**
 * Productive SQLite memory writer for Neon Core (memory autarky, Slice 3).
 *
 * The existing `memoryWriteRuntime.ts` writes to an isolated JSON store. This is
 * the real path: it writes the same `memory_entries` shape the canonical
 * an existing semantic-memory store uses, so Neon Core can eventually
 * own the write side that today's v2 Python cronjobs handle. It NEVER writes the
 * real DB on its own:
 *
 *   1. Two gates — `NEON_MEMORY_WRITE_ENABLED` must be armed AND an explicit
 *      `dbPath` must be passed. Default = blocked, no side effect.
 *   2. Hard guard — if `dbPath` resolves to the real semantic-memory DB the write
 *      is refused regardless of the gate, unless `allowRealDb` is explicitly set
 *      (a deliberate operator/cutover decision, not an autonomous one).
 *   3. Safety flag — the result records `targetedRealMemoryDb` so callers/tests
 *      can assert isolation.
 *
 * content_hash = sha256(`${source_file}::${content}`), matching v2/v3 dedup, with
 * `ON CONFLICT(content_hash) DO UPDATE`. All text is redacted before it is stored.
 */

const memoryWriteEnabledEnvKey = "NEON_MEMORY_WRITE_ENABLED";
const maxMemoryEntryLength = 8_000;
const defaultImportanceScore = 50;

export interface INeonMemoryDbWriteInput {
  readonly sourceFile: string;
  readonly content: string;
  readonly agent: string;
  readonly category: string;
  readonly importanceScore?: number;
  readonly entryDate?: string;
}

export interface INeonMemoryDbWriteGate {
  readonly enabled: boolean;
  readonly reason: "write-disabled" | "write-enabled";
  readonly envKey: typeof memoryWriteEnabledEnvKey;
}

export interface INeonMemoryDbWriteResult {
  readonly state: "written" | "blocked";
  readonly inserted: boolean;
  readonly updated: boolean;
  readonly entryId: number | undefined;
  readonly contentHash: string | undefined;
  readonly embedded: boolean;
  readonly dbPath: string | undefined;
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

export interface IWriteNeonMemoryDbEntryOptions {
  readonly dbPath: string;
  readonly input: INeonMemoryDbWriteInput;
  readonly gate: INeonMemoryDbWriteGate;
  readonly embedder?: INeonEmbeddingProvider;
  /** Explicit opt-in to target the real semantic-memory DB. Default false. */
  readonly allowRealDb?: boolean;
  readonly now?: () => Date;
  /**
   * Dedup semantics (memory cutover, Slice K2):
   * - "content-hash" (default): append-style upsert keyed on
   *   sha256(source_file::content). Every content revision becomes a new row -
   *   right for knowledge entries where history has value.
   * - "source-file": replace semantics - stale rows with the same source_file
   *   but a different content_hash are deleted in the same transaction before
   *   the upsert. Right for ephemeral state digests (live-index): one row per
   *   source, always the latest state. This is exactly the accumulation that
   *   polluted the v2 DB (one row per session state).
   */
  readonly dedupe?: "content-hash" | "source-file";
}

/**
 * Creates the `memory_entries` + `memory_fts` schema that mirrors the canonical
 * v2 DB closely enough for the writer + reader to round-trip: real core columns,
 * the UNIQUE content_hash dedup index, an external-content FTS5 table, and the
 * AI/AD/AU triggers that keep FTS in sync. The `community_id` foreign key to
 * `memory_communities` is intentionally dropped (that table is out of this
 * slice's scope and the writer never sets the column). `IF NOT EXISTS` makes it
 * idempotent so bootstrapping an already-seeded DB is a no-op.
 */
export function bootstrapNeonMemorySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      content TEXT NOT NULL,
      entry_date TEXT,
      agent TEXT NOT NULL,
      category TEXT NOT NULL,
      embedding BLOB,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      importance_score REAL NOT NULL DEFAULT 50.0,
      valid_until TEXT,
      community_id INTEGER,
      utility_score REAL DEFAULT 0.5
    );
    CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);
    CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_entries(source_file);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_content_hash ON memory_entries(content_hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      agent,
      category,
      content='memory_entries',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, content, agent, category)
      VALUES (new.id, new.content, new.agent, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, agent, category)
      VALUES ('delete', old.id, old.content, old.agent, old.category);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, agent, category)
      VALUES ('delete', old.id, old.content, old.agent, old.category);
      INSERT INTO memory_fts(rowid, content, agent, category)
      VALUES (new.id, new.content, new.agent, new.category);
    END;
  `);
}

export function resolveNeonMemoryDbWriteGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonMemoryDbWriteGate {
  // Single source for gate-env parsing: `readReadyCutoverEnv` (ready|true|1|yes).
  // Previously this module parsed the SAME env key with a diverging value set
  // ("on" instead of "yes") than memoryWriteRuntime - one key, one semantics.
  const enabled = readReadyCutoverEnv(env, memoryWriteEnabledEnvKey);
  return {
    enabled,
    reason: enabled ? "write-enabled" : "write-disabled",
    envKey: memoryWriteEnabledEnvKey
  };
}

export function computeNeonContentHash(sourceFile: string, content: string): string {
  return createHash("sha256").update(`${sourceFile}::${content}`).digest("hex");
}

function blocked(
  diagnostics: readonly string[],
  targetedRealMemoryDb: boolean
): INeonMemoryDbWriteResult {
  return {
    state: "blocked",
    inserted: false,
    updated: false,
    entryId: undefined,
    contentHash: undefined,
    embedded: false,
    dbPath: undefined,
    safety: { targetedRealMemoryDb },
    diagnostics
  };
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${truncateUtf16Safe(text, maxLength - 1)}…`;
}

/**
 * Writes one redacted entry into the target memory DB (content_hash dedup upsert),
 * but only when both gates are satisfied and the target is not the real DB. With an
 * `embedder`, a vector is generated and stored as a BLOB so the new row is also
 * reachable by the hybrid search; without one the row is FTS-only. Embedding failure
 * is non-fatal — the row is still written, just without a vector.
 */
export async function writeNeonMemoryDbEntry(
  options: IWriteNeonMemoryDbEntryOptions
): Promise<INeonMemoryDbWriteResult> {
  const targetsRealDb = targetsRealNeonDb(options.dbPath);

  if (targetsRealDb && options.allowRealDb !== true) {
    return blocked(
      ["productive memory-write refused: target is the real semantic-memory DB (set allowRealDb to override)"],
      true
    );
  }
  if (!options.gate.enabled) {
    return blocked(
      [`productive memory-write blocked: ${options.gate.envKey} is not armed`],
      targetsRealDb
    );
  }

  const content = truncate(redactText(options.input.content.replace(/\s+/g, " ").trim()), maxMemoryEntryLength);
  if (content.length === 0) {
    return blocked(["memory-write blocked: empty content"], targetsRealDb);
  }

  const sourceFile = redactText(options.input.sourceFile.trim()) || "neon-core:unsourced";
  const agent = redactText(options.input.agent.trim()) || "neo";
  const category = redactText(options.input.category.trim()) || "discoveries";
  const importanceScore =
    typeof options.input.importanceScore === "number" && Number.isFinite(options.input.importanceScore)
      ? options.input.importanceScore
      : defaultImportanceScore;
  const entryDate = options.input.entryDate ?? null;
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const contentHash = computeNeonContentHash(sourceFile, content);

  const diagnostics: string[] = [];
  let embeddingBlob: Uint8Array | null = null;
  if (options.embedder) {
    try {
      const vector = await options.embedder.embed(content);
      embeddingBlob = neonVectorToBuffer(vector);
    } catch (error) {
      const reason = error instanceof Error ? redactText(error.message) : "unknown error";
      diagnostics.push(`embedding skipped (row written FTS-only): ${reason}`);
    }
  }

  const database = new DatabaseSync(options.dbPath);
  try {
    bootstrapNeonMemorySchema(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      // Replace semantics: drop stale states of the same source before the
      // upsert. The FTS delete-trigger keeps the index consistent. Doing this
      // inside the same transaction also resolves the A->B->A hash-collision
      // case (the stale A row is gone before hash(A) is re-inserted).
      let replacedRows = 0;
      if (options.dedupe === "source-file") {
        const replaced = database
          .prepare("DELETE FROM memory_entries WHERE source_file = ? AND content_hash <> ?")
          .run(sourceFile, contentHash);
        replacedRows = Number(replaced.changes);
      }

      // Determine insert-vs-update deterministically before the upsert: a created_at
      // vs updated_at comparison breaks when a test injects a fixed `now()` (both
      // timestamps equal). A content_hash pre-check is exact regardless of clock.
      const priorRow = database
        .prepare("SELECT id FROM memory_entries WHERE content_hash = ?")
        .get(contentHash) as { id?: number } | undefined;
      const wasExisting = typeof priorRow?.id === "number";

      const row = database
        .prepare(
          `INSERT INTO memory_entries (
              source_file, content, entry_date, agent, category, embedding,
              content_hash, importance_score, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(content_hash) DO UPDATE SET
              content = excluded.content,
              entry_date = excluded.entry_date,
              agent = excluded.agent,
              category = excluded.category,
              embedding = excluded.embedding,
              importance_score = excluded.importance_score,
              updated_at = excluded.updated_at
            RETURNING id`
        )
        .get(
          sourceFile,
          content,
          entryDate,
          agent,
          category,
          embeddingBlob,
          contentHash,
          importanceScore,
          timestamp,
          timestamp
        ) as { id?: number } | undefined;

      database.exec("COMMIT");

      const entryId = typeof row?.id === "number" ? row.id : undefined;
      const inserted = !wasExisting;

      return {
        state: "written",
        inserted,
        updated: !inserted,
        entryId,
        contentHash,
        embedded: embeddingBlob !== null,
        dbPath: options.dbPath,
        safety: { targetedRealMemoryDb: targetsRealDb },
        diagnostics: [
          inserted ? "memory entry inserted" : "memory entry updated (content_hash conflict)",
          ...(replacedRows > 0 ? [`replaced ${replacedRows} stale state(s) of the same source`] : []),
          ...diagnostics
        ]
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function renderNeonMemoryDbWriteReport(result: INeonMemoryDbWriteResult): string {
  return [
    `Neon Memory DB Write: ${result.state}`,
    `Inserted: ${result.inserted}  Updated: ${result.updated}  Embedded: ${result.embedded}`,
    `Entry id: ${result.entryId ?? "none"}`,
    `Content hash: ${result.contentHash ?? "none"}`,
    `DB: ${result.dbPath ?? "none (gated)"}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
