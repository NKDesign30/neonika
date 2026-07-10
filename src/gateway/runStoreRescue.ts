import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readReadyCutoverEnv } from "../core/cutover.js";
import {
  readNeonGatewayRuns,
  resolveGatewayStatePaths
} from "./runStore.js";
import type { INeonGatewayShadowRun, TNeonGatewayRunStatus } from "./types.js";

/**
 * Run-store rescue for the Shadow exit gate.
 *
 * The Shadow exit gate requires `failedCount === 0` over the entire persisted
 * `runs.jsonl`. Historical build-time failures (for example Codex app-server
 * 60s-timeout smokes from before the timeout was raised) keep that count above
 * zero forever, because the store is append/upsert-only and there is no path to
 * retire a terminal run. This rescue rotates the failed runs into a dated
 * archive file (so the diagnostic data is preserved, never deleted) and rewrites
 * `runs.jsonl` without them, leaving every non-failed run untouched.
 *
 * It is gated: without `NEON_RUN_STORE_RESCUE_ENABLED` set to a ready value the
 * call is a dry-run that reports what it would archive and writes nothing.
 */
const ARCHIVE_DIR = "archive";
const RESCUE_ENABLED_ENV_KEY = "NEON_RUN_STORE_RESCUE_ENABLED";

/** Run statuses the rescue retires from the active store. */
const RESCUED_STATUSES: readonly TNeonGatewayRunStatus[] = ["failed"];

export interface INeonRunStoreRescueOptions {
  /** When false (default), the rescue is a dry-run and writes nothing. */
  readonly enabled?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export interface INeonRunStoreRescueResult {
  readonly applied: boolean;
  readonly totalRuns: number;
  readonly keptRuns: number;
  readonly rescuedRuns: number;
  readonly rescuedStatuses: readonly TNeonGatewayRunStatus[];
  readonly rescuedRunIds: readonly string[];
  readonly runsPath: string;
  readonly archivePath: string | null;
}

interface IRescuePartition {
  readonly kept: readonly INeonGatewayShadowRun[];
  readonly rescued: readonly INeonGatewayShadowRun[];
}

export function resolveNeonRunStoreRescueEnabled(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return readReadyCutoverEnv(env, RESCUE_ENABLED_ENV_KEY);
}

function partitionRescuableRuns(
  runs: readonly INeonGatewayShadowRun[]
): IRescuePartition {
  const kept: INeonGatewayShadowRun[] = [];
  const rescued: INeonGatewayShadowRun[] = [];

  for (const run of runs) {
    if (RESCUED_STATUSES.includes(run.status)) {
      rescued.push(run);
    } else {
      kept.push(run);
    }
  }

  return { kept, rescued };
}

export async function rescueNeonGatewayRunStore(
  projectRoot: string,
  options: INeonRunStoreRescueOptions = {}
): Promise<INeonRunStoreRescueResult> {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? resolveNeonRunStoreRescueEnabled(env);
  const now = options.now ?? (() => new Date());
  const paths = resolveGatewayStatePaths(projectRoot);
  const runs = await readNeonGatewayRuns(projectRoot);
  const { kept, rescued } = partitionRescuableRuns(runs);
  const rescuedRunIds = rescued.map((run) => run.runId);

  const baseResult: Omit<INeonRunStoreRescueResult, "applied" | "archivePath"> = {
    totalRuns: runs.length,
    keptRuns: kept.length,
    rescuedRuns: rescued.length,
    rescuedStatuses: RESCUED_STATUSES,
    rescuedRunIds,
    runsPath: paths.runsPath
  };

  if (!enabled || rescued.length === 0) {
    return { ...baseResult, applied: false, archivePath: null };
  }

  const archiveDir = join(paths.gatewayRoot, ARCHIVE_DIR);
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, `rescued-runs-${stamp}.jsonl`);
  const rescuedAt = now().toISOString();

  await mkdir(archiveDir, { recursive: true });
  const archiveBody = rescued
    .map((run) => JSON.stringify({ rescuedAt, reason: "shadow-exit-rescue", run }))
    .join("\n");
  await appendFile(archivePath, `${archiveBody}\n`, "utf8");

  const keptBody = kept.map((run) => JSON.stringify(run)).join("\n");
  await writeFile(paths.runsPath, kept.length > 0 ? `${keptBody}\n` : "", "utf8");

  return { ...baseResult, applied: true, archivePath };
}

export function renderNeonRunStoreRescueReport(
  result: INeonRunStoreRescueResult
): string {
  return [
    `Run-store rescue: ${result.applied ? "applied" : "dry-run"}`,
    `Total runs: ${result.totalRuns}`,
    `Kept: ${result.keptRuns}`,
    `Rescued (${result.rescuedStatuses.join(", ")}): ${result.rescuedRuns}`,
    `Runs path: ${result.runsPath}`,
    `Archive: ${result.archivePath ?? "none"}`,
    result.applied
      ? "Rescued runs were archived, not deleted."
      : result.rescuedRuns > 0
        ? `Set ${RESCUE_ENABLED_ENV_KEY}=ready to archive and rewrite the store.`
        : "Nothing to rescue."
  ].join("\n");
}
