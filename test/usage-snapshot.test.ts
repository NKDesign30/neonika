import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNeonUsageSnapshot, renderNeonUsageReport } from "../src/gateway/usageSnapshot.js";
import type { INeonGatewayShadowRun } from "../src/gateway/types.js";
import type { TCodexHarnessEvent, TNeonChannel } from "../src/harness/types.js";

interface IMakeRunOptions {
  readonly runId: string;
  readonly agentId: string;
  readonly channel: TNeonChannel;
  // Each tuple is [inputTokens, outputTokens, totalTokens] for one token-usage event.
  readonly tokenEvents?: ReadonlyArray<readonly [number, number, number]>;
}

function makeRun(options: IMakeRunOptions): INeonGatewayShadowRun {
  const events: TCodexHarnessEvent[] = (options.tokenEvents ?? []).map(([inputTokens, outputTokens, totalTokens]) => ({
    kind: "token-usage",
    inputTokens,
    outputTokens,
    totalTokens,
  }));
  events.push({ kind: "final", text: "final" });
  return {
    runId: options.runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: options.channel,
      accountId: "default",
      channelId: "channel-1",
      userId: "operator",
      agentId: options.agentId,
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "preview",
      receivedAt: "2026-06-03T00:00:00.000Z",
    },
    harnessId: "codex-app-server",
    harnessSessionKey: `neon:${options.agentId}:${options.runId}`,
    memoryState: "skipped",
    events,
    finalText: "final",
    delivery: {
      state: "suppressed",
      targetChannel: options.channel,
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "final",
    },
    startedAt: "2026-06-03T00:00:00.000Z",
    completedAt: "2026-06-03T00:00:01.000Z",
  };
}

describe("createNeonUsageSnapshot", () => {
  it("reports an empty snapshot when there are no runs", () => {
    const snapshot = createNeonUsageSnapshot([]);
    assert.equal(snapshot.state, "empty");
    assert.equal(snapshot.runCount, 0);
    assert.deepEqual(snapshot.tokens, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.deepEqual(snapshot.byAgent, []);
    assert.deepEqual(snapshot.byChannel, []);
  });

  it("sums token-usage events across runs into an overall total", () => {
    const snapshot = createNeonUsageSnapshot([
      makeRun({ runId: "r1", agentId: "chaty", channel: "discord", tokenEvents: [[10, 5, 15], [4, 1, 5]] }),
      makeRun({ runId: "r2", agentId: "neo", channel: "discord", tokenEvents: [[20, 10, 30]] }),
    ]);
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.runCount, 2);
    assert.deepEqual(snapshot.tokens, { inputTokens: 34, outputTokens: 16, totalTokens: 50 });
  });

  it("counts a run with no token-usage events as zero tokens, not a crash", () => {
    const snapshot = createNeonUsageSnapshot([makeRun({ runId: "r1", agentId: "chaty", channel: "discord" })]);
    assert.equal(snapshot.runCount, 1);
    assert.deepEqual(snapshot.tokens, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("groups token totals by agent, ranked by total tokens descending", () => {
    const snapshot = createNeonUsageSnapshot([
      makeRun({ runId: "r1", agentId: "chaty", channel: "discord", tokenEvents: [[10, 0, 10]] }),
      makeRun({ runId: "r2", agentId: "neo", channel: "discord", tokenEvents: [[100, 0, 100]] }),
      makeRun({ runId: "r3", agentId: "chaty", channel: "discord", tokenEvents: [[5, 0, 5]] }),
    ]);
    assert.deepEqual(
      snapshot.byAgent.map((a) => [a.agentId, a.runCount, a.tokens.totalTokens]),
      [
        ["neo", 1, 100],
        ["chaty", 2, 15],
      ],
    );
  });

  it("groups token totals by channel", () => {
    const snapshot = createNeonUsageSnapshot([
      makeRun({ runId: "r1", agentId: "chaty", channel: "discord", tokenEvents: [[10, 0, 10]] }),
      makeRun({ runId: "r2", agentId: "chaty", channel: "cli", tokenEvents: [[40, 0, 40]] }),
    ]);
    assert.deepEqual(
      snapshot.byChannel.map((c) => [c.channel, c.runCount, c.tokens.totalTokens]),
      [
        ["cli", 1, 40],
        ["discord", 1, 10],
      ],
    );
  });

  it("never invents a cost field", () => {
    const snapshot = createNeonUsageSnapshot([
      makeRun({ runId: "r1", agentId: "chaty", channel: "discord", tokenEvents: [[10, 5, 15]] }),
    ]);
    assert.ok(!Object.keys(snapshot).includes("cost"));
    assert.ok(!Object.keys(snapshot.tokens).includes("cost"));
    assert.match(renderNeonUsageReport(snapshot), /cost: n\/a/);
  });
});
