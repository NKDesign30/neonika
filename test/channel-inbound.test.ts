import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptDiscordPolicyToChannelInbound,
  createNeonDiscordIngressDecision,
  decideDiscordViaChannelContract,
  decideNeonChannelInbound,
  mapDiscordDropReasonToChannel,
  mapDiscordMentionPolicyToChannel,
  renderNeonChannelOutboundPolicyLine,
  resolveAllNeonChannelOutboundPolicies,
  resolveNeonChannelOutboundPolicy,
  neonChannelPlatforms,
  type INeonChannelInboundEnvelope,
  type INeonChannelInboundPolicy,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope
} from "../src/index.js";

const basePolicy: INeonChannelInboundPolicy = {
  agentId: "chaty",
  mentionPolicy: "never"
};

function dropReasonOf(
  decision: ReturnType<typeof decideNeonChannelInbound>
): string {
  return decision.state === "dropped" ? decision.reason : "accepted";
}

function envelope(
  overrides: Partial<INeonChannelInboundEnvelope> = {}
): INeonChannelInboundEnvelope {
  return {
    platform: "slack",
    accountId: "default",
    workspaceId: "W1",
    channelId: "C1",
    userId: "U1",
    content: "hello there",
    ...overrides
  };
}

describe("generic channel inbound decision", () => {
  it("accepts a normal message and normalizes the identity", () => {
    const decision = decideNeonChannelInbound(envelope({ content: "  spaced  " }), basePolicy);

    assert.equal(decision.state, "accepted");
    if (decision.state === "accepted") {
      assert.equal(decision.identity.content, "spaced");
      assert.equal(decision.identity.platform, "slack");
      assert.equal(decision.identity.workspaceId, "W1");
      assert.equal(decision.identity.agentId, "chaty");
    }
  });

  it("applies gates in order: bot, ignored, workspace, channel, mention, empty", () => {
    assert.equal(dropReasonOf(decideNeonChannelInbound(envelope({ isBot: true }), basePolicy)), "bot-author");
    assert.equal(
      dropReasonOf(decideNeonChannelInbound(envelope(), { ...basePolicy, ignoredUserIds: ["U1"] })),
      "ignored-user"
    );
    assert.equal(
      dropReasonOf(
        decideNeonChannelInbound(envelope(), { ...basePolicy, allowedWorkspaceIds: ["W2"] })
      ),
      "workspace-not-allowed"
    );
    assert.equal(
      dropReasonOf(
        decideNeonChannelInbound(envelope(), { ...basePolicy, allowedChannelIds: ["C2"] })
      ),
      "channel-not-allowed"
    );
    assert.equal(
      dropReasonOf(
        decideNeonChannelInbound(envelope(), { ...basePolicy, mentionPolicy: "always" })
      ),
      "mention-required"
    );
    assert.equal(
      dropReasonOf(decideNeonChannelInbound(envelope({ content: "   " }), basePolicy)),
      "empty-content"
    );
  });

  it("requires a mention only inside a workspace under the workspace policy", () => {
    const workspacePolicy: INeonChannelInboundPolicy = { ...basePolicy, mentionPolicy: "workspace" };

    assert.equal(decideNeonChannelInbound(envelope(), workspacePolicy).state, "dropped");
    assert.equal(
      decideNeonChannelInbound(envelope({ wasMentioned: true }), workspacePolicy).state,
      "accepted"
    );
    // Direct message (no workspace) needs no mention.
    const dm = envelope({ content: "hi" });
    const { workspaceId: _omitted, ...dmWithoutWorkspace } = dm;
    assert.equal(
      decideNeonChannelInbound(dmWithoutWorkspace, workspacePolicy).state,
      "accepted"
    );
  });
});

describe("generic channel outbound policy", () => {
  it("hard-suppresses every manifest-only platform with no send path", () => {
    for (const platform of neonChannelPlatforms) {
      if (platform === "discord") {
        continue;
      }
      const policy = resolveNeonChannelOutboundPolicy(platform, { env: {} });
      assert.equal(policy.mode, "suppressed");
      assert.equal(policy.canSend, false);
      assert.equal(policy.canary, undefined);
    }
  });

  it("keeps Discord canary-gated and closed by default", () => {
    const policy = resolveNeonChannelOutboundPolicy("discord", { env: {} });
    assert.equal(policy.mode, "canary-gated");
    assert.equal(policy.canSend, false);
    assert.ok(policy.canary);
    assert.equal(policy.canary?.ready, false);
  });

  it("opens the Discord gate only when every canary precondition is armed", () => {
    const armed = resolveNeonChannelOutboundPolicy("discord", {
      env: {
        NEON_DISCORD_BOT_TOKEN: "present-not-a-real-token",
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
        NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005,900000000000000003"
      }
    });
    assert.equal(armed.mode, "canary-gated");
    assert.equal(armed.canSend, true);
    assert.equal(armed.canary?.singleChannel, false);
  });

  it("projects all platforms and renders leak-safe lines", () => {
    const policies = resolveAllNeonChannelOutboundPolicies(neonChannelPlatforms, { env: {} });
    assert.equal(policies.length, 6);
    assert.equal(policies.every((policy) => policy.canSend === false), true);
    assert.equal(
      renderNeonChannelOutboundPolicyLine(policies[0]!),
      "discord: mode=canary-gated canSend=no"
    );
  });
});

describe("Discord adapter conformance", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly envelope: INeonDiscordMessageEnvelope;
    readonly policy: INeonDiscordIngressPolicy;
  }> = [
    {
      name: "accepted mention in guild",
      envelope: discordEnvelope({ content: "<@bot> hello", mentionedUserIds: ["bot"] }),
      policy: discordPolicy({ mentionPolicy: "guild", botUserId: "bot" })
    },
    {
      name: "bot author dropped",
      envelope: discordEnvelope({ author: { id: "U9", username: "b", bot: true } }),
      policy: discordPolicy({})
    },
    {
      name: "ignored user dropped",
      envelope: discordEnvelope({}),
      policy: discordPolicy({ ignoredUserIds: ["U1"] })
    },
    {
      name: "guild not allowed -> workspace-not-allowed",
      envelope: discordEnvelope({ guildId: "G1" }),
      policy: discordPolicy({ allowedGuildIds: ["G2"] })
    },
    {
      name: "channel not allowed",
      envelope: discordEnvelope({ channelId: "C1" }),
      policy: discordPolicy({ allowedChannelIds: ["C2"] })
    },
    {
      name: "mention required dropped",
      envelope: discordEnvelope({ content: "no mention here", guildId: "G1" }),
      policy: discordPolicy({ mentionPolicy: "guild", botUserId: "bot" })
    },
    {
      name: "empty content dropped",
      envelope: discordEnvelope({ content: "<@bot>", mentionedUserIds: ["bot"] }),
      policy: discordPolicy({ botUserId: "bot", mentionPolicy: "never" })
    }
  ];

  for (const testCase of cases) {
    it(`matches the live Discord verdict: ${testCase.name}`, () => {
      const discord = createNeonDiscordIngressDecision(testCase.envelope, testCase.policy);
      const generic = decideDiscordViaChannelContract(testCase.envelope, testCase.policy);

      assert.equal(generic.state, discord.state, "state parity");

      if (discord.state === "dropped" && generic.state === "dropped") {
        assert.equal(
          generic.reason,
          mapDiscordDropReasonToChannel(discord.reason),
          "drop reason parity"
        );
      }
    });
  }

  it("maps policy fields from Discord to the generic shape", () => {
    const policy = adaptDiscordPolicyToChannelInbound(
      discordPolicy({ mentionPolicy: "guild", allowedGuildIds: ["G1"], allowedChannelIds: ["C1"] })
    );
    assert.equal(policy.mentionPolicy, "workspace");
    assert.deepEqual(policy.allowedWorkspaceIds, ["G1"]);
    assert.deepEqual(policy.allowedChannelIds, ["C1"]);
    assert.equal(mapDiscordMentionPolicyToChannel("never"), "never");
    assert.equal(mapDiscordMentionPolicyToChannel("always"), "always");
  });
});

function discordEnvelope(
  overrides: Partial<INeonDiscordMessageEnvelope> = {}
): INeonDiscordMessageEnvelope {
  return {
    accountId: "default",
    channelId: "C1",
    messageId: "M1",
    author: { id: "U1", username: "user" },
    content: "hello there",
    createdAt: "2026-06-02T09:00:00.000Z",
    ...overrides
  };
}

function discordPolicy(
  overrides: Partial<INeonDiscordIngressPolicy> = {}
): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: "/tmp/neon",
    mode: "read-only",
    mentionPolicy: "never",
    ...overrides
  };
}
