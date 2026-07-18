import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonContextPackReport,
  type INeonContextPack
} from "../src/context/contextPack.js";
import {
  buildNeonCitationIndex,
  decorateNeonCitationText,
  formatNeonCitationMarker,
  resolveNeonCitationsMode,
  shouldIncludeNeonCitations
} from "../src/context/neonCitations.js";

function buildFixturePack(): INeonContextPack {
  return {
    state: "ready",
    generatedAt: "2026-06-03T01:00:00.000Z",
    agentId: "neo",
    channel: "discord",
    bounds: { maxItems: 10, charBudget: 1000, charsUsed: 30 },
    totals: { items: 3, sections: 1, droppedForBudget: 0 },
    sections: [
      {
        id: "memory",
        title: "Memory",
        items: [
          { kind: "memory", source: "memory:alpha", text: "first" },
          { kind: "memory", source: "run:beta", text: "second" },
          { kind: "memory", source: "memory:alpha", text: "third" }
        ],
        truncated: false
      }
    ],
    safety: { leakSafe: true, redacted: true }
  };
}

describe("Neon memory citations", () => {
  it("resolves the citations mode (default off)", () => {
    assert.equal(resolveNeonCitationsMode("inline"), "inline");
    assert.equal(resolveNeonCitationsMode("INLINE"), "inline");
    assert.equal(resolveNeonCitationsMode("off"), "off");
    assert.equal(resolveNeonCitationsMode(undefined), "off");
    assert.equal(resolveNeonCitationsMode("nonsense"), "off");
  });

  it("gates inclusion on inline mode", () => {
    assert.equal(shouldIncludeNeonCitations("inline"), true);
    assert.equal(shouldIncludeNeonCitations("off"), false);
  });

  it("numbers distinct sources in first-seen order and shares numbers", () => {
    const index = buildNeonCitationIndex([
      { source: "memory:a" },
      { source: "run:b" },
      { source: "memory:a" }
    ]);

    assert.equal(index.get("memory:a"), 1);
    assert.equal(index.get("run:b"), 2);
    assert.equal(index.size, 2);
  });

  it("formats markers and decorates known sources only", () => {
    assert.equal(formatNeonCitationMarker(3), "[src:3]");

    const index = buildNeonCitationIndex([{ source: "memory:a" }]);
    assert.equal(decorateNeonCitationText("hello", "memory:a", index), "[src:1] hello");
    assert.equal(decorateNeonCitationText("hello", "unknown", index), "hello");
  });

  it("leaves the context pack report unchanged in default (off) mode", () => {
    const report = renderNeonContextPackReport(buildFixturePack());

    assert.doesNotMatch(report, /\[src:/);
    assert.match(report, /- memory:alpha: first/);
  });

  it("adds [src:N] markers in inline mode, sharing numbers per source", () => {
    const report = renderNeonContextPackReport(buildFixturePack(), { citationsMode: "inline" });

    assert.match(report, /- memory:alpha: \[src:1\] first/);
    assert.match(report, /- run:beta: \[src:2\] second/);
    assert.match(report, /- memory:alpha: \[src:1\] third/);
  });
});
