import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonAgentMemoryAttachment,
  recallNeonAgentMemory,
  type INeonMemoryProvider,
  type INeonMemorySearchOptions,
  type INeonMemorySearchResult
} from "../src/index.js";

interface IRecordedCall {
  readonly query: string;
  readonly options: INeonMemorySearchOptions | undefined;
}

function createFakeProvider(
  hits: readonly { source: string; text: string }[],
  recorder: IRecordedCall[]
): INeonMemoryProvider {
  return {
    search: async (query, options): Promise<INeonMemorySearchResult> => {
      recorder.push({ query, options });
      return { query, hits, diagnostics: [] };
    }
  };
}

describe("Neon agent-scoped memory recall", () => {
  it("folds a known agent's profile seeds into the scoped query and tags the result", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([{ source: "memory", text: "hit" }], calls);

    const recall = await recallNeonAgentMemory(provider, "neo", "cutover status");

    assert.equal(recall.resolvedAgentId, "neo");
    assert.equal(recall.agentId, "neo");
    assert.ok(recall.scopeTerms.length > 0, "expected profile seeds to populate scope terms");
    assert.ok(recall.scopedQuery.startsWith("cutover status "));
    for (const term of recall.scopeTerms) {
      assert.ok(recall.scopedQuery.includes(term), `scoped query should include "${term}"`);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.query, recall.scopedQuery);
    assert.equal(calls[0]?.options?.maxHits, 5);
  });

  it("resolves an alias to the canonical agent id", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([], calls);

    const recall = await recallNeonAgentMemory(provider, "orchestrator", "anything");

    assert.equal(recall.resolvedAgentId, "neo");
    assert.equal(recall.agentId, "orchestrator");
  });

  it("scopes an unknown agent only from explicit focus terms", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([], calls);

    const recall = await recallNeonAgentMemory(provider, "ghost-agent", "deploy plan", {
      focus: ["delivery", "delivery", "  ", "canary"]
    });

    assert.equal(recall.resolvedAgentId, null);
    assert.deepEqual(recall.scopeTerms, ["delivery", "canary"]);
    assert.equal(recall.scopedQuery, "deploy plan delivery canary");
  });

  it("passes the query through unchanged for an unknown agent with no focus", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([], calls);

    const recall = await recallNeonAgentMemory(provider, "ghost-agent", "  raw query  ");

    assert.equal(recall.resolvedAgentId, null);
    assert.deepEqual(recall.scopeTerms, []);
    assert.equal(recall.scopedQuery, "raw query");
    assert.equal(calls[0]?.query, "raw query");
  });

  it("ignores profile seeds when useProfileSeeds is false", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([], calls);

    const recall = await recallNeonAgentMemory(provider, "neo", "status", {
      useProfileSeeds: false,
      focus: ["runtime"]
    });

    assert.equal(recall.resolvedAgentId, null);
    assert.deepEqual(recall.scopeTerms, ["runtime"]);
    assert.equal(recall.scopedQuery, "status runtime");
  });

  it("forwards an explicit maxHits to the provider", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([], calls);

    await recallNeonAgentMemory(provider, "neo", "status", { maxHits: 2 });

    assert.equal(calls[0]?.options?.maxHits, 2);
  });

  it("builds an attached memory attachment tagged with the resolved agent and hits it once", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider(
      [
        { source: "decisions", text: "shadow cutover stays read-only" },
        { source: "patterns", text: "delivery suppressed by default" }
      ],
      calls
    );

    const attachment = await createNeonAgentMemoryAttachment(provider, "orchestrator", "cutover");

    assert.equal(attachment.state, "attached");
    assert.equal(attachment.hitCount, 2);
    assert.equal(attachment.agentId, "orchestrator");
    assert.equal(attachment.resolvedAgentId, "neo");
    assert.match(attachment.note, /^\[agent neo\] /);
    assert.equal(calls.length, 1, "real provider must be hit exactly once");
  });

  it("reports a skipped attachment when the scoped recall returns no hits", async () => {
    const calls: IRecordedCall[] = [];
    const provider = createFakeProvider([], calls);

    const attachment = await createNeonAgentMemoryAttachment(provider, "ghost-agent", "nothing");

    assert.equal(attachment.state, "skipped");
    assert.equal(attachment.hitCount, 0);
    assert.equal(attachment.resolvedAgentId, null);
    assert.equal(attachment.agentId, "ghost-agent");
  });
});
