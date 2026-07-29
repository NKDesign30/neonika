// Adapted from NK Design's Neon runtime tests for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  bootstrapNeonMemorySchema,
  findNeonMemoryMaintenanceBlock,
  resolveNeonMemoryMaintenanceAccess,
  type INeonMemoryDbWriteGate
} from "../src/index.js";

const armed: INeonMemoryDbWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};
const disarmed: INeonMemoryDbWriteGate = {
  enabled: false,
  reason: "write-disabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

const hour = 60 * 60 * 1000;

describe("Neon memory maintenance gate", () => {
  let root = "";
  let dbPath = "";
  let database: DatabaseSync | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-maint-gate-"));
    dbPath = join(root, "semantic-memory.db");
    const seed = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(seed);
    } finally {
      seed.close();
    }
    database = new DatabaseSync(dbPath);
  });

  afterEach(async () => {
    database?.close();
    database = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function recallAt(when: number): void {
    database?.exec(
      `INSERT INTO memory_entries (source_file, content, agent, category, content_hash, last_accessed_at)
        VALUES ('a.md', 'inhalt', 'neo', 'discoveries', 'h-a', '${new Date(when).toISOString()}')`
    );
  }

  it("opens read-only while the write env is disarmed", () => {
    const access = resolveNeonMemoryMaintenanceAccess({ dbPath, gate: disarmed });
    assert.equal(access.canWrite, false);
    assert.equal(access.targetsRealDb, false);
  });

  it("lets an armed pass write against a temp database", () => {
    const access = resolveNeonMemoryMaintenanceAccess({ dbPath, gate: armed });
    assert.equal(access.canWrite, true);
  });

  it("blocks a disarmed pass and names the env key", () => {
    const access = resolveNeonMemoryMaintenanceAccess({ dbPath, gate: disarmed });
    const block = findNeonMemoryMaintenanceBlock(access, database!, {
      labels: { plan: "relation discovery" }
    });
    assert.equal(block?.state, "blocked");
    assert.match(block!.diagnostic, /relation discovery plan only: NEON_MEMORY_WRITE_ENABLED/);
  });

  it("lets an armed pass through when nothing blocks it", () => {
    const access = resolveNeonMemoryMaintenanceAccess({ dbPath, gate: armed });
    const block = findNeonMemoryMaintenanceBlock(access, database!, {
      labels: { plan: "relation discovery" }
    });
    assert.equal(block, null);
  });

  it("freezes before the write gates, so a stale-telemetry run never reads as merely disarmed", () => {
    // Order is the point: both conditions hold, and the caller must learn that
    // recall went silent rather than that the env was not armed.
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    recallAt(now - 80 * hour);
    const access = resolveNeonMemoryMaintenanceAccess({ dbPath, gate: disarmed });
    const block = findNeonMemoryMaintenanceBlock(access, database!, {
      labels: { freeze: "prune", plan: "prune", writeVerb: "archive" },
      maxRecallGapHours: 24,
      now
    });
    assert.equal(block?.state, "frozen");
    assert.match(block!.diagnostic, /^prune frozen:/);
  });

  it("does not freeze a pass that only adds rows", () => {
    // Backfill and relation discovery add data instead of reinterpreting
    // silence, so telemetry is not their precondition — no freeze label, and
    // the return type cannot even carry "frozen".
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    recallAt(now - 500 * hour);
    const access = resolveNeonMemoryMaintenanceAccess({ dbPath, gate: armed });
    const block = findNeonMemoryMaintenanceBlock(access, database!, {
      labels: { plan: "embedding backfill" },
      now
    });
    assert.equal(block, null);
  });

  it("uses the caller's verb in the real-DB hint", () => {
    const access = resolveNeonMemoryMaintenanceAccess({
      dbPath: join(root, "x.db"),
      gate: armed
    });
    // targetsRealDb is false for a temp path, so force the branch the way the
    // real DB would present itself.
    const realish = { ...access, targetsRealDb: true, allowRealDb: false };
    const block = findNeonMemoryMaintenanceBlock(realish, database!, {
      labels: { freeze: "prune", plan: "prune", writeVerb: "archive" },
      maxRecallGapHours: 0
    });
    assert.equal(block?.state, "planned");
    assert.match(block!.diagnostic, /set allowRealDb to archive/);
  });
});
