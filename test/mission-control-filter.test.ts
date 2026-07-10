import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveNeonActivityToolLabel,
  filterNeonMissionControlActivity,
  renderNeonMissionControlFilterReport,
  type INeonActivityEntry
} from "../src/index.js";

function entry(overrides: Partial<INeonActivityEntry> & { readonly id: string }): INeonActivityEntry {
  return {
    runId: "run-1",
    sessionKey: "discord:chan:thread",
    channel: "discord",
    channelId: "chan-1",
    agentId: "neo",
    kind: "run",
    status: "done",
    title: "Agent run",
    summary: "codex completed",
    runStatus: "completed",
    startedAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:01.000Z",
    durationMs: 1000,
    sequence: 0,
    ...overrides
  };
}

const entries: readonly INeonActivityEntry[] = [
  entry({ id: "a", agentId: "neo", kind: "run", status: "done", title: "Agent run", summary: "codex completed" }),
  entry({
    id: "b",
    agentId: "chaty",
    kind: "tool",
    status: "running",
    title: "Tool ripgrep",
    summary: "ripgrep started."
  }),
  entry({
    id: "c",
    agentId: "chaty",
    kind: "tool",
    status: "error",
    title: "Tool apply_patch",
    summary: "apply_patch returned output."
  }),
  entry({ id: "d", agentId: "neo", kind: "inbound", status: "done", title: "Inbound message", summary: "discord message" })
];

describe("Neon Mission-Control activity filter (Z94)", () => {
  it("returns every entry and marks unfiltered when no criteria are given", () => {
    const result = filterNeonMissionControlActivity(entries);
    assert.equal(result.totalCount, 4);
    assert.equal(result.visibleCount, 4);
    assert.equal(result.filtered, false);
    assert.equal(result.entries.length, 4);
  });

  it("matches free-text search case-insensitively across title/summary/agent", () => {
    const result = filterNeonMissionControlActivity(entries, { search: "RIPGREP" });
    assert.equal(result.visibleCount, 1);
    assert.equal(result.filtered, true);
    assert.equal(result.entries[0]?.id, "b");
  });

  it("filters by exact agent id", () => {
    const result = filterNeonMissionControlActivity(entries, { agentId: "chaty" });
    assert.equal(result.visibleCount, 2);
    assert.deepEqual(
      result.entries.map((item) => item.id),
      ["b", "c"]
    );
  });

  it("filters by derived tool label without matching non-tool entries", () => {
    const result = filterNeonMissionControlActivity(entries, { tool: "ripgrep" });
    assert.equal(result.visibleCount, 1);
    assert.equal(result.entries[0]?.id, "b");

    const noTool = filterNeonMissionControlActivity(entries, { tool: "does-not-exist" });
    assert.equal(noTool.visibleCount, 0);
  });

  it("filters by activity status", () => {
    const running = filterNeonMissionControlActivity(entries, { status: "running" });
    assert.equal(running.visibleCount, 1);
    assert.equal(running.entries[0]?.id, "b");

    const errors = filterNeonMissionControlActivity(entries, { status: "error" });
    assert.equal(errors.visibleCount, 1);
    assert.equal(errors.entries[0]?.id, "c");
  });

  it("combines criteria with AND semantics", () => {
    const result = filterNeonMissionControlActivity(entries, { agentId: "chaty", status: "error" });
    assert.equal(result.visibleCount, 1);
    assert.equal(result.entries[0]?.id, "c");
  });

  it("derives facets from the full set, sorted by count then value", () => {
    const result = filterNeonMissionControlActivity(entries, { status: "running" });
    // Facets must reflect ALL entries, not just the one visible row.
    assert.deepEqual(
      result.facets.agents.map((option) => `${option.value}:${option.count}`),
      ["chaty:2", "neo:2"]
    );
    assert.deepEqual(
      result.facets.tools.map((option) => `${option.value}:${option.count}`),
      ["apply_patch:1", "ripgrep:1"]
    );
    assert.deepEqual(
      result.facets.statuses.map((option) => `${option.value}:${option.count}`),
      ["done:2", "error:1", "running:1"]
    );
  });

  it("derives a tool label only for tool entries", () => {
    assert.equal(deriveNeonActivityToolLabel(entries[1] as INeonActivityEntry), "ripgrep");
    assert.equal(deriveNeonActivityToolLabel(entries[0] as INeonActivityEntry), undefined);
  });

  it("renders a leak-safe report with the visible/total count", () => {
    const result = filterNeonMissionControlActivity(entries, { agentId: "chaty" });
    const report = renderNeonMissionControlFilterReport(result);
    assert.match(report, /Visible: 2\/4/);
    assert.match(report, /agent=chaty/);
    assert.match(report, /Tools: apply_patch \(1\), ripgrep \(1\)/);
  });
});
