/**
 * Generic Neon channel inbound policy.
 *
 * Upstream gates inbound messages through a shared ingress kernel
 * (`src/channels/message-access/decision.ts`, `sender-gates.ts`) that resolves
 * route/sender/command gates against allowlists, mention facts, and account
 * scope. Neonika rebuilds the *decision shape* natively and platform-agnostic:
 * one ordered gate chain over account/workspace/channel/thread/user identity,
 * a mention policy, and allowlists. The Discord-specific decision in
 * `gateway/discordIngress.ts` stays untouched and live; this module is the
 * generic contract every other channel manifest maps onto, and the Discord
 * adapter (`discordChannelAdapter.ts`) proves Discord conforms to it.
 *
 * Pure and leak-safe: it returns accept/drop verdicts and a normalized identity,
 * never raw secrets. The only content it touches is text the caller already
 * normalized.
 */

import type { TNeonChannelPlatform } from "./channelManifest.js";

/**
 * Mention requirement for inbound gating. Generalizes the Discord
 * `always | guild | never` policy: `workspace` requires a mention whenever the
 * message arrives inside a workspace/guild/team context (vs a direct message).
 */
export type TNeonChannelMentionPolicy = "always" | "workspace" | "never";

export type TNeonChannelInboundDropReason =
  | "bot-author"
  | "ignored-user"
  | "ignored-mentioned-user"
  | "workspace-not-allowed"
  | "channel-not-allowed"
  // Inbound access-stack denials. `decideNeonChannelInbound` does not emit these
  // itself (it is the simpler base gate chain); they are produced by the
  // channel-ingress access composition (`channels/inboundAccessDecision.ts`,
  // wired into the Discord ingress first) and modeled here so the
  // platform-agnostic contract can represent any channel's access verdict.
  | "sender-not-allowed"
  | "dm-not-allowed"
  | "dm-pairing-required"
  | "command-not-authorized"
  | "mention-required"
  | "empty-content";

/**
 * A channel-agnostic inbound message. `workspaceId` is the platform's top-level
 * scope (Discord guild, Slack workspace, Teams team, Matrix homeserver/room);
 * absent for direct messages. `content` is expected pre-normalized by the caller
 * (e.g. with the bot mention stripped).
 */
export interface INeonChannelInboundEnvelope {
  readonly platform: TNeonChannelPlatform;
  readonly accountId: string;
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly isBot?: boolean;
  readonly wasMentioned?: boolean;
  readonly content: string;
  readonly createdAt?: string;
}

export interface INeonChannelInboundPolicy {
  readonly agentId: string;
  readonly mentionPolicy: TNeonChannelMentionPolicy;
  readonly allowedWorkspaceIds?: readonly string[];
  readonly allowedChannelIds?: readonly string[];
  readonly ignoredUserIds?: readonly string[];
  readonly allowBotAuthors?: boolean;
}

/** Normalized inbound identity carried on an accepted decision. */
export interface INeonChannelInboundIdentity {
  readonly platform: TNeonChannelPlatform;
  readonly accountId: string;
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly agentId: string;
  readonly content: string;
}

export type TNeonChannelInboundDecision =
  | {
      readonly state: "accepted";
      readonly identity: INeonChannelInboundIdentity;
      readonly wasMentioned: boolean;
    }
  | {
      readonly state: "dropped";
      readonly reason: TNeonChannelInboundDropReason;
      readonly wasMentioned: boolean;
    };

/**
 * Decide whether an inbound message is admitted. The gate order mirrors the
 * Discord ingress decision so the generic contract and the live Discord path
 * stay verifiably in parity: bot-author -> ignored-user -> workspace ->
 * channel -> mention -> empty-content.
 */
export function decideNeonChannelInbound(
  envelope: INeonChannelInboundEnvelope,
  policy: INeonChannelInboundPolicy
): TNeonChannelInboundDecision {
  const wasMentioned = envelope.wasMentioned === true;

  if (envelope.isBot === true && policy.allowBotAuthors !== true) {
    return { state: "dropped", reason: "bot-author", wasMentioned };
  }

  if (policy.ignoredUserIds?.includes(envelope.userId)) {
    return { state: "dropped", reason: "ignored-user", wasMentioned };
  }

  if (!isWorkspaceAllowed(envelope.workspaceId, policy.allowedWorkspaceIds)) {
    return { state: "dropped", reason: "workspace-not-allowed", wasMentioned };
  }

  if (!isChannelAllowed(envelope, policy.allowedChannelIds)) {
    return { state: "dropped", reason: "channel-not-allowed", wasMentioned };
  }

  if (requiresMention(envelope.workspaceId, policy.mentionPolicy) && !wasMentioned) {
    return { state: "dropped", reason: "mention-required", wasMentioned };
  }

  const content = envelope.content.trim();

  if (content.length === 0) {
    return { state: "dropped", reason: "empty-content", wasMentioned };
  }

  return {
    state: "accepted",
    wasMentioned,
    identity: {
      platform: envelope.platform,
      accountId: envelope.accountId,
      channelId: envelope.channelId,
      userId: envelope.userId,
      agentId: policy.agentId,
      content,
      ...(envelope.workspaceId ? { workspaceId: envelope.workspaceId } : {}),
      ...(envelope.threadId ? { threadId: envelope.threadId } : {}),
      ...(envelope.userDisplayName ? { userDisplayName: envelope.userDisplayName } : {})
    }
  };
}

function isWorkspaceAllowed(
  workspaceId: string | undefined,
  allowedWorkspaceIds: readonly string[] | undefined
): boolean {
  if (!allowedWorkspaceIds || allowedWorkspaceIds.length === 0) {
    return true;
  }

  return Boolean(workspaceId && allowedWorkspaceIds.includes(workspaceId));
}

function isChannelAllowed(
  envelope: INeonChannelInboundEnvelope,
  allowedChannelIds: readonly string[] | undefined
): boolean {
  if (!allowedChannelIds || allowedChannelIds.length === 0) {
    return true;
  }

  return (
    allowedChannelIds.includes(envelope.channelId) ||
    Boolean(envelope.threadId && allowedChannelIds.includes(envelope.threadId))
  );
}

function requiresMention(
  workspaceId: string | undefined,
  mentionPolicy: TNeonChannelMentionPolicy
): boolean {
  if (mentionPolicy === "always") {
    return true;
  }

  if (mentionPolicy === "workspace") {
    return Boolean(workspaceId);
  }

  return false;
}
