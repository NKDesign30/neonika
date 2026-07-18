import type { INeonOutboundSendResult, INeonOutboundSender } from "./outboundSender.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import { redactText } from "../harness/redaction.js";
import { formatNeonDiscordReplyText } from "./discordReplyFormat.js";
import { createNeonLocalMediaAttachmentsFromText } from "./localMediaAttachment.js";
import type { INeonGatewayShadowRun } from "./types.js";
import {
  createNeonDiscordVoiceReplyAttachment,
  type INeonDiscordVoiceReplyOptions
} from "./discordVoiceReplySynthesis.js";
import {
  createNeonDeliveryIntentId,
  createNeonDeliveryPayloadHash,
  executeNeonExactlyOnceDelivery,
  type INeonExactlyOnceDeliveryResult
} from "./deliveryReceiptStore.js";
import type { INeonPdfReviewRuntime } from "./pdfReviewFlow.js";
import { parseNeonDiscordPollMarker } from "./discordPollMarker.js";
import type { INeonDiscordPoll } from "./discordStickerPollPayload.js";
import { parseNeonDiscordCardMarker } from "./discordCardMarker.js";
import type { INeonDiscordEmbed } from "./discordRichPayload.js";
import { parseNeonDiscordButtonsMarker } from "./discordAgentButtons.js";
import { parseNeonDiscordPlanApprovalMarker } from "./discordPlanApproval.js";

export type TNeonCanaryReplyLoopState =
  | "delivered"
  | "review-pending"
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
  /** Present when the agent requested a native Discord poll via marker. */
  readonly poll?: INeonCanaryReplyPollResult;
  /** Present when the agent requested a rich card via marker. */
  readonly card?: INeonCanaryReplyPollResult;
  /**
   * Quick-reply labels the agent requested via marker. The loop only strips
   * and reports them — presenting buttons needs the component-action registry,
   * which lives with the tap, not here.
   */
  readonly buttons?: readonly string[];
  /** Present when an agent paused a clarified task behind the explicit plan approval gate. */
  readonly planApproval?: {
    readonly planText: string;
  };
}

export interface INeonCanaryReplyPollResult {
  readonly sent: boolean;
  readonly messageId?: string;
}

export interface IDeliverNeonCanaryReplyForRunOptions {
  readonly run: INeonGatewayShadowRun;
  readonly sender: INeonOutboundSender;
  readonly replyMode?: TNeonCanaryReplyMode;
  readonly projectRoot?: string;
  readonly pdfReview?: INeonPdfReviewRuntime;
  readonly voiceReply?: INeonDiscordVoiceReplyOptions;
}

export async function deliverNeonCanaryReplyForRun(
  options: IDeliverNeonCanaryReplyForRunOptions
): Promise<INeonCanaryReplyLoopResult> {
  const target = resolveCanaryReplyTarget(options.run, options.replyMode ?? "reply");
  // Agent-authored markers (poll, card, buttons) ride inside finalText; strip
  // them before any formatting/media work so raw marker syntax can never reach
  // Discord. Each parser runs on the previous parser's stripped remainder.
  const parsedPollMarker = parseNeonDiscordPollMarker(options.run.finalText.trim());
  const parsedCardMarker = parseNeonDiscordCardMarker(parsedPollMarker.text);
  const parsedButtonsMarker = parseNeonDiscordButtonsMarker(parsedCardMarker.text);
  const parsedPlanApprovalMarker = parseNeonDiscordPlanApprovalMarker(parsedButtonsMarker.text);
  const text = parsedPlanApprovalMarker.text;
  const poll = parsedPollMarker.poll;
  const card = parsedCardMarker.card;
  const buttons = parsedButtonsMarker.buttons;
  const planApproval = parsedPlanApprovalMarker.planApproval;

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

  if (text.length === 0 && !poll && !card) {
    return {
      state: "skipped",
      runId: options.run.runId,
      outboundSent: false,
      target,
      bodyPreview: "",
      reason: "empty-final-text"
    };
  }

  // Marker-only reply: the agent answered with nothing but poll/card markers.
  // Neither needs a text body, so deliver just the marker payloads.
  if (text.length === 0) {
    const pollResult = poll ? await deliverCanaryReplyPoll(options, target, poll) : undefined;
    const cardResult = card ? await deliverCanaryReplyCard(options, target, card) : undefined;
    const sentAny = pollResult?.sent === true || cardResult?.sent === true;
    const previewSource = poll ? `poll: ${poll.question}` : `card: ${card?.title ?? "embed"}`;
    const messageId = pollResult?.messageId ?? cardResult?.messageId;
    return {
      state: sentAny ? "delivered" : "suppressed",
      runId: options.run.runId,
      outboundSent: sentAny,
      target,
      bodyPreview: redactText(previewSource).slice(0, 280),
      ...(messageId ? { messageId } : {}),
      ...(pollResult ? { poll: pollResult } : {}),
      ...(cardResult ? { card: cardResult } : {}),
      ...(sentAny && buttons ? { buttons } : {}),
      ...(pollResult || cardResult ? {} : { reason: "marker-sender-unavailable" })
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
    if (options.pdfReview) {
      const review = await options.pdfReview.startReview({
        run: options.run,
        target,
        attachedFiles: media.attachedFiles
      });
      if (review.state === "review-pending") {
        return {
          state: "review-pending",
          runId: options.run.runId,
          outboundSent: true,
          target,
          bodyPreview: redactText(formattedText).slice(0, 280),
          messageId: review.messageId,
          reason: "pdf-review-pending"
        };
      }
      if (review.state === "blocked") {
        return {
          state: "skipped",
          runId: options.run.runId,
          outboundSent: false,
          target,
          bodyPreview: redactText(formattedText).slice(0, 280),
          reason: review.reason
        };
      }
    }
    const sendMedia = attachments.length > 0 && options.sender.sendMedia !== undefined;
    const kind = sendMedia ? "media" : "text";
    const send = async (deliveryTarget: INeonDeliveryQueueTarget): Promise<INeonOutboundSendResult> =>
      sendMedia && options.sender.sendMedia
        ? await options.sender.sendMedia(deliveryTarget, formattedText, attachments)
        : await options.sender.sendText(deliveryTarget, formattedText);

    if (!options.projectRoot) {
      const directResult = projectCanaryReplySendResult(options.run.runId, target, await send(target));
      return await attachCanaryReplyMarkers(
        directResult,
        options,
        target,
        poll,
        card,
        buttons,
        planApproval
      );
    }

    const payloadHash = createNeonDeliveryPayloadHash([
      target.accountId,
      target.channelId,
      target.threadId ?? "main",
      target.replyToMessageId ?? "none",
      formattedText,
      ...(sendMedia
        ? attachments.flatMap((attachment) => [
            attachment.name,
            attachment.contentType ?? "application/octet-stream",
            "data" in attachment ? attachment.data : attachment.url
          ])
        : [])
    ]);
    const result = await executeNeonExactlyOnceDelivery({
      projectRoot: options.projectRoot,
      intentId: createNeonDeliveryIntentId(options.run.runId, target, kind),
      runId: options.run.runId,
      kind,
      target,
      payloadHash,
      send
    });
    return await attachCanaryReplyMarkers(
      projectExactlyOnceReplyResult(options.run.runId, target, formattedText, result),
      options,
      target,
      poll,
      card,
      buttons,
      planApproval
    );
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

/**
 * Send the agent-requested marker payloads (poll, card) after a delivered text
 * reply. Marker failures are isolated on purpose: the text is already out, so
 * a marker transport error must never retro-mark the reply as failed.
 */
async function attachCanaryReplyMarkers(
  result: INeonCanaryReplyLoopResult,
  options: IDeliverNeonCanaryReplyForRunOptions,
  target: INeonDeliveryQueueTarget,
  poll: INeonDiscordPoll | undefined,
  card: INeonDiscordEmbed | undefined,
  buttons: readonly string[] | undefined,
  planApproval: INeonCanaryReplyLoopResult["planApproval"]
): Promise<INeonCanaryReplyLoopResult> {
  if ((!poll && !card && !buttons && !planApproval) || result.state !== "delivered") {
    return result;
  }
  const pollResult = poll ? await deliverCanaryReplyPoll(options, target, poll) : undefined;
  const cardResult = card ? await deliverCanaryReplyCard(options, target, card) : undefined;
  return {
    ...result,
    ...(pollResult ? { poll: pollResult } : {}),
    ...(cardResult ? { card: cardResult } : {}),
    ...(buttons ? { buttons } : {}),
    ...(planApproval ? { planApproval } : {})
  };
}

async function deliverCanaryReplyCard(
  options: IDeliverNeonCanaryReplyForRunOptions,
  target: INeonDeliveryQueueTarget,
  card: INeonDiscordEmbed
): Promise<INeonCanaryReplyPollResult | undefined> {
  const sendEmbeds = options.sender.sendEmbeds?.bind(options.sender);
  if (!sendEmbeds) {
    return undefined;
  }

  try {
    if (!options.projectRoot) {
      const sent = await sendEmbeds(target, [card]);
      return sent.outboundSent ? { sent: true, messageId: sent.messageId } : { sent: false };
    }

    const payloadHash = createNeonDeliveryPayloadHash([
      target.accountId,
      target.channelId,
      target.threadId ?? "main",
      card.title ?? "",
      card.description ?? "",
      String(card.color ?? ""),
      card.imageUrl ?? ""
    ]);
    const result = await executeNeonExactlyOnceDelivery({
      projectRoot: options.projectRoot,
      intentId: createNeonDeliveryIntentId(options.run.runId, target, "embed"),
      runId: options.run.runId,
      kind: "embed",
      target,
      payloadHash,
      send: (deliveryTarget) => sendEmbeds(deliveryTarget, [card])
    });
    return result.state === "delivered" || result.state === "already-delivered"
      ? { sent: true, ...(result.messageId ? { messageId: result.messageId } : {}) }
      : { sent: false };
  } catch {
    return { sent: false };
  }
}

async function deliverCanaryReplyPoll(
  options: IDeliverNeonCanaryReplyForRunOptions,
  target: INeonDeliveryQueueTarget,
  poll: INeonDiscordPoll
): Promise<INeonCanaryReplyPollResult | undefined> {
  const sendPoll = options.sender.sendPoll?.bind(options.sender);
  if (!sendPoll) {
    return undefined;
  }

  try {
    if (!options.projectRoot) {
      const sent = await sendPoll(target, poll);
      return sent.outboundSent ? { sent: true, messageId: sent.messageId } : { sent: false };
    }

    const payloadHash = createNeonDeliveryPayloadHash([
      target.accountId,
      target.channelId,
      target.threadId ?? "main",
      poll.question,
      String(poll.durationHours),
      poll.allowMultiselect === true ? "multi" : "single",
      ...poll.answers.map((answer) => answer.text)
    ]);
    const result = await executeNeonExactlyOnceDelivery({
      projectRoot: options.projectRoot,
      intentId: createNeonDeliveryIntentId(options.run.runId, target, "poll"),
      runId: options.run.runId,
      kind: "poll",
      target,
      payloadHash,
      send: (deliveryTarget) => sendPoll(deliveryTarget, poll)
    });
    return result.state === "delivered" || result.state === "already-delivered"
      ? { sent: true, ...(result.messageId ? { messageId: result.messageId } : {}) }
      : { sent: false };
  } catch {
    return { sent: false };
  }
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

function shouldCreateVoiceReply(
  run: INeonGatewayShadowRun,
  options: INeonDiscordVoiceReplyOptions | undefined
): boolean {
  if (!options || options.mode === "off") {
    return false;
  }

  return run.request.requestedVoiceReply === true;
}

function projectExactlyOnceReplyResult(
  runId: string,
  target: INeonDeliveryQueueTarget,
  formattedText: string,
  result: INeonExactlyOnceDeliveryResult
): INeonCanaryReplyLoopResult {
  const bodyPreview = redactText(formattedText).slice(0, 280);
  if (result.state === "delivered" && result.outboundSent && result.messageId) {
    return {
      state: "delivered",
      runId,
      outboundSent: true,
      target,
      bodyPreview,
      messageId: result.messageId
    };
  }

  if (result.state === "suppressed") {
    return {
      state: "suppressed",
      runId,
      outboundSent: false,
      target,
      bodyPreview,
      reason: result.reason ?? "canary-gate-closed"
    };
  }

  return {
    state: result.state === "transport-error" ? "transport-error" : "skipped",
    runId,
    outboundSent: false,
    target,
    bodyPreview,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    reason: result.reason ?? result.state
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
