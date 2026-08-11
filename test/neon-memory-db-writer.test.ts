import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  defaultNeonMemoryDbPath,
  bootstrapNeonMemorySchema,
  computeNeonContentHash,
  createNeonLocalEmbeddingProvider,
  hybridSearchNeonMemoryDb,
  renderNeonMemoryDbWriteReport,
  resolveNeonMemoryDbWriteGate,
  searchNeonMemoryDb,
  writeNeonMemoryDbEntries,
  writeNeonMemoryDbEntry,
  type INeonEmbeddingProvider,
  type INeonMemoryDbWriteGate
} from "../src/index.js";

const armedGate: INeonMemoryDbWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

describe("neon memory db schema bootstrap", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-writer-"));
    dbPath = join(root, "semantic-memory.db");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates the memory_entries + fts schema with the content_hash unique index", () => {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((row) => row.name);
      assert.ok(names.includes("memory_entries"));
      assert.ok(names.includes("memory_fts"));
      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      assert.ok(indexes.some((row) => row.name === "idx_memory_content_hash"));
    } finally {
      database.close();
    }
  });

  it("is idempotent: bootstrapping twice does not throw", () => {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      bootstrapNeonMemorySchema(database);
    } finally {
      database.close();
    }
  });
});

describe("neon memory db writer (gated, isolated)", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-writer-"));
    dbPath = join(root, "semantic-memory.db");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("blocks the write when the gate is disabled", async () => {
    const gate = resolveNeonMemoryDbWriteGate({});
    assert.equal(gate.enabled, false);
    const result = await writeNeonMemoryDbEntry({
      dbPath,
      gate,
      input: { sourceFile: "neonika:test", content: "should not be written", agent: "neo", category: "discoveries" }
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.inserted, false);
    assert.match(result.diagnostics[0] ?? "", /not armed/);
  });

  it("refuses to target the real semantic-memory DB without allowRealDb", async () => {
    const realDbPath = defaultNeonMemoryDbPath;
    const result = await writeNeonMemoryDbEntry({
      dbPath: realDbPath,
      gate: armedGate,
      input: { sourceFile: "x", content: "x", agent: "neo", category: "discoveries" }
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.safety.targetedRealMemoryDb, true);
    assert.match(result.diagnostics[0] ?? "", /real semantic-memory DB/);
  });

  it("writes a redacted entry that is findable via FTS", async () => {
    const result = await writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      input: {
        sourceFile: "neonika:slice3",
        content: "Neonika memory autarky writer slice three roundtrip",
        agent: "neo",
        category: "discoveries"
      }
    });
    assert.equal(result.state, "written");
    assert.equal(result.inserted, true);
    assert.equal(result.safety.targetedRealMemoryDb, false);
    assert.ok(typeof result.entryId === "number");
    const report = renderNeonMemoryDbWriteReport(result);
    assert.doesNotMatch(report, new RegExp(escapeRegExp(root), "u"));
    assert.doesNotMatch(report, /Content hash:/u);

    const hits = searchNeonMemoryDb("memory autarky writer roundtrip", { dbPath });
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((hit) => hit.content.includes("memory autarky writer")));
  });

  it("dedups by content_hash: a second identical write updates, not inserts", async () => {
    const input = {
      sourceFile: "neonika:dedup",
      content: "duplicate content stays one row",
      agent: "neo",
      category: "discoveries"
    } as const;
    const first = await writeNeonMemoryDbEntry({ dbPath, gate: armedGate, input });
    const second = await writeNeonMemoryDbEntry({ dbPath, gate: armedGate, input });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.updated, true);
    assert.equal(first.contentHash, second.contentHash);

    const database = new DatabaseSync(dbPath);
    try {
      const count = database.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
      assert.equal(count.n, 1);
    } finally {
      database.close();
    }
  });

  it("stores an embedding so the row is reachable by hybrid vector search", async () => {
    const embedder = createNeonLocalEmbeddingProvider();
    const result = await writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      embedder,
      input: {
        sourceFile: "neonika:vector",
        content: "vector reachable entry about fleet telemetry ingestion",
        agent: "neo",
        category: "discoveries"
      }
    });
    assert.equal(result.embedded, true);

    const rows = await hybridSearchNeonMemoryDb("fleet telemetry ingestion", embedder, { dbPath });
    assert.ok(rows.length >= 1);
    assert.ok(rows.some((row) => row.matchType === "hybrid" || row.matchType === "vector"));
  });

  it("bounds concurrent embeddings while preserving input order", async () => {
    let active = 0;
    let maxActive = 0;
    const embedder: INeonEmbeddingProvider = {
      name: "test:bounded",
      dimensions: 2,
      embed: async (_text, options): Promise<Float32Array> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await waitForEmbeddingFixture(10, options?.signal);
          return new Float32Array([1, 0]);
        } finally {
          active -= 1;
        }
      }
    };
    const inputs = Array.from({ length: 6 }, (_, index) => ({
      sourceFile: `bounded-${index}.md`,
      content: `bounded embedding ${index}`,
      agent: "neo",
      category: "discoveries"
    }));

    const results = await writeNeonMemoryDbEntries({
      dbPath,
      gate: armedGate,
      embedder,
      inputs,
      embeddingConcurrency: 2,
      embeddingTimeoutMs: 100
    });

    assert.equal(maxActive, 2);
    assert.equal(results.length, inputs.length);
    assert.ok(results.every((result) => result.embedded && !result.degraded));
    for (const [index, result] of results.entries()) {
      const input = inputs[index];
      assert.ok(input);
      assert.equal(result.contentHash, computeNeonContentHash(input.sourceFile, input.content));
    }
  });

  it("times out a hanging embedding and reports the FTS-only degradation", async () => {
    const embedder: INeonEmbeddingProvider = {
      name: "test:hanging",
      dimensions: 2,
      embed: async (_text, options): Promise<Float32Array> =>
        await waitForAbortedEmbeddingFixture(options?.signal)
    };

    const [result] = await writeNeonMemoryDbEntries({
      dbPath,
      gate: armedGate,
      embedder,
      inputs: [{
        sourceFile: "timeout.md",
        content: "timeout fallback remains searchable",
        agent: "neo",
        category: "discoveries"
      }],
      embeddingConcurrency: 1,
      embeddingTimeoutMs: 10
    });

    assert.equal(result?.state, "written");
    assert.equal(result?.embedded, false);
    assert.equal(result?.degraded, true);
    assert.ok(result?.diagnostics.some((entry) => entry.includes("timed out")));
    assert.equal(searchNeonMemoryDb("timeout fallback", { dbPath }).length, 1);
  });

  it("blocks a source-file batch with duplicate source keys before opening the database", async () => {
    const results = await writeNeonMemoryDbEntries({
      dbPath,
      gate: armedGate,
      dedupe: "source-file",
      inputs: [
        {
          sourceFile: "live-index/duplicate.md",
          content: "first state",
          agent: "neo",
          category: "live-index"
        },
        {
          sourceFile: "live-index/duplicate.md",
          content: "second state",
          agent: "neo",
          category: "live-index"
        }
      ]
    });

    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.state === "blocked"));
    assert.ok(results.every((result) => result.diagnostics.some((entry) => entry.includes("duplicate source"))));
    assert.equal(existsSync(dbPath), false);
  });

  it("redacts secret-shaped content before storing", async () => {
    await writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      input: {
        sourceFile: "neonika:secret",
        content: "token sk-ant-api03-SHOULDNOTPERSIST1234567890 in the body",
        agent: "neo",
        category: "discoveries"
      }
    });
    const database = new DatabaseSync(dbPath);
    try {
      const row = database.prepare("SELECT content FROM memory_entries LIMIT 1").get() as { content: string };
      assert.doesNotMatch(row.content, /SHOULDNOTPERSIST/);
    } finally {
      database.close();
    }
  });

  it("computes the v2/v3-compatible content hash (sha256 of source::content)", () => {
    const hash = computeNeonContentHash("file.md", "hello");
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, computeNeonContentHash("other.md", "hello"));
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function waitForEmbeddingFixture(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("embedding fixture aborted"));
    }, { once: true });
  });
}

async function waitForAbortedEmbeddingFixture(signal: AbortSignal | undefined): Promise<Float32Array> {
  return await new Promise<Float32Array>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("missing embedding abort signal"));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(new Error("embedding fixture aborted"));
    }, { once: true });
  });
}

describe("neon memory db write gate (unified env parsing)", () => {
  it("accepts the shared ready|true|1|yes value set", () => {
    for (const value of ["ready", "true", "1", "yes"]) {
      assert.equal(resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: value }).enabled, true);
    }
  });

  it("rejects the old diverging \"on\" value and everything else", () => {
    // "on" was accepted by this parser but rejected by memoryWriteRuntime for
    // the SAME env key - unified to readReadyCutoverEnv (Slice K2).
    assert.equal(resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "on" }).enabled, false);
    assert.equal(resolveNeonMemoryDbWriteGate({}).enabled, false);
    assert.equal(resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "nonsense" }).enabled, false);
  });
});

describe("neon memory db writer dedupe semantics", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-writer-dedupe-"));
    dbPath = join(root, "semantic-memory.db");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const countRows = (sourceFile: string): number => {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE source_file = ?")
        .get(sourceFile) as { n: number };
      return row.n;
    } finally {
      database.close();
    }
  };

  const write = (content: string, dedupe?: "content-hash" | "source-file"): ReturnType<typeof writeNeonMemoryDbEntry> =>
    writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      ...(dedupe ? { dedupe } : {}),
      input: {
        sourceFile: "live-index/claude/session-x.md",
        content,
        agent: "neo",
        category: "live-index"
      }
    });

  it("default content-hash mode appends a new row per content revision", async () => {
    await write("Stand A der Session");
    await write("Stand B der Session");
    assert.equal(countRows("live-index/claude/session-x.md"), 2);
  });

  it("source-file mode keeps exactly one row per source: latest state wins", async () => {
    await write("Stand A der Session", "source-file");
    const second = await write("Stand B der Session", "source-file");

    assert.equal(second.state, "written");
    assert.ok(second.diagnostics.some((line) => line.includes("replaced 1 stale state")));
    assert.equal(countRows("live-index/claude/session-x.md"), 1);

    const hits = searchNeonMemoryDb("Stand", { dbPath, category: "live-index", limit: 5 });
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.content ?? "", /Stand B/);
  });

  it("survives the A->B->A round trip without a hash collision", async () => {
    await write("Stand A der Session", "source-file");
    await write("Stand B der Session", "source-file");
    const third = await write("Stand A der Session", "source-file");

    assert.equal(third.state, "written");
    assert.equal(countRows("live-index/claude/session-x.md"), 1);
    const hits = searchNeonMemoryDb("Stand", { dbPath, category: "live-index", limit: 5 });
    assert.match(hits[0]?.content ?? "", /Stand A/);
  });
});
