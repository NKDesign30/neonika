import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildNeonFtsMatchExpression,
  createNeonMemoryDbProvider,
  searchNeonMemoryDb
} from "../src/index.js";

interface ISeedRow {
  readonly source: string;
  readonly content: string;
  readonly agent: string;
  readonly category: string;
  readonly importance: number;
}

const seedRows: readonly ISeedRow[] = [
  {
    source: "a.md",
    content: "Neon runtime cutover plan with Chaty and Operator",
    agent: "chaty",
    category: "discoveries",
    importance: 80
  },
  {
    source: "b.md",
    content: "Pokemon website built from the PokeAPI",
    agent: "neo",
    category: "projects",
    importance: 60
  },
  {
    source: "c.md",
    content: "Neon memory autarky via node:sqlite",
    agent: "chaty",
    category: "patterns",
    importance: 70
  }
];

function seedDatabase(dbPath: string): void {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        category TEXT NOT NULL,
        importance_score REAL NOT NULL DEFAULT 50.0
      );
      CREATE VIRTUAL TABLE memory_fts USING fts5(content, agent, category);
      CREATE TRIGGER memory_ai AFTER INSERT ON memory_entries BEGIN
        INSERT INTO memory_fts(rowid, content, agent, category)
        VALUES (new.id, new.content, new.agent, new.category);
      END;
    `);
    const insert = database.prepare(
      "INSERT INTO memory_entries (source_file, content, agent, category, importance_score) VALUES (?, ?, ?, ?, ?)"
    );
    for (const row of seedRows) {
      insert.run(row.source, row.content, row.agent, row.category, row.importance);
    }
  } finally {
    database.close();
  }
}

describe("neon memory db provider", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-memory-db-"));
    dbPath = join(root, "semantic-memory.db");
    seedDatabase(dbPath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a quoted OR-joined FTS match expression", () => {
    assert.equal(buildNeonFtsMatchExpression("shadow gateway"), '"shadow" OR "gateway"');
    assert.equal(buildNeonFtsMatchExpression("  pokeapi-stats  "), '"pokeapi-stats"');
    assert.equal(buildNeonFtsMatchExpression("   "), "");
  });

  it("returns bm25-ranked rows for a matching query", () => {
    const rows = searchNeonMemoryDb("Neon", { dbPath });
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((row) => typeof row.score === "number" && row.score >= 0));
    assert.ok(rows.every((row) => row.content.length > 0));
    // sqlite bm25 ranks are negative (best is most negative) and `ORDER BY rank`
    // is ascending (best first), so score = abs(rank) is non-increasing.
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      assert.ok(previous && current && previous.score >= current.score);
    }
  });

  it("filters by agent", () => {
    const rows = searchNeonMemoryDb("Neon", { dbPath, agent: "chaty" });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.agent === "chaty"));
  });

  it("honours the limit and caps the result set", () => {
    const rows = searchNeonMemoryDb("Neon", { dbPath, limit: 1 });
    assert.equal(rows.length, 1);
  });

  it("returns an empty array for a blank query without touching the DB", () => {
    assert.deepEqual(searchNeonMemoryDb("   ", { dbPath }), []);
  });

  it("exposes the provider contract with redacted hits", async () => {
    const provider = createNeonMemoryDbProvider({ dbPath });
    const result = await provider.search("Pokemon", { maxHits: 5 });
    assert.equal(result.query, "Pokemon");
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.hits.length >= 1);
    const hit = result.hits[0];
    assert.ok(hit);
    assert.equal(hit.source, "neo/projects");
    assert.match(hit.text, /Pokemon/);
  });

  it("throws when the DB file is absent", () => {
    assert.throws(() => searchNeonMemoryDb("Neon", { dbPath: join(root, "missing.db") }));
  });
});
