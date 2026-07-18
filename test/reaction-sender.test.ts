import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { INeonDeliveryQueueTarget } from "../src/gateway/deliveryQueue.js";
import {
  createNeonCanaryReactionSender,
  createNeonDryRunReactionSender,
  mapNeonAckStateToReactionEmoji,
  neonAckStateReactionEmojis,
  reactNeonAckState,
  type INeonReactionTransport
} from "../src/gateway/reactionSender.js";

const target: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "chan-1"
};

const fixedNow = (): Date => new Date("2026-06-03T01:00:00.000Z");

const openGate = {
  cutoverStage: "canary" as const,
  canaryApproved: true,
  outboundEnabled: true
};

const closedGate = {
  cutoverStage: "shadow" as const,
  canaryApproved: false,
  outboundEnabled: false
};

interface IRecordedReaction {
  readonly channelId: string;
  readonly messageId: string;
  readonly emoji: string;
}

function createRecordingTransport(): {
  readonly transport: INeonReactionTransport;
  readonly calls: IRecordedReaction[];
} {
  const calls: IRecordedReaction[] = [];

  return {
    transport: {
      addReaction(reactionTarget, messageId, emoji): Promise<void> {
        calls.push({ channelId: reactionTarget.channelId, messageId, emoji });
        return Promise.resolve();
      }
    },
    calls
  };
}

describe("Neon reaction sender", () => {
  it("dry-run sender never reacts and reports reactionSent:false", async () => {
    const sender = createNeonDryRunReactionSender({ now: fixedNow });

    const result = await sender.setReaction(target, "msg-1", "✅");

    assert.equal(result.reactionSent, false);
    if (!result.reactionSent) {
      assert.equal(result.reason, "dry-run-no-send");
      assert.equal(result.cutoverStage, "shadow");
      assert.equal(result.emoji, "✅");
      assert.equal(result.messageId, "msg-1");
    }
  });

  it("canary sender stays suppressed without an open gate", async () => {
    const sender = createNeonCanaryReactionSender({ now: fixedNow, gateFacts: closedGate });

    const result = await sender.setReaction(target, "msg-1", "✅");

    assert.equal(result.reactionSent, false);
    if (!result.reactionSent) {
      assert.equal(result.reason, "canary-gate-closed");
      assert.equal(result.cutoverStage, "shadow");
    }
  });

  it("canary sender stays suppressed when the gate is open but no transport is injected", async () => {
    const sender = createNeonCanaryReactionSender({ now: fixedNow, gateFacts: openGate });

    const result = await sender.setReaction(target, "msg-1", "✅");

    assert.equal(result.reactionSent, false);
    if (!result.reactionSent) {
      assert.equal(result.reason, "canary-gate-closed");
    }
  });

  it("canary sender reacts only with an open gate AND an injected transport", async () => {
    const { transport, calls } = createRecordingTransport();
    const sender = createNeonCanaryReactionSender({ now: fixedNow, gateFacts: openGate, transport });

    const result = await sender.setReaction(target, "msg-1", "✅");

    assert.equal(result.reactionSent, true);
    if (result.reactionSent) {
      assert.equal(result.cutoverStage, "canary");
      assert.equal(result.emoji, "✅");
      assert.equal(result.sentAt, "2026-06-03T01:00:00.000Z");
    }
    assert.deepEqual(calls, [{ channelId: "chan-1", messageId: "msg-1", emoji: "✅" }]);
  });

  it("canary sender rejects a channel outside the allowlist and never calls the transport", async () => {
    const { transport, calls } = createRecordingTransport();
    const sender = createNeonCanaryReactionSender({
      now: fixedNow,
      gateFacts: openGate,
      transport,
      channelAllowlist: { channels: new Set(["other-chan"]), configured: true }
    });

    const result = await sender.setReaction(target, "msg-1", "✅");

    assert.equal(result.reactionSent, false);
    if (!result.reactionSent) {
      assert.equal(result.reason, "canary-channel-not-allowlisted");
    }
    assert.deepEqual(calls, []);
  });

  it("maps ack lifecycle states to their default emojis", () => {
    assert.equal(mapNeonAckStateToReactionEmoji("queued"), neonAckStateReactionEmojis.queued);
    assert.equal(mapNeonAckStateToReactionEmoji("working"), "⏳");
    assert.equal(mapNeonAckStateToReactionEmoji("done"), "✅");
  });

  it("reactNeonAckState routes the mapped emoji through the sender", async () => {
    const { transport, calls } = createRecordingTransport();
    const sender = createNeonCanaryReactionSender({ now: fixedNow, gateFacts: openGate, transport });

    const result = await reactNeonAckState(sender, target, "msg-9", "done");

    assert.equal(result.reactionSent, true);
    assert.deepEqual(calls, [{ channelId: "chan-1", messageId: "msg-9", emoji: "✅" }]);
  });

  it("normalizes an overlong emoji identifier (no unbounded payload)", async () => {
    const sender = createNeonDryRunReactionSender({ now: fixedNow });
    const overlong = "a".repeat(200);

    const result = await sender.setReaction(target, "msg-1", `  ${overlong}  `);

    assert.equal(result.emoji.length, 64);
  });

  it("keeps a suppressed result leak-safe", async () => {
    const sender = createNeonCanaryReactionSender({ now: fixedNow, gateFacts: closedGate });

    const result = await sender.setReaction(target, "msg-1", "✅");

    assert.doesNotMatch(JSON.stringify(result), /secret/i);
  });
});
