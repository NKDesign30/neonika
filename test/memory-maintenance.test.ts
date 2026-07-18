import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNeonLocalEmbeddingProvider,
  runNeonMemoryMaintenance,
  renderNeonMemoryMaintenanceReport,
  writeNeonMemoryDbEntry,
  type INeonMemoryDbWriteGate
} from "../src/index.js";

const armedGate: INeonMemoryDbWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

describe("neon memory maintenance facade", () => {
  let root = "";
  let dbPath = "";
  let backupDir = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-maintenance-"));
    dbPath = join(root, "semantic-memory.db");
    backupDir = join(root, "backups");
    const embedder = createNeonLocalEmbeddingProvider();
    await writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      embedder,
      input: {
        sourceFile: "learnings/keep.md",
        content: "Wichtige Cutover-Entscheidung die oft recalled wird und bleiben muss.",
        agent: "neo",
        category: "learnings",
        importanceScore: 80
      }
    });
    await writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      embedder,
      input: {
        sourceFile: "noise/never-recalled.md",
        content: "Belangloser Noise-Eintrag ohne jeden Recall seit Monaten.",
        agent: "neo",
        category: "discoveries",
        importanceScore: 15
      }
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs backup first, mutating steps armed, prune plan-only by default", async () => {
    const result = await runNeonMemoryMaintenance({
      dbPath,
      backupDir,
      gate: armedGate,
      now: () => new Date("2026-07-07T03:15:00.000Z")
    });

    assert.equal(result.backup.state, "backed-up");
    assert.ok(result.backup.snapshotPath && existsSync(result.backup.snapshotPath));
    assert.equal(result.importance.state, "recalculated");
    assert.equal(result.relations.state, "discovered");
    assert.equal(result.pruneApplied, false);
    assert.notEqual(result.prune.state, "pruned");
    assert.ok(result.diagnostics.some((line) => line.includes("plan-only")));

    const report = renderNeonMemoryMaintenanceReport(result);
    assert.match(report, /Neonika Memory Maintenance/);
  });

  it("applies prune only with the explicit opt-in", async () => {
    const result = await runNeonMemoryMaintenance({
      dbPath,
      backupDir,
      gate: armedGate,
      applyPrune: true,
      pruneMaxScore: 25,
      now: () => new Date("2026-07-07T03:15:00.000Z")
    });

    assert.equal(result.pruneApplied, true);
    assert.equal(result.prune.state, "pruned");
  });

  it("degrades every mutating step when the gate is disarmed", async () => {
    const result = await runNeonMemoryMaintenance({
      dbPath,
      backupDir,
      gate: { enabled: false, reason: "write-disabled", envKey: "NEON_MEMORY_WRITE_ENABLED" }
    });

    // Backup is a read-copy and always allowed; mutations stay blocked.
    assert.equal(result.backup.state, "backed-up");
    assert.notEqual(result.importance.state, "recalculated");
    assert.notEqual(result.relations.state, "discovered");
    assert.notEqual(result.prune.state, "pruned");
  });
});
