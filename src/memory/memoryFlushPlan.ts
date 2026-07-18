// Memory-Flush-Plan for Neonika: a pure, read-only planner that DESCRIBES a
// pre-compaction memory flush without performing it.
//
// Template: upstream `extensions/memory-core/src/flush-plan.ts`
// (`buildMemoryFlushPlan`). Rebuild-native + simplified for the shadow runtime:
//   - No timezone/cron config (KISS) — the date stamp is a plain UTC YYYY-MM-DD.
//   - No live compaction trigger — neonika runs are terminal-only (shadow
//     contract: no live in-flight turn), so there is no auto-flush turn. This
//     module only produces the plan; a CLI dry-run is the entry point.
//
// The actual flush WRITE into `memory/YYYY-MM-DD.md` is a gated side-effect
// (`NEON_MEMORY_FLUSH_ENABLED`, default-off) and a product decision. It is NOT
// performed here — this is the planner/policy layer only, mirroring the existing
// gated memory-write dry-run seam.

import { readReadyCutoverEnv } from "../core/cutover.js";

export const NEON_MEMORY_FLUSH_DEFAULT_SOFT_THRESHOLD_TOKENS = 4000;
export const NEON_MEMORY_FLUSH_DEFAULT_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const NEON_MEMORY_FLUSH_ENV_VAR = "NEON_MEMORY_FLUSH_ENABLED" as const;

const TARGET_HINT =
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).";
const APPEND_ONLY_HINT =
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only; never overwrite existing entries.";
const READ_ONLY_HINT =
  "Treat workspace bootstrap/reference files (MEMORY.md, SOUL.md, AGENTS.md, CLAUDE.md) as read-only; never overwrite, replace, or edit them.";

const FLUSH_SAFETY_HINTS = [TARGET_HINT, APPEND_ONLY_HINT, READ_ONLY_HINT] as const;

export interface INeonMemoryFlushPlan {
  /** Canonical, append-only target path relative to the workspace root. */
  readonly relativePath: string;
  readonly dateStamp: string;
  readonly softThresholdTokens: number;
  readonly forceFlushTranscriptBytes: number;
  /** Agent-facing flush prompt with the safety hints baked in. */
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface INeonMemoryFlushGate {
  readonly enabled: boolean;
  readonly envVar: typeof NEON_MEMORY_FLUSH_ENV_VAR;
}

export interface INeonMemoryFlushPlanResult {
  readonly plan: INeonMemoryFlushPlan;
  readonly gate: INeonMemoryFlushGate;
  /**
   * Whether a real flush EXECUTOR would write given the current gate. This
   * planner never writes regardless — the flag documents the gated intent.
   */
  readonly wouldWrite: boolean;
}

export interface IBuildNeonMemoryFlushPlanOptions {
  readonly nowMs?: number;
  readonly softThresholdTokens?: number;
  readonly forceFlushTranscriptBytes?: number;
}

/** UTC date stamp `YYYY-MM-DD` for the canonical flush file name. */
export function formatNeonMemoryFlushDateStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function clampNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const int = Math.floor(value);
  return int >= 0 ? int : fallback;
}

export function buildNeonMemoryFlushPlan(
  options: IBuildNeonMemoryFlushPlanOptions = {}
): INeonMemoryFlushPlan {
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const dateStamp = formatNeonMemoryFlushDateStamp(nowMs);
  const relativePath = `memory/${dateStamp}.md`;
  const softThresholdTokens = clampNonNegativeInt(
    options.softThresholdTokens,
    NEON_MEMORY_FLUSH_DEFAULT_SOFT_THRESHOLD_TOKENS
  );
  const forceFlushTranscriptBytes = clampNonNegativeInt(
    options.forceFlushTranscriptBytes,
    NEON_MEMORY_FLUSH_DEFAULT_FORCE_TRANSCRIPT_BYTES
  );

  const prompt = [
    "Pre-compaction memory flush.",
    ...FLUSH_SAFETY_HINTS,
    "Always use the canonical YYYY-MM-DD.md filename; do not create timestamped variants."
  ]
    .join(" ")
    .replaceAll("YYYY-MM-DD", dateStamp);
  const systemPrompt = [
    "Pre-compaction memory flush turn. The session is near compaction; capture durable memories to disk.",
    ...FLUSH_SAFETY_HINTS
  ]
    .join(" ")
    .replaceAll("YYYY-MM-DD", dateStamp);

  return {
    relativePath,
    dateStamp,
    softThresholdTokens,
    forceFlushTranscriptBytes,
    prompt,
    systemPrompt
  };
}

export function resolveNeonMemoryFlushGate(
  env: NodeJS.ProcessEnv = process.env
): INeonMemoryFlushGate {
  // Single source for gate-env parsing (ready|true|1|yes). This parser used to
  // accept "on" but NOT "ready" - arming a flush with the standard "ready"
  // value silently stayed disabled. One semantics for every memory gate.
  const enabled = readReadyCutoverEnv(env, NEON_MEMORY_FLUSH_ENV_VAR);
  return { enabled, envVar: NEON_MEMORY_FLUSH_ENV_VAR };
}

export function planNeonMemoryFlush(
  options: IBuildNeonMemoryFlushPlanOptions & { readonly env?: NodeJS.ProcessEnv } = {}
): INeonMemoryFlushPlanResult {
  const { env, ...planOptions } = options;
  const plan = buildNeonMemoryFlushPlan(planOptions);
  const gate = resolveNeonMemoryFlushGate(env ?? process.env);
  return { plan, gate, wouldWrite: gate.enabled };
}
