import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonAgentMemoryAttachment,
  recallNeonAgentMemory,
  type INeonMemoryProvider,
  type INeonMemorySearchResult
} from "../src/index.js";

// The `agent-recall-smoke` CLI command (src/cli.ts) wires the scoped recall to a
// real entry point: it runs `recallNeonAgentMemory` with the live CLI provider
// and prints redacted, agent-tagged excerpts built via the shared attachment.
// This test pins the data contract that command prints, using a fake provider so
// it does not depend on the `memory-search` binary.
function createFakeProvider(
  hits: readonly { source: string; text: string }[]
): INeonMemoryProvider {
  return {
    search: async (query): Promise<INeonMemorySearchResult> => ({ query, hits, diagnostics: [] })
  };
}

describe("agent-recall-smoke data contract", () => {
  it("scopes the recall to a resolved agent and redacts secrets in the tagged excerpts", async () => {
    const provider = createFakeProvider([
      { source: "decisions", text: "deploy token sk-abcdef0123456789ABCD stays read-only" }
    ]);

    // Scoped recall: the seam the smoke calls first.
    const recall = await recallNeonAgentMemory(provider, "orchestrator", "cutover status", {
      maxHits: 5
    });
    assert.equal(recall.resolvedAgentId, "neo");
    assert.equal(recall.agentId, "orchestrator");
    assert.ok(recall.scopeTerms.length > 0, "expected profile seeds to scope the query");
    assert.ok(recall.scopedQuery.startsWith("cutover status "));

    // Redacted, agent-tagged excerpts: what the smoke prints.
    const attachment = await createNeonAgentMemoryAttachment(provider, "orchestrator", "cutover status", {
      maxHits: 5
    });
    assert.equal(attachment.state, "attached");
    assert.equal(attachment.hitCount, 1);
    assert.match(attachment.note, /^\[agent neo\] /);

    const excerpt = attachment.excerpts?.[0];
    assert.ok(excerpt, "expected one excerpt");
    assert.doesNotMatch(excerpt.text, /sk-abcdef0123456789ABCD/, "raw secret must not survive");
    assert.match(excerpt.text, /\[REDACTED_SECRET\]/, "secret must be redacted");
  });

  it("labels an unknown agent and still passes the query through", async () => {
    const provider = createFakeProvider([]);

    const recall = await recallNeonAgentMemory(provider, "ghost-agent", "deploy plan");
    assert.equal(recall.resolvedAgentId, null);
    assert.deepEqual(recall.scopeTerms, []);
    assert.equal(recall.scopedQuery, "deploy plan");

    const attachment = await createNeonAgentMemoryAttachment(provider, "ghost-agent", "deploy plan");
    assert.equal(attachment.state, "skipped");
    assert.equal(attachment.hitCount, 0);
    assert.equal(attachment.resolvedAgentId, null);
    assert.match(attachment.note, /^\[agent ghost-agent\]/);
  });
});
