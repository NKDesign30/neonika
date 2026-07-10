import type { ICodexHarness, TAgentRuntime } from "./types.js";

/**
 * Backend selection for Neon agent runs.
 *
 * A Neon agent profile declares a `runtime` (`TAgentRuntime`). This pure helper
 * maps that runtime onto the concrete harness the gateway should drive, so the
 * same ingress path can route a turn to either the Codex app-server harness or
 * the Claude CLI harness based on the agent's declared backend.
 *
 * Codex stays the safe default: `hybrid` and `human-gate` are not themselves
 * inference backends, so they fall back to Codex (production truth) rather than
 * silently switching to a different model. Only an explicit `claude` runtime
 * selects the Claude harness.
 */

export interface INeonHarnessRegistry {
  readonly codex: ICodexHarness;
  readonly claude: ICodexHarness;
}

export type TNeonHarnessSelectionReason =
  | "claude-runtime"
  | "codex-runtime"
  | "default-codex";

export interface INeonHarnessSelection {
  readonly harness: ICodexHarness;
  readonly runtime: TAgentRuntime;
  readonly reason: TNeonHarnessSelectionReason;
}

export function selectNeonHarness(
  runtime: TAgentRuntime,
  registry: INeonHarnessRegistry
): INeonHarnessSelection {
  if (runtime === "claude") {
    return { harness: registry.claude, runtime, reason: "claude-runtime" };
  }

  if (runtime === "codex") {
    return { harness: registry.codex, runtime, reason: "codex-runtime" };
  }

  // hybrid / human-gate are not inference backends — keep Codex (production
  // truth) rather than silently routing to a different model.
  return { harness: registry.codex, runtime, reason: "default-codex" };
}
