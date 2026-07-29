// Adapted from NK Design's Neon runtime for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

// Neon Memory — the one gate every maintenance pass has to clear.
//
// Importance recalculation, pruning, relation discovery and embedding backfill
// each asked the same three questions in the same order, in their own words:
//
//   1. did recall actually run?   (else "unimportant" is a measurement artefact)
//   2. is this the real DB?       (plan only unless explicitly allowed)
//   3. is the write env armed?    (silence contract)
//
// Four copies meant four places to change a rule and three places to forget.
// The order is load-bearing and now lives here once: freeze first, because a
// missing-telemetry run must not even look like a plan against the real DB;
// then the real-DB guard; then the arming guard.
//
// Split in two on purpose: the freeze check reads MAX(last_accessed_at), so it
// needs an open database, while the write decision has to be known *before*
// opening (it picks readOnly). One function that pretended otherwise would be
// lying about when it can answer.

import type { DatabaseSync } from "node:sqlite";

import { resolveNeonMemoryDbWriteGate, type INeonMemoryDbWriteGate } from "./neonMemoryDbWriter.js";
import { targetsRealNeonDb } from "./neonMemoryDbProvider.js";
import {
  NEON_DEFAULT_RECALL_GAP_HOURS,
  describeNeonRecallGap,
  readNeonRecallGapHours
} from "./neonMemoryRecallTelemetry.js";

/** Why a maintenance pass may not mutate. Mirrors the states the callers report. */
export type TNeonMemoryMaintenanceBlockState = "planned" | "blocked" | "frozen";

export interface INeonMemoryMaintenanceAccess {
  readonly gate: INeonMemoryDbWriteGate;
  readonly targetsRealDb: boolean;
  /** False means the database must be opened read-only. */
  readonly canWrite: boolean;
  readonly allowRealDb: boolean;
}

export interface INeonMemoryMaintenanceBlock<
  TState extends TNeonMemoryMaintenanceBlockState = TNeonMemoryMaintenanceBlockState
> {
  readonly state: TState;
  readonly diagnostic: string;
}

interface INeonMemoryMaintenanceLabelsBase {
  /** Prefix of the plan lines: "prune" renders "prune plan only: …". */
  readonly plan: string;
  /** Verb in "set allowRealDb to <verb>" — "write" for most, "archive" for prune. */
  readonly writeVerb?: string;
}

/** Labels for a pass that reinterprets recall silence and must freeze without it. */
export interface INeonMemoryFreezingLabels extends INeonMemoryMaintenanceLabelsBase {
  /** Prefix of the freeze line: "decay" renders "decay frozen: …". */
  readonly freeze: string;
}

/** Labels for a pass that only adds rows, so telemetry is not its precondition. */
export interface INeonMemoryAdditiveLabels extends INeonMemoryMaintenanceLabelsBase {
  readonly freeze?: undefined;
}

export type TNeonMemoryMaintenanceLabels =
  | INeonMemoryFreezingLabels
  | INeonMemoryAdditiveLabels;

export interface INeonMemoryMaintenanceAccessOptions {
  readonly dbPath: string;
  readonly gate?: INeonMemoryDbWriteGate;
  readonly allowRealDb?: boolean;
}

export interface INeonMemoryMaintenanceBlockOptions {
  readonly labels: TNeonMemoryMaintenanceLabels;
  /** Hours of recall silence tolerated before freezing. 0 disables the check. */
  readonly maxRecallGapHours?: number;
  readonly now?: number;
}

/**
 * Decide write access before the database is opened.
 *
 * Callers pass the result straight into `openNeonMemoryDatabase(path, {
 * readOnly: !access.canWrite })` — the read-only flag and the later block
 * reason come from the same decision instead of being derived twice.
 */
export function resolveNeonMemoryMaintenanceAccess(
  options: INeonMemoryMaintenanceAccessOptions
): INeonMemoryMaintenanceAccess {
  const gate = options.gate ?? resolveNeonMemoryDbWriteGate(process.env);
  const targetsRealDb = targetsRealNeonDb(options.dbPath);
  const allowRealDb = options.allowRealDb === true;

  return {
    gate,
    targetsRealDb,
    allowRealDb,
    canWrite: gate.enabled && (!targetsRealDb || allowRealDb)
  };
}

/**
 * Find the reason this pass must not mutate, or null when it may proceed.
 *
 * Freeze is only evaluated when the caller supplies a `freeze` label — passes
 * that never delete or overwrite (relation discovery, embedding backfill) add
 * rows rather than reinterpreting silence, so recall telemetry is not their
 * precondition.
 */
export function findNeonMemoryMaintenanceBlock(
  access: INeonMemoryMaintenanceAccess,
  database: DatabaseSync,
  options: INeonMemoryMaintenanceBlockOptions & { readonly labels: INeonMemoryFreezingLabels }
): INeonMemoryMaintenanceBlock | null;
/** Without a freeze label the pass can never freeze — the type says so too. */
export function findNeonMemoryMaintenanceBlock(
  access: INeonMemoryMaintenanceAccess,
  database: DatabaseSync,
  options: INeonMemoryMaintenanceBlockOptions & { readonly labels: INeonMemoryAdditiveLabels }
): INeonMemoryMaintenanceBlock<"planned" | "blocked"> | null;
export function findNeonMemoryMaintenanceBlock(
  access: INeonMemoryMaintenanceAccess,
  database: DatabaseSync,
  options: INeonMemoryMaintenanceBlockOptions
): INeonMemoryMaintenanceBlock | null {
  const { labels } = options;

  if (labels.freeze !== undefined) {
    const limitHours = options.maxRecallGapHours ?? NEON_DEFAULT_RECALL_GAP_HOURS;
    if (limitHours > 0) {
      const gapHours = readNeonRecallGapHours(database, options.now ?? Date.now());
      if (gapHours > limitHours) {
        return {
          state: "frozen",
          diagnostic: `${labels.freeze} frozen: ${describeNeonRecallGap(gapHours, limitHours)}`
        };
      }
    }
  }

  if (access.targetsRealDb && !access.allowRealDb) {
    return {
      state: "planned",
      diagnostic:
        `${labels.plan} plan only: target is the real semantic-memory DB ` +
        `(set allowRealDb to ${labels.writeVerb ?? "write"})`
    };
  }

  if (!access.gate.enabled) {
    return {
      state: "blocked",
      diagnostic: `${labels.plan} plan only: ${access.gate.envKey} is not armed`
    };
  }

  return null;
}
