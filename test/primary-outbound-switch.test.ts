import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonCanaryMessageEditSender,
  createNeonCanaryOutboundSender,
  createNeonCanaryReactionSender,
  evaluateNeonCanaryLivePreconditions,
  evaluateNeonWebhookLivePreconditions,
  isNeonOutboundStage,
  type INeonCanaryOutboundGateFacts,
  type INeonDeliveryQueueTarget,
  type INeonMessageEditTransport,
  type INeonOutboundTransport,
  type INeonReactionTransport
} from "../src/index.js";

/**
 * Row 44 (Primary Switch) proof: once the runtime is promoted to
 * `NEON_CUTOVER_STAGE=primary`, the outbound send paths must keep sending. This
 * locks in that primary is a real outbound stage alongside canary, and that
 * non-outbound stages (shadow/mirror/retire) still stay suppressed.
 */
const target: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "local",
  channelId: "channel-primary"
};

const primaryFacts: INeonCanaryOutboundGateFacts = {
  cutoverStage: "primary",
  canaryApproved: true,
  outboundEnabled: true
};

const primaryEnv = {
  NEON_CUTOVER_STAGE: "primary",
  NEON_CUTOVER_CANARY_APPROVED: "ready",
  NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
  NEON_CUTOVER_CANARY_CHANNELS: "channel-primary",
  NEON_DISCORD_BOT_TOKEN: "present-not-checked-for-value"
} as const;

describe("Primary outbound switch (Row 44)", () => {
  it("isNeonOutboundStage allows canary and primary, blocks the rest", () => {
    assert.equal(isNeonOutboundStage("canary"), true);
    assert.equal(isNeonOutboundStage("primary"), true);
    assert.equal(isNeonOutboundStage("shadow"), false);
    assert.equal(isNeonOutboundStage("mirror"), false);
    assert.equal(isNeonOutboundStage("retire"), false);
  });

  it("text outbound sends under primary and carries cutoverStage=primary", async () => {
    const calls: string[] = [];
    const transport: INeonOutboundTransport = {
      postMessage(_t, body) {
        calls.push(body);
        return Promise.resolve({ messageId: "primary-msg-1" });
      }
    };
    const sender = createNeonCanaryOutboundSender({ transport, gateFacts: primaryFacts });

    const result = await sender.sendText(target, "primary is live");

    assert.equal(result.outboundSent, true);
    if (result.outboundSent !== true) {
      throw new Error("expected a sent result under primary");
    }
    assert.equal(result.cutoverStage, "primary");
    assert.equal(result.messageId, "primary-msg-1");
    assert.equal(calls.length, 1);
  });

  it("media outbound sends under primary", async () => {
    const mediaCalls: number[] = [];
    const transport: INeonOutboundTransport = {
      postMessage() {
        return Promise.resolve({ messageId: "unused" });
      },
      postMedia() {
        mediaCalls.push(1);
        return Promise.resolve({ messageId: "primary-media-1" });
      }
    };
    const sender = createNeonCanaryOutboundSender({ transport, gateFacts: primaryFacts });

    const result = await sender.sendMedia?.(target, "caption", [
      { name: "a.png", data: new Uint8Array([1, 2, 3]), contentType: "image/png" }
    ]);

    assert.ok(result);
    assert.equal(result?.outboundSent, true);
    if (result?.outboundSent === true) {
      assert.equal(result.cutoverStage, "primary");
    }
    assert.equal(mediaCalls.length, 1);
  });

  it("stays suppressed under a non-outbound stage (shadow)", async () => {
    let sent = 0;
    const transport: INeonOutboundTransport = {
      postMessage() {
        sent += 1;
        return Promise.resolve({ messageId: "should-not-send" });
      }
    };
    const sender = createNeonCanaryOutboundSender({
      transport,
      gateFacts: { cutoverStage: "shadow", canaryApproved: true, outboundEnabled: true }
    });

    const result = await sender.sendText(target, "must not send");

    assert.equal(result.outboundSent, false);
    if (result.outboundSent === false) {
      assert.equal(result.reason, "canary-gate-closed");
      assert.equal(result.cutoverStage, "shadow");
    }
    assert.equal(sent, 0);
  });

  it("reactions send under primary and carry cutoverStage=primary", async () => {
    const reactions: string[] = [];
    const transport: INeonReactionTransport = {
      addReaction(_t, _m, emoji) {
        reactions.push(emoji);
        return Promise.resolve();
      }
    };
    const sender = createNeonCanaryReactionSender({ transport, gateFacts: primaryFacts });

    const result = await sender.setReaction(target, "message-1", "✅");

    assert.equal(result.reactionSent, true);
    if (result.reactionSent === true) {
      assert.equal(result.cutoverStage, "primary");
    }
    assert.equal(reactions.length, 1);
  });

  it("message edits send under primary and carry cutoverStage=primary", async () => {
    const edits: string[] = [];
    const transport: INeonMessageEditTransport = {
      editMessage(_t, _m, body) {
        edits.push(body);
        return Promise.resolve();
      },
      deleteMessage() {
        return Promise.resolve();
      }
    };
    const sender = createNeonCanaryMessageEditSender({ transport, gateFacts: primaryFacts });

    const result = await sender.editMessage(target, "message-1", "edited under primary");

    assert.equal(result.editSent, true);
    if (result.editSent === true) {
      assert.equal(result.cutoverStage, "primary");
    }
    assert.equal(edits.length, 1);
  });

  it("live preconditions are ready under primary (stageAllowsOutbound, not stageIsCanary)", () => {
    const pre = evaluateNeonCanaryLivePreconditions(primaryEnv);

    assert.equal(pre.ready, true);
    assert.equal(pre.stageAllowsOutbound, true);
    assert.equal(pre.stageIsCanary, false, "primary is not canary");
    assert.equal(pre.singleChannel, true);
  });

  it("live preconditions stay not-ready under a non-outbound stage (mirror)", () => {
    const pre = evaluateNeonCanaryLivePreconditions({ ...primaryEnv, NEON_CUTOVER_STAGE: "mirror" });

    assert.equal(pre.ready, false);
    assert.equal(pre.stageAllowsOutbound, false);
  });

  it("webhook preconditions allow outbound under primary", () => {
    const pre = evaluateNeonWebhookLivePreconditions({
      NEON_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x/y",
      NEON_WEBHOOK_OUTBOUND_ENABLED: "ready",
      NEON_CUTOVER_STAGE: "primary",
      NEON_CUTOVER_CANARY_APPROVED: "ready"
    });

    assert.equal(pre.stageAllowsOutbound, true);
    assert.equal(pre.stageIsCanary, false);
    assert.equal(pre.ready, true);
  });
});
