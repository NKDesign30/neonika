// Retire-stage portability evidence: a real export -> import round-trip over the
// persisted, already-redacted gateway runs. This replaces the bare
// `NEON_CUTOVER_RETIRE_EVIDENCE` flag claim with a concrete, verifiable smoke an
// operator can run to prove the run history is portable before decommissioning
// the old runtime. Upstream exports/imports session + state during migration
// (`src/commands/doctor-state-integrity.ts`, wizard migration import). Strategy:
// rebuild-native — Neon owns a small, versioned run-bundle format. No live run is
// mutated and the runs are already redacted on read, so the bundle carries no
// new secret.

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  readNeonGatewayRuns,
  resolveGatewayStatePaths,
  scanNeonRunStoreIntegrity
} from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";

export const NEON_RETIRE_BUNDLE_VERSION = 1;
export const NEON_RETIRE_EVIDENCE_VERSION = 1;

export interface INeonRetireExportBundle {
  readonly version: number;
  readonly exportedAt: string;
  readonly runCount: number;
  readonly runs: readonly INeonGatewayShadowRun[];
}

export interface INeonRetireParseResult {
  readonly ok: boolean;
  readonly bundle?: INeonRetireExportBundle;
  readonly error?: string;
}

export interface INeonRetireRoundTripResult {
  readonly exported: number;
  readonly imported: number;
  readonly roundTripOk: boolean;
  readonly diagnostics: readonly string[];
}

export interface INeonRetireEvidenceRecord {
  readonly version: number;
  readonly verifiedAt: string;
  readonly exported: number;
  readonly imported: number;
  readonly roundTripOk: true;
  readonly bundleSha256: string;
}

export interface INeonRetireEvidenceSnapshot {
  readonly state: "ready" | "needs-evidence" | "blocked";
  readonly record?: INeonRetireEvidenceRecord;
  readonly diagnostics: readonly string[];
}

export interface INeonRetireEvidenceWriteResult {
  readonly record: INeonRetireEvidenceRecord;
  readonly roundTrip: INeonRetireRoundTripResult;
}

const CUTOVER_STATE_DIR = "cutover";
const RETIRE_EVIDENCE_FILE = "retire-evidence.json";

export function resolveNeonRetireEvidencePath(projectRoot: string): string {
  const gatewayPaths = resolveGatewayStatePaths(projectRoot);
  return join(gatewayPaths.stateRoot, CUTOVER_STATE_DIR, RETIRE_EVIDENCE_FILE);
}

export async function writeNeonRetireRoundTripEvidence(
  projectRoot: string,
  verifiedAt: string
): Promise<INeonRetireEvidenceWriteResult> {
  const runs = await readFullNeonRetireRunStore(projectRoot);
  if (runs.length === 0) {
    throw new Error("Retire evidence requires a non-empty run history");
  }
  if (!Number.isFinite(Date.parse(verifiedAt))) {
    throw new Error("Retire evidence requires a valid verification timestamp");
  }

  const result = verifyNeonRetireRoundTrip(runs, verifiedAt);
  if (!result.roundTripOk || result.exported !== result.imported) {
    throw new Error("Retire export/import round-trip verification failed");
  }
  const serializedBundle = serializeNeonRetireBundle(createNeonRetireExportBundle(runs, verifiedAt));
  const record: INeonRetireEvidenceRecord = {
    version: NEON_RETIRE_EVIDENCE_VERSION,
    verifiedAt,
    exported: result.exported,
    imported: result.imported,
    roundTripOk: true,
    bundleSha256: createHash("sha256").update(serializedBundle).digest("hex")
  };
  const evidencePath = resolveNeonRetireEvidencePath(projectRoot);
  const evidenceRoot = dirname(evidencePath);
  const temporaryPath = `${evidencePath}.${randomUUID()}.tmp`;

  await mkdir(evidenceRoot, { mode: 0o700, recursive: true });
  const evidenceRootStats = await lstat(evidenceRoot);
  if (!evidenceRootStats.isDirectory() || evidenceRootStats.isSymbolicLink()) {
    throw new Error("Retire evidence directory must be a real directory");
  }
  await chmod(evidenceRoot, 0o700);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, evidencePath);
    await chmod(evidencePath, 0o600);
  } catch (error) {
    await handle?.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return { record, roundTrip: result };
}

export async function createNeonRetireEvidenceSnapshot(
  projectRoot: string
): Promise<INeonRetireEvidenceSnapshot> {
  const evidencePath = resolveNeonRetireEvidencePath(projectRoot);
  const boundaryState = await inspectNeonRetireEvidenceBoundary(projectRoot, evidencePath);
  if (boundaryState === "missing") {
    return {
      state: "needs-evidence",
      diagnostics: ["retire evidence has not been recorded"]
    };
  }
  if (boundaryState === "blocked") {
    return {
      state: "blocked",
      diagnostics: ["retire evidence boundary is unsafe"]
    };
  }
  let raw: string;

  try {
    const stats = await lstat(evidencePath);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
      return {
        state: "blocked",
        diagnostics: ["retire evidence must be a private regular file"]
      };
    }
    raw = await readFile(evidencePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return {
        state: "needs-evidence",
        diagnostics: ["retire evidence has not been recorded"]
      };
    }
    return {
      state: "blocked",
      diagnostics: ["retire evidence could not be read safely"]
    };
  }

  const record = parseNeonRetireEvidenceRecord(raw);
  if (!record) {
    return {
        state: "blocked",
        diagnostics: ["retire evidence is malformed"]
      };
  }

  let runs: readonly INeonGatewayShadowRun[];
  try {
    runs = await readFullNeonRetireRunStore(projectRoot);
  } catch {
    return {
      state: "blocked",
      diagnostics: ["retire evidence cannot verify the current full run store"]
    };
  }
  const currentRoundTrip = verifyNeonRetireRoundTrip(runs, record.verifiedAt);
  const currentBundleSha256 = createHash("sha256")
    .update(serializeNeonRetireBundle(createNeonRetireExportBundle(runs, record.verifiedAt)))
    .digest("hex");
  if (
    !currentRoundTrip.roundTripOk ||
    currentRoundTrip.exported !== record.exported ||
    currentRoundTrip.imported !== record.imported ||
    currentBundleSha256 !== record.bundleSha256
  ) {
    return {
      state: "blocked",
      diagnostics: ["retire evidence no longer matches the current full run store"]
    };
  }

  return {
    state: "ready",
    record,
    diagnostics: [`verified ${record.imported} portable run(s) against the current full run store`]
  };
}

export function createNeonRetireExportBundle(
  runs: readonly INeonGatewayShadowRun[],
  exportedAt: string
): INeonRetireExportBundle {
  return {
    version: NEON_RETIRE_BUNDLE_VERSION,
    exportedAt,
    runCount: runs.length,
    runs
  };
}

export function serializeNeonRetireBundle(bundle: INeonRetireExportBundle): string {
  return JSON.stringify(bundle);
}

export function parseNeonRetireBundle(text: string): INeonRetireParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "bundle is not valid JSON" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "bundle is not an object" };
  }

  if (parsed["version"] !== NEON_RETIRE_BUNDLE_VERSION) {
    return { ok: false, error: `unsupported bundle version (expected ${NEON_RETIRE_BUNDLE_VERSION})` };
  }

  const exportedAt = parsed["exportedAt"];
  if (typeof exportedAt !== "string" || exportedAt.length === 0) {
    return { ok: false, error: "bundle is missing exportedAt" };
  }

  const runs = parsed["runs"];
  if (!Array.isArray(runs)) {
    return { ok: false, error: "bundle runs is not an array" };
  }

  if (!runs.every((run) => isRecord(run) && typeof run["runId"] === "string")) {
    return { ok: false, error: "bundle contains a run without a string runId" };
  }

  if (parsed["runCount"] !== runs.length) {
    return { ok: false, error: "bundle runCount does not match the run array length" };
  }

  return {
    ok: true,
    bundle: {
      version: NEON_RETIRE_BUNDLE_VERSION,
      exportedAt,
      runCount: runs.length,
      runs: runs as readonly INeonGatewayShadowRun[]
    }
  };
}

/**
 * Export the runs to a bundle, serialize, parse back, and verify the round-trip
 * preserved every run (count + stable re-serialization). Pure and deterministic.
 */
export function verifyNeonRetireRoundTrip(
  runs: readonly INeonGatewayShadowRun[],
  exportedAt: string
): INeonRetireRoundTripResult {
  const bundle = createNeonRetireExportBundle(runs, exportedAt);
  const serialized = serializeNeonRetireBundle(bundle);
  const parsed = parseNeonRetireBundle(serialized);
  const diagnostics: string[] = [];

  if (!parsed.ok || !parsed.bundle) {
    diagnostics.push(`import failed: ${parsed.error ?? "unknown error"}`);
    return { exported: runs.length, imported: 0, roundTripOk: false, diagnostics };
  }

  const imported = parsed.bundle.runs.length;
  const stable = serializeNeonRetireBundle(parsed.bundle) === serialized;

  if (!stable) {
    diagnostics.push("round-trip changed the serialized bundle");
  }

  const countOk = imported === runs.length;
  if (!countOk) {
    diagnostics.push(`run count changed: exported ${runs.length}, imported ${imported}`);
  }

  if (diagnostics.length === 0) {
    diagnostics.push(`round-trip verified ${imported} run(s) with a stable bundle`);
  }

  return {
    exported: runs.length,
    imported,
    roundTripOk: stable && countOk,
    diagnostics
  };
}

export function renderNeonRetireRoundTripReport(result: INeonRetireRoundTripResult): string {
  return [
    `Neonika Retire Export/Import: ${result.roundTripOk ? "ok" : "failed"}`,
    `Exported: ${result.exported}`,
    `Imported: ${result.imported}`,
    `Round-trip: ${result.roundTripOk}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNeonRetireEvidenceRecord(raw: string): INeonRetireEvidenceRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const verifiedAt = value["verifiedAt"];
  const exported = value["exported"];
  const imported = value["imported"];
  const bundleSha256 = value["bundleSha256"];
  if (
    value["version"] !== NEON_RETIRE_EVIDENCE_VERSION ||
    typeof verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(verifiedAt)) ||
    !Number.isSafeInteger(exported) ||
    typeof exported !== "number" ||
    exported < 1 ||
    imported !== exported ||
    value["roundTripOk"] !== true ||
    typeof bundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(bundleSha256)
  ) {
    return undefined;
  }

  return {
    version: NEON_RETIRE_EVIDENCE_VERSION,
    verifiedAt,
    exported,
    imported: exported,
    roundTripOk: true,
    bundleSha256
  };
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}

async function readFullNeonRetireRunStore(
  projectRoot: string
): Promise<readonly INeonGatewayShadowRun[]> {
  const paths = resolveGatewayStatePaths(projectRoot);
  await assertRealDirectory(paths.projectRoot, undefined, "Retire project root");
  const stateRootPresent = await assertRealDirectory(paths.stateRoot, 0o700, "Retire state root", true);
  if (!stateRootPresent) {
    return [];
  }
  const gatewayRootPresent = await assertRealDirectory(
    paths.gatewayRoot,
    0o700,
    "Retire gateway state directory",
    true
  );
  if (!gatewayRootPresent) {
    return [];
  }
  const runsPresent = await assertPrivateRegularFile(paths.runsPath, "Retire run store", true);
  if (!runsPresent) {
    return [];
  }
  let rawRuns: string | undefined;
  try {
    rawRuns = await readFile(paths.runsPath, "utf8");
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
  const integrity = scanNeonRunStoreIntegrity(rawRuns);
  if (integrity.corruptLines > 0) {
    throw new Error("Retire evidence requires a fully parseable run store");
  }
  const runs = await readNeonGatewayRuns(projectRoot);
  if (runs.length !== integrity.parsedRuns) {
    throw new Error("Retire evidence run store changed during verification");
  }
  return runs;
}

async function inspectNeonRetireEvidenceBoundary(
  projectRoot: string,
  evidencePath: string
): Promise<"blocked" | "missing" | "ready"> {
  const paths = resolveGatewayStatePaths(projectRoot);
  try {
    await assertRealDirectory(paths.projectRoot, undefined, "Retire project root");
    const stateRootPresent = await assertRealDirectory(
      paths.stateRoot,
      0o700,
      "Retire state root",
      true
    );
    if (!stateRootPresent) {
      return "missing";
    }
    const evidenceRootPresent = await assertRealDirectory(
      dirname(evidencePath),
      0o700,
      "Retire evidence directory",
      true
    );
    return evidenceRootPresent ? "ready" : "missing";
  } catch {
    return "blocked";
  }
}

async function assertRealDirectory(
  path: string,
  expectedMode: number | undefined,
  label: string,
  allowMissing = false
): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (allowMissing && isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (expectedMode !== undefined && (stats.mode & 0o777) !== expectedMode) {
    throw new Error(`${label} permissions must be ${expectedMode.toString(8)}`);
  }
  return true;
}

async function assertPrivateRegularFile(
  path: string,
  label: string,
  allowMissing = false
): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (allowMissing && isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 600`);
  }
  return true;
}
