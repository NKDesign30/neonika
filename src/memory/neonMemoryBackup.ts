import { openNeonMemoryDatabase } from "./neonMemoryDbOpen.js";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

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
  readonly state: "backed-up" | "skipped";
  readonly snapshotPath: string | undefined;
  readonly bytes: number;
  readonly entries: number;
  readonly rotated: readonly string[];
  readonly kept: number;
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

  await mkdir(options.backupDir, { recursive: true });
  const snapshotPath = join(options.backupDir, `semantic-memory-${stamp}.db`);

  // VACUUM INTO refuses to overwrite an existing file (throws "output file already
  // exists"). Rather than crash mid-run on a stamp collision, skip cleanly — the
  // existing snapshot for that stamp is already a valid backup.
  const exists = await access(snapshotPath).then(
    () => true,
    () => false
  );
  if (exists) {
    return {
      state: "skipped",
      snapshotPath,
      bytes: 0,
      entries: 0,
      rotated: [],
      kept: keep,
      diagnostics: [`snapshot for stamp ${stamp} already exists, skipped`]
    };
  }

  // VACUUM INTO requires a string literal, not a bound parameter. The path is
  // ours (built from backupDir + sanitized stamp), and single quotes are escaped.
  const source = openNeonMemoryDatabase(options.dbPath, { readOnly: true });
  let entries = 0;
  try {
    source.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    const countRow = source.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n?: number };
    entries = typeof countRow?.n === "number" ? countRow.n : 0;
  } finally {
    source.close();
  }

  const snapshotStat = await stat(snapshotPath);
  const rotated = await rotateNeonMemoryBackups(options.backupDir, keep);

  return {
    state: "backed-up",
    snapshotPath,
    bytes: snapshotStat.size,
    entries,
    rotated,
    kept: keep,
    diagnostics: [
      `snapshot written (${snapshotStat.size} bytes, ${entries} entries)`,
      ...(rotated.length > 0 ? [`rotated ${rotated.length} old snapshot(s)`] : [])
    ]
  };
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
    `Snapshot: ${result.snapshotPath ?? "none"}`,
    `Size: ${result.bytes} bytes  Entries: ${result.entries}`,
    `Rotation: kept ${result.kept}, removed ${result.rotated.length}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
