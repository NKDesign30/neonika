// Adapted from NK Design's Neon runtime tests for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  backfillNeonMemoryEmbeddings,
  bootstrapNeonMemorySchema,
  createNeonLocalEmbeddingProvider,
  type INeonEmbeddingProvider,
  type INeonMemoryDbWriteGate
} from "../src/index.js";

const armedGate: INeonMemoryDbWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};
const disabledGate: INeonMemoryDbWriteGate = {
  enabled: false,
  reason: "write-disabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

describe("neon memory embedding backfill (gated)", () => {
  let root = "";
  let dbPath = "";

  function seed(): void {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      const insert = database.prepare(
        `INSERT INTO memory_entries (source_file, content, agent, category, content_hash, importance_score)
          VALUES (?, ?, ?, ?, ?, ?)`
      );
      // All three land without a vector, exactly like a writer whose embedder was down.
      insert.run("a.md", "Robotics distribution across regions", "operator", "discoveries", "h-a", 80);
      insert.run("b.md", "Meeting capture about notarisation", "operator", "meeting", "h-b", 70);
      insert.run("c.md", "Voice session on wake word tuning", "operator", "voice-session", "h-c", 60);
    } finally {
      database.close();
    }
  }

  function countMissing(): number {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE embedding IS NULL")
        .get() as { n: number };
      return row.n;
    } finally {
      database.close();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-embed-backfill-"));
    dbPath = join(root, "semantic-memory.db");
    seed();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports the gap but writes nothing while the gate is closed", async () => {
    const result = await backfillNeonMemoryEmbeddings({
      dbPath,
      gate: disabledGate,
      embedder: createNeonLocalEmbeddingProvider()
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.missing, 3);
    assert.equal(result.embedded, 0);
    assert.equal(countMissing(), 3);
  });

  it("embeds every entry that had no vector when armed", async () => {
    const result = await backfillNeonMemoryEmbeddings({
      dbPath,
      gate: armedGate,
      embedder: createNeonLocalEmbeddingProvider()
    });
    assert.equal(result.state, "backfilled");
    assert.equal(result.missing, 3);
    assert.equal(result.embedded, 3);
    assert.equal(result.failed, 0);
    assert.equal(countMissing(), 0);
  });

  it("keeps going when one entry cannot be embedded", async () => {
    // The failure mode that used to kill whole batches: one bad entry must cost
    // exactly one entry, and it must be reported rather than silently dropped.
    const inner = createNeonLocalEmbeddingProvider();
    let calls = 0;
    const flaky: INeonEmbeddingProvider = {
      name: "flaky",
      dimensions: inner.dimensions,
      embed: async (text: string) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("embedding backend unreachable");
        }
        return inner.embed(text);
      }
    };

    const result = await backfillNeonMemoryEmbeddings({ dbPath, gate: armedGate, embedder: flaky });
    assert.equal(result.state, "backfilled");
    assert.equal(result.embedded, 2);
    assert.equal(result.failed, 1);
    assert.equal(countMissing(), 1, "the failed entry keeps its null vector for the next run");
    assert.ok(
      result.diagnostics.some((line) => line.includes("failed")),
      "expected the failure to be reported"
    );
  });

  it("is idempotent: a second run finds nothing left to do", async () => {
    await backfillNeonMemoryEmbeddings({
      dbPath,
      gate: armedGate,
      embedder: createNeonLocalEmbeddingProvider()
    });
    const second = await backfillNeonMemoryEmbeddings({
      dbPath,
      gate: armedGate,
      embedder: createNeonLocalEmbeddingProvider()
    });
    assert.equal(second.missing, 0);
    assert.equal(second.embedded, 0);
  });
});
