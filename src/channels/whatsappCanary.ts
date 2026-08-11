import { createHash } from "node:crypto";

import {
  isNeonOutboundStage,
  readReadyCutoverEnv,
  resolveCutoverStageFromEnv,
  type TCutoverStageId
} from "../core/cutover.js";
import { loadNeonCutoverEnv } from "../core/cutoverPromotion.js";
import {
  createNeonDeliveryIntentId,
  createNeonDeliveryPayloadHash,
  executeNeonExactlyOnceDelivery,
  type TNeonExactlyOnceDeliveryState
} from "../gateway/deliveryReceiptStore.js";
import type { INeonDeliveryQueueTarget } from "../gateway/deliveryQueue.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";

export const neonWhatsAppCanaryCommandPrefix = "/neon" as const;
export const neonWhatsAppCanaryOutboundEnabledEnvKey =
  "NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED" as const;

export type TNeonWhatsAppCanaryCommandDecision =
  | { readonly state: "accepted"; readonly content: string }
  | {
      readonly state: "dropped";
      readonly reason: "command-prefix-required" | "empty-command";
    };

export type TNeonWhatsAppCanaryGateBlocker =
  | "whatsapp-canary-disabled"
  | "stage-not-outbound"
  | "canary-not-approved"
  | "outbound-disarmed";

export interface INeonWhatsAppCanaryGate {
  readonly ready: boolean;
  readonly stage: TCutoverStageId;
  readonly whatsappCanaryEnabled: boolean;
  readonly canaryApproved: boolean;
  readonly outboundArmed: boolean;
  readonly blockers: readonly TNeonWhatsAppCanaryGateBlocker[];
}

export interface IDeliverNeonWhatsAppCanaryReplyOptions {
  readonly projectRoot: string;
  readonly run: INeonGatewayShadowRun;
  readonly ownerPeerId: string;
  readonly liveEnv?: Readonly<Record<string, string | undefined>>;
  readonly sendText: (
    peerJid: string,
    body: string,
    messageId: string
  ) => Promise<{ readonly messageId: string }>;
  readonly loadCutoverEnv?: typeof loadNeonCutoverEnv;
  readonly now?: () => Date;
}

export interface INeonWhatsAppCanaryDeliveryResult {
  readonly state: TNeonExactlyOnceDeliveryState | "skipped";
  readonly runId: string;
  readonly outboundSent: boolean;
  readonly bodyPreview: string;
  readonly blockers: readonly TNeonWhatsAppCanaryGateBlocker[];
  readonly messageId?: string;
  readonly cutoverStage?: "canary" | "primary";
  readonly reason?: string;
}

const whatsappCanaryBodyMaxLength = 4_000;
const whatsappCanaryPreviewMaxLength = 280;

export function parseNeonWhatsAppCanaryCommand(
  value: string
): TNeonWhatsAppCanaryCommandDecision {
  const normalized = value.trim();
  if (
    normalized !== neonWhatsAppCanaryCommandPrefix &&
    !normalized.startsWith(`${neonWhatsAppCanaryCommandPrefix} `) &&
    !normalized.startsWith(`${neonWhatsAppCanaryCommandPrefix}\t`)
  ) {
    return { state: "dropped", reason: "command-prefix-required" };
  }
  const content = normalized.slice(neonWhatsAppCanaryCommandPrefix.length).trim();
  return content.length > 0
    ? { state: "accepted", content }
    : { state: "dropped", reason: "empty-command" };
}

export function resolveNeonWhatsAppCanaryGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonWhatsAppCanaryGate {
  const stage = resolveCutoverStageFromEnv(env);
  const whatsappCanaryEnabled =
    env[neonWhatsAppCanaryOutboundEnabledEnvKey]?.trim() === "ready";
  const canaryApproved = readReadyCutoverEnv(env, "NEON_CUTOVER_CANARY_APPROVED");
  const outboundArmed = readReadyCutoverEnv(env, "NEON_CUTOVER_OUTBOUND_ENABLED");
  const blockers: TNeonWhatsAppCanaryGateBlocker[] = [];
  if (!whatsappCanaryEnabled) {
    blockers.push("whatsapp-canary-disabled");
  }
  if (!isNeonOutboundStage(stage)) {
    blockers.push("stage-not-outbound");
  }
  if (!canaryApproved) {
    blockers.push("canary-not-approved");
  }
  if (!outboundArmed) {
    blockers.push("outbound-disarmed");
  }
  return {
    ready: blockers.length === 0,
    stage,
    whatsappCanaryEnabled,
    canaryApproved,
    outboundArmed,
    blockers
  };
}

export function createNeonWhatsAppCanaryMessageId(intentId: string): string {
  const normalized = intentId.trim();
  if (normalized.length < 1 || normalized.length > 1_000 || /[\r\n\0]/u.test(normalized)) {
    throw new Error("WhatsApp canary delivery intent id is invalid");
  }
  return `NEON${createHash("sha256").update(normalized).digest("hex").slice(0, 28).toUpperCase()}`;
}

export function isNeonWhatsAppCanaryMessageId(value: string): boolean {
  return /^NEON[A-F0-9]{28}$/u.test(value);
}

export async function deliverNeonWhatsAppCanaryReply(
  options: IDeliverNeonWhatsAppCanaryReplyOptions
): Promise<INeonWhatsAppCanaryDeliveryResult> {
  if (options.run.request.channel !== "whatsapp") {
    return skippedDelivery(options.run.runId, "unsupported-channel");
  }
  if (options.run.status !== "completed") {
    return skippedDelivery(options.run.runId, "run-not-completed");
  }
  const body = createWhatsAppCanaryBody(options.run.finalText);
  if (body.length === 0) {
    return skippedDelivery(options.run.runId, "empty-final-text");
  }

  const ownerJid = resolveOwnerJid(options.ownerPeerId);
  const target: INeonDeliveryQueueTarget = {
    channel: "whatsapp",
    accountId: options.run.request.accountId,
    channelId: options.run.request.channelId
  };
  const intentId = createNeonDeliveryIntentId(options.run.runId, target, "text");
  const payloadHash = createNeonDeliveryPayloadHash([
    target.accountId,
    target.channelId,
    neonWhatsAppCanaryCommandPrefix,
    body
  ]);
  let latestGate: INeonWhatsAppCanaryGate | undefined;
  const result = await executeNeonExactlyOnceDelivery({
    projectRoot: options.projectRoot,
    intentId,
    runId: options.run.runId,
    kind: "text",
    target,
    payloadHash,
    ...(options.now ? { now: options.now } : {}),
    send: async (deliveryTarget) => {
      const env = await (options.loadCutoverEnv ?? loadNeonCutoverEnv)(
        options.projectRoot,
        options.liveEnv ?? process.env
      );
      const gate = resolveNeonWhatsAppCanaryGate(env);
      latestGate = gate;
      if (!gate.ready || !isNeonOutboundStage(gate.stage)) {
        return {
          outboundSent: false,
          target: deliveryTarget,
          bodyPreview: createWhatsAppCanaryPreview(body),
          reason: "canary-gate-closed" as const,
          cutoverStage: gate.stage,
          attemptedAt: (options.now?.() ?? new Date()).toISOString()
        };
      }
      const deliveryIntentId = deliveryTarget.deliveryIntentId;
      if (!deliveryIntentId) {
        throw new Error("WhatsApp canary delivery intent is missing");
      }
      const messageId = createNeonWhatsAppCanaryMessageId(deliveryIntentId);
      const sent = await options.sendText(ownerJid, body, messageId);
      if (sent.messageId !== messageId) {
        throw new Error("WhatsApp canary transport returned an unexpected message id");
      }
      return {
        outboundSent: true,
        target: deliveryTarget,
        bodyPreview: createWhatsAppCanaryPreview(body),
        cutoverStage: gate.stage,
        messageId,
        sentAt: (options.now?.() ?? new Date()).toISOString()
      };
    }
  });

  return {
    state: result.state,
    runId: options.run.runId,
    outboundSent: result.outboundSent,
    bodyPreview: createWhatsAppCanaryPreview(body),
    blockers: latestGate?.blockers ?? [],
    ...(result.messageId ? { messageId: result.messageId } : {}),
    ...(result.cutoverStage ? { cutoverStage: result.cutoverStage } : {}),
    ...(result.reason ? { reason: result.reason } : {})
  };
}

function createWhatsAppCanaryBody(value: string): string {
  return truncateUtf16Safe(redactText(value).trim(), whatsappCanaryBodyMaxLength);
}

function createWhatsAppCanaryPreview(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return truncateUtf16Safe(compact, whatsappCanaryPreviewMaxLength);
}

function resolveOwnerJid(ownerPeerId: string): string {
  const normalized = ownerPeerId.trim();
  if (!/^\+[1-9]\d{7,14}$/u.test(normalized)) {
    throw new Error("WhatsApp canary owner must be an E.164 peer");
  }
  return `${normalized.slice(1)}@s.whatsapp.net`;
}

function skippedDelivery(
  runId: string,
  reason: string
): INeonWhatsAppCanaryDeliveryResult {
  return {
    state: "skipped",
    runId,
    outboundSent: false,
    bodyPreview: "",
    blockers: [],
    reason
  };
}
