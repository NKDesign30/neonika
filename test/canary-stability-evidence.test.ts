import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonCanaryStabilityReport,
  summarizeNeonCanaryStability,
  type INeonGatewayShadowRun,
  type INeonOperatorAck
} from "../src/index.js";

function run(
  runId: string,
  overrides: Partial<INeonGatewayShadowRun> = {}
): INeonGatewayShadowRun {
  return {
    runId,
    mode: "live",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "canary-channel",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/neonika",
      mode: "read-only",
      contentPreview: "Canary evidence request",
      receivedAt: "2026-08-11T12:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: `neon:canary:${runId}`,
    memoryState: "attached",
    events: [{ kind: "final", text: "Canary evidence response" }],
    finalText: "Canary evidence response",
    delivery: {
      state: "delivered",
      targetChannel: "discord",
      targetChannelId: "canary-channel",
      reason: "canary-reply",
      finalText: "Canary evidence response",
      messageId: `message-${runId}`,
      cutoverStage: "canary"
    },
    startedAt: "2026-08-11T12:00:00.000Z",
    completedAt: "2026-08-11T12:01:00.000Z",
    ...overrides
  };
}

function ack(runId: string, ackedAt = "2026-08-11T12:02:00.000Z"): INeonOperatorAck {
  return { runId, ackedBy: "operator", ackedAt };
}

describe("Neon canary stability evidence", () => {
  it("returns an explicit empty-state and keeps primary blocked", () => {
    const snapshot = summarizeNeonCanaryStability([], []);

    assert.equal(snapshot.verdict, "no-evidence");
    assert.equal(snapshot.totals.delivered, 0);
    assert.equal(snapshot.totals.acknowledged, 0);
    assert.equal(snapshot.primaryReadiness.ready, false);
    assert.equal(snapshot.primaryReadiness.reason, "needs-five-acknowledged-canary-deliveries");
    assert.match(renderNeonCanaryStabilityReport(snapshot), /empty evidence/u);
  });

  it("counts only genuine canary deliveries and excludes unrelated completed runs", () => {
    const unrelatedShadow = run("shadow", {
      mode: "shadow",
      delivery: {
        state: "suppressed",
        targetChannel: "discord",
        targetChannelId: "canary-channel",
        reason: "shadow-mode",
        finalText: "suppressed"
      }
    });
    const primaryDelivery = run("primary", {
      delivery: { ...run("base").delivery, cutoverStage: "primary" }
    });
    const canaryDelivery = run("canary");

    const snapshot = summarizeNeonCanaryStability(
      [unrelatedShadow, primaryDelivery, canaryDelivery],
      [ack("shadow"), ack("primary"), ack("canary")]
    );

    assert.equal(snapshot.totals.inspected, 3);
    assert.equal(snapshot.totals.delivered, 1);
    assert.equal(snapshot.totals.acknowledged, 1);
    assert.deepEqual(snapshot.records.map((record) => record.runId), ["canary"]);
  });

  it("becomes stable after five delivered canary runs are acknowledged afterwards", () => {
    const runs = Array.from({ length: 5 }, (_, index) => run(`canary-${index + 1}`));
    const acks = runs.map((entry) => ack(entry.runId));

    const snapshot = summarizeNeonCanaryStability(runs, acks);

    assert.equal(snapshot.verdict, "stable");
    assert.equal(snapshot.totals.delivered, 5);
    assert.equal(snapshot.totals.acknowledged, 5);
    assert.equal(snapshot.totals.unresolvedFailures, 0);
    assert.equal(snapshot.primaryReadiness.ready, true);
    assert.equal(snapshot.primaryReadiness.reason, "ready");
    assert.ok(snapshot.records.every((record) => record.disposition === "acknowledged"));
  });

  it("does not count an acknowledgement recorded before delivery completed", () => {
    const snapshot = summarizeNeonCanaryStability(
      [run("pre-acked")],
      [ack("pre-acked", "2026-08-11T11:59:00.000Z")]
    );

    assert.equal(snapshot.verdict, "collecting");
    assert.equal(snapshot.totals.delivered, 1);
    assert.equal(snapshot.totals.acknowledged, 0);
    assert.equal(snapshot.records[0]?.disposition, "awaiting-acknowledgement");
  });

  it("reports unstable while any active gateway failure is unresolved", () => {
    const failed = run("failed", {
      mode: "shadow",
      status: "failed",
      delivery: {
        state: "suppressed",
        targetChannel: "discord",
        targetChannelId: "canary-channel",
        reason: "shadow-mode",
        finalText: ""
      }
    });
    const snapshot = summarizeNeonCanaryStability([run("delivered"), failed], [ack("delivered")]);

    assert.equal(snapshot.verdict, "unstable");
    assert.equal(snapshot.totals.unresolvedFailures, 1);
    assert.equal(snapshot.primaryReadiness.ready, false);
    assert.equal(snapshot.primaryReadiness.reason, "unresolved-failures");
    assert.equal(snapshot.records.find((record) => record.runId === "failed")?.disposition, "failed");
  });

  it("never projects message text, message ids, channel ids, or ack notes", () => {
    const secret = "private-canary-payload-SHOULD-NOT-LEAK";
    const delivery = run("leak-safe", {
      request: { ...run("base").request, contentPreview: secret },
      finalText: secret,
      delivery: {
        ...run("base").delivery,
        targetChannelId: "private-channel-id",
        finalText: secret,
        messageId: "private-message-id"
      }
    });
    const acknowledgement: INeonOperatorAck = {
      ...ack("leak-safe"),
      note: "private operator note"
    };

    const snapshot = summarizeNeonCanaryStability([delivery], [acknowledgement]);
    const serialized = JSON.stringify(snapshot);
    const report = renderNeonCanaryStabilityReport(snapshot);

    for (const privateValue of [secret, "private-channel-id", "private-message-id", "private operator note"]) {
      assert.doesNotMatch(serialized, new RegExp(privateValue, "u"));
      assert.doesNotMatch(report, new RegExp(privateValue, "u"));
    }
  });
});
