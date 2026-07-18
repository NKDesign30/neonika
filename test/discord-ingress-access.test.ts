import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordIngressDecision,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type TNeonAccessGroup
} from "../src/index.js";

const botUserId = "bot-1";
const guildId = "guild-1";
const channelId = "channel-1";

// Live-ingress proof that `createNeonDiscordIngressDecision` runs the real
// inbound access chain (allow-from -> access groups -> DM guard -> command auth
// -> mention) and not just the legacy bot/guild/channel/mention gates.
describe("Neon Discord ingress — inbound access stack composition", () => {
  it("drops a guild sender outside the configured allow-from", () => {
    const decision = createNeonDiscordIngressDecision(
      guildEnvelope({ author: { id: "stranger", username: "stranger" } }),
      guildPolicy({ allowFrom: ["operator"] })
    );
    assert.equal(decision.state, "dropped");
    if (decision.state === "dropped") {
      assert.equal(decision.reason, "sender-not-allowed");
    }
  });

  it("accepts a guild sender resolved through an access group", () => {
    const decision = createNeonDiscordIngressDecision(
      guildEnvelope({ author: { id: "chaty", username: "chaty" } }),
      guildPolicy({
        allowFrom: ["accessGroup:ops"],
        accessGroups: {
          ops: { type: "message.senders", members: { discord: ["chaty"] } } satisfies TNeonAccessGroup
        }
      })
    );
    assert.equal(decision.state, "accepted");
  });

  it("blocks a DM when the dmPolicy is disabled", () => {
    const decision = createNeonDiscordIngressDecision(dmEnvelope(), dmPolicy({ dmPolicy: "disabled" }));
    assert.equal(decision.state, "dropped");
    if (decision.state === "dropped") {
      assert.equal(decision.reason, "dm-not-allowed");
    }
  });

  it("requires pairing for an unknown DM sender under the pairing policy", () => {
    const decision = createNeonDiscordIngressDecision(
      dmEnvelope({ author: { id: "stranger", username: "stranger" } }),
      dmPolicy({ dmPolicy: "pairing", allowFrom: ["operator"] })
    );
    assert.equal(decision.state, "dropped");
    if (decision.state === "dropped") {
      assert.equal(decision.reason, "dm-pairing-required");
    }
  });

  it("blocks an unauthorized control command when text commands are enabled", () => {
    const decision = createNeonDiscordIngressDecision(
      guildEnvelope({ content: `<@${botUserId}> /restart`, author: { id: "stranger", username: "stranger" } }),
      guildPolicy({ allowTextCommands: true })
    );
    assert.equal(decision.state, "dropped");
    if (decision.state === "dropped") {
      assert.equal(decision.reason, "command-not-authorized");
    }
  });

  it("stays backward compatible: no access config still accepts a mentioned guild message", () => {
    const decision = createNeonDiscordIngressDecision(guildEnvelope(), guildPolicy());
    assert.equal(decision.state, "accepted");
  });
});

function guildPolicy(
  overrides: Partial<INeonDiscordIngressPolicy> = {}
): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: "/tmp/neonika",
    mode: "read-only",
    botUserId,
    mentionPolicy: "guild",
    allowedGuildIds: [guildId],
    allowedChannelIds: [channelId],
    ...overrides
  };
}

function dmPolicy(overrides: Partial<INeonDiscordIngressPolicy> = {}): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: "/tmp/neonika",
    mode: "read-only",
    botUserId,
    mentionPolicy: "never",
    allowedGuildIds: [],
    ...overrides
  };
}

function guildEnvelope(
  overrides: Partial<INeonDiscordMessageEnvelope> = {}
): INeonDiscordMessageEnvelope {
  return {
    accountId: "default",
    guildId,
    channelId,
    messageId: "m1",
    author: { id: "operator", username: "operator", displayName: "Operator" },
    content: `<@${botUserId}> hallo`,
    createdAt: "2026-06-02T12:00:00.000Z",
    mentionedUserIds: [botUserId],
    ...overrides
  };
}

function dmEnvelope(
  overrides: Partial<INeonDiscordMessageEnvelope> = {}
): INeonDiscordMessageEnvelope {
  return {
    accountId: "default",
    channelId: "dm-1",
    messageId: "m1",
    author: { id: "operator", username: "operator", displayName: "Operator" },
    content: "dm hallo",
    createdAt: "2026-06-02T12:00:00.000Z",
    mentionedUserIds: [],
    ...overrides
  };
}
