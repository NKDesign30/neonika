import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordInboundReplayGuard,
  dispatchNeonAutoReply,
  type INeonAutoReplyPolicy,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope
} from "../src/index.js";

const POLICY: INeonDiscordIngressPolicy = {
  agentId: "agent-1",
  workspaceRoot: "/tmp/ws",
  mode: "read-only",
  botUserId: "bot-1",
  mentionPolicy: "always"
};

const REPLY_WHEN_MENTIONED: INeonAutoReplyPolicy = { replyWhenMentioned: true };

const now = () => new Date("2026-06-03T12:00:00.000Z");

function envelope(overrides: Partial<INeonDiscordMessageEnvelope> = {}): INeonDiscordMessageEnvelope {
  return {
    accountId: "acct-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "msg-1",
    author: { id: "user-1", username: "alice" },
    content: "hey <@bot-1> help",
    createdAt: "2026-06-03T11:59:59.000Z",
    mentionedUserIds: ["bot-1"],
    ...overrides
  };
}

describe("dispatchNeonAutoReply (Z204)", () => {
  it("dispatches a dry-run reply for an accepted, mentioned inbound", async () => {
    const result = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: "Here is the answer.", ackReaction: "👀" },
      now
    });
    assert.equal(result.state, "dispatched-dry-run");
    assert.equal(result.safety.outboundSent, false);
    assert.equal(result.wasMentioned, true);
    assert.equal(result.target?.channelId, "channel-1");
    assert.equal(result.target?.replyToMessageId, "msg-1");
    // typing-start, one send-chunk, ack-reaction, typing-stop
    assert.equal(result.steps[0]?.kind, "typing-start");
    assert.equal(result.steps.at(-1)?.kind, "typing-stop");
    assert.equal(result.payloadSummary.chunks, 1);
    assert.equal(result.payloadSummary.hasReaction, true);
    // Every delivery result is suppressed.
    assert.ok(result.deliveryResults.every((entry) => entry.outboundSent === false));
  });

  it("validates brick payloads and includes them in the summary", async () => {
    const result = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: {
        text: "with extras",
        embeds: [{ title: "Status", description: "green" }],
        components: [{ buttons: [{ label: "Ok", style: "success", customId: "ok" }] }]
      },
      now
    });
    assert.equal(result.state, "dispatched-dry-run");
    assert.equal(result.payloadSummary.embeds, 1);
    assert.equal(result.payloadSummary.components, 1);
  });

  it("drops a bot-authored inbound at the ingress decision", async () => {
    const result = await dispatchNeonAutoReply({
      envelope: envelope({ author: { id: "bot-2", username: "b", bot: true } }),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: "x" },
      now
    });
    assert.equal(result.state, "dropped");
    assert.match(result.reason, /ingress-dropped/);
    assert.equal(result.safety.outboundSent, false);
    assert.equal(result.steps.length, 0);
  });

  it("skips when not mentioned under a mention-only auto-reply policy (ingress admits)", async () => {
    // ingress mentionPolicy "never" admits the message (access layer); the
    // auto-reply policy is the separate layer that skips an unmentioned reply.
    const admitAll: INeonDiscordIngressPolicy = { ...POLICY, mentionPolicy: "never" };
    const result = await dispatchNeonAutoReply({
      envelope: envelope({ content: "no ping here", mentionedUserIds: [] }),
      ingressPolicy: admitAll,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: "unsolicited" },
      now
    });
    assert.equal(result.state, "skipped");
    assert.equal(result.reason, "not-mentioned");
  });

  it("skips an empty reply and an invalid brick payload", async () => {
    const empty = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: "   " },
      now
    });
    assert.equal(empty.state, "skipped");
    assert.equal(empty.reason, "empty-reply");

    const invalid = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      // Empty embed object is rejected by the embed builder.
      payload: { text: "has text", embeds: [{}] },
      now
    });
    assert.equal(invalid.state, "skipped");
    assert.match(invalid.reason, /invalid-payload/);
  });

  it("skips a duplicate inbound via the replay guard", async () => {
    const replayGuard = createNeonDiscordInboundReplayGuard();
    const first = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: "first" },
      replayGuard,
      now
    });
    const second = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: "second" },
      replayGuard,
      now
    });
    assert.equal(first.state, "dispatched-dry-run");
    assert.equal(second.state, "skipped");
    assert.equal(second.reason, "duplicate-inbound");
  });

  it("splits a long reply into multiple dry-run send chunks", async () => {
    const longText = "word ".repeat(900).trim(); // > 2000 chars
    const result = await dispatchNeonAutoReply({
      envelope: envelope(),
      ingressPolicy: POLICY,
      autoReplyPolicy: REPLY_WHEN_MENTIONED,
      payload: { text: longText },
      now
    });
    assert.equal(result.state, "dispatched-dry-run");
    assert.ok(result.payloadSummary.chunks >= 2, "expected the long reply to chunk");
    assert.ok(result.deliveryResults.every((entry) => entry.outboundSent === false));
  });
});
