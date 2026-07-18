// Retire-stage portability evidence: a real export -> import round-trip over the
// persisted, already-redacted gateway runs. This replaces the bare
// `NEON_CUTOVER_RETIRE_EVIDENCE` flag claim with a concrete, verifiable smoke an
// operator can run to prove the run history is portable before decommissioning
// the old runtime. Upstream exports/imports session + state during migration
// (`src/commands/doctor-state-integrity.ts`, wizard migration import). Strategy:
// rebuild-native — Neon owns a small, versioned run-bundle format. No live run is
// mutated and the runs are already redacted on read, so the bundle carries no
// new secret.

import type { INeonGatewayShadowRun } from "../gateway/types.js";

export const NEON_RETIRE_BUNDLE_VERSION = 1;

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
