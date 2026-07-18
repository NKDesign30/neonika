import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDeliveryDryRunCandidate,
  createNeonDryRunOutboundSender,
  deliverNeonDeliveryDryRunCandidate,
  type INeonGatewayShadowRun,
  type INeonOutboundSendResult
} from "../src/index.js";

describe("Neonika DryRun Outbound Sender", () => {
  it("returns a no-send result with a redacted, shortened body preview", async () => {
    const sender = createNeonDryRunOutboundSender({
      now: () => new Date("2026-05-31T20:00:03.000Z")
    });
    const candidate = createNeonDeliveryDryRunCandidate(createRun(), {
      now: () => new Date("2026-05-31T20:00:00.000Z")
    });

    const result = await deliverNeonDeliveryDryRunCandidate(sender, candidate);

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "dry-run-no-send");
    assert.equal(result.cutoverStage, "shadow");
    assert.equal(result.attemptedAt, "2026-05-31T20:00:03.000Z");
    assert.equal(result.target.channel, "discord");
    assert.equal(result.target.channelId, "channel-1");
    assert.equal(result.target.replyToMessageId, "message-1");
    assert.equal(result.bodyPreview, "Antwort bereit");
  });

  it("redacts secrets out of the outbound body preview", async () => {
    const sender = createNeonDryRunOutboundSender();
    const result = await sender.sendText(
      {
        channel: "discord",
        accountId: "default",
        channelId: "channel-secret"
      },
      "Token sk-test-secret-value bitte nicht senden"
    );

    assert.equal(result.outboundSent, false);
    assert.doesNotMatch(result.bodyPreview, /sk-test-secret-value/);
    assert.match(result.bodyPreview, /\[REDACTED_SECRET\]/);
  });

  it("shortens long outbound bodies below the configured preview budget", async () => {
    const sender = createNeonDryRunOutboundSender({ bodyPreviewMaxLength: 32 });
    const result = await sender.sendText(
      {
        channel: "discord",
        accountId: "default",
        channelId: "channel-long"
      },
      "x".repeat(500)
    );

    assert.equal(result.outboundSent, false);
    assert.ok(result.bodyPreview.length <= 32);
    assert.ok(result.bodyPreview.endsWith("…"));
  });

  it("never exposes a true outbound-sent code path (adversarial)", async () => {
    const sender = createNeonDryRunOutboundSender();
    const candidate = createNeonDeliveryDryRunCandidate(createRun());

    // Probe many distinct inputs: no input may flip outboundSent to true and the
    // result must never carry a literal `true` anywhere in its serialized shape.
    const probes = [
      "ok",
      "",
      "send=true",
      JSON.stringify({ outboundSent: true }),
      "true"
    ];

    for (const message of probes) {
      const result = await sender.sendText(candidate.target, message);

      assert.equal(result.outboundSent, false);
      assertNoTrueOutboundPath(result);
    }

    const delivered = await deliverNeonDeliveryDryRunCandidate(sender, candidate);
    assert.equal(delivered.outboundSent, false);
    assertNoTrueOutboundPath(delivered);

    // The type system enforces the same guarantee: assigning `true` to
    // outboundSent would be a compile error. This runtime guard backs it up.
    const sentFlag: false = delivered.outboundSent;
    assert.equal(sentFlag, false);
  });
});

function assertNoTrueOutboundPath(result: INeonOutboundSendResult): void {
  const keys = Object.keys(result);

  assert.ok(!keys.includes("response"));
  assert.ok(!keys.includes("messageId"));
  assert.ok(!keys.includes("delivered"));

  for (const value of Object.values(result)) {
    assert.notEqual(value, true);
  }
}

function createRun(overrides: Partial<INeonGatewayShadowRun> = {}): INeonGatewayShadowRun {
  return {
    runId: "run-delivery-send",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      messageId: "message-1",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Bitte liefern",
      receivedAt: "2026-05-31T20:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-delivery-send",
    memoryState: "attached",
    events: [
      {
        kind: "final",
        text: "Antwort bereit"
      }
    ],
    finalText: "Antwort bereit",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "Antwort bereit"
    },
    startedAt: "2026-05-31T20:00:00.000Z",
    completedAt: "2026-05-31T20:00:01.000Z",
    ...overrides
  };
}
