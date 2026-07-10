import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  bootstrapNeonMemorySchema,
  computeNeonMemoryRetention,
  recalcNeonMemoryImportance,
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

describe("neon memory retention (pure)", () => {
  it("is 1 for a fresh entry and decays with age", () => {
    assert.equal(computeNeonMemoryRetention({ ageDays: 0, accessCount: 0 }), 1);
    // 90 days, 0 accesses, 30-day half-life => 0.5^3 = 0.125 (matches the documented curve).
    const decayed = computeNeonMemoryRetention({ ageDays: 90, accessCount: 0 });
    assert.ok(Math.abs(decayed - 0.125) < 1e-9);
  });

  it("access count slows the decay (each access doubles the half-life)", () => {
    const noAccess = computeNeonMemoryRetention({ ageDays: 90, accessCount: 0 });
    const accessed = computeNeonMemoryRetention({ ageDays: 90, accessCount: 3 });
    assert.ok(accessed > noAccess);
    // access=3 => half-life 30*8=240 => 0.5^(90/240)
    assert.ok(Math.abs(accessed - 0.5 ** (90 / 240)) < 1e-9);
  });

  it("clamps to [0,1] for extreme inputs", () => {
    assert.equal(computeNeonMemoryRetention({ ageDays: -5, accessCount: 0 }), 1);
    assert.ok(computeNeonMemoryRetention({ ageDays: 100000, accessCount: 0 }) >= 0);
  });
});

describe("neon memory importance recalc (gated)", () => {
  let root = "";
  let dbPath = "";
  const base = Date.now();
  const now = (): Date => new Date(base);

  function seed(): void {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      const insert = database.prepare(
        `INSERT INTO memory_entries (source_file, content, agent, category, content_hash, access_count, last_accessed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const old = new Date(base - 90 * 86_400_000).toISOString();
      const fresh = new Date(base).toISOString();
      insert.run("old.md", "an old never-accessed note", "neo", "discoveries", "h-old", 0, old);
      insert.run("fresh.md", "a fresh frequently-accessed note", "neo", "discoveries", "h-fresh", 10, fresh);
    } finally {
      database.close();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-importance-"));
    dbPath = join(root, "semantic-memory.db");
    seed();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plans but does not write when the gate is disabled", () => {
    const result = recalcNeonMemoryImportance({ dbPath, gate: disabledGate, now });
    assert.equal(result.state, "blocked");
    assert.equal(result.scanned, 2);
    assert.equal(result.updated, 0);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = database.prepare("SELECT DISTINCT utility_score FROM memory_entries").all() as Array<{
        utility_score: number;
      }>;
      // untouched default
      assert.ok(rows.every((row) => row.utility_score === 0.5));
    } finally {
      database.close();
    }
  });

  it("writes utility_score when armed, fading old entries and keeping fresh ones high", () => {
    const result = recalcNeonMemoryImportance({ dbPath, gate: armedGate, now });
    assert.equal(result.state, "recalculated");
    assert.equal(result.updated, 2);
    assert.ok(result.faded >= 1);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const oldRow = database
        .prepare("SELECT utility_score FROM memory_entries WHERE source_file = 'old.md'")
        .get() as { utility_score: number };
      const freshRow = database
        .prepare("SELECT utility_score FROM memory_entries WHERE source_file = 'fresh.md'")
        .get() as { utility_score: number };
      assert.ok(Math.abs(oldRow.utility_score - 0.125) < 1e-6);
      assert.ok(freshRow.utility_score > oldRow.utility_score);
    } finally {
      database.close();
    }
  });

  it("is idempotent: a second recalc yields the same utility_score", () => {
    recalcNeonMemoryImportance({ dbPath, gate: armedGate, now });
    const first = new DatabaseSync(dbPath, { readOnly: true });
    const a = (first.prepare("SELECT utility_score FROM memory_entries WHERE source_file='old.md'").get() as {
      utility_score: number;
    }).utility_score;
    first.close();

    recalcNeonMemoryImportance({ dbPath, gate: armedGate, now });
    const second = new DatabaseSync(dbPath, { readOnly: true });
    const b = (second.prepare("SELECT utility_score FROM memory_entries WHERE source_file='old.md'").get() as {
      utility_score: number;
    }).utility_score;
    second.close();

    assert.equal(a, b);
  });
});
