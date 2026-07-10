import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyNeonHeartbeatResponse,
  isNeonHeartbeatOkResponse,
  isNeonHeartbeatUserMessage,
  renderNeonHeartbeatClassificationReport,
  NEON_HEARTBEAT_OK_TOKEN,
  NEON_HEARTBEAT_POLL_MARKER
} from "../src/automation/heartbeatPolicy.js";
import {
  dispatchNeonAutoReply,
  type INeonAutoReplyPolicy,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope
} from "../src/index.js";

describe("classifyNeonHeartbeatResponse", () => {
  it("suppresses an empty response", () => {
    const result = classifyNeonHeartbeatResponse("   ");
    assert.equal(result.verdict, "ok-suppress");
    assert.equal(result.reason, "empty");
    assert.ok(isNeonHeartbeatOkResponse(""));
  });

  it("suppresses a bare OK token (with surrounding whitespace)", () => {
    assert.equal(classifyNeonHeartbeatResponse(NEON_HEARTBEAT_OK_TOKEN).reason, "ok-token");
    assert.equal(classifyNeonHeartbeatResponse(`\n  ${NEON_HEARTBEAT_OK_TOKEN}  \n`).verdict, "ok-suppress");
    assert.ok(isNeonHeartbeatOkResponse("heartbeat_ok"), "token match is case-insensitive");
  });

  it("treats an OK token wrapped in a markdown skeleton as no-op", () => {
    const result = classifyNeonHeartbeatResponse(`## Status\n\n${NEON_HEARTBEAT_OK_TOKEN}\n- [ ]`);
    assert.equal(result.verdict, "ok-suppress");
  });

  it("keeps a response actionable when real content accompanies the OK token", () => {
    const result = classifyNeonHeartbeatResponse(`Restarted the worker. ${NEON_HEARTBEAT_OK_TOKEN}`);
    assert.equal(result.verdict, "actionable");
    assert.equal(result.reason, "actionable-content");
    assert.ok(result.residualLength > 0);
    assert.equal(isNeonHeartbeatOkResponse("Restarted the worker."), false);
  });

  it("suppresses a markdown-skeleton-only response and keeps a real one actionable", () => {
    assert.equal(classifyNeonHeartbeatResponse("# Heading\n- [ ]\n```").verdict, "ok-suppress");
    const real = classifyNeonHeartbeatResponse("Found 3 stale branches to prune.");
    assert.equal(real.verdict, "actionable");
    assert.match(renderNeonHeartbeatClassificationReport(real), /actionable \(actionable-content/);
  });
});

describe("isNeonHeartbeatUserMessage", () => {
  it("detects the synthetic poll marker and an exact configured prompt, not a real message", () => {
    assert.equal(isNeonHeartbeatUserMessage(NEON_HEARTBEAT_POLL_MARKER), true);
    assert.equal(isNeonHeartbeatUserMessage("[NEON HEARTBEAT POLL]"), true, "marker match is case-insensitive");
    assert.equal(isNeonHeartbeatUserMessage("check due tasks", "check due tasks"), true);
    assert.equal(isNeonHeartbeatUserMessage("hey neo, deploy please"), false);
    assert.equal(isNeonHeartbeatUserMessage(""), false);
  });
});

describe("auto-reply suppresses a heartbeat-OK reply (parity row 404 consumer)", () => {
  const ingressPolicy: INeonDiscordIngressPolicy = {
    agentId: "agent-1",
    workspaceRoot: "/tmp/ws",
    mode: "read-only",
    botUserId: "bot-1",
    mentionPolicy: "always"
  };
  const autoReplyPolicy: INeonAutoReplyPolicy = { replyWhenMentioned: true };
  const now = () => new Date("2026-06-03T12:00:00.000Z");
  const envelope: INeonDiscordMessageEnvelope = {
    accountId: "acct-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "msg-1",
    author: { id: "user-1", username: "alice" },
    content: "hey <@bot-1> status?",
    createdAt: "2026-06-03T11:59:59.000Z",
    mentionedUserIds: ["bot-1"]
  };

  it("skips a HEARTBEAT_OK reply payload without planning a send", async () => {
    const result = await dispatchNeonAutoReply({
      envelope,
      ingressPolicy,
      autoReplyPolicy,
      payload: { text: NEON_HEARTBEAT_OK_TOKEN },
      now
    });
    assert.equal(result.state, "skipped");
    assert.equal(result.reason, "heartbeat-ok-suppressed");
    assert.equal(result.steps.length, 0);
    assert.equal(result.safety.outboundSent, false);
  });

  it("still dispatches a real reply as a dry-run", async () => {
    const result = await dispatchNeonAutoReply({
      envelope,
      ingressPolicy,
      autoReplyPolicy,
      payload: { text: "All green, three jobs ran." },
      now
    });
    assert.equal(result.state, "dispatched-dry-run");
    assert.equal(result.safety.outboundSent, false);
  });
});
