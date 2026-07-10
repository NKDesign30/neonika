import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  NEON_MEMORY_DB_PATH_ENV,
  createDefaultNeonMemoryProvider,
  createNeonLocalEmbeddingProvider,
  defaultNeonMemoryDbPath,
  recallNeonMemory,
  resolveNeonMemoryRecallDbPath,
  writeNeonMemoryDbEntry,
  type INeonEmbeddingProvider,
  type INeonMemoryDbWriteGate
} from "../src/index.js";

const armedGate: INeonMemoryDbWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

describe("neon memory recall seam", () => {
  let root = "";
  let primaryDbPath = "";
  let archiveDbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-recall-"));
    primaryDbPath = join(root, "primary-semantic-memory.db");
    archiveDbPath = join(root, "archive-semantic-memory.db");

    await writeNeonMemoryDbEntry({
      dbPath: primaryDbPath,
      gate: armedGate,
      input: {
        sourceFile: "destillat/01-decisions.md",
        content: "Neon Cutover Entscheidung: die neue Memory-DB ist die primäre Heimat.",
        agent: "neo",
        category: "destillat"
      }
    });
    await writeNeonMemoryDbEntry({
      dbPath: archiveDbPath,
      gate: armedGate,
      input: {
        sourceFile: "learnings/2026-04-01.md",
        content: "Altes Cutover Learning aus dem v2 Archiv über die Memory-Pipeline.",
        agent: "neo",
        category: "learnings"
      }
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the recall db path from the env with the v2 default as fallback", () => {
    assert.equal(resolveNeonMemoryRecallDbPath({}), defaultNeonMemoryDbPath);
    assert.equal(
      resolveNeonMemoryRecallDbPath({ [NEON_MEMORY_DB_PATH_ENV]: "/tmp/x.db" }),
      "/tmp/x.db"
    );
    assert.equal(resolveNeonMemoryRecallDbPath({ [NEON_MEMORY_DB_PATH_ENV]: "  " }), defaultNeonMemoryDbPath);
  });

  it("merges primary and archive hits with origins, primary first", async () => {
    const recall = await recallNeonMemory("Cutover", { primaryDbPath, archiveDbPath, limit: 5 });

    assert.equal(recall.mode, "fts");
    assert.equal(recall.primaryHits, 1);
    assert.equal(recall.archiveHits, 1);
    assert.equal(recall.results.length, 2);
    assert.equal(recall.results[0]?.origin, "primary");
    assert.match(recall.results[0]?.entry.content ?? "", /neue Memory-DB/);
    assert.equal(recall.results[1]?.origin, "archive");
    assert.match(recall.results[1]?.entry.content ?? "", /v2 Archiv/);
  });

  it("tracks access on primary hits only and reports it", async () => {
    const recall = await recallNeonMemory("Cutover", {
      primaryDbPath,
      archiveDbPath,
      trackingGate: armedGate,
      now: () => new Date("2026-07-07T11:00:00.000Z")
    });

    assert.equal(recall.accessTracking?.state, "tracked");
    assert.equal(recall.accessTracking?.updatedRows, 1);

    const database = new DatabaseSync(primaryDbPath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT access_count, last_accessed_at FROM memory_entries")
        .get() as { access_count: number; last_accessed_at: string | null };
      assert.equal(row.access_count, 1);
      assert.equal(row.last_accessed_at, "2026-07-07T11:00:00.000Z");
    } finally {
      database.close();
    }
  });

  it("runs hybrid mode on the primary with an embedder (the production mode)", async () => {
    const embedder = createNeonLocalEmbeddingProvider();
    // Seed the primary with an embedding so the vector half has data.
    await writeNeonMemoryDbEntry({
      dbPath: primaryDbPath,
      gate: armedGate,
      embedder,
      input: {
        sourceFile: "destillat/02-voice.md",
        content: "Voice-Stack Entscheidung mit Embedding für die Hybrid-Suche.",
        agent: "neo",
        category: "destillat"
      }
    });

    const recall = await recallNeonMemory("Hybrid Suche Voice", {
      primaryDbPath,
      archiveDbPath,
      embedder
    });

    assert.equal(recall.mode, "hybrid");
    assert.ok(recall.primaryHits >= 1);
    assert.ok(recall.results.every((hit) => hit.origin === "primary" || hit.origin === "archive"));
  });

  it("degrades to fts-fallback when embedding fails, archive still merged", async () => {
    const brokenEmbedder: INeonEmbeddingProvider = {
      name: "broken-test-embedder",
      dimensions: 768,
      embed: async () => {
        throw new Error("embedder down");
      }
    };

    const recall = await recallNeonMemory("Cutover", {
      primaryDbPath,
      archiveDbPath,
      embedder: brokenEmbedder
    });

    assert.equal(recall.mode, "fts-fallback");
    assert.equal(recall.primaryHits, 1);
    assert.equal(recall.archiveHits, 1);
    assert.ok(recall.diagnostics.some((line) => line.includes("degraded to FTS")));
  });

  it("realpath-dedupes a dot-segment variant of the primary as archive", async () => {
    // Raw string on purpose: path.join would normalize the "." away.
    const dotVariant = `${root}/./primary-semantic-memory.db`;
    const recall = await recallNeonMemory("Cutover", {
      primaryDbPath,
      archiveDbPath: dotVariant
    });

    assert.equal(recall.primaryHits, 1);
    assert.equal(recall.archiveHits, 0);
  });

  it("skips a missing archive without breaking recall", async () => {
    const recall = await recallNeonMemory("Cutover", {
      primaryDbPath,
      archiveDbPath: join(root, "does-not-exist.db")
    });

    assert.equal(recall.primaryHits, 1);
    assert.equal(recall.archiveHits, 0);
  });

  it("ignores the archive when it equals the primary (post-cutover state)", async () => {
    const recall = await recallNeonMemory("Cutover", {
      primaryDbPath,
      archiveDbPath: primaryDbPath
    });

    assert.equal(recall.primaryHits, 1);
    assert.equal(recall.archiveHits, 0);
  });

  it("default provider honours NEON_MEMORY_DB_PATH and merges the archive", async () => {
    // env points at the primary test DB; the "archive" here is the real
    // defaultNeonMemoryDbPath which exists on this machine - so we only assert
    // the primary hit is present and first.
    const provider = createDefaultNeonMemoryProvider({ env: { NEON_MEMORY_DB_PATH: primaryDbPath } });
    const result = await provider.search("Cutover Entscheidung primäre Heimat", { maxHits: 5 });

    assert.ok(result.hits.length >= 1);
    assert.match(result.hits[0]?.text ?? "", /neue Memory-DB/);
  });
});
