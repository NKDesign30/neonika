import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  bootstrapNeonMemorySchema,
  discoverNeonMemoryRelations,
  embedNeonLocalText,
  neonVectorToBuffer,
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

const DIMS = 384; // local embedder dimension

describe("neon memory relation discovery (gated)", () => {
  let root = "";
  let dbPath = "";

  function seed(): void {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      const insert = database.prepare(
        `INSERT INTO memory_entries (source_file, content, agent, category, content_hash, embedding, importance_score)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      // Two near-identical texts (high cosine) + one unrelated.
      const rows = [
        { src: "a.md", text: "fleet telemetry ingestion across DACH markets", imp: 80 },
        { src: "b.md", text: "fleet telemetry ingestion in DACH territory", imp: 75 },
        { src: "c.md", text: "Pokemon battle statistics from the PokeAPI endpoint", imp: 60 }
      ];
      for (const row of rows) {
        const vector = embedNeonLocalText(row.text, DIMS);
        insert.run(row.src, row.text, "neo", "discoveries", `h-${row.src}`, neonVectorToBuffer(vector), row.imp);
      }
    } finally {
      database.close();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-relations-"));
    dbPath = join(root, "semantic-memory.db");
    seed();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plans but does not write when the gate is disabled", () => {
    const result = discoverNeonMemoryRelations({ dbPath, gate: disabledGate, dimensions: DIMS, threshold: 0.5 });
    assert.equal(result.state, "blocked");
    assert.equal(result.scanned, 3);
    assert.equal(result.inserted, 0);
    // No relations table written.
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_relations'")
        .get();
      assert.equal(table, undefined);
    } finally {
      database.close();
    }
  });

  it("discovers related pairs above the threshold when armed", () => {
    // minNeighbors: 0 isolates the pure threshold behaviour this test asserts.
    const result = discoverNeonMemoryRelations({
      dbPath,
      gate: armedGate,
      dimensions: DIMS,
      threshold: 0.5,
      minNeighbors: 0
    });
    assert.equal(result.state, "discovered");
    assert.ok(result.inserted >= 1);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rel = database
        .prepare("SELECT source_id, target_id, relation_type, confidence FROM memory_relations")
        .all() as Array<{ source_id: number; target_id: number; relation_type: string; confidence: number }>;
      assert.ok(rel.length >= 1);
      // a.md (1) and b.md (2) are the near-identical pair.
      assert.ok(rel.some((row) => row.source_id === 1 && row.target_id === 2));
      assert.ok(rel.every((row) => row.relation_type === "related"));
      assert.ok(rel.every((row) => row.confidence >= 0.5 && row.confidence <= 1));
      assert.ok(rel.every((row) => row.source_id < row.target_id));
    } finally {
      database.close();
    }
  });

  it("leaves entries islanded when only the threshold runs", () => {
    // 0.99 is above even the near-identical pair, so nothing qualifies.
    const result = discoverNeonMemoryRelations({
      dbPath,
      gate: armedGate,
      dimensions: DIMS,
      threshold: 0.99,
      minNeighbors: 0
    });
    assert.equal(result.state, "discovered");
    assert.equal(result.inserted, 0);
  });

  it("gives every entry an edge via the nearest-neighbour pass", () => {
    // Same unreachable threshold: every edge below must come from the k-NN pass.
    const result = discoverNeonMemoryRelations({
      dbPath,
      gate: armedGate,
      dimensions: DIMS,
      threshold: 0.99,
      minNeighbors: 2
    });
    assert.equal(result.state, "discovered");
    assert.ok(result.inserted >= 1);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rel = database
        .prepare("SELECT source_id, target_id, confidence FROM memory_relations")
        .all() as Array<{ source_id: number; target_id: number; confidence: number }>;
      // The unrelated entry (c.md, id 3) is the island the threshold never reaches.
      assert.ok(rel.some((row) => row.source_id === 3 || row.target_id === 3));
      // Weak edges are allowed, meaningless ones are not.
      assert.ok(rel.every((row) => row.confidence > 0 && row.confidence <= 1));
      assert.ok(rel.every((row) => row.source_id < row.target_id));
    } finally {
      database.close();
    }
  });

  it("is idempotent via the unique index (re-run updates, no duplicates)", () => {
    discoverNeonMemoryRelations({ dbPath, gate: armedGate, dimensions: DIMS, threshold: 0.5 });
    discoverNeonMemoryRelations({ dbPath, gate: armedGate, dimensions: DIMS, threshold: 0.5 });
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = database
        .prepare("SELECT COUNT(*) AS n FROM memory_relations WHERE source_id=1 AND target_id=2")
        .get() as { n: number };
      assert.equal(count.n, 1);
    } finally {
      database.close();
    }
  });

  it("says so when the entry cap truncates the sweep", () => {
    // Zweimal dieselbe Falle: erst strandete ein 200er-Cap den Tail, dann wuchs
    // die DB über den 2000er hinaus — und beide Male meldete der Lauf Erfolg,
    // weil ein stilles LIMIT von aussen wie ein vollständiger Durchgang aussieht.
    const truncated = discoverNeonMemoryRelations({
      dbPath,
      gate: armedGate,
      dimensions: DIMS,
      maxEntries: 2
    });
    assert.ok(
      truncated.diagnostics.some((line) => line.includes("cap reached")),
      "a truncated sweep must not report like a complete one"
    );

    const complete = discoverNeonMemoryRelations({
      dbPath,
      gate: armedGate,
      dimensions: DIMS
    });
    assert.equal(
      complete.diagnostics.some((line) => line.includes("cap reached")),
      false,
      "a complete sweep must stay quiet"
    );
  });
});
