import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonMirrorEvidenceSnapshot,
  readNeonMirrorEvidence,
  renderNeonMirrorEvidenceReport,
  resolveNeonMirrorEvidencePaths,
  writeNeonMirrorEvidence
} from "../src/index.js";

describe("Neon Mirror evidence", () => {
  it("writes redacted old-vs-new comparison evidence and reports ready", async () => {
    const projectRoot = await createTempProjectRoot();
    const secretValue = "sk-mirrorsecretsecretsecret";

    try {
      const record = await writeNeonMirrorEvidence(projectRoot, {
        evidenceId: "mirror-evidence-1",
        prompt: `Compare this secret ${secretValue}`,
        legacyOutput: "Legacy answer keeps Operator context.",
        neonOutput: "Neon answer keeps Operator context.",
        verdict: "match",
        legacyLatencyMs: 1200,
        neonLatencyMs: 800,
        reviewer: "chaty",
        notes: `No leak ${secretValue}`,
        now: () => new Date("2026-05-31T21:30:00.000Z")
      });
      const snapshot = await createNeonMirrorEvidenceSnapshot(projectRoot, {
        now: () => new Date("2026-05-31T21:31:00.000Z")
      });
      const report = renderNeonMirrorEvidenceReport(snapshot);
      const serialized = JSON.stringify(snapshot);

      assert.equal(record.evidenceId, "mirror-evidence-1");
      assert.equal(record.verdict, "match");
      assert.equal(record.latencyDeltaMs, -400);
      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.accepted, 1);
      assert.equal(snapshot.latestRecord?.evidenceId, "mirror-evidence-1");
      assert.match(report, /Neon Mirror Evidence: ready/);
      assert.doesNotMatch(serialized, new RegExp(secretValue));
      assert.doesNotMatch(report, new RegExp(secretValue));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks mirror readiness on drift or failed evidence", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonMirrorEvidence(projectRoot, {
        evidenceId: "mirror-evidence-drift",
        prompt: "Compare task routing.",
        legacyOutput: "Legacy routes to Neo.",
        neonOutput: "Neon misses the requested route.",
        verdict: "drift",
        now: () => new Date("2026-05-31T21:32:00.000Z")
      });

      const snapshot = await createNeonMirrorEvidenceSnapshot(projectRoot);

      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.totals.drift, 1);
      assert.ok(snapshot.recovery.some((entry) => entry.includes("Review drift")));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("skips malformed mirror evidence lines", async () => {
    const projectRoot = await createTempProjectRoot();
    const paths = resolveNeonMirrorEvidencePaths(projectRoot);

    try {
      await mkdir(dirname(paths.evidencePath), { recursive: true });
      await writeFile(
        paths.evidencePath,
        [
          "not-json",
          JSON.stringify({
            evidenceId: "mirror-evidence-valid",
            createdAt: "2026-05-31T21:33:00.000Z",
            promptHash: "hash",
            promptPreview: "prompt",
            legacyOutputPreview: "legacy",
            neonOutputPreview: "neon",
            verdict: "acceptable"
          })
        ].join("\n"),
        "utf8"
      );

      const records = await readNeonMirrorEvidence(projectRoot);

      assert.equal(records.length, 1);
      assert.equal(records[0]?.evidenceId, "mirror-evidence-valid");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-mirror-evidence-"));
}
