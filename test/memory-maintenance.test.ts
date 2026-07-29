import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  // Die Wartung läuft gegen dieses feste Jetzt; der Recall liegt kurz davor.
  const maintenanceNow = new Date("2026-07-07T03:15:00.000Z");
  const lastRecall = new Date("2026-07-07T02:00:00.000Z");

  /**
   * Der Writer setzt `last_accessed_at` nicht — erst ein Recall tut das. Ohne
   * diesen Zeitstempel frieren Decay und Prune absichtlich ein (eine tote Suche
   * erzeugt dieselbe Signatur wie unwichtige Einträge). Die Tests hier prüfen
   * den Normalbetrieb, also muss die Telemetrie vorhanden sein.
   */
  function registerRecall(): void {
    const database = new DatabaseSync(dbPath);
    try {
      database
        .prepare("UPDATE memory_entries SET last_accessed_at = ? WHERE source_file = 'learnings/keep.md'")
        .run(lastRecall.toISOString());
    } finally {
      database.close();
    }
  }

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
    registerRecall();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs backup first, mutating steps armed, prune plan-only by default", async () => {
    const result = await runNeonMemoryMaintenance({
      dbPath,
      backupDir,
      gate: armedGate,
      now: () => maintenanceNow
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
      now: () => maintenanceNow
    });

    assert.equal(result.pruneApplied, true);
    assert.equal(result.prune.state, "pruned");
  });

  it("degrades every mutating step when the gate is disarmed", async () => {
    const result = await runNeonMemoryMaintenance({
      dbPath,
      backupDir,
      gate: { enabled: false, reason: "write-disabled", envKey: "NEON_MEMORY_WRITE_ENABLED" },
      // Mit frischer Telemetrie, damit hier wirklich das Gate blockt und nicht
      // versehentlich der Recall-Freeze — sonst wäre der Test grün aus dem
      // falschen Grund.
      now: () => maintenanceNow
    });

    // Backup is a read-copy and always allowed; mutations stay blocked.
    assert.equal(result.backup.state, "backed-up");
    assert.notEqual(result.importance.state, "recalculated");
    assert.notEqual(result.relations.state, "discovered");
    assert.notEqual(result.prune.state, "pruned");
  });
});
