import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonMirrorEvidenceSnapshot,
  resolveNeonMirrorRunGate,
  runNeonMirrorComparison,
  type INeonMirrorRunGate,
  type INeonMirrorSideResult
} from "../src/index.js";

const armedGate: INeonMirrorRunGate = {
  enabled: true,
  reason: "mirror-run-enabled",
  envKey: "NEON_MIRROR_RUN_ENABLED"
};
const closedGate: INeonMirrorRunGate = {
  enabled: false,
  reason: "mirror-run-disabled",
  envKey: "NEON_MIRROR_RUN_ENABLED"
};

function neonSide(output: string, latencyMs = 100): (prompt: string) => Promise<INeonMirrorSideResult> {
  return () => Promise.resolve({ output, latencyMs, runId: "neon-mirror" });
}

describe("Neon mirror comparison run (DP-13)", () => {
  it("keeps the mirror run off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonMirrorRunGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonMirrorRunGate({ NEON_MIRROR_RUN_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonMirrorRunGate({ NEON_MIRROR_RUN_ENABLED: "0" }).enabled, false);
  });

  it("blocks the run and writes no evidence while the gate is closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-mirror-run-"));
    let neonInvoked = false;
    try {
      const result = await runNeonMirrorComparison({
        projectRoot: dir,
        prompt: "ping",
        gate: closedGate,
        runNeonSide: () => {
          neonInvoked = true;
          return Promise.resolve({ output: "pong" });
        },
        v3Side: { output: "pong" }
      });

      assert.equal(result.state, "blocked");
      assert.equal(result.safety.evidenceWritten, false);
      assert.equal(result.safety.drivesV3Live, false);
      assert.equal(neonInvoked, false);

      const snapshot = await createNeonMirrorEvidenceSnapshot(dir);
      assert.equal(snapshot.totals.records, 0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("drives the Neon side, takes v3 as input, and writes a match verdict with latency delta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-mirror-run-"));
    try {
      const result = await runNeonMirrorComparison({
        projectRoot: dir,
        prompt: "ping",
        gate: armedGate,
        runNeonSide: neonSide("pong", 120),
        v3Side: { output: "pong", latencyMs: 180, runId: "v3-mirror" }
      });

      assert.equal(result.state, "compared");
      assert.equal(result.verdict, "match");
      assert.equal(result.safety.evidenceWritten, true);
      assert.equal(result.safety.drivesV3Live, false);
      assert.equal(result.latencyDeltaMs, 120 - 180);
      assert.ok(result.evidenceId);

      const snapshot = await createNeonMirrorEvidenceSnapshot(dir);
      assert.equal(snapshot.totals.records, 1);
      assert.equal(snapshot.latestRecord?.verdict, "match");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("classifies whitespace-only differences as acceptable and real differences as drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-mirror-run-"));
    try {
      const acceptable = await runNeonMirrorComparison({
        projectRoot: dir,
        prompt: "ping",
        gate: armedGate,
        runNeonSide: neonSide("Hello   World"),
        v3Side: { output: "hello world" }
      });
      assert.equal(acceptable.verdict, "acceptable");

      const drift = await runNeonMirrorComparison({
        projectRoot: dir,
        prompt: "ping",
        gate: armedGate,
        runNeonSide: neonSide("completely different"),
        v3Side: { output: "pong" }
      });
      assert.equal(drift.verdict, "drift");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps secrets out of written evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-mirror-run-"));
    try {
      await runNeonMirrorComparison({
        projectRoot: dir,
        prompt: "token sk-abcdef0123456789ABCDEF",
        gate: armedGate,
        runNeonSide: neonSide("output with sk-abcdef0123456789ABCDEF"),
        v3Side: { output: "legacy sk-abcdef0123456789ABCDEF" }
      });

      const snapshot = await createNeonMirrorEvidenceSnapshot(dir);
      assert.doesNotMatch(JSON.stringify(snapshot), /sk-abcdef/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
