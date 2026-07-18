import { buildNeonDiscordComponentPayload, type TNeonDiscordActionRow } from "./discordComponentPayload.js";
import { chunkNeonDiscordText } from "./discordChunk.js";
import {
  createNeonDiscordIngressDecision,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope
} from "./discordIngress.js";
import {
  buildNeonInboundReplayKey,
  claimNeonInboundReplay,
  type INeonDiscordInboundReplayGuard
} from "./discordInboundReplayGuard.js";
import { buildNeonDiscordMediaPayload, type TNeonDiscordMediaAttachment } from "./discordMediaPayload.js";
import { isNeonHeartbeatOkResponse } from "../automation/heartbeatPolicy.js";
import { buildNeonDiscordEmbedPayload, type INeonDiscordEmbed } from "./discordRichPayload.js";
import {
  createNeonDryRunOutboundSender,
  type INeonOutboundSendResult
} from "./outboundSender.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";

/**
 * Neon-native auto-reply dispatcher (parity row "Auto-reply inbound dispatch").
 *
 * This is the missing inbound→reply bridge: it runs an accepted inbound envelope
 * through the REAL ingress access decision, an explicit auto-reply policy, the
 * inbound replay/dedup guard, and fail-closed validation of every reply payload
 * (text + the new brick transports: embeds / components / media), then plans the
 * reply as ordered dry-run steps (typing → chunked sends → optional ack reaction
 * → typing-stop).
 *
 * Shadow-contract by construction: the send steps route through
 * `createNeonDryRunOutboundSender`, which is no-send and redacts every preview.
 * `safety.outboundSent` is the literal `false`; there is no injected canary
 * sender here, so a real Discord send is unreachable from this module. Arming the
 * live send is a separate, gated dispatch loop — a product decision, not this
 * dispatcher's job.
 */

export interface INeonAutoReplyPayload {
  readonly text: string;
  readonly embeds?: readonly INeonDiscordEmbed[];
  readonly components?: readonly TNeonDiscordActionRow[];
  readonly attachments?: readonly TNeonDiscordMediaAttachment[];
  /** Optional ack reaction emoji planned as a dry-run step (never sent). */
  readonly ackReaction?: string;
}

export interface INeonAutoReplyPolicy {
  /** Only reply when the bot was mentioned. */
  readonly replyWhenMentioned: boolean;
  /** Reply to bot authors (default false; ingress usually drops bots already). */
  readonly replyToBots?: boolean;
}

export type TNeonAutoReplyStep =
  | { readonly kind: "typing-start" }
  | {
      readonly kind: "send-chunk";
      readonly index: number;
      readonly total: number;
      readonly preview: string;
      readonly outboundSent: false;
    }
  | { readonly kind: "ack-reaction"; readonly emoji: string; readonly outboundSent: false }
  | { readonly kind: "typing-stop" };

export type TNeonAutoReplyState = "dispatched-dry-run" | "skipped" | "dropped";

export interface INeonAutoReplyPayloadSummary {
  readonly chunks: number;
  readonly embeds: number;
  readonly components: number;
  readonly attachments: number;
  readonly hasReaction: boolean;
}

export interface INeonAutoReplyResult {
  readonly state: TNeonAutoReplyState;
  readonly reason: string;
  readonly wasMentioned: boolean;
  readonly target?: INeonDeliveryQueueTarget;
  readonly steps: readonly TNeonAutoReplyStep[];
  readonly deliveryResults: readonly INeonOutboundSendResult[];
  readonly payloadSummary: INeonAutoReplyPayloadSummary;
  readonly safety: { readonly outboundSent: false };
}

export interface INeonAutoReplyDispatchParams {
  readonly envelope: INeonDiscordMessageEnvelope;
  readonly ingressPolicy: INeonDiscordIngressPolicy;
  readonly autoReplyPolicy: INeonAutoReplyPolicy;
  readonly payload: INeonAutoReplyPayload;
  /** Optional inbound dedup. A duplicate message is skipped before any planning. */
  readonly replayGuard?: INeonDiscordInboundReplayGuard;
  readonly now?: () => Date;
}

const EMPTY_SUMMARY: INeonAutoReplyPayloadSummary = {
  chunks: 0,
  embeds: 0,
  components: 0,
  attachments: 0,
  hasReaction: false
};

const SAFETY = { outboundSent: false } as const;

function skip(reason: string, wasMentioned: boolean): INeonAutoReplyResult {
  return {
    state: "skipped",
    reason,
    wasMentioned,
    steps: [],
    deliveryResults: [],
    payloadSummary: EMPTY_SUMMARY,
    safety: SAFETY
  };
}

function validateBrickPayloads(payload: INeonAutoReplyPayload): readonly string[] {
  const errors: string[] = [];
  if (payload.embeds && payload.embeds.length > 0) {
    const result = buildNeonDiscordEmbedPayload(payload.embeds);
    if (!result.ok) {
      errors.push(`embeds: ${result.errors.join(", ")}`);
    }
  }
  if (payload.components && payload.components.length > 0) {
    const result = buildNeonDiscordComponentPayload(payload.components);
    if (!result.ok) {
      errors.push(`components: ${result.errors.join(", ")}`);
    }
  }
  if (payload.attachments && payload.attachments.length > 0) {
    const result = buildNeonDiscordMediaPayload(payload.attachments);
    if (!result.ok) {
      errors.push(`attachments: ${result.errors.join(", ")}`);
    }
  }
  return errors;
}

/**
 * Run an inbound envelope through the real ingress decision and, when accepted +
 * permitted by the auto-reply policy, plan a dry-run reply. Returns "dropped"
 * (ingress refused), "skipped" (policy/dedup/empty/invalid), or
 * "dispatched-dry-run" (planned, nothing sent).
 */
export async function dispatchNeonAutoReply(
  params: INeonAutoReplyDispatchParams
): Promise<INeonAutoReplyResult> {
  // 1. Real ingress access decision (bot/ignored/guild/channel/mention/command auth).
  const decision = createNeonDiscordIngressDecision(params.envelope, params.ingressPolicy);
  if (decision.state === "dropped") {
    return {
      state: "dropped",
      reason: `ingress-dropped: ${decision.reason}`,
      wasMentioned: decision.wasMentioned,
      steps: [],
      deliveryResults: [],
      payloadSummary: EMPTY_SUMMARY,
      safety: SAFETY
    };
  }
  const wasMentioned = decision.wasMentioned;

  // 2. Inbound dedup: a redelivered message id is skipped before planning.
  if (params.replayGuard) {
    const key = buildNeonInboundReplayKey({
      accountId: params.envelope.accountId,
      channelId: params.envelope.channelId,
      messageId: params.envelope.messageId
    });
    if ((await claimNeonInboundReplay(params.replayGuard, key)) === "duplicate") {
      return skip("duplicate-inbound", wasMentioned);
    }
  }

  // 3. Auto-reply policy.
  if (params.autoReplyPolicy.replyWhenMentioned && !wasMentioned) {
    return skip("not-mentioned", wasMentioned);
  }
  if (params.envelope.author.bot === true && params.autoReplyPolicy.replyToBots !== true) {
    return skip("bot-author", wasMentioned);
  }

  // 4. Content + fail-closed payload validation: an invalid brick payload skips
  // the whole reply rather than sending a partial one.
  const text = params.payload.text.trim();
  const hasContent =
    text.length > 0 ||
    (params.payload.embeds?.length ?? 0) > 0 ||
    (params.payload.components?.length ?? 0) > 0 ||
    (params.payload.attachments?.length ?? 0) > 0;
  if (!hasContent) {
    return skip("empty-reply", wasMentioned);
  }
  // Heartbeat OK-suppression (parity row 404): when the agent's reply is a pure
  // HEARTBEAT_OK / no-op heartbeat response, suppress it instead of planning a reply.
  if (isNeonHeartbeatOkResponse(text)) {
    return skip("heartbeat-ok-suppressed", wasMentioned);
  }
  const validationErrors = validateBrickPayloads(params.payload);
  if (validationErrors.length > 0) {
    return skip(`invalid-payload: ${validationErrors.join("; ")}`, wasMentioned);
  }

  // 5. Reply target derived from the inbound envelope (reply to the message).
  const target: INeonDeliveryQueueTarget = {
    channel: "discord",
    accountId: params.envelope.accountId,
    channelId: params.envelope.channelId,
    ...(params.envelope.guildId ? { guildId: params.envelope.guildId } : {}),
    ...(params.envelope.threadId ? { threadId: params.envelope.threadId } : {}),
    replyToMessageId: params.envelope.messageId
  };

  // 6. Plan ordered dry-run steps. Sends go through the no-send DryRun sender,
  // which redacts every preview — outboundSent stays false by construction.
  const sender = createNeonDryRunOutboundSender(params.now ? { now: params.now } : {});
  const chunks = text.length > 0 ? chunkNeonDiscordText(text) : [];
  const steps: TNeonAutoReplyStep[] = [{ kind: "typing-start" }];
  const deliveryResults: INeonOutboundSendResult[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const result = await sender.sendText(target, chunk);
    deliveryResults.push(result);
    steps.push({
      kind: "send-chunk",
      index,
      total: chunks.length,
      preview: result.bodyPreview,
      outboundSent: false
    });
  }
  if (params.payload.ackReaction !== undefined && params.payload.ackReaction.length > 0) {
    steps.push({ kind: "ack-reaction", emoji: params.payload.ackReaction, outboundSent: false });
  }
  steps.push({ kind: "typing-stop" });

  return {
    state: "dispatched-dry-run",
    reason: "dispatched as dry-run (no send)",
    wasMentioned,
    target,
    steps,
    deliveryResults,
    payloadSummary: {
      chunks: chunks.length,
      embeds: params.payload.embeds?.length ?? 0,
      components: params.payload.components?.length ?? 0,
      attachments: params.payload.attachments?.length ?? 0,
      hasReaction: params.payload.ackReaction !== undefined && params.payload.ackReaction.length > 0
    },
    safety: SAFETY
  };
}

export function renderNeonAutoReplyDispatchReport(result: INeonAutoReplyResult): string {
  const lines = [
    "Neon Auto-Reply Dispatch",
    `State: ${result.state}`,
    `Reason: ${result.reason}`,
    `Was mentioned: ${result.wasMentioned}`,
    `Outbound sent: ${result.safety.outboundSent}`
  ];
  if (result.target) {
    lines.push(`Target: ${result.target.channel}/${result.target.channelId}`);
  }
  lines.push(
    `Payload: chunks=${result.payloadSummary.chunks} embeds=${result.payloadSummary.embeds} ` +
      `components=${result.payloadSummary.components} attachments=${result.payloadSummary.attachments} ` +
      `reaction=${result.payloadSummary.hasReaction}`
  );
  for (const step of result.steps) {
    if (step.kind === "send-chunk") {
      lines.push(`  step send-chunk ${step.index + 1}/${step.total}: "${step.preview}" (sent=${step.outboundSent})`);
    } else if (step.kind === "ack-reaction") {
      lines.push(`  step ack-reaction: ${step.emoji} (sent=${step.outboundSent})`);
    } else {
      lines.push(`  step ${step.kind}`);
    }
  }
  return lines.join("\n");
}
