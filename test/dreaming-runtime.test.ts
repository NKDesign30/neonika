import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  promoteNeonDreamProposal,
  readNeonMemoryStore,
  resolveNeonDreamingGate,
  runNeonDreamingReflection,
  type INeonDreamCandidate,
  type INeonDreamingGate,
  type INeonMemoryWriteGate
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");
const armedGate: INeonDreamingGate = {
  enabled: true,
  reason: "dreaming-enabled",
  envKey: "NEON_DREAMING_ENABLED"
};
const closedGate: INeonDreamingGate = {
  enabled: false,
  reason: "dreaming-disabled",
  envKey: "NEON_DREAMING_ENABLED"
};
const candidates: readonly INeonDreamCandidate[] = [
  { id: "mem-1", content: "Operator prefers Umlaute everywhere", accessCount: 5 },
  { id: "mem-2", content: "Operator prefers Umlaute in output", accessCount: 4 },
  { id: "mem-3", content: "One-off note never recalled", accessCount: 0 }
];

describe("Neon dreaming runtime (DP-10)", () => {
  it("keeps dreaming off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonDreamingGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonDreamingGate({ NEON_DREAMING_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonDreamingGate({ NEON_DREAMING_ENABLED: "0" }).enabled, false);
  });

  it("emits no proposals while dreaming is disabled", () => {
    const result = runNeonDreamingReflection({
      gate: closedGate,
      phase: "light",
      candidates,
      now: () => fixedNow
    });

    assert.equal(result.dreamed, false);
    assert.equal(result.proposals.length, 0);
    assert.equal(result.safety.memoryWritten, false);
    assert.equal(result.safety.autoPromoted, false);
  });

  it("light phase proposes promotion of frequently recalled entries only", () => {
    const result = runNeonDreamingReflection({
      gate: armedGate,
      phase: "light",
      candidates,
      now: () => fixedNow
    });

    assert.equal(result.dreamed, true);
    assert.ok(result.proposals.every((proposal) => proposal.kind === "promote"));
    // mem-1 and mem-2 have accessCount >= 3, mem-3 does not.
    assert.deepEqual(
      result.proposals.flatMap((proposal) => proposal.sourceIds).sort(),
      ["mem-1", "mem-2"]
    );
    assert.equal(result.safety.memoryWritten, false);
  });

  it("deep phase proposes merging near-duplicate entries", () => {
    const result = runNeonDreamingReflection({
      gate: armedGate,
      phase: "deep",
      candidates,
      now: () => fixedNow
    });

    const merge = result.proposals.find((proposal) => proposal.kind === "merge");
    assert.ok(merge, "expected a merge proposal for the two 'Operator prefers Umlaute' entries");
    assert.deepEqual(merge?.sourceIds.slice().sort(), ["mem-1", "mem-2"]);
  });

  // Reworded near-duplicates: share concepts (websocket/gateway/backpressure) but
  // have different lead words, so the prefix key cannot cluster them.
  const reworded: readonly INeonDreamCandidate[] = [
    { id: "ws-1", content: "Websocket gateway needs backpressure handling", accessCount: 2 },
    { id: "ws-2", content: "Backpressure protects the gateway websocket buffer", accessCount: 2 },
    { id: "note-3", content: "Standup planning for Monday", accessCount: 1 }
  ];

  it("deep phase without conceptMerge leaves reworded near-duplicates unmerged", () => {
    const result = runNeonDreamingReflection({
      gate: armedGate,
      phase: "deep",
      candidates: reworded,
      now: () => fixedNow
    });

    // Lead-words prefixes differ, so the default prefix grouping merges nothing.
    assert.equal(result.proposals.filter((proposal) => proposal.kind === "merge").length, 0);
  });

  it("deep phase with conceptMerge clusters reworded near-duplicates by shared concept tags", () => {
    const result = runNeonDreamingReflection({
      gate: armedGate,
      phase: "deep",
      candidates: reworded,
      conceptMerge: true,
      now: () => fixedNow
    });

    const merges = result.proposals.filter((proposal) => proposal.kind === "merge");
    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0]?.sourceIds.slice().sort(), ["ws-1", "ws-2"]);
    assert.match(result.diagnostics.join("\n"), /grouped by shared concept tags/);
  });

  it("rem phase proposes prune candidates for never-recalled entries", () => {
    const result = runNeonDreamingReflection({
      gate: armedGate,
      phase: "rem",
      candidates,
      now: () => fixedNow
    });

    assert.deepEqual(
      result.proposals.map((proposal) => proposal.kind),
      ["prune-candidate"]
    );
    assert.deepEqual(result.proposals[0]?.sourceIds, ["mem-3"]);
  });

  it("redacts a secret inside a proposal summary", () => {
    const result = runNeonDreamingReflection({
      gate: armedGate,
      phase: "light",
      candidates: [{ id: "mem-x", content: "token sk-abcdef0123456789ABCDEF", accessCount: 9 }],
      now: () => fixedNow
    });

    assert.doesNotMatch(JSON.stringify(result), /sk-abcdef/);
    assert.match(result.proposals[0]?.summary ?? "", /\[REDACTED_SECRET\]/);
  });

  it("blocks promotion while the memory-write gate is closed and writes through it when open", async () => {
    const proposal = runNeonDreamingReflection({
      gate: armedGate,
      phase: "light",
      candidates,
      now: () => fixedNow
    }).proposals[0];
    assert.ok(proposal);

    const closedMemoryGate: INeonMemoryWriteGate = {
      enabled: false,
      reason: "write-disabled",
      envKey: "NEON_MEMORY_WRITE_ENABLED"
    };
    const openMemoryGate: INeonMemoryWriteGate = {
      enabled: true,
      reason: "write-enabled",
      envKey: "NEON_MEMORY_WRITE_ENABLED"
    };
    const dir = await mkdtemp(join(tmpdir(), "neon-dream-"));
    const storePath = join(dir, "store.json");

    try {
      const blocked = await promoteNeonDreamProposal({
        proposal,
        memoryGate: closedMemoryGate,
        storePath,
        now: () => fixedNow
      });
      assert.equal(blocked.state, "blocked");

      const written = await promoteNeonDreamProposal({
        proposal,
        memoryGate: openMemoryGate,
        storePath,
        now: () => fixedNow
      });
      assert.equal(written.state, "written");
      assert.equal(written.safety.targetedRealMemoryDb, false);

      const store = await readNeonMemoryStore(storePath);
      assert.equal(store.length, 1);
      assert.match(store[0]?.category ?? "", /^dream:light:promote$/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
