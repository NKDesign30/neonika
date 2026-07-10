import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  defaultNeonMemoryDbPath,
  recordNeonMemoryDbAccess,
  searchNeonMemoryDb,
  writeNeonMemoryDbEntry,
  type INeonMemoryDbWriteGate
} from "../src/index.js";

const armedGate: INeonMemoryDbWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

const disabledGate: INeonMemoryDbWriteGate = {
  enabled: false,
  reason: "write-disabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

describe("neon memory db access tracking (Ebbinghaus feed)", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-access-tracking-"));
    dbPath = join(root, "semantic-memory.db");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const seedEntry = async (): Promise<number> => {
    const write = await writeNeonMemoryDbEntry({
      dbPath,
      gate: armedGate,
      input: {
        sourceFile: "learnings/2026-07-07.md",
        content: "Access-Tracking füttert die Ebbinghaus-Retention der neuen Memory-DB.",
        agent: "neo",
        category: "learnings"
      }
    });
    assert.equal(write.state, "written");
    assert.ok(typeof write.entryId === "number");
    return write.entryId;
  };

  const readAccessRow = (entryId: number): { access_count: number; last_accessed_at: string | null } => {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return database
        .prepare("SELECT access_count, last_accessed_at FROM memory_entries WHERE id = ?")
        .get(entryId) as { access_count: number; last_accessed_at: string | null };
    } finally {
      database.close();
    }
  };

  it("increments access_count and stamps last_accessed_at for tracked hits", async () => {
    const entryId = await seedEntry();
    const before = readAccessRow(entryId);
    assert.equal(before.access_count, 0);
    assert.equal(before.last_accessed_at, null);

    const now = (): Date => new Date("2026-07-07T10:00:00.000Z");
    const first = recordNeonMemoryDbAccess({ dbPath, entryIds: [entryId], gate: armedGate, now });
    const second = recordNeonMemoryDbAccess({ dbPath, entryIds: [entryId], gate: armedGate, now });
    const after = readAccessRow(entryId);

    assert.equal(first.state, "tracked");
    assert.equal(first.updatedRows, 1);
    assert.equal(second.state, "tracked");
    assert.equal(after.access_count, 2);
    assert.equal(after.last_accessed_at, "2026-07-07T10:00:00.000Z");
  });

  it("keeps the search read path intact while tracking (search -> track roundtrip)", async () => {
    const entryId = await seedEntry();
    const hits = searchNeonMemoryDb("Ebbinghaus", { dbPath, limit: 5 });
    assert.equal(hits.length, 1);

    const tracking = recordNeonMemoryDbAccess({
      dbPath,
      entryIds: hits.map((hit) => hit.id),
      gate: armedGate
    });

    assert.equal(tracking.state, "tracked");
    assert.equal(readAccessRow(entryId).access_count, 1);
  });

  it("skips without hits and blocks without an armed gate - no side effect", async () => {
    const entryId = await seedEntry();

    const skipped = recordNeonMemoryDbAccess({ dbPath, entryIds: [], gate: armedGate });
    const blocked = recordNeonMemoryDbAccess({ dbPath, entryIds: [entryId], gate: disabledGate });

    assert.equal(skipped.state, "skipped");
    assert.equal(blocked.state, "blocked");
    assert.equal(readAccessRow(entryId).access_count, 0);
  });

  it("refuses to mutate the real v2 archive DB without allowRealDb", () => {
    const result = recordNeonMemoryDbAccess({
      dbPath: defaultNeonMemoryDbPath,
      entryIds: [1],
      gate: armedGate
    });

    assert.equal(result.state, "blocked");
    assert.equal(result.updatedRows, 0);
    assert.equal(result.safety.targetedRealMemoryDb, true);
  });
});
