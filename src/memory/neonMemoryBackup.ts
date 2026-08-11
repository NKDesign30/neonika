import { openNeonMemoryDatabase } from "./neonMemoryDbOpen.js";
import { createReadStream } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { redactSnapshotText } from "../harness/redaction.js";
import { canonicalNeonDbPath } from "./neonMemoryDbProvider.js";

/**
 * Read-only memory-DB backup for Neonika (memory autarky).
 *
 * Replaces v2's nightly `~/.claude/bin/memory-backup` LaunchAgent in the autarkic
 * runtime. It takes a consistent snapshot via SQLite `VACUUM INTO` — which only
 * reads the source DB, so it never mutates the canonical memory DB — and writes a
 * timestamped `.db` snapshot into an explicit backup directory. Rotation keeps the
 * newest `keep` snapshots. The source path is never defaulted to the real DB by
 * this module's callers without intent; the snapshot target must be passed
 * explicitly, so a backup can never silently land somewhere unexpected.
 */

const defaultKeep = 14;

export interface INeonMemoryBackupOptions {
  readonly dbPath: string;
  readonly backupDir: string;
  readonly keep?: number;
  /** Stamp used in the snapshot filename. Injectable for deterministic tests. */
  readonly stamp?: string;
}

export interface INeonMemoryBackupResult {
  readonly state: "backed-up" | "skipped" | "invalid";
  readonly snapshotPath: string | undefined;
  readonly snapshotId: string | undefined;
  readonly verification: "verified" | "failed" | "not-run";
  readonly checksum: string | undefined;
  readonly bytes: number;
  readonly entries: number;
  readonly rotated: readonly string[];
  readonly kept: number;
  readonly diagnostics: readonly string[];
}

export interface INeonMemorySnapshotVerification {
  readonly state: "verified" | "failed";
  readonly bytes: number;
  readonly entries: number;
  readonly checksum: string | undefined;
  readonly diagnostics: readonly string[];
}

function sanitizeStamp(stamp: string): string {
  // Filenames must be filesystem-safe; collapse anything but [A-Za-z0-9._-].
  return stamp.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Takes a `VACUUM INTO` snapshot of the memory DB and rotates old snapshots. The
 * source is opened read-only; the snapshot is a standalone, re-openable DB file.
 */
export async function createNeonMemoryBackup(
  options: INeonMemoryBackupOptions
): Promise<INeonMemoryBackupResult> {
  const keep = typeof options.keep === "number" && options.keep > 0 ? Math.floor(options.keep) : defaultKeep;
  const stamp = sanitizeStamp(options.stamp ?? new Date().toISOString().replace(/[:.]/g, "-"));

  if (
    canonicalNeonDbPath(options.backupDir) ===
    dirname(canonicalNeonDbPath(options.dbPath))
  ) {
    return invalidBackupResult(keep, "backup directory must be separate from the source database");
  }

  await mkdir(options.backupDir, { recursive: true, mode: 0o700 });
  const backupDirectory = await lstat(options.backupDir).catch(() => undefined);
  if (!backupDirectory?.isDirectory() || backupDirectory.isSymbolicLink()) {
    return invalidBackupResult(keep, "backup target is not a private regular directory");
  }
  await chmod(options.backupDir, 0o700);
  const snapshotPath = join(options.backupDir, `semantic-memory-${stamp}.db`);
  const snapshotId = basename(snapshotPath);

  // VACUUM INTO refuses to overwrite an existing file (throws "output file already
  // exists"). Rather than crash mid-run on a stamp collision, skip cleanly — the
  // existing snapshot for that stamp is already a valid backup.
  const exists = await access(snapshotPath).then(
    () => true,
    () => false
  );
  if (exists) {
    const existing = await lstat(snapshotPath).catch(() => undefined);
    if (
      !existing ||
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      (existing.mode & 0o077) !== 0
    ) {
      return invalidBackupResult(keep, "snapshot collision is not a private regular file");
    }
    const verification = await verifyNeonMemorySnapshot(snapshotPath);
    if (verification.state !== "verified") {
      return invalidBackupResult(keep, verification.diagnostics);
    }
    return {
      state: "skipped",
      snapshotPath,
      snapshotId,
      verification: verification.state,
      checksum: verification.checksum,
      bytes: verification.bytes,
      entries: verification.entries,
      rotated: [],
      kept: keep,
      diagnostics: [
        `snapshot for stamp ${stamp} already exists, skipped`,
        ...verification.diagnostics
      ]
    };
  }

  // VACUUM INTO requires a string literal, not a bound parameter. The path is
  // ours (built from backupDir + sanitized stamp), and single quotes are escaped.
  const source = openNeonMemoryDatabase(options.dbPath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  await chmod(snapshotPath, 0o600);
  const verification = await verifyNeonMemorySnapshot(snapshotPath);
  if (verification.state !== "verified") {
    await rm(snapshotPath, { force: true });
    return invalidBackupResult(keep, verification.diagnostics);
  }

  const rotated = await rotateNeonMemoryBackups(options.backupDir, keep);

  return {
    state: "backed-up",
    snapshotPath,
    snapshotId,
    verification: "verified",
    checksum: verification.checksum,
    bytes: verification.bytes,
    entries: verification.entries,
    rotated,
    kept: keep,
    diagnostics: [
      `snapshot written and verified (${verification.bytes} bytes, ${verification.entries} entries)`,
      ...(rotated.length > 0 ? [`rotated ${rotated.length} old snapshot(s)`] : [])
    ]
  };
}

/** Verifies SQLite integrity, the required memory table, row count and bytes. */
export async function verifyNeonMemorySnapshot(
  snapshotPath: string,
  expectedEntries?: number
): Promise<INeonMemorySnapshotVerification> {
  try {
    const snapshotStat = await stat(snapshotPath);
    const database = openNeonMemoryDatabase(snapshotPath, { readOnly: true });
    let entries = 0;
    try {
      const quickRows = database.prepare("PRAGMA quick_check").all() as readonly Record<string, unknown>[];
      const quickCheckOk = quickRows.length === 1 && Object.values(quickRows[0] ?? {}).includes("ok");
      const table = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'")
        .get() as { readonly present?: number } | undefined;
      if (!quickCheckOk || table?.present !== 1) {
        return failedVerification("snapshot verification failed: SQLite integrity or schema check failed");
      }
      const countRow = database.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
        readonly count?: number;
      } | undefined;
      entries = typeof countRow?.count === "number" ? countRow.count : 0;
    } finally {
      database.close();
    }

    if (expectedEntries !== undefined && entries !== expectedEntries) {
      return failedVerification("snapshot verification failed: entry count mismatch");
    }

    return {
      state: "verified",
      bytes: snapshotStat.size,
      entries,
      checksum: await hashFile(snapshotPath),
      diagnostics: ["snapshot verification passed"]
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failedVerification(
      `snapshot verification failed: ${redactSnapshotText(reason, { previewLimit: 240 })}`
    );
  }
}

function failedVerification(diagnostic: string): INeonMemorySnapshotVerification {
  return {
    state: "failed",
    bytes: 0,
    entries: 0,
    checksum: undefined,
    diagnostics: [diagnostic]
  };
}

function invalidBackupResult(
  keep: number,
  diagnostic: string | readonly string[]
): INeonMemoryBackupResult {
  return {
    state: "invalid",
    snapshotPath: undefined,
    snapshotId: undefined,
    verification: "failed",
    checksum: undefined,
    bytes: 0,
    entries: 0,
    rotated: [],
    kept: keep,
    diagnostics: typeof diagnostic === "string" ? [diagnostic] : diagnostic
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Deletes all but the newest `keep` `semantic-memory-*.db` snapshots in a directory.
 * Returns the filenames that were removed (newest-first ordering by name, which is
 * ISO-timestamp sortable).
 */
export async function rotateNeonMemoryBackups(
  backupDir: string,
  keep: number
): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    return [];
  }
  const snapshots = entries
    .filter((name) => name.startsWith("semantic-memory-") && name.endsWith(".db"))
    .sort()
    .reverse();
  const toRemove = snapshots.slice(Math.max(0, keep));
  for (const name of toRemove) {
    await rm(join(backupDir, name), { force: true });
  }
  return toRemove;
}

export function renderNeonMemoryBackupReport(result: INeonMemoryBackupResult): string {
  return [
    `Neonika Memory Backup: ${result.state}`,
    `Snapshot: ${result.snapshotId ?? "none"}`,
    `Verification: ${result.verification}`,
    `Size: ${result.bytes} bytes  Entries: ${result.entries}`,
    `Rotation: kept ${result.kept}, removed ${result.rotated.length}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
