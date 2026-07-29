import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createNeonLocalEmbeddingProvider,
  createNeonMemoryDbProvider,
  embedNeonLocalText,
  hybridSearchNeonMemoryDb,
  neonVectorToBuffer,
  searchNeonMemoryDb,
  toNeonV3SearchResult
} from "../src/index.js";

interface ISeedRow {
  readonly source: string;
  readonly content: string;
  readonly agent: string;
  readonly category: string;
  readonly importance: number;
  readonly embedDimensions: number;
}

// The hybrid path is embedder-agnostic, so the test uses the deterministic local
// provider (no Ollama dependency). One row is embedded at the wrong dimension to
// prove the LENGTH(embedding) filter skips the known mixed-dimension data bug.
const seedRows: readonly ISeedRow[] = [
  {
    source: "a.md",
    content: "Neonika cutover plan with mirror and canary stages",
    agent: "chaty",
    category: "discoveries",
    importance: 80,
    embedDimensions: 384
  },
  {
    source: "b.md",
    content: "Neonika cutover sequence: shadow then mirror then canary",
    agent: "neo",
    category: "plan",
    importance: 75,
    embedDimensions: 384
  },
  {
    source: "c.md",
    content: "Pokemon battle statistics fetched from the PokeAPI",
    agent: "neo",
    category: "projects",
    importance: 60,
    embedDimensions: 384
  },
  {
    source: "d.md",
    content: "wrong dimension embedding that must be skipped by the vector pass",
    agent: "chaty",
    category: "discoveries",
    importance: 50,
    embedDimensions: 768
  },
  // Der reale Fall vom 25.07.2026, nachgebaut: ein Digest zitiert das Thema in
  // seinem Preview, ohne etwas darüber zu wissen. Er ist kurz, also ist seine
  // bm25-Dichte hoch — und schlug damit die Summary, die das Thema wirklich
  // behandelt.
  {
    source: "live-index/claude/session-abc.md",
    content:
      "Claude transcript live-index digest Project: global Session: abc Mode: final " +
      "Messages: 2 (1 user / 1 assistant) Tool failures: 0 Latest preview: Fahrtenbuch",
    agent: "neo",
    category: "live-index",
    importance: 34,
    embedDimensions: 384
  },
  {
    source: "session-summaries/2026-07-24-global.md",
    content:
      "# Session-Summary [global] (2026-07-24) Die Operatorin hat mit der Finanzverwaltung " +
      "die Anforderungen für das Fahrtenbuch geklärt, inklusive Listenpreis und Kilometerstand",
    agent: "live-indexer",
    category: "session-summary",
    importance: 70,
    embedDimensions: 384
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
        importance_score REAL NOT NULL DEFAULT 50.0,
        embedding BLOB
      );
      CREATE VIRTUAL TABLE memory_fts USING fts5(content, agent, category);
      CREATE TRIGGER memory_ai AFTER INSERT ON memory_entries BEGIN
        INSERT INTO memory_fts(rowid, content, agent, category)
        VALUES (new.id, new.content, new.agent, new.category);
      END;
    `);
    const insert = database.prepare(
      "INSERT INTO memory_entries (source_file, content, agent, category, importance_score, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const row of seedRows) {
      const vector = embedNeonLocalText(row.content, row.embedDimensions);
      insert.run(
        row.source,
        row.content,
        row.agent,
        row.category,
        row.importance,
        neonVectorToBuffer(vector)
      );
    }
  } finally {
    database.close();
  }
}

describe("neon hybrid memory search", () => {
  const embedder = createNeonLocalEmbeddingProvider();
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-hybrid-"));
    dbPath = join(root, "semantic-memory.db");
    seedDatabase(dbPath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("fuses fts and vector signals and ranks the cutover rows first", async () => {
    const rows = await hybridSearchNeonMemoryDb("Neonika cutover", embedder, { dbPath });
    assert.ok(rows.length >= 2);
    const topSources = rows.slice(0, 2).map((row) => row.source);
    assert.ok(topSources.includes("a.md"));
    assert.ok(topSources.includes("b.md"));
    // unrelated pokemon row must not outrank the cutover rows
    const pokemon = rows.find((row) => row.source === "c.md");
    const cutover = rows.find((row) => row.source === "a.md");
    assert.ok(cutover);
    if (pokemon) {
      assert.ok(cutover.score >= pokemon.score);
    }
  });

  it("skips the wrong-dimension row in the vector pass", async () => {
    // A query that only the wrong-dim row's vector could match must not return it
    // via the vector path (its 768-dim blob is filtered out for a 384-dim query).
    const rows = await hybridSearchNeonMemoryDb("wrong dimension embedding skipped", embedder, {
      dbPath
    });
    const wrongDim = rows.find((row) => row.source === "d.md");
    // It may still appear via FTS (it shares words), but never with matchType "vector".
    if (wrongDim) {
      assert.notEqual(wrongDim.matchType, "vector");
    }
  });

  it("labels match types and sorts by score descending", async () => {
    const rows = await hybridSearchNeonMemoryDb("Neonika cutover sequence", embedder, { dbPath });
    assert.ok(rows.every((row) => ["fts", "vector", "hybrid"].includes(row.matchType)));
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      assert.ok(previous && current && previous.score >= current.score);
    }
  });

  it("honours the agent filter", async () => {
    const rows = await hybridSearchNeonMemoryDb("Neonika cutover", embedder, {
      dbPath,
      agent: "neo"
    });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.agent === "neo"));
  });

  it("provider runs hybrid when an embedder is injected", async () => {
    const provider = createNeonMemoryDbProvider({ dbPath, embedder });
    const result = await provider.search("Neonika cutover", { maxHits: 3 });
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.hits.length >= 1);
    assert.ok(result.hits.every((hit) => typeof hit.score === "number"));
    assert.ok(result.hits.some((hit) => hit.matchType === "hybrid" || hit.matchType === "vector"));
  });

  it("provider falls back to fts-only with a diagnostic when embedding fails", async () => {
    const failing = {
      name: "broken",
      dimensions: 384,
      embed: async (): Promise<Float32Array> => {
        throw new Error("ollama unreachable");
      }
    };
    const provider = createNeonMemoryDbProvider({ dbPath, embedder: failing });
    const result = await provider.search("Neonika cutover", { maxHits: 3 });
    assert.ok(result.hits.length >= 1);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0] ?? "", /fts-only fallback/);
  });

  // This is the drop-in contract: when the previous runtime is retired, an external memory-search client
  // reads result.entry.{agent,category,sourceFile,content} + top-level score. The mapper
  // must re-nest the flat row into exactly that shape so the consumer keeps working.
  it("maps rows to the v3 /api/memory/v3/search wire shape", async () => {
    const ftsRows = searchNeonMemoryDb("Neonika cutover", { dbPath });
    assert.ok(ftsRows.length >= 1);
    const ftsResult = toNeonV3SearchResult(ftsRows[0]!);
    assert.equal(ftsResult.matchType, "fts");
    assert.equal(typeof ftsResult.score, "number");
    assert.equal(typeof ftsResult.entry.agent, "string");
    assert.equal(typeof ftsResult.entry.category, "string");
    assert.equal(typeof ftsResult.entry.sourceFile, "string");
    assert.equal(typeof ftsResult.entry.content, "string");
    assert.equal(typeof ftsResult.entry.importanceScore, "number");

    const hybridRows = await hybridSearchNeonMemoryDb("Neonika cutover", embedder, { dbPath });
    const hybridResult = toNeonV3SearchResult(hybridRows[0]!);
    assert.ok(["fts", "vector", "hybrid"].includes(hybridResult.matchType));
    // v3 carries provenance/timestamps; Neonika intentionally omits them (leak-safety
    // + not loaded in the projection). The consumer never reads them.
    assert.equal("provenance" in hybridResult.entry, false);
    assert.equal("createdAt" in hybridResult.entry, false);
  });

  it("keeps session bookkeeping out of a content search", async () => {
    // Vor dem Fix gewann hier der Digest: sein Preview zitiert das Wort, er ist
    // kurz, und die Fusion las importance nicht. Gesucht wird Inhalt, nicht die
    // Buchhaltung darüber, welche Session das Wort einmal enthielt.
    for (const rows of [
      searchNeonMemoryDb("Fahrtenbuch", { dbPath }),
      await hybridSearchNeonMemoryDb("Fahrtenbuch", embedder, { dbPath })
    ]) {
      assert.ok(rows.length >= 1, "the real summary must still be found");
      assert.equal(
        rows.some((row) => row.category === "live-index"),
        false,
        "ambient digests do not belong in a content search"
      );
      assert.equal(rows[0]?.category, "session-summary");
    }
  });

  it("still returns digests when the category is asked for explicitly", async () => {
    // Ausgeblendet ist nicht gelöscht: wer die Kategorie nennt, bekommt sie.
    const rows = searchNeonMemoryDb("Fahrtenbuch", { dbPath, category: "live-index" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, "live-index");

    const hybrid = await hybridSearchNeonMemoryDb("Fahrtenbuch", embedder, {
      dbPath,
      category: "live-index"
    });
    assert.ok(hybrid.some((row) => row.category === "live-index"));
  });

  it("weights importance into the fused score without zeroing anything out", async () => {
    // Der zweite Teil des Fixes, unabhängig vom Kategorie-Filter: importance geht
    // multiplikativ ein, darf aber keinen echten Treffer auslöschen.
    const rows = await hybridSearchNeonMemoryDb("Neonika cutover", embedder, { dbPath });
    const a = rows.find((row) => row.source === "a.md");
    const b = rows.find((row) => row.source === "b.md");
    assert.ok(a && b, "both cutover rows must be present");
    assert.ok(a.score > 0 && b.score > 0, "importance weighting must not zero a score out");
  });
});
