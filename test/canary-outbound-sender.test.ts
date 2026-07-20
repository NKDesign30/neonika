import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonCanaryOutboundSender,
  evaluateNeonCanaryLivePreconditions,
  isNeonCanaryChannelEligible,
  resolveNeonCanaryChannelAllowlist,
  type INeonCanaryOutboundGateFacts,
  type INeonDeliveryQueueTarget,
  type INeonOutboundTransport,
  type TNeonDiscordMediaAttachment
} from "../src/index.js";

const target: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "local",
  channelId: "channel-canary"
};

const openFacts: INeonCanaryOutboundGateFacts = {
  cutoverStage: "canary",
  canaryApproved: true,
  outboundEnabled: true
};

/**
 * Records every postMessage call so the test can prove the transport was only
 * invoked when the gate was fully open. It performs no real network IO: it just
 * returns a deterministic mock messageId.
 */
function createMockTransport(): {
  readonly transport: INeonOutboundTransport;
  readonly calls: Array<{ readonly target: INeonDeliveryQueueTarget; readonly body: string }>;
  readonly mediaCalls: Array<{
    readonly target: INeonDeliveryQueueTarget;
    readonly body: string | undefined;
    readonly attachments: readonly TNeonDiscordMediaAttachment[];
  }>;
} {
  const calls: Array<{ readonly target: INeonDeliveryQueueTarget; readonly body: string }> = [];
  const mediaCalls: Array<{
    readonly target: INeonDeliveryQueueTarget;
    readonly body: string | undefined;
    readonly attachments: readonly TNeonDiscordMediaAttachment[];
  }> = [];

  return {
    calls,
    mediaCalls,
    transport: {
      postMessage(postTarget, body) {
        calls.push({ target: postTarget, body });
        return Promise.resolve({ messageId: "mock-message-id-123" });
      },
      postMedia(postTarget, body, attachments) {
        mediaCalls.push({ target: postTarget, body, attachments });
        return Promise.resolve({ messageId: "mock-media-message-id-123" });
      }
    }
  };
}

describe("Neonika Canary Outbound Sender", () => {
  it("(a) stays no-send by default with no transport and no flags", async () => {
    const sender = createNeonCanaryOutboundSender({ env: {} });

    const result = await sender.sendText(target, "default gate-closed probe");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
    // The reported stage is the default an unconfigured install resolves to. It is
    // outbound-capable, and the gate stays shut anyway: approval, arming and a
    // transport are each still required.
    assert.equal(result.cutoverStage, "primary");
    assert.equal(result.bodyPreview, "default gate-closed probe");
  });

  it("(b1) stays no-send when stage is not canary even with approval, flag, and transport", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: { cutoverStage: "shadow", canaryApproved: true, outboundEnabled: true }
    });

    const result = await sender.sendText(target, "wrong stage");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
    assert.equal(result.cutoverStage, "shadow");
    assert.equal(mock.calls.length, 0);
  });

  it("(b2) stays no-send when canary is not approved", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: { cutoverStage: "canary", canaryApproved: false, outboundEnabled: true }
    });

    const result = await sender.sendText(target, "not approved");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
    assert.equal(result.cutoverStage, "canary");
    assert.equal(mock.calls.length, 0);
  });

  it("(b3) stays no-send when the outbound-enabled flag is off", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: { cutoverStage: "canary", canaryApproved: true, outboundEnabled: false }
    });

    const result = await sender.sendText(target, "flag off");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
    assert.equal(mock.calls.length, 0);
  });

  it("(b4) stays no-send when no transport is injected even with all flags ready", async () => {
    const sender = createNeonCanaryOutboundSender({ gateFacts: openFacts });

    const result = await sender.sendText(target, "no transport");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
    assert.equal(result.cutoverStage, "canary");
  });

  it("(b-env) stays no-send when env opens the gate but no transport is injected", async () => {
    const sender = createNeonCanaryOutboundSender({
      env: {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
      }
    });

    const result = await sender.sendText(target, "env opened but no transport");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
  });

  it("(c) sends through the mock transport only when all four conditions are met", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts,
      now: () => new Date("2026-05-31T20:00:05.000Z")
    });

    const result = await sender.sendText(target, "all gates open, send it");

    assert.equal(result.outboundSent, true);
    if (result.outboundSent !== true) {
      throw new Error("expected a sent result");
    }
    assert.equal(result.messageId, "mock-message-id-123");
    assert.equal(result.cutoverStage, "canary");
    assert.equal(result.sentAt, "2026-05-31T20:00:05.000Z");
    assert.equal(result.bodyPreview, "all gates open, send it");
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.target.channelId, "channel-canary");
    assert.equal(mock.calls[0]?.body, "all gates open, send it");
  });

  it("(c-env) sends when env flags open the gate and a transport is injected", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      env: {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "true",
        NEON_CUTOVER_OUTBOUND_ENABLED: "1"
      }
    });

    const result = await sender.sendText(target, "env-driven send");

    assert.equal(result.outboundSent, true);
    assert.equal(mock.calls.length, 1);
  });

  it("(c-format) preserves Discord text in the live transport body", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts
    });

    const body =
      "1. Sitzt.\n2. Nummern bleiben stabil.\n\nKurzfassung: Kein künstlicher Textblock mehr.";

    const result = await sender.sendText(target, body);

    assert.equal(result.outboundSent, true);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.body, body);
    assert.doesNotMatch(result.bodyPreview, /\n/u);
    assert.match(result.bodyPreview, /1\. Sitzt\. 2\. Nummern bleiben stabil\./u);
  });

  it("(d) redacts secrets out of the body preview and the transport body when sending", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts
    });

    const result = await sender.sendText(
      target,
      "Token sk-canary-secret-value-1234567890 darf nie geloggt werden"
    );

    assert.equal(result.outboundSent, true);
    assert.doesNotMatch(result.bodyPreview, /sk-canary-secret-value-1234567890/);
    assert.match(result.bodyPreview, /\[REDACTED_SECRET\]/);
    // The transport must only ever see the redacted body, never the raw secret.
    assert.equal(mock.calls.length, 1);
    assert.doesNotMatch(mock.calls[0]?.body ?? "", /sk-canary-secret-value-1234567890/);
    assert.match(mock.calls[0]?.body ?? "", /\[REDACTED_SECRET\]/);
  });

  it("(d-full-body) sends redacted full body while keeping preview bounded", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts,
      bodyPreviewMaxLength: 40
    });
    const longText = `Intro ${"long ".repeat(120)} outro`;

    const result = await sender.sendText(target, longText);

    assert.equal(result.outboundSent, true);
    assert.ok(result.bodyPreview.length <= 40);
    assert.match(result.bodyPreview, /…$/);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.body, longText.trim());
    assert.ok((mock.calls[0]?.body.length ?? 0) > result.bodyPreview.length);
  });

  it("(d-closed) redacts secrets out of the body preview while gate is closed", async () => {
    const sender = createNeonCanaryOutboundSender({ env: {} });

    const result = await sender.sendText(
      target,
      "Discord bot token sk-leak-attempt-abcdef1234567890 im no-send Pfad"
    );

    assert.equal(result.outboundSent, false);
    assert.doesNotMatch(result.bodyPreview, /sk-leak-attempt-abcdef1234567890/);
    assert.match(result.bodyPreview, /\[REDACTED_SECRET\]/);
  });

  it("(e) sends media through the mock transport only when the canary gate is open", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts
    });
    const attachments: readonly TNeonDiscordMediaAttachment[] = [
      { name: "screen.png", data: new Uint8Array([1, 2, 3]), contentType: "image/png" }
    ];

    const result = await sender.sendMedia?.(target, "Screenshot screen.png", attachments);

    assert.equal(result?.outboundSent, true);
    assert.equal(mock.mediaCalls.length, 1);
    assert.equal(mock.mediaCalls[0]?.body, "Screenshot screen.png");
    assert.equal(mock.mediaCalls[0]?.attachments[0]?.name, "screen.png");
  });

  it("(e-closed) suppresses media when the gate is closed", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: { cutoverStage: "shadow", canaryApproved: true, outboundEnabled: true }
    });

    const result = await sender.sendMedia?.(target, "Screenshot screen.png", [
      { name: "screen.png", data: new Uint8Array([1, 2, 3]), contentType: "image/png" }
    ]);

    assert.equal(result?.outboundSent, false);
    assert.equal(mock.mediaCalls.length, 0);
  });
});

describe("Neonika Canary Channel Allowlist", () => {
  it("parses the env allowlist and defaults to empty (nothing eligible)", () => {
    const empty = resolveNeonCanaryChannelAllowlist({});
    assert.equal(empty.configured, false);
    assert.equal(empty.channels.size, 0);

    const configured = resolveNeonCanaryChannelAllowlist({
      NEON_CUTOVER_CANARY_CHANNELS: " channel-canary , channel-two ,, "
    });
    assert.equal(configured.configured, true);
    assert.equal(configured.channels.size, 2);
    assert.equal(isNeonCanaryChannelEligible("channel-canary", configured), true);
    assert.equal(isNeonCanaryChannelEligible("channel-other", configured), false);
  });

  it("keeps the canary gate closed for a channel that is not on the allowlist", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts,
      channelAllowlist: resolveNeonCanaryChannelAllowlist({
        NEON_CUTOVER_CANARY_CHANNELS: "some-other-channel"
      })
    });

    const result = await sender.sendText(target, "not on allowlist");

    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-channel-not-allowlisted");
    assert.equal(mock.calls.length, 0);
  });

  it("opens the gate only for an explicitly allowlisted channel with all flags ready", async () => {
    const mock = createMockTransport();
    const sender = createNeonCanaryOutboundSender({
      transport: mock.transport,
      gateFacts: openFacts,
      channelAllowlist: resolveNeonCanaryChannelAllowlist({
        NEON_CUTOVER_CANARY_CHANNELS: "channel-canary"
      })
    });

    const result = await sender.sendText(target, "on allowlist");

    assert.equal(result.outboundSent, true);
    assert.equal(mock.calls.length, 1);
  });
});

describe("Neonika Canary live preconditions", () => {
  it("is not ready and leaks no token value on an empty env", () => {
    const pre = evaluateNeonCanaryLivePreconditions({});

    assert.equal(pre.ready, false);
    assert.equal(pre.tokenPresent, false);
    assert.equal(pre.channelConfigured, false);
    assert.equal(pre.singleChannel, false);
    assert.equal(pre.channelId, undefined);
    // Only booleans + channel id are exposed — no token field at all.
    assert.deepEqual(Object.keys(pre).includes("token"), false);
  });

  it("is ready when token, at least one channel, and all three flags line up", () => {
    const pre = evaluateNeonCanaryLivePreconditions({
      NEON_DISCORD_BOT_TOKEN: "bot-token-secret-value",
      NEON_CUTOVER_CANARY_CHANNELS: "channel-canary",
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "ready",
      NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
    });

    assert.equal(pre.ready, true);
    assert.equal(pre.tokenPresent, true);
    assert.equal(pre.singleChannel, true);
    assert.equal(pre.channelId, "channel-canary");
    // The token value never appears in the precondition projection.
    assert.doesNotMatch(JSON.stringify(pre), /bot-token-secret-value/);
  });

  it("allows multiple explicit channels while withholding a single smoke channel id", () => {
    const pre = evaluateNeonCanaryLivePreconditions({
      NEON_DISCORD_BOT_TOKEN: "bot-token-secret-value",
      NEON_CUTOVER_CANARY_CHANNELS: "channel-a,channel-b",
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "ready",
      NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
    });

    assert.equal(pre.singleChannel, false);
    assert.equal(pre.channelId, undefined);
    assert.equal(pre.ready, true);
  });

  it("stays not-ready when only some flags are set", () => {
    const pre = evaluateNeonCanaryLivePreconditions({
      NEON_DISCORD_BOT_TOKEN: "bot-token-secret-value",
      NEON_CUTOVER_CANARY_CHANNELS: "channel-canary",
      NEON_CUTOVER_STAGE: "canary"
    });

    assert.equal(pre.canaryApproved, false);
    assert.equal(pre.outboundEnabled, false);
    assert.equal(pre.ready, false);
  });
});
