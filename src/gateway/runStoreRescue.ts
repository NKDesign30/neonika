import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readReadyCutoverEnv } from "../core/cutover.js";
import {
  readNeonGatewayRuns,
  resolveGatewayStatePaths,
  scanNeonRunStoreIntegrity
} from "./runStore.js";
import type { INeonGatewayShadowRun, TNeonGatewayRunStatus } from "./types.js";

/**
 * Archive-not-delete supersession for failed terminal runs.
 *
 * The default is a read-only plan. Apply requires the explicit ready gate,
 * writes a private archive first, replaces the active store atomically, and
 * records leak-safe evidence that Doctor and the cutover report can inspect.
 */
const ARCHIVE_DIR = "archive";
const SUPERSESSION_DIR = "supersessions";
const RESCUE_ENABLED_ENV_KEY = "NEON_RUN_STORE_RESCUE_ENABLED";
const SUPERSESSION_REASON = "operator-failed-run-supersession";
const ARCHIVE_REASON = "shadow-exit-rescue";
const SUPERSESSION_SCHEMA_VERSION = 1;

/** Run statuses the workflow supersedes from the active evidence set. */
const RESCUED_STATUSES: readonly TNeonGatewayRunStatus[] = ["failed"];

export type TNeonRunStoreSupersessionEvidenceState = "empty" | "ready" | "invalid";
export type TNeonRunStoreSupersessionRecordState = "prepared" | "applied";

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
  readonly supersessionPath: string | null;
  readonly supersessionId: string | null;
}

export interface INeonRunStoreSupersessionRecord {
  readonly schemaVersion: 1;
  readonly state: TNeonRunStoreSupersessionRecordState;
  readonly supersessionId: string;
  readonly supersededAt: string;
  readonly reason: typeof SUPERSESSION_REASON;
  readonly activeRunsBefore: number;
  readonly activeRunsAfter: number;
  readonly archivedFailedRuns: number;
  readonly activeStoreBeforeSha256: string;
  readonly activeStoreAfterSha256: string;
  readonly archiveFile: string;
  readonly archiveSha256: string;
}

export interface INeonRunStoreSupersessionTotals {
  readonly records: number;
  readonly archivedFailedRuns: number;
  readonly incompleteRecords: number;
  readonly invalidRecords: number;
}

export interface INeonRunStoreSupersessionEvidence {
  readonly state: TNeonRunStoreSupersessionEvidenceState;
  readonly totals: INeonRunStoreSupersessionTotals;
  readonly latest: INeonRunStoreSupersessionRecord | null;
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

  const baseResult: Omit<
    INeonRunStoreRescueResult,
    "applied" | "archivePath" | "supersessionPath" | "supersessionId"
  > = {
    totalRuns: runs.length,
    keptRuns: kept.length,
    rescuedRuns: rescued.length,
    rescuedStatuses: RESCUED_STATUSES,
    rescuedRunIds,
    runsPath: paths.runsPath
  };

  if (!enabled || rescued.length === 0) {
    return {
      ...baseResult,
      applied: false,
      archivePath: null,
      supersessionPath: null,
      supersessionId: null
    };
  }

  const activeStoreBefore = await readOptionalFile(paths.runsPath);
  const integrity = scanNeonRunStoreIntegrity(activeStoreBefore || undefined);
  if (integrity.corruptLines > 0) {
    throw new Error(
      `Run-store supersession refused: ${integrity.corruptLines} unparsable line(s) require operator review.`
    );
  }

  const supersededAt = now().toISOString();
  const stamp = supersededAt.replace(/[:.]/g, "-");
  const archiveDir = join(paths.gatewayRoot, ARCHIVE_DIR);
  const supersessionDir = join(archiveDir, SUPERSESSION_DIR);
  const archiveBody = rescued
    .map((run) => JSON.stringify({ supersededAt, reason: ARCHIVE_REASON, run }))
    .join("\n");
  const activeStoreAfter = serializeRuns(kept);
  const archiveSha256 = sha256(archiveBody);
  const activeStoreBeforeSha256 = sha256(activeStoreBefore);
  const activeStoreAfterSha256 = sha256(activeStoreAfter);
  const supersessionId = deriveSupersessionId(
    supersededAt,
    archiveSha256,
    activeStoreBeforeSha256,
    activeStoreAfterSha256
  );
  const archiveFile = `rescued-runs-${stamp}-${supersessionId.slice(0, 12)}.jsonl`;
  const archivePath = join(archiveDir, archiveFile);
  const supersessionPath = join(supersessionDir, `supersession-${supersessionId}.json`);
  const record: INeonRunStoreSupersessionRecord = {
    schemaVersion: SUPERSESSION_SCHEMA_VERSION,
    state: "prepared",
    supersessionId,
    supersededAt,
    reason: SUPERSESSION_REASON,
    activeRunsBefore: runs.length,
    activeRunsAfter: kept.length,
    archivedFailedRuns: rescued.length,
    activeStoreBeforeSha256,
    activeStoreAfterSha256,
    archiveFile,
    archiveSha256
  };

  await mkdir(supersessionDir, { recursive: true, mode: 0o700 });
  await writeFile(archivePath, `${archiveBody}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await writeJsonAtomically(supersessionPath, record);
  await writeTextAtomically(paths.runsPath, activeStoreAfter);
  await writeJsonAtomically(supersessionPath, { ...record, state: "applied" });

  return {
    ...baseResult,
    applied: true,
    archivePath,
    supersessionPath,
    supersessionId
  };
}

export async function readNeonRunStoreSupersessionEvidence(
  projectRoot: string
): Promise<INeonRunStoreSupersessionEvidence> {
  const paths = resolveGatewayStatePaths(projectRoot);
  const archiveDir = join(paths.gatewayRoot, ARCHIVE_DIR);
  const supersessionDir = join(archiveDir, SUPERSESSION_DIR);
  const fileNames = await readDirectoryOrEmpty(supersessionDir);
  const records: INeonRunStoreSupersessionRecord[] = [];
  let incompleteRecords = 0;
  let invalidRecords = 0;

  for (const fileName of fileNames.filter((entry) => entry.endsWith(".json")).sort()) {
    const raw = await readOptionalFile(join(supersessionDir, fileName));
    const record = parseSupersessionRecord(raw);
    if (!record) {
      invalidRecords += 1;
      continue;
    }
    if (fileName !== `supersession-${record.supersessionId}.json`) {
      invalidRecords += 1;
      continue;
    }
    if (record.state !== "applied") {
      incompleteRecords += 1;
      continue;
    }
    if (!(await validateSupersessionArchive(archiveDir, record))) {
      invalidRecords += 1;
      continue;
    }
    records.push(record);
  }

  const archivedFailedRuns = records.reduce((total, record) => total + record.archivedFailedRuns, 0);
  const latest = [...records]
    .sort((left, right) => left.supersededAt.localeCompare(right.supersededAt))
    .at(-1) ?? null;

  return {
    state:
      invalidRecords > 0 || incompleteRecords > 0
        ? "invalid"
        : records.length > 0
          ? "ready"
          : "empty",
    totals: {
      records: records.length,
      archivedFailedRuns,
      incompleteRecords,
      invalidRecords
    },
    latest
  };
}

export function renderNeonRunStoreRescueReport(
  result: INeonRunStoreRescueResult
): string {
  return [
    `Run-store rescue: ${result.applied ? "applied" : "dry-run"}`,
    `Total runs: ${result.totalRuns}`,
    `Kept: ${result.keptRuns}`,
    `Rescued (${result.rescuedStatuses.join(", ")}): ${result.rescuedRuns}`,
    `Audit evidence: ${result.supersessionId ? result.supersessionId.slice(0, 16) : "none"}`,
    result.applied
      ? "Failed runs were archived locally and superseded from the active evidence set."
      : result.rescuedRuns > 0
        ? `Set ${RESCUE_ENABLED_ENV_KEY}=ready to archive and atomically rewrite the active store.`
        : "Nothing to rescue."
  ].join("\n");
}

export function renderNeonRunStoreSupersessionReport(
  evidence: INeonRunStoreSupersessionEvidence
): string {
  return [
    `Run-store supersession evidence: ${evidence.state}`,
    `Records: ${evidence.totals.records}`,
    `Archived failed runs: ${evidence.totals.archivedFailedRuns}`,
    `Incomplete records: ${evidence.totals.incompleteRecords}`,
    `Invalid records: ${evidence.totals.invalidRecords}`,
    evidence.latest
      ? `Latest: ${evidence.latest.supersessionId.slice(0, 16)} at ${evidence.latest.supersededAt} (${evidence.latest.activeRunsBefore} -> ${evidence.latest.activeRunsAfter}) archive-sha256=${evidence.latest.archiveSha256}`
      : "Latest: none"
  ].join("\n");
}

function serializeRuns(runs: readonly INeonGatewayShadowRun[]): string {
  const body = runs.map((run) => JSON.stringify(run)).join("\n");
  return body.length > 0 ? `${body}\n` : "";
}

async function validateSupersessionArchive(
  archiveDir: string,
  record: INeonRunStoreSupersessionRecord
): Promise<boolean> {
  if (basename(record.archiveFile) !== record.archiveFile) {
    return false;
  }
  if (
    record.supersessionId !==
    deriveSupersessionId(
      record.supersededAt,
      record.archiveSha256,
      record.activeStoreBeforeSha256,
      record.activeStoreAfterSha256
    )
  ) {
    return false;
  }
  if (record.activeRunsBefore - record.archivedFailedRuns !== record.activeRunsAfter) {
    return false;
  }

  const archiveRaw = await readOptionalFile(join(archiveDir, record.archiveFile));
  if (!archiveRaw || sha256(archiveRaw.trimEnd()) !== record.archiveSha256) {
    return false;
  }

  const lines = archiveRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== record.archivedFailedRuns) {
    return false;
  }

  return lines.every((line) => isArchivedFailedRunLine(line));
}

function isArchivedFailedRunLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return (
      isRecord(parsed) &&
      parsed["reason"] === ARCHIVE_REASON &&
      isRecord(parsed["run"]) &&
      parsed["run"]["status"] === "failed"
    );
  } catch {
    return false;
  }
}

function parseSupersessionRecord(raw: string): INeonRunStoreSupersessionRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed["schemaVersion"] !== SUPERSESSION_SCHEMA_VERSION ||
      (parsed["state"] !== "prepared" && parsed["state"] !== "applied") ||
      typeof parsed["supersessionId"] !== "string" ||
      !isSha256(parsed["supersessionId"]) ||
      typeof parsed["supersededAt"] !== "string" ||
      !Number.isFinite(Date.parse(parsed["supersededAt"])) ||
      parsed["reason"] !== SUPERSESSION_REASON ||
      !isNonNegativeInteger(parsed["activeRunsBefore"]) ||
      !isNonNegativeInteger(parsed["activeRunsAfter"]) ||
      !isNonNegativeInteger(parsed["archivedFailedRuns"]) ||
      !isSha256(parsed["activeStoreBeforeSha256"]) ||
      !isSha256(parsed["activeStoreAfterSha256"]) ||
      typeof parsed["archiveFile"] !== "string" ||
      !isSha256(parsed["archiveSha256"])
    ) {
      return undefined;
    }

    return {
      schemaVersion: SUPERSESSION_SCHEMA_VERSION,
      state: parsed["state"],
      supersessionId: parsed["supersessionId"],
      supersededAt: parsed["supersededAt"],
      reason: SUPERSESSION_REASON,
      activeRunsBefore: parsed["activeRunsBefore"],
      activeRunsAfter: parsed["activeRunsAfter"],
      archivedFailedRuns: parsed["archivedFailedRuns"],
      activeStoreBeforeSha256: parsed["activeStoreBeforeSha256"],
      activeStoreAfterSha256: parsed["activeStoreAfterSha256"],
      archiveFile: parsed["archiveFile"],
      archiveSha256: parsed["archiveSha256"]
    };
  } catch {
    return undefined;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function readDirectoryOrEmpty(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deriveSupersessionId(
  supersededAt: string,
  archiveSha256: string,
  activeStoreBeforeSha256: string,
  activeStoreAfterSha256: string
): string {
  return sha256(
    `${supersededAt}:${archiveSha256}:${activeStoreBeforeSha256}:${activeStoreAfterSha256}`
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
