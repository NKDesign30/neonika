import { DatabaseSync } from "node:sqlite";

import { targetsRealNeonDb } from "./neonMemoryDbProvider.js";
import {
  resolveNeonMemoryDbWriteGate,
  type INeonMemoryDbWriteGate
} from "./neonMemoryDbWriter.js";

/**
 * Ebbinghaus retention recalc for Neon Core (memory autarky).
 *
 * Mirrors v2's "forgetting curve": entries that are never recalled fade, entries
 * that are accessed stay stable. Each access doubles the effective half-life, so
 * `retention = 0.5 ^ (ageDays / (halfLife * 2^accessCount))`. The intrinsic
 * `importance_score` (actively used, 20..90 in the real DB) is left untouched;
 * the retention is written into the `utility_score` column, which is an unused
 * default (0.5 everywhere) and therefore free to carry this signal. The recalc is
 * idempotent — `utility_score` depends only on age + access_count, never on its
 * previous value.
 *
 * Two gates protect the write exactly like `neonMemoryDbWriter`: the
 * `NEON_MEMORY_WRITE_ENABLED` gate must be armed, and the real semantic-memory DB
 * is hard-refused unless `allowRealDb` is set. The read/plan pass always runs.
 */

const defaultHalfLifeDays = 30;
const accessStabilityCap = 6; // 2^6 = 64x half-life max, so age never overflows.
const msPerDay = 86_400_000;

export interface INeonRetentionInput {
  readonly ageDays: number;
  readonly accessCount: number;
  readonly halfLifeDays?: number;
}

/** Pure Ebbinghaus retention in [0, 1]. */
export function computeNeonMemoryRetention(input: INeonRetentionInput): number {
  const halfLife = input.halfLifeDays && input.halfLifeDays > 0 ? input.halfLifeDays : defaultHalfLifeDays;
  const age = Number.isFinite(input.ageDays) && input.ageDays > 0 ? input.ageDays : 0;
  const access = Number.isFinite(input.accessCount) && input.accessCount > 0 ? input.accessCount : 0;
  const effectiveHalfLife = halfLife * 2 ** Math.min(access, accessStabilityCap);
  const retention = 0.5 ** (age / effectiveHalfLife);
  return Math.max(0, Math.min(1, retention));
}

export interface INeonImportanceRecalcOptions {
  readonly dbPath: string;
  readonly gate?: INeonMemoryDbWriteGate;
  readonly halfLifeDays?: number;
  readonly allowRealDb?: boolean;
  readonly now?: () => Date;
}

export interface INeonImportanceRecalcResult {
  readonly state: "recalculated" | "planned" | "blocked";
  readonly scanned: number;
  readonly updated: number;
  readonly meanRetention: number;
  readonly faded: number; // entries with retention < 0.25
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

interface IRetentionRow {
  readonly id: number;
  readonly retention: number;
}

function ageDaysFrom(now: number, value: unknown): number {
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.max(0, (now - parsed) / msPerDay);
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Scans every memory entry, computes its Ebbinghaus retention from
 * last_accessed_at (falling back to updated_at, then created_at) and access_count,
 * and — when both gates allow — writes it to utility_score. Returns a plan
 * (scanned/updated/meanRetention/faded) whether or not the write happened.
 */
export function recalcNeonMemoryImportance(
  options: INeonImportanceRecalcOptions
): INeonImportanceRecalcResult {
  const gate = options.gate ?? resolveNeonMemoryDbWriteGate(process.env);
  const targetsRealDb = targetsRealNeonDb(options.dbPath);
  const now = (options.now?.() ?? new Date()).getTime();

  const database = new DatabaseSync(options.dbPath, {
    readOnly: !(gate.enabled && (!targetsRealDb || options.allowRealDb === true))
  });
  try {
    const rows = database
      .prepare(
        `SELECT id, access_count, last_accessed_at, updated_at, created_at
          FROM memory_entries`
      )
      .all() as Array<Record<string, unknown>>;

    const retentions: IRetentionRow[] = rows.map((row) => {
      const ageDays = ageDaysFrom(
        now,
        row["last_accessed_at"] ?? row["updated_at"] ?? row["created_at"]
      );
      const retention = computeNeonMemoryRetention({
        ageDays,
        accessCount: readNumber(row, "access_count"),
        ...(options.halfLifeDays ? { halfLifeDays: options.halfLifeDays } : {})
      });
      return { id: readNumber(row, "id"), retention };
    });

    const scanned = retentions.length;
    const meanRetention =
      scanned === 0 ? 0 : retentions.reduce((sum, entry) => sum + entry.retention, 0) / scanned;
    const faded = retentions.filter((entry) => entry.retention < 0.25).length;

    if (targetsRealDb && options.allowRealDb !== true) {
      return blocked("planned", scanned, meanRetention, faded, true, [
        "importance recalc plan only: target is the real semantic-memory DB (set allowRealDb to write)"
      ]);
    }
    if (!gate.enabled) {
      return blocked("blocked", scanned, meanRetention, faded, targetsRealDb, [
        `importance recalc plan only: ${gate.envKey} is not armed`
      ]);
    }

    const update = database.prepare("UPDATE memory_entries SET utility_score = ? WHERE id = ?");
    let updated = 0;
    for (const entry of retentions) {
      update.run(entry.retention, entry.id);
      updated += 1;
    }

    return {
      state: "recalculated",
      scanned,
      updated,
      meanRetention,
      faded,
      safety: { targetedRealMemoryDb: targetsRealDb },
      diagnostics: [`utility_score recalculated for ${updated} entries (mean retention ${meanRetention.toFixed(3)})`]
    };
  } finally {
    database.close();
  }
}

function blocked(
  state: "planned" | "blocked",
  scanned: number,
  meanRetention: number,
  faded: number,
  targetedRealMemoryDb: boolean,
  diagnostics: readonly string[]
): INeonImportanceRecalcResult {
  return {
    state,
    scanned,
    updated: 0,
    meanRetention,
    faded,
    safety: { targetedRealMemoryDb },
    diagnostics
  };
}

export function renderNeonImportanceRecalcReport(result: INeonImportanceRecalcResult): string {
  return [
    `Neon Memory Importance Recalc: ${result.state}`,
    `Scanned: ${result.scanned}  Updated: ${result.updated}`,
    `Mean retention: ${result.meanRetention.toFixed(3)}  Faded (<0.25): ${result.faded}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}
