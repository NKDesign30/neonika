import assert from "node:assert/strict";
import { appendFile, chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonRetireEvidenceSnapshot,
  createNeonRetireExportBundle,
  parseNeonRetireBundle,
  resolveGatewayStatePaths,
  resolveNeonRetireEvidencePath,
  serializeNeonRetireBundle,
  verifyNeonRetireRoundTrip,
  writeNeonGatewayRun,
  writeNeonRetireRoundTripEvidence,
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

  it("persists only private leak-safe proof after a non-empty verified round-trip", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-retire-evidence-"));
    const sensitiveRunId = "sensitive-retire-run-id";

    try {
      await writeNeonGatewayRun(projectRoot, retireRun(sensitiveRunId));
      const writeResult = await writeNeonRetireRoundTripEvidence(
        projectRoot,
        "2026-08-11T20:00:00.000Z"
      );
      const record = writeResult.record;
      const snapshot = await createNeonRetireEvidenceSnapshot(projectRoot);
      const evidencePath = resolveNeonRetireEvidencePath(projectRoot);
      const raw = await readFile(evidencePath, "utf8");
      const stats = await lstat(evidencePath);

      assert.equal(record.exported, 1);
      assert.equal(record.imported, 1);
      assert.equal(record.roundTripOk, true);
      assert.match(record.bundleSha256, /^[a-f0-9]{64}$/u);
      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.record?.bundleSha256, record.bundleSha256);
      assert.equal(stats.mode & 0o777, 0o600);
      assert.doesNotMatch(raw, new RegExp(sensitiveRunId, "u"));
      assert.doesNotMatch(raw, /Retire export proof/u);
      assert.doesNotMatch(raw, /Users\/operator/u);
      assert.doesNotMatch(raw, /900000000000000005/u);

      await writeNeonGatewayRun(projectRoot, retireRun("run-added-after-proof"));
      const stale = await createNeonRetireEvidenceSnapshot(projectRoot);
      assert.equal(stale.state, "blocked");
      assert.match(stale.diagnostics.join(" "), /current full run store/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects empty proof and treats malformed or non-private evidence as blocked", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-retire-evidence-invalid-"));
    const evidencePath = resolveNeonRetireEvidencePath(projectRoot);

    try {
      await assert.rejects(
        writeNeonRetireRoundTripEvidence(projectRoot, "2026-08-11T20:00:00.000Z"),
        /non-empty run history/u
      );
      await writeNeonGatewayRun(projectRoot, retireRun("run-private-proof"));
      await writeNeonRetireRoundTripEvidence(
        projectRoot,
        "2026-08-11T20:00:00.000Z"
      );
      await chmod(evidencePath, 0o644);
      assert.equal((await createNeonRetireEvidenceSnapshot(projectRoot)).state, "blocked");

      await writeFile(evidencePath, "{not-json\n", { mode: 0o600 });
      await chmod(evidencePath, 0o600);
      assert.equal((await createNeonRetireEvidenceSnapshot(projectRoot)).state, "blocked");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("refuses to certify a partially corrupt full run store", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-retire-evidence-corrupt-store-"));

    try {
      await writeNeonGatewayRun(projectRoot, retireRun("run-before-corrupt-line"));
      await appendFile(resolveGatewayStatePaths(projectRoot).runsPath, "{not-a-run\n", "utf8");

      await assert.rejects(
        writeNeonRetireRoundTripEvidence(projectRoot, "2026-08-11T20:00:00.000Z"),
        /fully parseable run store/u
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked state boundary without reading or writing its target", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-retire-evidence-symlink-root-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "neon-retire-evidence-external-"));

    try {
      await symlink(externalRoot, resolveGatewayStatePaths(projectRoot).stateRoot);

      await assert.rejects(
        writeNeonGatewayRun(projectRoot, retireRun("run-must-not-cross-boundary")),
        /state root must be a real directory/u
      );
      assert.equal((await createNeonRetireEvidenceSnapshot(projectRoot)).state, "blocked");
      await assert.rejects(lstat(join(externalRoot, "cutover")), /ENOENT/u);
      await assert.rejects(lstat(join(externalRoot, "gateway")), /ENOENT/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
      await rm(externalRoot, { force: true, recursive: true });
    }
  });
});
