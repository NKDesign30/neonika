import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonRetireExportBundle,
  parseNeonRetireBundle,
  serializeNeonRetireBundle,
  verifyNeonRetireRoundTrip,
  NEON_RETIRE_BUNDLE_VERSION,
  type INeonGatewayShadowRun
} from "../src/index.js";

function retireRun(runId: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Retire export proof",
      receivedAt: "2026-05-31T18:30:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:c…only",
    memoryState: "attached",
    events: [{ kind: "final", text: "ok" }],
    finalText: "ok",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "ok"
    },
    startedAt: "2026-05-31T18:30:00.000Z",
    completedAt: "2026-05-31T18:30:01.000Z"
  };
}

describe("Neon retire export/import", () => {
  it("round-trips runs through a versioned bundle with a stable serialization", () => {
    const runs = [retireRun("run-a"), retireRun("run-b"), retireRun("run-c")];

    const result = verifyNeonRetireRoundTrip(runs, "2026-06-02T00:00:00.000Z");

    assert.equal(result.exported, 3);
    assert.equal(result.imported, 3);
    assert.equal(result.roundTripOk, true);
    assert.match(result.diagnostics.join(" "), /round-trip verified 3 run/);
  });

  it("round-trips an empty run history", () => {
    const result = verifyNeonRetireRoundTrip([], "2026-06-02T00:00:00.000Z");

    assert.equal(result.exported, 0);
    assert.equal(result.imported, 0);
    assert.equal(result.roundTripOk, true);
  });

  it("parses a well-formed bundle", () => {
    const bundle = createNeonRetireExportBundle([retireRun("run-a")], "2026-06-02T00:00:00.000Z");
    const parsed = parseNeonRetireBundle(serializeNeonRetireBundle(bundle));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.bundle?.version, NEON_RETIRE_BUNDLE_VERSION);
    assert.equal(parsed.bundle?.runs.length, 1);
  });

  it("rejects invalid bundles without throwing", () => {
    assert.equal(parseNeonRetireBundle("{not json").ok, false);
    assert.equal(parseNeonRetireBundle("[]").ok, false);
    assert.equal(parseNeonRetireBundle(JSON.stringify({ version: 99, exportedAt: "x", runCount: 0, runs: [] })).ok, false);
    assert.equal(
      parseNeonRetireBundle(JSON.stringify({ version: 1, exportedAt: "", runCount: 0, runs: [] })).ok,
      false
    );
    assert.equal(
      parseNeonRetireBundle(JSON.stringify({ version: 1, exportedAt: "x", runCount: 1, runs: [] })).ok,
      false
    );
    assert.equal(
      parseNeonRetireBundle(JSON.stringify({ version: 1, exportedAt: "x", runCount: 1, runs: [{ noId: true }] })).ok,
      false
    );
  });
});
