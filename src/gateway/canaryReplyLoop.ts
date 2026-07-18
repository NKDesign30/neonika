import type { INeonOutboundSendResult, INeonOutboundSender } from "./outboundSender.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import { formatNeonDiscordReplyText } from "./discordReplyFormat.js";
import { createNeonLocalMediaAttachmentsFromText } from "./localMediaAttachment.js";
import type { INeonGatewayShadowRun } from "./types.js";
import {
  createNeonDiscordVoiceReplyAttachment,
  type INeonDiscordVoiceReplyOptions
} from "./discordVoiceReplySynthesis.js";

export type TNeonCanaryReplyLoopState =
  | "delivered"
  | "suppressed"
  | "skipped"
  | "transport-error";

export type TNeonCanaryReplyMode = "reply" | "channel";

export interface INeonCanaryReplyLoopResult {
  readonly state: TNeonCanaryReplyLoopState;
  readonly runId: string;
  readonly outboundSent: boolean;
  readonly target?: INeonDeliveryQueueTarget;
  readonly bodyPreview: string;
  readonly messageId?: string;
  readonly reason?: string;
}

export interface IDeliverNeonCanaryReplyForRunOptions {
  readonly run: INeonGatewayShadowRun;
  readonly sender: INeonOutboundSender;
  readonly replyMode?: TNeonCanaryReplyMode;
  readonly projectRoot?: string;
  readonly voiceReply?: INeonDiscordVoiceReplyOptions;
}

export async function deliverNeonCanaryReplyForRun(
  options: IDeliverNeonCanaryReplyForRunOptions
): Promise<INeonCanaryReplyLoopResult> {
  const target = resolveCanaryReplyTarget(options.run, options.replyMode ?? "reply");
  const text = options.run.finalText.trim();

  if (!target) {
    return {
      state: "skipped",
      runId: options.run.runId,
      outboundSent: false,
      bodyPreview: "",
      reason: "unsupported-channel"
    };
  }

  if (options.run.status !== "completed") {
    return {
      state: "skipped",
      runId: options.run.runId,
      outboundSent: false,
      target,
      bodyPreview: "",
      reason: "run-not-completed"
    };
  }

  if (text.length === 0) {
    return {
      state: "skipped",
      runId: options.run.runId,
      outboundSent: false,
      target,
      bodyPreview: "",
      reason: "empty-final-text"
    };
  }

  try {
    const media = await createNeonLocalMediaAttachmentsFromText(text, {
      projectRoot: options.projectRoot ?? options.run.request.workspaceRoot
    });
    const formattedText = formatNeonDiscordReplyText(media.text);
    const voiceAttachment = shouldCreateVoiceReply(options.run, options.voiceReply)
      ? await createNeonDiscordVoiceReplyAttachment(media.text, options.voiceReply)
      : undefined;
    const attachments = voiceAttachment ? [...media.attachments, voiceAttachment] : media.attachments;
    const result =
      attachments.length > 0 && options.sender.sendMedia
        ? await options.sender.sendMedia(target, formattedText, attachments)
        : await options.sender.sendText(target, formattedText);
    return projectCanaryReplySendResult(options.run.runId, target, result);
  } catch {
    return {
      state: "transport-error",
      runId: options.run.runId,
      outboundSent: false,
      target,
      bodyPreview: "",
      reason: "transport-error"
    };
  }
}

function shouldCreateVoiceReply(
  run: INeonGatewayShadowRun,
  options: INeonDiscordVoiceReplyOptions | undefined
): boolean {
  if (!options || options.mode === "off") {
    return false;
  }

  return run.request.requestedVoiceReply === true;
}

function projectCanaryReplySendResult(
  runId: string,
  target: INeonDeliveryQueueTarget,
  result: INeonOutboundSendResult
): INeonCanaryReplyLoopResult {
  if (result.outboundSent) {
    return {
      state: "delivered",
      runId,
      outboundSent: true,
      target,
      bodyPreview: result.bodyPreview,
      messageId: result.messageId
    };
  }

  return {
    state: "suppressed",
    runId,
    outboundSent: false,
    target,
    bodyPreview: result.bodyPreview,
    reason: result.reason
  };
}

function resolveCanaryReplyTarget(
  run: INeonGatewayShadowRun,
  replyMode: TNeonCanaryReplyMode
): INeonDeliveryQueueTarget | undefined {
  if (run.request.channel !== "discord") {
    return undefined;
  }

  return {
    channel: "discord",
    accountId: run.request.accountId,
    channelId: run.request.channelId,
    ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
    ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
    ...(replyMode === "reply" && run.request.messageId ? { replyToMessageId: run.request.messageId } : {})
  };
}
