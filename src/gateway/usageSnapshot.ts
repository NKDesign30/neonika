import {
  addTokenTotals,
  createEmptyTokenTotals,
  extractRunTokenTotals,
  type INeonSessionTokenTotals,
} from "./sessionSnapshot.js";
import type { INeonGatewayShadowRun } from "./types.js";
import type { TNeonChannel } from "../harness/types.js";

// Read-only token-usage projection over the persisted run store. Aggregates the
// per-run token-usage harness events (reusing the sessionSnapshot token helpers)
// into an overall total plus per-agent / per-channel breakdowns for the operator
// Usage dashboard.
//
// Cost is intentionally absent: the Codex harness `token-usage` event
// (harness/types.ts) carries only input/output/total token counts — no
// estimatedCostUsd or cache fields — so any monetary figure would be fabricated.
// See parity gap row 169 (deferred: needs-upstream-protocol).

export type TNeonUsageSnapshotState = "ready" | "empty";

export interface INeonUsageAgentTotals {
  readonly agentId: string;
  readonly runCount: number;
  readonly tokens: INeonSessionTokenTotals;
}

export interface INeonUsageChannelTotals {
  readonly channel: TNeonChannel;
  readonly runCount: number;
  readonly tokens: INeonSessionTokenTotals;
}

export interface INeonUsageSnapshot {
  readonly state: TNeonUsageSnapshotState;
  readonly runCount: number;
  readonly tokens: INeonSessionTokenTotals;
  readonly byAgent: readonly INeonUsageAgentTotals[];
  readonly byChannel: readonly INeonUsageChannelTotals[];
}

interface IUsageGroupAccumulator {
  runCount: number;
  tokens: INeonSessionTokenTotals;
}

function accumulate<K>(map: Map<K, IUsageGroupAccumulator>, key: K, runTokens: INeonSessionTokenTotals): void {
  const existing = map.get(key) ?? { runCount: 0, tokens: createEmptyTokenTotals() };
  map.set(key, {
    runCount: existing.runCount + 1,
    tokens: addTokenTotals(existing.tokens, runTokens),
  });
}

export function createNeonUsageSnapshot(runs: readonly INeonGatewayShadowRun[]): INeonUsageSnapshot {
  const byAgent = new Map<string, IUsageGroupAccumulator>();
  const byChannel = new Map<TNeonChannel, IUsageGroupAccumulator>();
  let tokens = createEmptyTokenTotals();

  for (const run of runs) {
    const runTokens = extractRunTokenTotals(run);
    tokens = addTokenTotals(tokens, runTokens);
    accumulate(byAgent, run.request.agentId, runTokens);
    accumulate(byChannel, run.request.channel, runTokens);
  }

  return {
    state: runs.length === 0 ? "empty" : "ready",
    runCount: runs.length,
    tokens,
    byAgent: [...byAgent.entries()]
      .map(([agentId, value]) => ({ agentId, runCount: value.runCount, tokens: value.tokens }))
      .sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens || a.agentId.localeCompare(b.agentId)),
    byChannel: [...byChannel.entries()]
      .map(([channel, value]) => ({ channel, runCount: value.runCount, tokens: value.tokens }))
      .sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens || a.channel.localeCompare(b.channel)),
  };
}

// Text report for CLI/log surfaces. Leak-safe: only agentId/channel labels and
// integer counts, never run content.
export function renderNeonUsageReport(snapshot: INeonUsageSnapshot): string {
  if (snapshot.state === "empty") {
    return "Neon usage: no runs recorded yet.";
  }
  const lines = [
    `Neon usage: ${snapshot.runCount} run(s), ${snapshot.tokens.totalTokens} tokens ` +
      `(${snapshot.tokens.inputTokens} in / ${snapshot.tokens.outputTokens} out)`,
    `  agents: ${snapshot.byAgent.length} · channels: ${snapshot.byChannel.length} · cost: n/a (not surfaced by harness)`,
  ];
  for (const agent of snapshot.byAgent) {
    lines.push(`  · ${agent.agentId}: ${agent.tokens.totalTokens} tokens over ${agent.runCount} run(s)`);
  }
  return lines.join("\n");
}
