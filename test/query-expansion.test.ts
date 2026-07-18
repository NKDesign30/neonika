import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractNeonQueryKeywords,
  isNeonQueryKeyword,
  isNeonQueryStopWord,
  recallNeonAgentMemory,
  tokenizeNeonQuery,
  type INeonMemoryProvider,
  type INeonMemorySearchOptions,
  type INeonMemorySearchResult
} from "../src/index.js";

interface IRecordedCall {
  readonly query: string;
  readonly options: INeonMemorySearchOptions | undefined;
}

function createCapturingProvider(recorder: IRecordedCall[]): INeonMemoryProvider {
  return {
    search: async (query, options): Promise<INeonMemorySearchResult> => {
      recorder.push({ query, options });
      return { query, hits: [], diagnostics: [] };
    }
  };
}

describe("Neon query expansion", () => {
  it("extracts DE keywords, lowercased, with umlauts preserved", () => {
    assert.deepEqual(
      extractNeonQueryKeywords("was war die Lösung für den Bug"),
      ["lösung", "bug"]
    );
  });

  it("extracts EN keywords from a conversational query", () => {
    assert.deepEqual(
      extractNeonQueryKeywords("that thing we discussed about the API"),
      ["discussed", "api"]
    );
  });

  it("dedupes repeated keywords in first-seen order", () => {
    assert.deepEqual(extractNeonQueryKeywords("API api the API bug"), ["api", "bug"]);
  });

  it("returns an empty list for a stopword-only query", () => {
    assert.deepEqual(extractNeonQueryKeywords("der die das und oder für"), []);
  });

  it("drops short ASCII fragments and pure numbers but keeps real terms", () => {
    assert.deepEqual(extractNeonQueryKeywords("ok 42 server crash"), ["server", "crash"]);
  });

  it("classifies stopwords and keywords", () => {
    assert.equal(isNeonQueryStopWord("für"), true);
    assert.equal(isNeonQueryStopWord("the"), true);
    assert.equal(isNeonQueryStopWord("bug"), false);
    assert.equal(isNeonQueryKeyword("api"), true);
    assert.equal(isNeonQueryKeyword("ok"), false);
    assert.equal(isNeonQueryKeyword("42"), false);
  });

  it("tokenizes on whitespace and punctuation, lowercasing", () => {
    assert.deepEqual(tokenizeNeonQuery("Bug, API; server!"), ["bug", "api", "server"]);
  });

  it("leaves the recall query unchanged by default (non-breaking)", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createCapturingProvider(calls);

    const recall = await recallNeonAgentMemory(
      provider,
      "ghost-agent",
      "was war die Lösung für den Bug",
      { useProfileSeeds: false }
    );

    assert.equal(recall.scopedQuery, "was war die Lösung für den Bug");
    assert.equal(calls[0]?.query, "was war die Lösung für den Bug");
  });

  it("reduces the recall query to keywords when expandKeywords is opted in", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createCapturingProvider(calls);

    const recall = await recallNeonAgentMemory(
      provider,
      "ghost-agent",
      "was war die Lösung für den Bug",
      { useProfileSeeds: false, expandKeywords: true }
    );

    assert.equal(recall.scopedQuery, "lösung bug");
    assert.equal(calls[0]?.query, "lösung bug");
  });

  it("folds keywords ahead of focus scope terms when expanding", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createCapturingProvider(calls);

    const recall = await recallNeonAgentMemory(provider, "ghost-agent", "the deploy plan", {
      useProfileSeeds: false,
      focus: ["canary"],
      expandKeywords: true
    });

    assert.equal(recall.scopedQuery, "deploy plan canary");
  });

  it("falls back to the original query when expansion yields no keywords", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createCapturingProvider(calls);

    const recall = await recallNeonAgentMemory(provider, "ghost-agent", "der die das und", {
      useProfileSeeds: false,
      expandKeywords: true
    });

    assert.equal(recall.scopedQuery, "der die das und");
    assert.equal(calls[0]?.query, "der die das und");
  });
});
