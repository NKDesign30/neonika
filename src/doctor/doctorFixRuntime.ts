import { chmod, stat } from "node:fs/promises";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";

/**
 * Gated Doctor `--fix` runtime (DP-12).
 *
 * `doctor --explain` produces a read-only repair plan whose remediations are all
 * permission tightenings (`chmod 700` on the state dir, `chmod 600` on config files).
 * This applies ONE such permission fix, but only behind the `NEON_DOCTOR_FIX_ENABLED`
 * gate (default-off) and only for the `permission-tighten` kind. It is content-safe
 * (mode bits only, never file contents) and reversible: the previous mode is captured
 * as a rollback record before the chmod, so `rollbackNeonDoctorPermissionFix` can
 * restore it. Re-running on the real state/config tree is a deliberate operator decision;
 * the smoke and tests prove it against an isolated temp file.
 */
export type TNeonDoctorFixGateReason = "fix-disabled" | "fix-enabled";
export type TNeonDoctorFixState = "fixed" | "blocked";
export type TNeonDoctorFixKind = "permission-tighten";
export type TNeonDoctorFixBlockReason = "gate-disabled" | "not-a-file" | "already-tight";

const doctorFixEnabledEnvKey = "NEON_DOCTOR_FIX_ENABLED";
const permissionMask = 0o777;

export interface INeonDoctorFixGate {
  readonly enabled: boolean;
  readonly reason: TNeonDoctorFixGateReason;
  readonly envKey: typeof doctorFixEnabledEnvKey;
}

export interface INeonDoctorFixRollback {
  readonly targetPath: string;
  readonly mode: number;
  readonly modeOctal: string;
}

export interface INeonDoctorPermissionFixResult {
  readonly state: TNeonDoctorFixState;
  readonly kind: TNeonDoctorFixKind;
  readonly blockReason?: TNeonDoctorFixBlockReason;
  readonly gate: INeonDoctorFixGate;
  readonly targetPath: string;
  readonly previousModeOctal?: string;
  readonly newModeOctal?: string;
  readonly rollback?: INeonDoctorFixRollback;
  readonly safety: { readonly contentMutated: false; readonly reversible: true };
  readonly diagnostics: readonly string[];
}

export interface IApplyNeonDoctorPermissionFixOptions {
  readonly targetPath: string;
  readonly desiredMode: number;
  readonly gate: INeonDoctorFixGate;
}

const safety = { contentMutated: false, reversible: true } as const;

export function resolveNeonDoctorFixGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonDoctorFixGate {
  const enabled = readReadyCutoverEnv(env, doctorFixEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "fix-enabled" : "fix-disabled",
    envKey: doctorFixEnabledEnvKey
  };
}

export async function applyNeonDoctorPermissionFix(
  options: IApplyNeonDoctorPermissionFixOptions
): Promise<INeonDoctorPermissionFixResult> {
  const displayPath = redactText(options.targetPath);
  const desiredMode = options.desiredMode & permissionMask;

  if (!options.gate.enabled) {
    return blocked("gate-disabled", options.gate, displayPath, [
      "doctor --fix blocked: NEON_DOCTOR_FIX_ENABLED is off (default)"
    ]);
  }

  const stats = await stat(options.targetPath).catch(() => undefined);
  if (!stats || !stats.isFile()) {
    return blocked("not-a-file", options.gate, displayPath, [
      "doctor --fix blocked: target is not a regular file"
    ]);
  }

  const previousMode = stats.mode & permissionMask;
  if (previousMode === desiredMode) {
    return {
      state: "blocked",
      kind: "permission-tighten",
      blockReason: "already-tight",
      gate: options.gate,
      targetPath: displayPath,
      previousModeOctal: toOctal(previousMode),
      safety,
      diagnostics: ["doctor --fix skipped: permissions already match the desired mode"]
    };
  }

  await chmod(options.targetPath, desiredMode);
  const after = await stat(options.targetPath);
  const newMode = after.mode & permissionMask;

  return {
    state: "fixed",
    kind: "permission-tighten",
    gate: options.gate,
    targetPath: displayPath,
    previousModeOctal: toOctal(previousMode),
    newModeOctal: toOctal(newMode),
    rollback: { targetPath: options.targetPath, mode: previousMode, modeOctal: toOctal(previousMode) },
    safety,
    diagnostics: [`tightened permissions ${toOctal(previousMode)} -> ${toOctal(newMode)} (content untouched, reversible)`]
  };
}

export async function rollbackNeonDoctorPermissionFix(
  rollback: INeonDoctorFixRollback
): Promise<{ readonly restoredModeOctal: string }> {
  await chmod(rollback.targetPath, rollback.mode & permissionMask);
  const after = await stat(rollback.targetPath);

  return { restoredModeOctal: toOctal(after.mode & permissionMask) };
}

export function renderNeonDoctorPermissionFixReport(result: INeonDoctorPermissionFixResult): string {
  return [
    `Neon Doctor Fix: ${result.state}${result.blockReason ? ` / ${result.blockReason}` : ""} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Kind: ${result.kind}`,
    `Target: ${result.targetPath}`,
    `Mode: ${result.previousModeOctal ?? "?"} -> ${result.newModeOctal ?? result.previousModeOctal ?? "?"}`,
    `Rollback: ${result.rollback ? `restore ${result.rollback.modeOctal}` : "none"}`,
    `Safety: contentMutated=${result.safety.contentMutated} reversible=${result.safety.reversible}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function blocked(
  blockReason: TNeonDoctorFixBlockReason,
  gate: INeonDoctorFixGate,
  targetPath: string,
  diagnostics: readonly string[]
): INeonDoctorPermissionFixResult {
  return {
    state: "blocked",
    kind: "permission-tighten",
    blockReason,
    gate,
    targetPath,
    safety,
    diagnostics
  };
}

function toOctal(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}
