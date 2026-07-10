import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  createNeonDiscordWorkboardDedupeKey,
  createNeonDiscordWorkboardSourceUrl,
  readNeonWorkboardCards,
  recordNeonDiscordWorkboardCard,
  resolveNeonDiscordWorkboardIntent,
  runNeonDiscordSlashInteractionShadow,
  runNeonDiscordShadowIngress,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type INeonDiscordSlashInteractionEnvelope,
  type INeonGatewayInboundMessage
} from "../src/index.js";

const botUserId = "900000000000000010";
const guildId = "900000000000000001";
const channelId = "900000000000000005";
const threadId = "900000000000000011";

describe("Discord -> Neon Workboard producer", () => {
  it("creates one redacted Workboard card for a Discord action intent and dedupes by message", async () => {
    const projectRoot = await createTempProjectRoot();
    const message = createGatewayMessage({
      workspaceRoot: projectRoot,
      content: "ah nice ja bitte bau Discord Workboard komplett p1 sk-live-SHOULD-REDACT",
      messageId: "discord-workboard-message"
    });

    try {
      const intent = resolveNeonDiscordWorkboardIntent(message);
      assert.equal(intent?.kind, "action-request");
      assert.equal(intent?.priority, "urgent");

      const first = await recordNeonDiscordWorkboardCard(projectRoot, message, {
        now: () => new Date("2026-06-05T12:00:00.000Z")
      });
      const second = await recordNeonDiscordWorkboardCard(projectRoot, message, {
        now: () => new Date("2026-06-05T12:00:01.000Z")
      });

      assert.equal(first.state, "created");
      assert.equal(second.state, "existing");
      if (first.state === "created") {
        assert.equal(first.dedupeKey, createNeonDiscordWorkboardDedupeKey(message));
        assert.equal(first.card.taskId, first.dedupeKey);
        assert.equal(first.card.status, "ready");
        assert.equal(first.card.priority, "urgent");
        assert.equal(first.card.metadata?.source?.kind, "discord-message");
        assert.equal(first.card.metadata?.source?.messageId, "discord-workboard-message");
        assert.equal(first.card.sourceUrl, createNeonDiscordWorkboardSourceUrl(message));
        assert.doesNotMatch(JSON.stringify(first.card), /sk-live-SHOULD-REDACT/);
      }

      const cards = await readNeonWorkboardCards(projectRoot);
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.metadata?.source?.dedupeKey, createNeonDiscordWorkboardDedupeKey(message));
      assert.doesNotMatch(JSON.stringify(cards), /sk-live-SHOULD-REDACT/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records cards from the accepted Discord ingress path and skips dropped or non-work messages", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const accepted = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: `<@${botUserId}> /workboard add Fix Discord board urgent sk-live-SHOULD-REDACT`,
            messageId: "accepted-workboard-message"
          }),
          policy: createPolicy(projectRoot),
          memory: { state: "skipped", hitCount: 0, note: "workboard ingress test" }
        },
        {
          projectRoot,
          harness: createDryRunHarness(),
          now: () => new Date("2026-06-05T12:05:00.000Z")
        }
      );

      assert.equal(accepted.state, "accepted");
      if (accepted.state === "accepted") {
        assert.equal(accepted.workboard.state, "created");
        if (accepted.workboard.state === "created") {
          assert.equal(accepted.workboard.intent.kind, "workboard-command");
          assert.equal(accepted.workboard.card.priority, "urgent");
        }
      }

      const chatOnly = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: `<@${botUserId}> danke dir`,
            messageId: "chat-only-message"
          }),
          policy: createPolicy(projectRoot),
          memory: { state: "skipped", hitCount: 0, note: "chat-only ingress test" }
        },
        {
          projectRoot,
          harness: createDryRunHarness(),
          now: () => new Date("2026-06-05T12:06:00.000Z")
        }
      );

      assert.equal(chatOnly.state, "accepted");
      if (chatOnly.state === "accepted") {
        assert.deepEqual(chatOnly.workboard, { state: "skipped", reason: "no-work-intent" });
      }

      const dropped = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: "bitte bau das trotzdem",
            mentionedUserIds: [],
            messageId: "dropped-workboard-message"
          }),
          policy: createPolicy(projectRoot),
          memory: { state: "skipped", hitCount: 0, note: "dropped ingress test" }
        },
        {
          projectRoot,
          harness: createDryRunHarness()
        }
      );

      assert.equal(dropped.state, "dropped");

      const cards = await readNeonWorkboardCards(projectRoot);
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.status, "done");
      assert.equal(cards[0]?.metadata?.source?.messageId, "accepted-workboard-message");
      assert.equal(cards[0]?.metadata?.proof?.at(-1)?.label, "discord-ingress-run");
      assert.doesNotMatch(JSON.stringify(cards), /sk-live-SHOULD-REDACT/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records native /workboard slash interactions as Workboard cards", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const result = await runNeonDiscordSlashInteractionShadow(
        {
          interaction: createSlashInteraction({
            commandName: "workboard",
            options: [{ name: "task", value: "Fix native Slash Workboard card urgent" }]
          }),
          policy: { ...createPolicy(projectRoot), mentionPolicy: "never" },
          memory: { state: "skipped", hitCount: 0, note: "workboard slash test" }
        },
        {
          projectRoot,
          harness: createDryRunHarness(),
          now: () => new Date("2026-06-05T12:10:00.000Z")
        }
      );

      assert.equal(result.state, "accepted");

      const cards = await readNeonWorkboardCards(projectRoot);
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.title, "Fix native Slash Workboard card urgent");
      assert.equal(cards[0]?.status, "done");
      assert.equal(cards[0]?.priority, "urgent");
      assert.equal(cards[0]?.metadata?.source?.messageId, "interaction:workboard-interaction");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createPolicy(projectRoot: string): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: projectRoot,
    mode: "read-only",
    botUserId,
    mentionPolicy: "guild",
    allowedGuildIds: [guildId],
    allowedChannelIds: [channelId]
  };
}

function createDiscordEnvelope(
  overrides: Partial<INeonDiscordMessageEnvelope> = {}
): INeonDiscordMessageEnvelope {
  return {
    accountId: "default",
    guildId,
    channelId,
    threadId,
    messageId: "900000000000000012",
    author: {
      id: "operator",
      username: "operator",
      displayName: "Operator"
    },
    content: `<@${botUserId}> bitte bau Workboard`,
    createdAt: "2026-06-05T12:00:00.000Z",
    mentionedUserIds: [botUserId],
    ...overrides
  };
}

function createGatewayMessage(
  overrides: Partial<INeonGatewayInboundMessage> = {}
): INeonGatewayInboundMessage {
  return {
    channel: "discord",
    accountId: "default",
    guildId,
    channelId,
    threadId,
    messageId: "900000000000000012",
    userId: "operator",
    userDisplayName: "Operator",
    agentId: "chaty",
    workspaceRoot: "/Users/operator/neon-projects/neon-core",
    mode: "read-only",
    content: "bitte bau Workboard",
    createdAt: "2026-06-05T12:00:00.000Z",
    ...overrides
  };
}

function createSlashInteraction(
  overrides: Partial<INeonDiscordSlashInteractionEnvelope> = {}
): INeonDiscordSlashInteractionEnvelope {
  return {
    accountId: "default",
    guildId,
    channelId,
    threadId,
    interactionId: "workboard-interaction",
    commandName: "workboard",
    author: {
      id: "operator",
      username: "operator",
      displayName: "Operator"
    },
    options: [{ name: "task", value: "Fix native Slash Workboard card urgent" }],
    createdAt: "2026-06-05T12:10:00.000Z",
    ...overrides
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-discord-workboard-"));
}
