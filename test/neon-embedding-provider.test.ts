import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NEON_LOCAL_EMBEDDING_DIMENSIONS,
  NEON_LOCAL_EMBEDDING_NAME,
  NEON_OLLAMA_EMBEDDING_DIMENSIONS,
  bufferToNeonVector,
  createNeonLocalEmbeddingProvider,
  createNeonOllamaEmbeddingProvider,
  embedNeonLocalText,
  neonCosineSimilarity,
  neonVectorToBuffer,
  normalizeNeonVector
} from "../src/index.js";

describe("neon local embedding provider", () => {
  const provider = createNeonLocalEmbeddingProvider();

  it("exposes the contract name and dimensions", () => {
    assert.equal(provider.name, NEON_LOCAL_EMBEDDING_NAME);
    assert.equal(provider.name, "local:feature-hash");
    assert.equal(provider.dimensions, NEON_LOCAL_EMBEDDING_DIMENSIONS);
    assert.equal(provider.dimensions, 384);
  });

  it("is deterministic: same text yields a bit-identical vector", () => {
    const a = embedNeonLocalText("Neonika memory autarky");
    const b = embedNeonLocalText("Neonika memory autarky");
    assert.equal(a.length, 384);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it("exposes the same vector through the async provider", async () => {
    const sync = embedNeonLocalText("async wrapper parity");
    const viaProvider = await provider.embed("async wrapper parity");
    assert.deepEqual(Array.from(viaProvider), Array.from(sync));
  });

  it("produces an L2-normalized vector (self-cosine = 1)", () => {
    const vector = embedNeonLocalText("Pokemon stats from the PokeAPI");
    assert.ok(Math.abs(neonCosineSimilarity(vector, vector) - 1) < 1e-6);
    let norm = 0;
    for (const value of vector) {
      norm += value * value;
    }
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
  });

  it("separates unrelated text from related text by cosine", () => {
    const base = embedNeonLocalText("Neonika cutover plan");
    const related = embedNeonLocalText("Neonika cutover sequence");
    const unrelated = embedNeonLocalText("Pokemon battle statistics");
    assert.ok(neonCosineSimilarity(base, related) > neonCosineSimilarity(base, unrelated));
  });

  it("round-trips a vector through a BLOB buffer without loss", () => {
    const vector = embedNeonLocalText("round trip through sqlite blob");
    const buffer = neonVectorToBuffer(vector);
    const restored = bufferToNeonVector(buffer);
    assert.deepEqual(Array.from(restored), Array.from(vector));
    assert.ok(Math.abs(neonCosineSimilarity(restored, vector) - 1) < 1e-6);
  });

  it("round-trips through a plain Uint8Array (node:sqlite BLOB shape)", () => {
    const vector = embedNeonLocalText("uint8array blob from node sqlite");
    const buffer = neonVectorToBuffer(vector);
    const asPlainBytes = new Uint8Array(buffer);
    const restored = bufferToNeonVector(asPlainBytes);
    assert.deepEqual(Array.from(restored), Array.from(vector));
  });

  it("returns a zero-safe vector for empty text", () => {
    const vector = embedNeonLocalText("   ");
    assert.equal(vector.length, 384);
    assert.deepEqual(Array.from(normalizeNeonVector(vector)), Array.from(vector));
  });
});

describe("neon ollama embedding provider", () => {
  it("derives name, model and dimensions from options", () => {
    const provider = createNeonOllamaEmbeddingProvider({ model: "nomic-embed-text" });
    assert.equal(provider.name, "ollama:nomic-embed-text");
    assert.equal(provider.dimensions, NEON_OLLAMA_EMBEDDING_DIMENSIONS);
    assert.equal(provider.dimensions, 768);
  });

  it("honours a custom dimension override", () => {
    const provider = createNeonOllamaEmbeddingProvider({ model: "custom", dimensions: 512 });
    assert.equal(provider.name, "ollama:custom");
    assert.equal(provider.dimensions, 512);
  });
});
