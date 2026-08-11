import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  bootstrapNeonMemorySchema,
  createNeonMemoryBackup,
  executeNeonMemoryWriteback,
  resolveNeonMemoryRollbackGate,
  resolveNeonMemoryWritebackGate,
  rollbackNeonMemoryWriteback,
  searchNeonMemoryDb,
  writeNeonMemoryDbEntries,
  type INeonMemoryDbWriteInput
} from "../src/index.js";

const firstInput: INeonMemoryDbWriteInput = {
  sourceFile: "live-index/discord/first.md",
  content: "First accepted live-index memory entry.",
  agent: "chaty",
  category: "live-index"
};

const secondInput: INeonMemoryDbWriteInput = {
  sourceFile: "live-index/codex/second.md",
  content: "Second accepted live-index memory entry.",
  agent: "chaty",
  category: "live-index"
};

describe("productive Neonika memory writeback", () => {
  let root = "";
  let primaryDbPath = "";
  let backupDir = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-memory-writeback-"));
    primaryDbPath = join(root, "memory", "semantic-memory.db");
    backupDir = join(root, "memory-backups");
    await seedDatabase(primaryDbPath);
    await chmod(primaryDbPath, 0o600);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the default gate side-effect free and hides private paths and content", async () => {
    const result = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate: resolveNeonMemoryWritebackGate({}),
      inputs: [firstInput]
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.state, "blocked");
    assert.equal(result.target.reason, "not-evaluated");
    assert.equal(result.backup.state, "not-created");
    assert.equal(existsSync(backupDir), false);
    assert.equal(countEntries(primaryDbPath), 1);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(root), "u"));
    assert.doesNotMatch(serialized, /First accepted live-index/u);
  });

  it("blocks target mismatch and unsafe database permissions before backup or write", async () => {
    const otherDbPath = join(root, "other", "semantic-memory.db");
    await seedDatabase(otherDbPath);
    await chmod(otherDbPath, 0o600);
    const gate = resolveNeonMemoryWritebackGate({
      NEON_MEMORY_WRITE_ENABLED: "ready",
      NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
    });

    const mismatch = await executeNeonMemoryWriteback({
      targetDbPath: otherDbPath,
      primaryDbPath,
      backupDir,
      gate,
      inputs: [firstInput]
    });
    assert.equal(mismatch.state, "blocked");
    assert.equal(mismatch.target.reason, "target-mismatch");
    assert.equal(existsSync(backupDir), false);

    const sameDirectoryBackup = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir: dirname(primaryDbPath),
      gate,
      inputs: [firstInput]
    });
    assert.equal(sameDirectoryBackup.state, "blocked");
    assert.equal(sameDirectoryBackup.target.reason, "invalid-backup-target");
    assert.equal(countEntries(primaryDbPath), 1);

    const linkedBackupTarget = join(root, "linked-backup-target");
    await mkdir(linkedBackupTarget, { recursive: true, mode: 0o700 });
    await symlink(linkedBackupTarget, backupDir);
    const linkedBackup = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate,
      inputs: [firstInput]
    });
    assert.equal(linkedBackup.state, "blocked");
    assert.equal(linkedBackup.target.reason, "invalid-backup-target");
    assert.equal((await readdir(linkedBackupTarget)).length, 0);
    await rm(backupDir, { force: true });

    await chmod(primaryDbPath, 0o644);
    const unsafe = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate,
      inputs: [firstInput]
    });
    assert.equal(unsafe.state, "blocked");
    assert.equal(unsafe.target.reason, "unsafe-target-permissions");
    assert.equal(existsSync(backupDir), false);
  });

  it("creates and verifies a private pre-write backup before one atomic batch", async () => {
    const now = Date.now();
    const result = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate: resolveNeonMemoryWritebackGate({
        NEON_MEMORY_WRITE_ENABLED: "ready",
        NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
      }),
      inputs: [firstInput, secondInput],
      operationId: "writeback-success",
      now: () => new Date(now)
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.state, "written");
    assert.equal(result.target.state, "validated");
    assert.equal(result.backup.state, "verified");
    assert.match(result.backup.snapshotId ?? "", /^semantic-memory-/u);
    assert.equal(result.writes.written, 2);
    assert.equal(countEntries(primaryDbPath), 3);
    assert.equal((await lstat(backupDir)).mode & 0o077, 0);
    assert.equal((await lstat(join(backupDir, result.backup.snapshotId!))).mode & 0o077, 0);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(root), "u"));
    assert.doesNotMatch(serialized, /First accepted live-index/u);
  });

  it("commits FTS-only fallback rows while exposing embedding degradation", async () => {
    const result = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate: resolveNeonMemoryWritebackGate({
        NEON_MEMORY_WRITE_ENABLED: "ready",
        NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
      }),
      inputs: [firstInput],
      embedder: {
        name: "test:unavailable",
        dimensions: 2,
        embed: async (): Promise<Float32Array> => {
          throw new Error("fixture embedding unavailable");
        }
      },
      operationId: "writeback-degraded",
      now: () => new Date(Date.now())
    });

    assert.equal(result.state, "written");
    assert.equal(result.writes.written, 1);
    assert.equal(result.writes.embedded, 0);
    assert.equal(result.writes.degraded, 1);
  });

  it("rolls back the whole SQLite transaction when one entry fails", async () => {
    installRejectingTrigger(primaryDbPath);

    await assert.rejects(
      writeNeonMemoryDbEntries({
        dbPath: primaryDbPath,
        gate: {
          enabled: true,
          reason: "write-enabled",
          envKey: "NEON_MEMORY_WRITE_ENABLED"
        },
        inputs: [firstInput, { ...secondInput, sourceFile: "reject.md" }],
        dedupe: "source-file"
      }),
      /fixture-reject/u
    );

    assert.equal(countEntries(primaryDbPath), 1);
    assert.equal(searchNeonMemoryDb("First accepted", { dbPath: primaryDbPath }).length, 0);
  });

  it("restores only a verified snapshot behind the rollback gate and verifies the target", async () => {
    const now = Date.now();
    const writeback = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate: resolveNeonMemoryWritebackGate({
        NEON_MEMORY_WRITE_ENABLED: "ready",
        NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
      }),
      inputs: [firstInput],
      operationId: "before-rollback",
      now: () => new Date(now)
    });
    const snapshotId = writeback.backup.snapshotId;
    assert.ok(snapshotId);
    assert.equal(countEntries(primaryDbPath), 2);

    const blocked = await rollbackNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      snapshotId,
      gate: resolveNeonMemoryRollbackGate({})
    });
    assert.equal(blocked.state, "blocked");
    assert.equal(countEntries(primaryDbPath), 2);

    const restored = await rollbackNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      snapshotId,
      gate: resolveNeonMemoryRollbackGate({ NEON_MEMORY_ROLLBACK_ENABLED: "ready" }),
      operationId: "restore-once",
      now: () => new Date(now + 60_000)
    });
    const serialized = JSON.stringify(restored);

    assert.equal(restored.state, "restored");
    assert.equal(restored.verification, "verified");
    assert.ok(restored.recoveryAttempts <= 1);
    assert.equal(countEntries(primaryDbPath), 1);
    assert.equal(searchNeonMemoryDb("First accepted", { dbPath: primaryDbPath }).length, 0);
    assert.ok((await readdir(backupDir)).filter((name) => name.endsWith(".db")).length >= 2);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(root), "u"));
  });

  it("recovers the previous target exactly once when the selected restore cannot start", async () => {
    const now = Date.now();
    const writeback = await executeNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      gate: resolveNeonMemoryWritebackGate({
        NEON_MEMORY_WRITE_ENABLED: "ready",
        NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
      }),
      inputs: [firstInput],
      operationId: "before-recovery-test",
      now: () => new Date(now)
    });
    const snapshotId = writeback.backup.snapshotId;
    assert.ok(snapshotId);
    assert.equal(countEntries(primaryDbPath), 2);
    const operationId = "restore-with-recovery";
    await writeFile(
      join(dirname(primaryDbPath), `.semantic-memory-restore-${operationId}.tmp`),
      "force the selected restore staging collision",
      { mode: 0o600 }
    );

    const result = await rollbackNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      snapshotId,
      gate: resolveNeonMemoryRollbackGate({ NEON_MEMORY_ROLLBACK_ENABLED: "ready" }),
      operationId,
      now: () => new Date(now + 60_000)
    });

    assert.equal(result.state, "failed");
    assert.equal(result.reason, "restore-failed");
    assert.equal(result.recoveryAttempts, 1);
    assert.equal(countEntries(primaryDbPath), 2);
    assert.equal(countSourceEntries(primaryDbPath, firstInput.sourceFile), 1);
  });

  it("rejects traversal and corrupt snapshots without touching the current target", async () => {
    await writeFile(join(root, "outside.db"), "not sqlite", "utf8");
    const gate = resolveNeonMemoryRollbackGate({ NEON_MEMORY_ROLLBACK_ENABLED: "ready" });

    const traversal = await rollbackNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      snapshotId: "../outside.db",
      gate
    });
    assert.equal(traversal.state, "blocked");
    assert.equal(traversal.reason, "invalid-snapshot-id");

    await rm(backupDir, { recursive: true, force: true });
    await seedBackupDirectory(backupDir);
    const corruptId = "semantic-memory-corrupt.db";
    await writeFile(join(backupDir, corruptId), "not sqlite", { mode: 0o600 });
    const corrupt = await rollbackNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir,
      snapshotId: corruptId,
      gate
    });

    assert.equal(corrupt.state, "blocked");
    assert.equal(corrupt.reason, "snapshot-verification-failed");
    assert.equal(countEntries(primaryDbPath), 1);

    const privateBackupDir = join(root, "private-backups");
    const linkedBackupDir = join(root, "linked-backups");
    const privateBackup = await createPrivateBackup(primaryDbPath, privateBackupDir);
    await symlink(privateBackupDir, linkedBackupDir);
    const linked = await rollbackNeonMemoryWriteback({
      targetDbPath: primaryDbPath,
      primaryDbPath,
      backupDir: linkedBackupDir,
      snapshotId: privateBackup,
      gate
    });
    assert.equal(linked.state, "blocked");
    assert.equal(linked.reason, "invalid-target");
    assert.equal(countEntries(primaryDbPath), 1);
  });
});

async function createPrivateBackup(dbPath: string, backupDir: string): Promise<string> {
  const backup = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "linked-source" });
  assert.ok(backup.snapshotId);
  return backup.snapshotId;
}

async function seedDatabase(dbPath: string): Promise<void> {
  await seedBackupDirectory(dirname(dbPath));
  const database = new DatabaseSync(dbPath);
  try {
    bootstrapNeonMemorySchema(database);
    database
      .prepare(
        "INSERT INTO memory_entries (source_file, content, agent, category, content_hash) VALUES (?, ?, ?, ?, ?)"
      )
      .run("seed.md", "Original primary memory row.", "neo", "learnings", "seed-hash");
  } finally {
    database.close();
  }
}

async function seedBackupDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function installRejectingTrigger(dbPath: string): void {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TRIGGER reject_fixture_entry
      BEFORE INSERT ON memory_entries
      WHEN NEW.source_file = 'reject.md'
      BEGIN
        SELECT RAISE(ABORT, 'fixture-reject');
      END;
    `);
  } finally {
    database.close();
  }
}

function countEntries(dbPath: string): number {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
      readonly count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
}

function countSourceEntries(dbPath: string, sourceFile: string): number {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM memory_entries WHERE source_file = ?")
      .get(sourceFile) as { readonly count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
