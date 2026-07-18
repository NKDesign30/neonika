// Neonika Transcript Indexer — production arming resolution. One pure place that
// answers "is the LLM pass armed, is persistence armed, and where does the
// isolated store live?" so the CLI stays thin and the answer is testable.
//
// Arming model (all default OFF, each an explicit operator decision):
// - LLM pass:   NEON_TRANSCRIPT_LLM_ENABLED  -> real `claude -p` runner injected
// - Persist:    NEON_MEMORY_WRITE_ENABLED + NEON_TRANSCRIPT_STORE_PATH
//               -> productive writes into the isolated JSON store
//               (writeNeonMemoryEntry can never touch the real semantic DB)

import { resolveNeonLlmGate, type INeonLlmGate } from "../llm/llmRuntime.js";
import {
  resolveNeonMemoryWriteGate,
  type INeonMemoryWriteGate
} from "../memory/memoryWriteRuntime.js";

export const neonTranscriptStorePathEnvKey = "NEON_TRANSCRIPT_STORE_PATH";

export interface INeonTranscriptArming {
  readonly llmGate: INeonLlmGate;
  readonly memoryGate: INeonMemoryWriteGate;
  readonly storePath: string | null;
  /** True -> the CLI injects the real claude -p process runner. */
  readonly llmArmed: boolean;
  /** True -> persist runs productive against the isolated store. */
  readonly persistArmed: boolean;
  readonly fullyArmed: boolean;
}

export function resolveNeonTranscriptArming(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonTranscriptArming {
  const llmGate = resolveNeonLlmGate(env);
  const memoryGate = resolveNeonMemoryWriteGate(env);
  const storePathRaw = env[neonTranscriptStorePathEnvKey]?.trim();
  const storePath = storePathRaw !== undefined && storePathRaw.length > 0 ? storePathRaw : null;

  const llmArmed = llmGate.enabled;
  const persistArmed = memoryGate.enabled && storePath !== null;

  return {
    llmGate,
    memoryGate,
    storePath,
    llmArmed,
    persistArmed,
    fullyArmed: llmArmed && persistArmed
  };
}

export function renderNeonTranscriptArmingReport(arming: INeonTranscriptArming): string {
  return [
    `Neonika Transcript production check: ${arming.fullyArmed ? "ARMED" : "not armed"}`,
    `LLM pass: ${arming.llmArmed ? "armed (real claude -p runner)" : "dry-run"} (env ${arming.llmGate.envKey})`,
    `Persist: ${arming.persistArmed ? "productive (isolated store)" : "dry-run"} (env NEON_MEMORY_WRITE_ENABLED + ${neonTranscriptStorePathEnvKey})`,
    `Store path: ${arming.storePath ?? "(not set)"}`,
    "Safety: isolated JSON store only — the real semantic DB is unreachable by construction"
  ].join("\n");
}
