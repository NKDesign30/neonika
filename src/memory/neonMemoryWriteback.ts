import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactSnapshotText } from "../harness/redaction.js";
import type { INeonEmbeddingProvider } from "./neonEmbeddingProvider.js";
import { openNeonMemoryDatabase } from "./neonMemoryDbOpen.js";
import {
  createNeonMemoryBackup,
  verifyNeonMemorySnapshot
} from "./neonMemoryBackup.js";
import {
  resolveNeonMemoryDbWriteGate,
  writeNeonMemoryDbEntries,
  type INeonMemoryDbWriteGate,
  type INeonMemoryDbWriteInput
} from "./neonMemoryDbWriter.js";
import { canonicalNeonDbPath } from "./neonMemoryDbProvider.js";

export const NEON_LIVE_INDEX_WRITEBACK_ENV = "NEON_LIVE_INDEX_WRITEBACK_ENABLED" as const;
export const NEON_MEMORY_ROLLBACK_ENV = "NEON_MEMORY_ROLLBACK_ENABLED" as const;

export type TNeonMemoryWritebackGateReason =
  | "memory-write-disabled"
  | "writeback-disabled"
  | "writeback-enabled";

export interface INeonMemoryWritebackGate {
  readonly enabled: boolean;
  readonly reason: TNeonMemoryWritebackGateReason;
  readonly envKey: typeof NEON_LIVE_INDEX_WRITEBACK_ENV;
  readonly memoryGate: INeonMemoryDbWriteGate;
}

export interface INeonMemoryRollbackGate {
  readonly enabled: boolean;
  readonly reason: "rollback-disabled" | "rollback-enabled";
  readonly envKey: typeof NEON_MEMORY_ROLLBACK_ENV;
}

export type TNeonMemoryWritebackTargetReason =
  | "validated-primary"
  | "missing-target"
  | "target-mismatch"
  | "target-not-regular"
  | "unsafe-target-permissions"
  | "target-verification-failed"
  | "invalid-backup-target";

export interface INeonMemoryWritebackTarget {
  readonly state: "validated" | "blocked";
  readonly reason: TNeonMemoryWritebackTargetReason;
  readonly targetConfigured: boolean;
  readonly matchesPrimary: boolean;
  readonly ownerOnly: boolean;
}

export interface INeonMemoryWritebackBackupObservation {
  readonly state: "not-created" | "verified" | "failed";
  readonly snapshotId?: string;
  readonly entries: number;
  readonly rotated: number;
}

export interface INeonMemoryWritebackCounts {
  readonly requested: number;
  readonly written: number;
  readonly inserted: number;
  readonly updated: number;
  readonly embedded: number;
  readonly degraded: number;
  readonly blocked: number;
}

export interface INeonMemoryWritebackResult {
  readonly state: "planned" | "blocked" | "written" | "failed";
  readonly target: INeonMemoryWritebackTarget;
  readonly backup: INeonMemoryWritebackBackupObservation;
  readonly writes: INeonMemoryWritebackCounts;
  readonly diagnostics: readonly string[];
}

export interface IExecuteNeonMemoryWritebackOptions {
  readonly targetDbPath: string | undefined;
  readonly primaryDbPath: string | undefined;
  readonly backupDir: string | undefined;
  readonly gate: INeonMemoryWritebackGate;
  readonly inputs: readonly INeonMemoryDbWriteInput[];
  readonly embedder?: INeonEmbeddingProvider;
  readonly operationId?: string;
  readonly now?: () => Date;
  readonly keepBackups?: number;
}

export type TNeonMemoryRollbackReason =
  | "restored"
  | "rollback-disabled"
  | "invalid-target"
  | "invalid-snapshot-id"
  | "snapshot-not-private"
  | "snapshot-verification-failed"
  | "database-active"
  | "safety-backup-failed"
  | "restore-failed"
  | "recovery-failed";

export interface INeonMemoryRollbackResult {
  readonly state: "blocked" | "restored" | "failed";
  readonly reason: TNeonMemoryRollbackReason;
  readonly snapshotId?: string;
  readonly verification: "not-run" | "verified" | "failed";
  readonly recoveryAttempts: 0 | 1;
  readonly safetySnapshotId?: string;
  readonly diagnostics: readonly string[];
}

export interface IRollbackNeonMemoryWritebackOptions {
  readonly targetDbPath: string | undefined;
  readonly primaryDbPath: string | undefined;
  readonly backupDir: string | undefined;
  readonly snapshotId: string;
  readonly gate: INeonMemoryRollbackGate;
  readonly operationId?: string;
  readonly now?: () => Date;
}

const notCreatedBackup: INeonMemoryWritebackBackupObservation = {
  state: "not-created",
  entries: 0,
  rotated: 0
};

export function resolveNeonMemoryWritebackGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonMemoryWritebackGate {
  const memoryGate = resolveNeonMemoryDbWriteGate(env);
  const writebackEnabled = readReadyCutoverEnv(env, NEON_LIVE_INDEX_WRITEBACK_ENV);
  const enabled = memoryGate.enabled && writebackEnabled;
  return {
    enabled,
    reason: !memoryGate.enabled
      ? "memory-write-disabled"
      : writebackEnabled
        ? "writeback-enabled"
        : "writeback-disabled",
    envKey: NEON_LIVE_INDEX_WRITEBACK_ENV,
    memoryGate
  };
}

export function resolveNeonMemoryRollbackGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonMemoryRollbackGate {
  const enabled = readReadyCutoverEnv(env, NEON_MEMORY_ROLLBACK_ENV);
  return {
    enabled,
    reason: enabled ? "rollback-enabled" : "rollback-disabled",
    envKey: NEON_MEMORY_ROLLBACK_ENV
  };
}

export async function validateNeonMemoryWritebackTarget(options: {
  readonly targetDbPath: string | undefined;
  readonly primaryDbPath: string | undefined;
  readonly backupDir: string | undefined;
}): Promise<INeonMemoryWritebackTarget> {
  const targetDbPath = options.targetDbPath?.trim();
  const primaryDbPath = options.primaryDbPath?.trim();
  if (!targetDbPath || !primaryDbPath) {
    return blockedTarget("missing-target");
  }

  const matchesPrimary = canonicalNeonDbPath(targetDbPath) === canonicalNeonDbPath(primaryDbPath);
  if (!matchesPrimary) {
    return blockedTarget("target-mismatch", { targetConfigured: true });
  }
  const backupDir = options.backupDir?.trim();
  if (!backupDir) {
    return blockedTarget("invalid-backup-target", { targetConfigured: true, matchesPrimary: true });
  }
  const canonicalBackupDir = canonicalNeonDbPath(backupDir);
  if (
    canonicalBackupDir === canonicalNeonDbPath(targetDbPath) ||
    canonicalBackupDir === canonicalNeonDbPath(dirname(targetDbPath))
  ) {
    return blockedTarget("invalid-backup-target", { targetConfigured: true, matchesPrimary: true });
  }
  try {
    const backupStat = await lstat(backupDir);
    if (
      !backupStat.isDirectory() ||
      backupStat.isSymbolicLink() ||
      (backupStat.mode & 0o077) !== 0
    ) {
      return blockedTarget("invalid-backup-target", {
        targetConfigured: true,
        matchesPrimary: true
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return blockedTarget("invalid-backup-target", {
        targetConfigured: true,
        matchesPrimary: true
      });
    }
  }

  try {
    const targetStat = await lstat(targetDbPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      return blockedTarget("target-not-regular", { targetConfigured: true, matchesPrimary: true });
    }
    if ((targetStat.mode & 0o077) !== 0) {
      return blockedTarget("unsafe-target-permissions", {
        targetConfigured: true,
        matchesPrimary: true
      });
    }
  } catch {
    return blockedTarget("target-not-regular", { targetConfigured: true, matchesPrimary: true });
  }

  const verification = await verifyNeonMemorySnapshot(targetDbPath);
  if (verification.state !== "verified") {
    return blockedTarget("target-verification-failed", {
      targetConfigured: true,
      matchesPrimary: true,
      ownerOnly: true
    });
  }

  return {
    state: "validated",
    reason: "validated-primary",
    targetConfigured: true,
    matchesPrimary: true,
    ownerOnly: true
  };
}

export async function executeNeonMemoryWriteback(
  options: IExecuteNeonMemoryWritebackOptions
): Promise<INeonMemoryWritebackResult> {
  if (options.inputs.length === 0) {
    const target = options.gate.enabled
      ? await validateNeonMemoryWritebackTarget(options)
      : blockedTarget("missing-target");
    return createWritebackResult({
      state: "planned",
      target,
      requested: 0,
      diagnostics: ["memory writeback planned: no entries require promotion"]
    });
  }
  if (!options.gate.enabled) {
    return createWritebackResult({
      state: "blocked",
      target: blockedTarget("missing-target"),
      requested: options.inputs.length,
      diagnostics: [`memory writeback blocked: ${options.gate.reason}`]
    });
  }

  const target = await validateNeonMemoryWritebackTarget(options);
  if (target.state !== "validated" || !options.targetDbPath || !options.backupDir) {
    return createWritebackResult({
      state: "blocked",
      target,
      requested: options.inputs.length,
      diagnostics: [`memory writeback blocked: ${target.reason}`]
    });
  }

  const backupReady = await preparePrivateBackupDirectory(options.backupDir);
  if (!backupReady) {
    return createWritebackResult({
      state: "blocked",
      target,
      requested: options.inputs.length,
      diagnostics: ["memory writeback blocked: private backup directory unavailable"]
    });
  }

  let backup: Awaited<ReturnType<typeof createNeonMemoryBackup>>;
  try {
    backup = await createNeonMemoryBackup({
      dbPath: options.targetDbPath,
      backupDir: options.backupDir,
      keep: options.keepBackups ?? 14,
      stamp: operationStamp(options.now, options.operationId)
    });
  } catch (error) {
    return createWritebackResult({
      state: "blocked",
      target,
      backup: { state: "failed", entries: 0, rotated: 0 },
      requested: options.inputs.length,
      diagnostics: [`memory writeback blocked: backup failed (${safeError(error)})`]
    });
  }
  const backupObservation: INeonMemoryWritebackBackupObservation = {
    state: backup.state === "backed-up" && backup.verification === "verified" ? "verified" : "failed",
    ...(backup.snapshotId ? { snapshotId: backup.snapshotId } : {}),
    entries: backup.entries,
    rotated: backup.rotated.length
  };
  if (backupObservation.state !== "verified") {
    return createWritebackResult({
      state: "blocked",
      target,
      backup: backupObservation,
      requested: options.inputs.length,
      diagnostics: ["memory writeback blocked: fresh verified backup unavailable"]
    });
  }

  try {
    const writes = await writeNeonMemoryDbEntries({
      dbPath: options.targetDbPath,
      gate: options.gate.memoryGate,
      inputs: options.inputs,
      dedupe: "source-file",
      // The orchestration gate above already proved that both independently
      // configured paths resolve to the same private, verified primary DB and
      // created a verified pre-write backup. This replaces the low-level
      // single-gate override used by isolated writer callers.
      allowRealDb: true,
      ...(options.embedder ? { embedder: options.embedder } : {}),
      ...(options.now ? { now: options.now } : {})
    });
    const counts = countWriteResults(options.inputs.length, writes);
    return {
      state: counts.written === options.inputs.length ? "written" : "blocked",
      target,
      backup: backupObservation,
      writes: counts,
      diagnostics: [
        counts.written === options.inputs.length
          ? `memory writeback committed atomically: ${counts.written} entry(s)`
          : "memory writeback blocked before a complete batch could commit"
      ]
    };
  } catch (error) {
    return createWritebackResult({
      state: "failed",
      target,
      backup: backupObservation,
      requested: options.inputs.length,
      diagnostics: [
        `memory writeback transaction rolled back: ${safeError(error)}`
      ]
    });
  }
}

export async function rollbackNeonMemoryWriteback(
  options: IRollbackNeonMemoryWritebackOptions
): Promise<INeonMemoryRollbackResult> {
  if (!options.gate.enabled) {
    return rollbackResult("blocked", "rollback-disabled", "not-run", 0, [
      `memory rollback blocked: ${options.gate.envKey} is not armed`
    ]);
  }

  const target = await validateNeonMemoryWritebackTarget(options);
  if (target.state !== "validated" || !options.targetDbPath || !options.backupDir) {
    return rollbackResult("blocked", "invalid-target", "not-run", 0, [
      `memory rollback blocked: ${target.reason}`
    ]);
  }
  if (!isValidSnapshotId(options.snapshotId)) {
    return rollbackResult("blocked", "invalid-snapshot-id", "not-run", 0, [
      "memory rollback blocked: snapshot id is invalid"
    ]);
  }
  if (!(await isPrivateDirectory(options.backupDir))) {
    return rollbackResult("blocked", "snapshot-not-private", "not-run", 0, [
      "memory rollback blocked: backup directory is linked or not owner-only"
    ]);
  }
  const snapshotPath = join(options.backupDir, options.snapshotId);
  if (!(await isPrivateRegularFile(snapshotPath))) {
    return rollbackResult("blocked", "snapshot-not-private", "not-run", 0, [
      "memory rollback blocked: snapshot is missing, linked, or not owner-only"
    ]);
  }
  const sourceVerification = await verifyNeonMemorySnapshot(snapshotPath);
  if (sourceVerification.state !== "verified" || !sourceVerification.checksum) {
    return rollbackResult("blocked", "snapshot-verification-failed", "failed", 0, [
      "memory rollback blocked: snapshot verification failed"
    ]);
  }
  if (!(await prepareNeonMemoryRestoreTarget(options.targetDbPath))) {
    return rollbackResult("blocked", "database-active", "not-run", 0, [
      "memory rollback blocked: stop the writer and checkpoint SQLite first"
    ]);
  }

  let safetyBackup: Awaited<ReturnType<typeof createNeonMemoryBackup>>;
  try {
    safetyBackup = await createNeonMemoryBackup({
      dbPath: options.targetDbPath,
      backupDir: options.backupDir,
      keep: Number.MAX_SAFE_INTEGER,
      stamp: `${operationStamp(options.now, options.operationId)}-before-restore`
    });
  } catch (error) {
    return rollbackResult("blocked", "safety-backup-failed", "failed", 0, [
      `memory rollback blocked: current target could not be preserved (${safeError(error)})`
    ]);
  }
  if (
    safetyBackup.state !== "backed-up" ||
    safetyBackup.verification !== "verified" ||
    !safetyBackup.snapshotPath ||
    !safetyBackup.snapshotId
  ) {
    return rollbackResult("blocked", "safety-backup-failed", "failed", 0, [
      "memory rollback blocked: current target could not be preserved"
    ]);
  }

  const restored = await replaceTargetFromSnapshot({
    targetDbPath: options.targetDbPath,
    snapshotPath,
    expectedChecksum: sourceVerification.checksum,
    expectedEntries: sourceVerification.entries,
    operationId: options.operationId
  });
  if (restored) {
    return {
      state: "restored",
      reason: "restored",
      snapshotId: options.snapshotId,
      verification: "verified",
      recoveryAttempts: 0,
      safetySnapshotId: safetyBackup.snapshotId,
      diagnostics: ["memory rollback restored and verified the selected snapshot"]
    };
  }

  const safetyVerification = await verifyNeonMemorySnapshot(safetyBackup.snapshotPath);
  const recoveryAttempted = safetyVerification.state === "verified" && safetyVerification.checksum !== undefined;
  const recovered = recoveryAttempted && safetyVerification.checksum
    ? await replaceTargetFromSnapshot({
        targetDbPath: options.targetDbPath,
        snapshotPath: safetyBackup.snapshotPath,
        expectedChecksum: safetyVerification.checksum,
        expectedEntries: safetyVerification.entries,
        operationId: `${options.operationId ?? "restore"}-recovery`
      })
    : false;

  return {
    state: "failed",
    reason: recovered ? "restore-failed" : "recovery-failed",
    snapshotId: options.snapshotId,
    verification: "failed",
    recoveryAttempts: recoveryAttempted ? 1 : 0,
    safetySnapshotId: safetyBackup.snapshotId,
    diagnostics: [
      recovered
        ? "memory rollback failed verification; previous target recovered once"
        : recoveryAttempted
          ? "memory rollback and its single recovery attempt failed"
          : "memory rollback failed; the safety snapshot could not be verified, no recovery was attempted"
    ]
  };
}

export function renderNeonMemoryWritebackReport(result: INeonMemoryWritebackResult): string {
  return [
    `Neonika Memory Writeback: ${result.state}`,
    `Target: ${result.target.state} (${result.target.reason})`,
    `Backup: ${result.backup.state}${result.backup.snapshotId ? ` (${result.backup.snapshotId})` : ""}`,
    `Writes: requested=${result.writes.requested} written=${result.writes.written} inserted=${result.writes.inserted} updated=${result.writes.updated} embedded=${result.writes.embedded} degraded=${result.writes.degraded} blocked=${result.writes.blocked}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

export function renderNeonMemoryRollbackReport(result: INeonMemoryRollbackResult): string {
  return [
    `Neonika Memory Rollback: ${result.state}`,
    `Reason: ${result.reason}`,
    `Snapshot: ${result.snapshotId ?? "none"}`,
    `Verification: ${result.verification}`,
    `Recovery attempts: ${result.recoveryAttempts}/1`,
    ...(result.safetySnapshotId ? [`Safety snapshot: ${result.safetySnapshotId}`] : []),
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function blockedTarget(
  reason: Exclude<TNeonMemoryWritebackTargetReason, "validated-primary">,
  overrides: Partial<Omit<INeonMemoryWritebackTarget, "state" | "reason">> = {}
): INeonMemoryWritebackTarget {
  return {
    state: "blocked",
    reason,
    targetConfigured: overrides.targetConfigured ?? false,
    matchesPrimary: overrides.matchesPrimary ?? false,
    ownerOnly: overrides.ownerOnly ?? false
  };
}

function createWritebackResult(options: {
  readonly state: INeonMemoryWritebackResult["state"];
  readonly target: INeonMemoryWritebackTarget;
  readonly backup?: INeonMemoryWritebackBackupObservation;
  readonly requested: number;
  readonly diagnostics: readonly string[];
}): INeonMemoryWritebackResult {
  return {
    state: options.state,
    target: options.target,
    backup: options.backup ?? notCreatedBackup,
    writes: {
      requested: options.requested,
      written: 0,
      inserted: 0,
      updated: 0,
      embedded: 0,
      degraded: 0,
      blocked: options.state === "blocked" ? options.requested : 0
    },
    diagnostics: options.diagnostics
  };
}

function countWriteResults(
  requested: number,
  writes: Awaited<ReturnType<typeof writeNeonMemoryDbEntries>>
): INeonMemoryWritebackCounts {
  return {
    requested,
    written: writes.filter((write) => write.state === "written").length,
    inserted: writes.filter((write) => write.inserted).length,
    updated: writes.filter((write) => write.updated).length,
    embedded: writes.filter((write) => write.embedded).length,
    degraded: writes.filter((write) => write.degraded).length,
    blocked: writes.filter((write) => write.state === "blocked").length
  };
}

async function preparePrivateBackupDirectory(backupDir: string): Promise<boolean> {
  try {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupStat = await lstat(backupDir);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
      return false;
    }
    await chmod(backupDir, 0o700);
    return true;
  } catch {
    return false;
  }
}

function operationStamp(now: (() => Date) | undefined, operationId: string | undefined): string {
  const timestamp = (now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  const suffix = (operationId ?? randomUUID()).replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 64);
  return `${timestamp}-${suffix || "operation"}`;
}

function isValidSnapshotId(snapshotId: string): boolean {
  return /^semantic-memory-[A-Za-z0-9._-]+\.db$/u.test(snapshotId) && !snapshotId.includes("..");
}

async function isPrivateRegularFile(path: string): Promise<boolean> {
  try {
    const fileStat = await lstat(path);
    return fileStat.isFile() && !fileStat.isSymbolicLink() && (fileStat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function isPrivateDirectory(path: string): Promise<boolean> {
  try {
    const directoryStat = await lstat(path);
    return (
      directoryStat.isDirectory() &&
      !directoryStat.isSymbolicLink() &&
      (directoryStat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

async function prepareNeonMemoryRestoreTarget(dbPath: string): Promise<boolean> {
  try {
    const database = openNeonMemoryDatabase(dbPath);
    try {
      database.exec("BEGIN EXCLUSIVE");
      database.exec("COMMIT");
      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        readonly busy?: number;
      } | undefined;
      if (checkpoint?.busy !== 0) {
        return false;
      }
    } finally {
      database.close();
    }
  } catch {
    return false;
  }

  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
  for (const sidecar of sidecars) {
    const exists = await access(sidecar).then(
      () => true,
      () => false
    );
    if (!exists) {
      continue;
    }
    try {
      if ((await stat(sidecar)).size > 0) {
        return false;
      }
      await rm(sidecar, { force: true });
    } catch {
      return false;
    }
  }
  return true;
}

async function replaceTargetFromSnapshot(options: {
  readonly targetDbPath: string;
  readonly snapshotPath: string;
  readonly expectedChecksum: string;
  readonly expectedEntries: number;
  readonly operationId: string | undefined;
}): Promise<boolean> {
  const suffix = (options.operationId ?? randomUUID()).replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 64);
  const stagingPath = join(dirname(options.targetDbPath), `.semantic-memory-restore-${suffix || "operation"}.tmp`);
  try {
    await copyFile(options.snapshotPath, stagingPath, fsConstants.COPYFILE_EXCL);
    await chmod(stagingPath, 0o600);
    const handle = await open(stagingPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await verifyNeonMemorySnapshot(stagingPath, options.expectedEntries);
    if (staged.state !== "verified" || staged.checksum !== options.expectedChecksum) {
      return false;
    }
    await rename(stagingPath, options.targetDbPath);
    await chmod(options.targetDbPath, 0o600);
    const targetDirectory = await open(dirname(options.targetDbPath), "r");
    try {
      await targetDirectory.sync();
    } finally {
      await targetDirectory.close();
    }
    const restored = await verifyNeonMemorySnapshot(options.targetDbPath, options.expectedEntries);
    return restored.state === "verified" && restored.checksum === options.expectedChecksum;
  } catch {
    return false;
  } finally {
    await rm(stagingPath, { force: true });
  }
}

function rollbackResult(
  state: INeonMemoryRollbackResult["state"],
  reason: TNeonMemoryRollbackReason,
  verification: INeonMemoryRollbackResult["verification"],
  recoveryAttempts: 0 | 1,
  diagnostics: readonly string[]
): INeonMemoryRollbackResult {
  return { state, reason, verification, recoveryAttempts, diagnostics };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSnapshotText(message, { previewLimit: 240 });
}
