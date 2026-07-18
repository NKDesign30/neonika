/**
 * Discord -> generic channel contract adapter.
 *
 * Places the existing, live Discord ingress (`gateway/discordIngress.ts`) into
 * the generic channel inbound contract (`channelInbound.ts`) WITHOUT modifying
 * the Discord path. The Discord-specific decision stays the production truth;
 * this adapter maps Discord's envelope/policy onto the platform-agnostic shape
 * (guild -> workspace, author -> user) and lets the generic gate chain reach the
 * same accept/drop verdict. The conformance is proved by test parity, not by
 * rewiring the runtime.
 */

import {
  normalizeDiscordContent,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type TDiscordMentionPolicy,
  type TNeonDiscordDropReason
} from "../gateway/discordIngress.js";
import {
  decideNeonChannelInbound,
  type INeonChannelInboundEnvelope,
  type INeonChannelInboundPolicy,
  type TNeonChannelInboundDecision,
  type TNeonChannelInboundDropReason,
  type TNeonChannelMentionPolicy
} from "./channelInbound.js";

export function mapDiscordMentionPolicyToChannel(
  policy: TDiscordMentionPolicy
): TNeonChannelMentionPolicy {
  return policy === "guild" ? "workspace" : policy;
}

export function mapDiscordDropReasonToChannel(
  reason: TNeonDiscordDropReason
): TNeonChannelInboundDropReason {
  return reason === "guild-not-allowed" ? "workspace-not-allowed" : reason;
}

export function adaptDiscordEnvelopeToChannelInbound(
  envelope: INeonDiscordMessageEnvelope,
  botUserId: string | undefined
): INeonChannelInboundEnvelope {
  const displayName = envelope.author.displayName ?? envelope.author.username;

  return {
    platform: "discord",
    accountId: envelope.accountId,
    channelId: envelope.channelId,
    userId: envelope.author.id,
    userDisplayName: displayName,
    isBot: envelope.author.bot === true,
    wasMentioned: isDiscordBotMentioned(envelope, botUserId),
    content: normalizeDiscordContent(envelope.content, botUserId),
    createdAt: envelope.createdAt,
    ...(envelope.guildId ? { workspaceId: envelope.guildId } : {}),
    ...(envelope.threadId ? { threadId: envelope.threadId } : {}),
    ...(envelope.messageId ? { messageId: envelope.messageId } : {})
  };
}

export function adaptDiscordPolicyToChannelInbound(
  policy: INeonDiscordIngressPolicy
): INeonChannelInboundPolicy {
  return {
    agentId: policy.agentId,
    mentionPolicy: mapDiscordMentionPolicyToChannel(policy.mentionPolicy),
    ...(policy.allowedGuildIds ? { allowedWorkspaceIds: policy.allowedGuildIds } : {}),
    ...(policy.allowedChannelIds ? { allowedChannelIds: policy.allowedChannelIds } : {}),
    ...(policy.ignoredUserIds ? { ignoredUserIds: policy.ignoredUserIds } : {}),
    ...(policy.allowBotAuthors !== undefined ? { allowBotAuthors: policy.allowBotAuthors } : {})
  };
}

/**
 * Run the generic channel gate chain over an adapted Discord message/policy.
 * Used to prove the Discord path conforms to the generic contract; the live
 * runtime keeps using `createNeonDiscordIngressDecision`.
 */
export function decideDiscordViaChannelContract(
  envelope: INeonDiscordMessageEnvelope,
  policy: INeonDiscordIngressPolicy
): TNeonChannelInboundDecision {
  return decideNeonChannelInbound(
    adaptDiscordEnvelopeToChannelInbound(envelope, policy.botUserId),
    adaptDiscordPolicyToChannelInbound(policy)
  );
}

function isDiscordBotMentioned(
  envelope: INeonDiscordMessageEnvelope,
  botUserId: string | undefined
): boolean {
  if (!botUserId) {
    return false;
  }

  return Boolean(
    envelope.mentionedUserIds?.includes(botUserId) ||
      new RegExp(`<@!?${escapeRegExp(botUserId)}>`).test(envelope.content)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
