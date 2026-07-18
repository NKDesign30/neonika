import { readReadyCutoverEnv } from "./cutover.js";
import {
  writeNeonMirrorEvidence,
  type INeonMirrorEvidenceRecord,
  type TNeonMirrorEvidenceVerdict
} from "./mirrorEvidence.js";

/**
 * Gated mirror comparison run (DP-13, mirror half).
 *
 * The mirror stage wants the SAME prompt run against the previous runtime and Neonika, with
 * latency measured and evidence written. Driving v3 live needs a running v3 process,
 * which is an operator decision — so this runtime drives only the Neonika side live (via an
 * injected runner) and takes the v3 side as INPUT. Behind `NEON_MIRROR_RUN_ENABLED`
 * (default-off) it runs the Neon side, computes a verdict against the supplied v3 output,
 * and writes a redacted evidence record through the existing mirror-evidence layer.
 * `safety.drivesV3Live:false` documents that v3 is never auto-driven here.
 */
export type TNeonMirrorRunGateReason = "mirror-run-disabled" | "mirror-run-enabled";
export type TNeonMirrorComparisonState = "compared" | "blocked";

const mirrorRunEnabledEnvKey = "NEON_MIRROR_RUN_ENABLED";

export interface INeonMirrorRunGate {
  readonly enabled: boolean;
  readonly reason: TNeonMirrorRunGateReason;
  readonly envKey: typeof mirrorRunEnabledEnvKey;
}

export interface INeonMirrorSideResult {
  readonly output: string;
  readonly latencyMs?: number;
  readonly runId?: string;
}

export interface INeonMirrorComparisonResult {
  readonly state: TNeonMirrorComparisonState;
  readonly gate: INeonMirrorRunGate;
  readonly verdict?: TNeonMirrorEvidenceVerdict;
  readonly evidenceId?: string;
  readonly latencyDeltaMs?: number;
  readonly safety: { readonly evidenceWritten: boolean; readonly drivesV3Live: false };
  readonly diagnostics: readonly string[];
}

export interface IRunNeonMirrorComparisonOptions {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly gate: INeonMirrorRunGate;
  readonly runNeonSide: (prompt: string) => Promise<INeonMirrorSideResult>;
  readonly v3Side: INeonMirrorSideResult;
  readonly computeVerdict?: (neonOutput: string, v3Output: string) => TNeonMirrorEvidenceVerdict;
  readonly reviewer?: string;
  readonly now?: () => Date;
}

export function resolveNeonMirrorRunGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonMirrorRunGate {
  const enabled = readReadyCutoverEnv(env, mirrorRunEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "mirror-run-enabled" : "mirror-run-disabled",
    envKey: mirrorRunEnabledEnvKey
  };
}

export function defaultNeonMirrorVerdict(
  neonOutput: string,
  v3Output: string
): TNeonMirrorEvidenceVerdict {
  if (neonOutput === v3Output) {
    return "match";
  }
  if (normalize(neonOutput) === normalize(v3Output)) {
    return "acceptable";
  }
  return "drift";
}

export async function runNeonMirrorComparison(
  options: IRunNeonMirrorComparisonOptions
): Promise<INeonMirrorComparisonResult> {
  if (!options.gate.enabled) {
    return {
      state: "blocked",
      gate: options.gate,
      safety: { evidenceWritten: false, drivesV3Live: false },
      diagnostics: [
        "mirror run blocked: NEON_MIRROR_RUN_ENABLED is off (default). No Neon side run, no evidence written.",
        "v3 is supplied as input; this runtime never auto-drives the live v3 process."
      ]
    };
  }

  const neon = await options.runNeonSide(options.prompt);
  const verdict = (options.computeVerdict ?? defaultNeonMirrorVerdict)(neon.output, options.v3Side.output);
  const latencyDeltaMs = resolveLatencyDelta(neon.latencyMs, options.v3Side.latencyMs);

  const record: INeonMirrorEvidenceRecord = await writeNeonMirrorEvidence(options.projectRoot, {
    prompt: options.prompt,
    legacyOutput: options.v3Side.output,
    neonOutput: neon.output,
    verdict,
    ...(options.v3Side.latencyMs !== undefined ? { legacyLatencyMs: options.v3Side.latencyMs } : {}),
    ...(neon.latencyMs !== undefined ? { neonLatencyMs: neon.latencyMs } : {}),
    ...(options.v3Side.runId ? { legacyRunId: options.v3Side.runId } : {}),
    ...(neon.runId ? { neonRunId: neon.runId } : {}),
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  return {
    state: "compared",
    gate: options.gate,
    verdict,
    evidenceId: record.evidenceId,
    ...(latencyDeltaMs !== undefined ? { latencyDeltaMs } : {}),
    safety: { evidenceWritten: true, drivesV3Live: false },
    diagnostics: [
      `mirror run: Neon side driven live, v3 supplied as input, verdict=${verdict}.`,
      "Evidence written through the redacted mirror-evidence layer; v3 not auto-driven."
    ]
  };
}

export function renderNeonMirrorComparisonReport(result: INeonMirrorComparisonResult): string {
  return [
    `Neonika Mirror Run: ${result.state} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Verdict: ${result.verdict ?? "n/a"}`,
    `Evidence: ${result.evidenceId ?? "none"}`,
    `Latency delta: ${result.latencyDeltaMs ?? "n/a"}`,
    `Safety: evidenceWritten=${result.safety.evidenceWritten} drivesV3Live=${result.safety.drivesV3Live}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function resolveLatencyDelta(neonLatencyMs?: number, v3LatencyMs?: number): number | undefined {
  if (neonLatencyMs === undefined || v3LatencyMs === undefined) {
    return undefined;
  }
  return neonLatencyMs - v3LatencyMs;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
