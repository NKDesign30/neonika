import { readReadyCutoverEnv } from "../core/cutover.js";
import type { THarnessRunMode } from "./types.js";

/**
 * Write-mode gate for harness runs (DP-4).
 *
 * The harness maps a `write` binding to a `workspace-write` codex sandbox with an
 * `on-request` approval policy — a real filesystem side effect. This gate is the
 * single decision point that keeps that path closed by default: a run only enters
 * `write` mode when it both requests it AND an explicit, env-set flag is ready.
 * Any unrequested or ungated run is forced to `read-only`, so the default Neon
 * gateway path can never silently start writing.
 */
export type TNeonHarnessRunModeReason =
  | "requested-read-only"
  | "write-enabled"
  | "write-gate-closed";

export interface INeonHarnessRunModeDecision {
  readonly mode: THarnessRunMode;
  readonly requested: THarnessRunMode;
  readonly writeEnabled: boolean;
  readonly reason: TNeonHarnessRunModeReason;
}

const harnessWriteEnabledEnvKey = "NEON_HARNESS_WRITE_ENABLED";

export function resolveNeonHarnessRunMode(
  requested: THarnessRunMode,
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonHarnessRunModeDecision {
  if (requested === "read-only") {
    return {
      mode: "read-only",
      requested,
      writeEnabled: false,
      reason: "requested-read-only"
    };
  }

  const writeEnabled = readReadyCutoverEnv(env, harnessWriteEnabledEnvKey);

  return writeEnabled
    ? { mode: "write", requested, writeEnabled: true, reason: "write-enabled" }
    : { mode: "read-only", requested, writeEnabled: false, reason: "write-gate-closed" };
}
