import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  bootstrapNeonMemorySchema,
  createNeonMemoryBackup,
  renderNeonMemoryBackupReport,
  rotateNeonMemoryBackups,
  verifyNeonMemorySnapshot
} from "../src/index.js";

function seedDb(dbPath: string, rows: number): void {
  const database = new DatabaseSync(dbPath);
  try {
    bootstrapNeonMemorySchema(database);
    const insert = database.prepare(
      "INSERT INTO memory_entries (source_file, content, agent, category, content_hash) VALUES (?, ?, ?, ?, ?)"
    );
    for (let index = 0; index < rows; index += 1) {
      insert.run(`s${index}.md`, `content number ${index}`, "neo", "discoveries", `hash-${index}`);
    }
  } finally {
    database.close();
  }
}

describe("neon memory backup", () => {
  let root = "";
  let dbPath = "";
  let backupDir = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-backup-"));
    dbPath = join(root, "semantic-memory.db");
    backupDir = join(root, "backups");
    seedDb(dbPath, 5);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a re-openable snapshot with the same entry count, leaving the source intact", async () => {
    const before = await readFile(dbPath);
    const result = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "2026-06-04T00-00-00" });
    assert.equal(result.state, "backed-up");
    assert.equal(result.entries, 5);
    assert.ok(result.bytes > 0);
    assert.ok(result.snapshotPath);
    const report = renderNeonMemoryBackupReport(result);
    assert.doesNotMatch(report, new RegExp(escapeRegExp(root), "u"));
    assert.doesNotMatch(report, /Checksum:/u);

    // Snapshot is a standalone, readable DB with the same rows.
    const snapshot = new DatabaseSync(result.snapshotPath!, { readOnly: true });
    try {
      const row = snapshot.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
      assert.equal(row.n, 5);
    } finally {
      snapshot.close();
    }

    // Source DB was opened read-only: byte-identical after the backup.
    const after = await readFile(dbPath);
    assert.ok(before.equals(after));
  });

  it("can skip the checksum for state-only verification", async () => {
    const backup = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "state-only" });
    assert.ok(backup.snapshotPath);

    const verification = await verifyNeonMemorySnapshot(
      backup.snapshotPath,
      undefined,
      { computeChecksum: false }
    );

    assert.equal(verification.state, "verified");
    assert.equal(verification.entries, 5);
    assert.equal(verification.checksum, undefined);
  });

  it("rotates old snapshots, keeping only the newest N", async () => {
    const stamps = [
      "2026-06-01T00-00-00",
      "2026-06-02T00-00-00",
      "2026-06-03T00-00-00",
      "2026-06-04T00-00-00"
    ];
    for (const stamp of stamps) {
      await createNeonMemoryBackup({ dbPath, backupDir, keep: 2, stamp });
    }
    const remaining = (await readdir(backupDir)).filter((name) => name.endsWith(".db")).sort();
    assert.equal(remaining.length, 2);
    // Newest two stamps survive.
    assert.ok(remaining.includes("semantic-memory-2026-06-03T00-00-00.db"));
    assert.ok(remaining.includes("semantic-memory-2026-06-04T00-00-00.db"));
  });

  it("skips cleanly on a stamp collision instead of crashing", async () => {
    const first = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "2026-06-04T00-00-00" });
    assert.equal(first.state, "backed-up");
    // Same stamp again: VACUUM INTO would throw on the existing file; we skip.
    const second = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "2026-06-04T00-00-00" });
    assert.equal(second.state, "skipped");
    assert.match(second.diagnostics[0] ?? "", /already exists/);

    await writeFile(join(backupDir, "semantic-memory-corrupt.db"), "not sqlite", {
      mode: 0o600
    });
    const corrupt = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "corrupt" });
    assert.equal(corrupt.state, "invalid");
    assert.equal(corrupt.verification, "failed");
  });

  it("rejects a linked snapshot collision instead of trusting the link target", async () => {
    await mkdir(backupDir, { recursive: true });
    const snapshotPath = join(backupDir, "semantic-memory-linked.db");
    await symlink(dbPath, snapshotPath);

    const result = await createNeonMemoryBackup({ dbPath, backupDir, stamp: "linked" });

    assert.equal(result.state, "invalid");
    assert.equal(result.snapshotPath, undefined);
    assert.match(result.diagnostics[0] ?? "", /not a private regular file/u);
  });

  it("rejects a linked backup directory before changing or writing through it", async () => {
    const realBackupDir = join(root, "real-backups");
    const linkedBackupDir = join(root, "linked-backups");
    await mkdir(realBackupDir, { recursive: true });
    await symlink(realBackupDir, linkedBackupDir);

    const result = await createNeonMemoryBackup({
      dbPath,
      backupDir: linkedBackupDir,
      stamp: "linked-directory"
    });

    assert.equal(result.state, "invalid");
    assert.equal((await readdir(realBackupDir)).length, 0);
  });

  it("rejects the source database directory as a rotation target", async () => {
    const result = await createNeonMemoryBackup({
      dbPath,
      backupDir: root,
      keep: 1,
      stamp: "same-directory"
    });

    assert.equal(result.state, "invalid");
    assert.match(result.diagnostics[0] ?? "", /separate from the source database/u);
    assert.equal((await readdir(root)).includes("semantic-memory.db"), true);
  });

  it("rotateNeonMemoryBackups ignores unrelated files", async () => {
    await mkdtemp(join(tmpdir(), "noop-"));
    const dir = join(root, "mixed");
    await rm(dir, { recursive: true, force: true });
    await createNeonMemoryBackup({ dbPath, backupDir: dir, keep: 1, stamp: "2026-06-04T00-00-00" });
    await writeFile(join(dir, "readme.txt"), "not a snapshot", "utf8");
    const removed = await rotateNeonMemoryBackups(dir, 1);
    assert.equal(removed.length, 0);
    const remaining = await readdir(dir);
    assert.ok(remaining.includes("readme.txt"));
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
