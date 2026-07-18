import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  defaultNeonMemoryDbPath,
  bootstrapNeonMemorySchema,
  pruneNeonMemory,
  targetsRealNeonDb,
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

describe("neon memory prune (gated, archive-not-delete)", () => {
  let root = "";
  let dbPath = "";

  function seed(): void {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      const insert = database.prepare(
        `INSERT INTO memory_entries (source_file, content, agent, category, content_hash, importance_score, access_count)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      // noise: low score, never accessed -> prune candidate
      insert.run("noise.md", "low value never recalled", "neo", "discoveries", "h-noise", 20, 0);
      // valuable: high score -> keep
      insert.run("gold.md", "high value note", "neo", "discoveries", "h-gold", 80, 0);
      // low score but recalled -> keep (access_count > 0)
      insert.run("used.md", "low score but recalled often", "neo", "discoveries", "h-used", 20, 5);
    } finally {
      database.close();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-prune-"));
    dbPath = join(root, "semantic-memory.db");
    seed();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plans but does not prune when the gate is disabled", () => {
    const result = pruneNeonMemory({ dbPath, gate: disabledGate, maxScore: 35 });
    assert.equal(result.state, "blocked");
    assert.equal(result.scanned, 3);
    assert.equal(result.candidates, 1);
    assert.equal(result.archived, 0);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = database.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
      assert.equal(count.n, 3); // nothing removed
    } finally {
      database.close();
    }
  });

  it("archives noise and removes it from memory_entries when armed", () => {
    const result = pruneNeonMemory({ dbPath, gate: armedGate, maxScore: 35 });
    assert.equal(result.state, "pruned");
    assert.equal(result.archived, 1);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const remaining = database
        .prepare("SELECT source_file FROM memory_entries ORDER BY source_file")
        .all() as Array<{ source_file: string }>;
      const names = remaining.map((row) => row.source_file);
      assert.deepEqual(names, ["gold.md", "used.md"]); // noise gone, gold + used kept
      // noise is repairable from the archive.
      const archived = database
        .prepare("SELECT source_file, content, archive_reason FROM memory_archive")
        .all() as Array<{ source_file: string; content: string; archive_reason: string }>;
      assert.equal(archived.length, 1);
      assert.equal(archived[0]?.source_file, "noise.md");
      assert.match(archived[0]?.archive_reason ?? "", /prune:/);
    } finally {
      database.close();
    }
  });

  it("archives every restorable column (full reversibility, not just a subset)", () => {
    const database = new DatabaseSync(dbPath);
    try {
      // Give the noise row the full column set a real entry would have.
      database.exec(
        `UPDATE memory_entries SET created_at='2026-01-01T00:00:00Z', updated_at='2026-02-01T00:00:00Z',
           last_accessed_at='2026-03-01T00:00:00Z', valid_until='2026-12-31T00:00:00Z',
           community_id=7, utility_score=0.42 WHERE source_file='noise.md'`
      );
    } finally {
      database.close();
    }
    pruneNeonMemory({ dbPath, gate: armedGate, maxScore: 35 });
    const readback = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = readback
        .prepare(
          `SELECT created_at, updated_at, last_accessed_at, valid_until, community_id, utility_score
            FROM memory_archive WHERE source_file='noise.md'`
        )
        .get() as Record<string, unknown>;
      assert.equal(row["created_at"], "2026-01-01T00:00:00Z");
      assert.equal(row["updated_at"], "2026-02-01T00:00:00Z");
      assert.equal(row["last_accessed_at"], "2026-03-01T00:00:00Z");
      assert.equal(row["valid_until"], "2026-12-31T00:00:00Z");
      assert.equal(row["community_id"], 7);
      assert.equal(row["utility_score"], 0.42);
    } finally {
      readback.close();
    }
  });

  it("targetsRealNeonDb resolves path aliases (guard cannot be bypassed by ./ or test paths)", () => {
    // A plain test path is never the real DB.
    assert.equal(targetsRealNeonDb(dbPath), false);
    // An unnormalized alias of the canonical path still resolves to the real DB.
    const real = defaultNeonMemoryDbPath;
    const alias = real.replace("/semantic", "/./semantic");
    assert.notEqual(alias, real); // differs as a string
    assert.equal(targetsRealNeonDb(alias), true); // but the guard sees through it
  });

  it("keeps FTS consistent after the archive move (pruned row not searchable)", () => {
    pruneNeonMemory({ dbPath, gate: armedGate, maxScore: 35 });
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // The memory_ad trigger should have removed the noise row from the FTS index.
      const ftsHit = database
        .prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'value'")
        .get() as { n: number };
      // 'value' matches gold ("high value") but not the archived noise row.
      assert.ok(ftsHit.n >= 1);
      const noiseHit = database
        .prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'recalled'")
        .get() as { n: number };
      // 'recalled' appeared in noise.md (archived) and used.md (kept) -> only used.md remains.
      assert.equal(noiseHit.n, 1);
    } finally {
      database.close();
    }
  });
});
