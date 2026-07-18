import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordIngressDecision,
  resolveNeonCanonicalPeer,
  runNeonSetup
} from "../src/index.js";

describe("Neonika explicit cross-channel identity", () => {
  it("maps exact Discord and WhatsApp links to one private owner session", async () => {
    const configRoot = join(tmpdir(), `neonika-identity-${process.pid}-${Date.now()}`);
    try {
      const { config } = await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        discord: { enabled: true, ownerPeerId: "900000000000000010" },
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      const discord = resolveNeonCanonicalPeer(config, {
        channel: "discord",
        accountId: "default",
        peerId: "900000000000000010"
      });
      const whatsapp = resolveNeonCanonicalPeer(config, {
        channel: "whatsapp",
        accountId: "default",
        peerId: "+15551234567"
      });

      assert.equal(discord.linkedToOwner, true);
      assert.equal(whatsapp.linkedToOwner, true);
      assert.equal(discord.canonicalPeerId, "owner-primary");
      assert.equal(whatsapp.canonicalPeerId, "owner-primary");
      assert.equal(discord.sessionPeerKey, whatsapp.sessionPeerKey);
      assert.doesNotMatch(discord.sessionPeerKey, /900000000000000010/u);
      assert.doesNotMatch(whatsapp.sessionPeerKey, /15551234567/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("keeps an unknown peer isolated even when another channel is linked", async () => {
    const configRoot = join(tmpdir(), `neonika-identity-unknown-${process.pid}-${Date.now()}`);
    try {
      const { config } = await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        discord: { enabled: true, ownerPeerId: "900000000000000010" }
      });
      const unknown = resolveNeonCanonicalPeer(config, {
        channel: "whatsapp",
        accountId: "default",
        peerId: "+15557654321"
      });

      assert.equal(unknown.linkedToOwner, false);
      assert.notEqual(unknown.canonicalPeerId, "owner-primary");
      assert.match(unknown.sessionPeerKey, /^whatsapp:[a-f0-9]{24}$/u);
      assert.doesNotMatch(unknown.sessionPeerKey, /15557654321/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("applies the shared owner session only to the exact Discord author", async () => {
    const configRoot = join(tmpdir(), `neonika-identity-discord-${process.pid}-${Date.now()}`);
    try {
      const { config } = await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        discord: { enabled: true, ownerPeerId: "900000000000000010" },
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      const owner = resolveNeonCanonicalPeer(config, {
        channel: "discord",
        accountId: "default",
        peerId: "900000000000000010"
      });
      const policy = {
        agentId: "chaty",
        workspaceRoot: "/home/operator/neonika",
        mode: "read-only" as const,
        mentionPolicy: "never" as const,
        allowedGuildIds: ["900000000000000001"],
        allowedChannelIds: ["900000000000000005"],
        ownerSession: {
          userId: "900000000000000010",
          sessionPeerKey: owner.sessionPeerKey
        }
      };
      const envelope = {
        accountId: "default",
        guildId: "900000000000000001",
        channelId: "900000000000000005",
        messageId: "900000000000000006",
        author: {
          id: "900000000000000010",
          username: "operator"
        },
        content: "memory check",
        createdAt: "2026-07-18T18:00:00.000Z"
      };
      const linked = createNeonDiscordIngressDecision(envelope, policy);
      const unknown = createNeonDiscordIngressDecision(
        {
          ...envelope,
          messageId: "900000000000000007",
          author: { ...envelope.author, id: "900000000000000011" }
        },
        policy
      );

      assert.equal(linked.state, "accepted");
      assert.equal(
        linked.state === "accepted" ? linked.message.sessionPeerKey : undefined,
        owner.sessionPeerKey
      );
      assert.equal(unknown.state, "accepted");
      assert.equal(
        unknown.state === "accepted" ? unknown.message.sessionPeerKey : undefined,
        undefined
      );
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });
});
