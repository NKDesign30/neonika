import {
  createNeonMemoryBackup,
  renderNeonMemoryBackupReport,
  type INeonMemoryBackupResult
} from "./neonMemoryBackup.js";
import {
  recalcNeonMemoryImportance,
  renderNeonImportanceRecalcReport,
  type INeonImportanceRecalcResult
} from "./neonMemoryImportance.js";
import {
  discoverNeonMemoryRelations,
  renderNeonRelationDiscoveryReport,
  type INeonRelationDiscoveryResult
} from "./neonMemoryRelations.js";
import {
  pruneNeonMemory,
  renderNeonPruneReport,
  type INeonPruneResult
} from "./neonMemoryPrune.js";
import type { INeonMemoryDbWriteGate } from "./neonMemoryDbWriter.js";

/**
 * The maintenance facade over the neonika memory DB (memory cutover, Slice K5).
 *
 * Replaces the v2 Python cron zoo (memory-backup, importance recalc in the
 * Evolution Engine, relation discovery, adversarial prune) with ONE ordered,
 * gated pipeline against the neonika DB:
 *
 *   1. Backup FIRST - a snapshot exists before anything mutates.
 *   2. Importance recalc - Ebbinghaus retention, now fed by real access
 *      tracking (Slice K2/K1): never-recalled entries decay, recalled ones hold.
 *   3. Relation discovery - vector-similarity edges between entries.
 *   4. Prune - archive-not-delete for stale noise. Runs PLAN-ONLY by default;
 *      `applyPrune` is a deliberate operator opt-in, never an autonomous one.
 *
 * Every step carries the shared write gate and the real-DB guard, so a
 * misconfigured dbPath degrades to plans and diagnostics instead of mutations.
 */

const DISABLED_GATE_REASON = "write-disabled" as const;

export interface INeonMemoryMaintenanceOptions {
  readonly dbPath: string;
  readonly backupDir: string;
  readonly gate: INeonMemoryDbWriteGate;
  /** Vector dimensions for relation discovery (default 768 / nomic-embed-text). */
  readonly embedderDimensions?: number;
  /** Default false: prune reports its candidates but archives nothing. */
  readonly applyPrune?: boolean;
  readonly pruneMaxScore?: number;
  readonly keepBackups?: number;
  readonly allowRealDb?: boolean;
  readonly now?: () => Date;
}

export interface INeonMemoryMaintenanceResult {
  readonly backup: INeonMemoryBackupResult;
  readonly importance: INeonImportanceRecalcResult;
  readonly relations: INeonRelationDiscoveryResult;
  readonly prune: INeonPruneResult;
  readonly pruneApplied: boolean;
  readonly diagnostics: readonly string[];
}

export async function runNeonMemoryMaintenance(
  options: INeonMemoryMaintenanceOptions
): Promise<INeonMemoryMaintenanceResult> {
  const diagnostics: string[] = [];

  const backup = await createNeonMemoryBackup({
    dbPath: options.dbPath,
    backupDir: options.backupDir,
    keep: options.keepBackups ?? 14,
    ...(options.now ? { stamp: options.now().toISOString().replace(/[:.]/g, "-") } : {})
  });
  if (backup.state !== "backed-up") {
    // No snapshot means no mutation: importance/prune are skipped via a
    // disabled gate so the run degrades to plans instead of risking the DB.
    diagnostics.push("backup missing - mutating steps degraded to plan-only");
  }

  const mutationGate: INeonMemoryDbWriteGate =
    backup.state === "backed-up"
      ? options.gate
      : { enabled: false, reason: DISABLED_GATE_REASON, envKey: options.gate.envKey };

  const importance = recalcNeonMemoryImportance({
    dbPath: options.dbPath,
    gate: mutationGate,
    ...(options.allowRealDb !== undefined ? { allowRealDb: options.allowRealDb } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  const relations = discoverNeonMemoryRelations({
    dbPath: options.dbPath,
    gate: mutationGate,
    dimensions: options.embedderDimensions ?? 768,
    ...(options.allowRealDb !== undefined ? { allowRealDb: options.allowRealDb } : {})
  });

  const pruneApplied = options.applyPrune === true && mutationGate.enabled;
  const pruneGate: INeonMemoryDbWriteGate = pruneApplied
    ? mutationGate
    : { enabled: false, reason: DISABLED_GATE_REASON, envKey: options.gate.envKey };
  const prune = pruneNeonMemory({
    dbPath: options.dbPath,
    gate: pruneGate,
    ...(options.pruneMaxScore !== undefined ? { maxScore: options.pruneMaxScore } : {}),
    ...(options.allowRealDb !== undefined ? { allowRealDb: options.allowRealDb } : {}),
    ...(options.now ? { now: options.now } : {}),
    reason: pruneApplied ? "maintenance:prune-apply" : "maintenance:plan-only"
  });
  if (!pruneApplied) {
    diagnostics.push("prune ran plan-only (pass --prune-apply for a real archive pass)");
  }

  return { backup, importance, relations, prune, pruneApplied, diagnostics };
}

export function renderNeonMemoryMaintenanceReport(result: INeonMemoryMaintenanceResult): string {
  return [
    "Neonika Memory Maintenance",
    renderNeonMemoryBackupReport(result.backup),
    renderNeonImportanceRecalcReport(result.importance),
    renderNeonRelationDiscoveryReport(result.relations),
    renderNeonPruneReport(result.prune),
    ...result.diagnostics.map((line) => `- ${line}`)
  ].join("\n\n");
}
