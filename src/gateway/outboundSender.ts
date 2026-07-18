import {
  isNeonOutboundStage,
  readReadyCutoverEnv,
  type TCutoverStageId,
  type TNeonOutboundStage
} from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import type {
  INeonDeliveryQueueCandidate,
  INeonDeliveryQueueTarget
} from "./deliveryQueue.js";
import { formatNeonDiscordReplyText } from "./discordReplyFormat.js";
import type { TNeonDiscordMediaAttachment } from "./discordMediaPayload.js";

/**
 * Outbound-Sender-Vertrag für Neonika.
 *
 * Dies ist die Andock-Stelle, an der echtes Discord-Outbound hängen kann. Der
 * DryRunSender erfüllt diesen Vertrag garantiert no-send: kein fetch, kein
 * HTTP, keine Discord-API. Der CanarySender KANN senden, tut es aber nur, wenn
 * ein hartes Gate (Stage, Approval, Aktivierungs-Flag, injizierter Transport)
 * vollständig erfüllt ist — und auch dann ausschließlich über den injizierten
 * Transport. Default ist immer no-send.
 */
export interface INeonOutboundSender {
  sendText(
    target: INeonDeliveryQueueTarget,
    message: string
  ): Promise<INeonOutboundSendResult>;
  sendMedia?(
    target: INeonDeliveryQueueTarget,
    message: string | undefined,
    attachments: readonly TNeonDiscordMediaAttachment[]
  ): Promise<INeonOutboundSendResult>;
}

/**
 * Ergebnis eines Outbound-Send-Versuchs als diskriminierte Union über
 * `outboundSent`. Der no-send-Pfad (`outboundSent: false`) ist der Default; der
 * Sent-Pfad (`outboundSent: true`) entsteht ausschließlich, wenn der
 * CanarySender sein Gate vollständig erfüllt und über einen injizierten
 * Transport sendet.
 */
export type INeonOutboundSendResult =
  | INeonOutboundSuppressedResult
  | INeonOutboundSentResult;

/**
 * No-send-Resultat. Bestehende Form des DryRun-Pfades, erweitert um den Grund
 * `canary-gate-closed`, mit dem der CanarySender ein verriegeltes Gate meldet.
 * `outboundSent` ist bewusst der Literal-Typ `false`: ein versehentlich gesetztes
 * `true` wäre hier ein Compile-Fehler.
 */
export interface INeonOutboundSuppressedResult {
  readonly outboundSent: false;
  readonly target: INeonDeliveryQueueTarget;
  readonly bodyPreview: string;
  readonly reason: "dry-run-no-send" | "canary-gate-closed" | "canary-channel-not-allowlisted";
  readonly cutoverStage: TCutoverStageId;
  readonly attemptedAt: string;
}

/**
 * Sent-Resultat. Entsteht nur, wenn der CanarySender sein Gate vollständig
 * erfüllt und über den injizierten Transport gesendet hat. `messageId` stammt
 * ausschließlich vom Transport; es wird kein Bot-Token gespeichert oder geloggt.
 */
export interface INeonOutboundSentResult {
  readonly outboundSent: true;
  readonly target: INeonDeliveryQueueTarget;
  readonly bodyPreview: string;
  readonly cutoverStage: TNeonOutboundStage;
  readonly messageId: string;
  readonly sentAt: string;
}

/**
 * Injektions-Punkt für echtes Outbound (z.B. Discord-HTTP). Der Transport
 * bekommt nur das bereits redigierte/gekürzte `body` und liefert die
 * `messageId` des gesendeten Posts zurück. In diesem Slice wird KEIN echter
 * Transport mitgeliefert — der Default-Pfad bleibt no-send.
 */
export interface INeonOutboundTransport {
  postMessage(
    target: INeonDeliveryQueueTarget,
    body: string
  ): Promise<{ readonly messageId: string }>;
  postMedia?(
    target: INeonDeliveryQueueTarget,
    body: string | undefined,
    attachments: readonly TNeonDiscordMediaAttachment[]
  ): Promise<{ readonly messageId: string }>;
}

export interface INeonDryRunOutboundSenderOptions {
  readonly now?: () => Date;
  readonly bodyPreviewMaxLength?: number;
}

/**
 * Fakten, gegen die das Canary-Gate auswertet. Werden injiziert (Tests) oder aus
 * der Umgebung gelesen (Default), nie hartkodiert auf "offen".
 */
export interface INeonCanaryOutboundGateFacts {
  readonly cutoverStage: TCutoverStageId;
  readonly canaryApproved: boolean;
  readonly outboundEnabled: boolean;
}

const canaryChannelsEnvKey = "NEON_CUTOVER_CANARY_CHANNELS";

/**
 * Read-only Canary-Channel-Allowlist. Liest `NEON_CUTOVER_CANARY_CHANNELS`
 * (komma-separierte Channel-IDs) in ein Set. Default ist LEER = kein Kanal
 * eligible, damit der Canary-Blast-Radius pro Kanal explizit opt-in ist und nie
 * implizit. Reine Lese-Auswertung — kein Send, keine Mutation.
 */
export interface INeonCanaryChannelAllowlist {
  readonly channels: ReadonlySet<string>;
  readonly configured: boolean;
}

export function resolveNeonCanaryChannelAllowlist(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCanaryChannelAllowlist {
  const channels = new Set(
    (env[canaryChannelsEnvKey] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  return { channels, configured: channels.size > 0 };
}

export function isNeonCanaryChannelEligible(
  channelId: string,
  allowlist: INeonCanaryChannelAllowlist
): boolean {
  return allowlist.channels.has(channelId);
}

const canaryBotTokenEnvKey = "NEON_DISCORD_BOT_TOKEN";
const canaryStageEnvKey = "NEON_CUTOVER_STAGE";
const canaryApprovedEnvKey = "NEON_CUTOVER_CANARY_APPROVED";
const canaryOutboundEnabledEnvKey = "NEON_CUTOVER_OUTBOUND_ENABLED";

/**
 * Leak-safe evaluation of whether real canary outbound sends are allowed for
 * explicitly allowlisted channels. Returns only booleans plus the resolved
 * single channel id when there is exactly one (a channel id is not a secret).
 * The bot token is checked for presence only — its value is never returned,
 * logged, or persisted. `ready` is true only when ALL global preconditions hold;
 * the per-channel blast radius remains enforced by `channelAllowlist` in the
 * sender.
 */
export interface INeonCanaryLivePreconditions {
  readonly tokenPresent: boolean;
  readonly channelConfigured: boolean;
  readonly singleChannel: boolean;
  readonly stageIsCanary: boolean;
  /**
   * True when the current cutover stage is allowed to send real outbound
   * traffic (canary or primary). Distinct from `stageIsCanary`, which stays an
   * exact `stage === "canary"` check: `ready` derives from this field so the
   * live transport stays open once the runtime is promoted from canary to
   * primary.
   */
  readonly stageAllowsOutbound: boolean;
  readonly canaryApproved: boolean;
  readonly outboundEnabled: boolean;
  readonly channelId?: string;
  readonly ready: boolean;
}

export function evaluateNeonCanaryLivePreconditions(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCanaryLivePreconditions {
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelIds = [...allowlist.channels];
  const singleChannel = channelIds.length === 1;
  const channelId = singleChannel ? channelIds[0] : undefined;

  const tokenPresent = Boolean((env[canaryBotTokenEnvKey] ?? "").trim());
  const stage = env[canaryStageEnvKey];
  const stageIsCanary = stage === "canary";
  const stageAllowsOutbound = stage === "canary" || stage === "primary";
  // Same readiness convention as the canary sender's gate facts: accepts
  // ready/true/1/yes, so the precondition can never disagree with the sender.
  const canaryApproved = readReadyCutoverEnv(env, canaryApprovedEnvKey);
  const outboundEnabled = readReadyCutoverEnv(env, canaryOutboundEnabledEnvKey);

  const ready =
    tokenPresent &&
    allowlist.configured &&
    stageAllowsOutbound &&
    canaryApproved &&
    outboundEnabled;

  return {
    tokenPresent,
    channelConfigured: allowlist.configured,
    singleChannel,
    stageIsCanary,
    stageAllowsOutbound,
    canaryApproved,
    outboundEnabled,
    ...(channelId ? { channelId } : {}),
    ready
  };
}

export interface INeonCanaryOutboundSenderOptions {
  readonly now?: () => Date;
  readonly bodyPreviewMaxLength?: number;
  /**
   * Optional maximum for the actual redacted body handed to the live transport.
   * This is separate from `bodyPreviewMaxLength`: previews stay short for state
   * and logs, while live Discord replies should not be silently cut to preview
   * length. Discord transport still chunks at platform limits.
   */
  readonly bodyMaxLength?: number;
  /**
   * Echter Sende-Transport. Ohne Transport kann der Sender konstruktiv NICHT
   * senden — das Gate bleibt verriegelt, egal welche Flags gesetzt sind.
   */
  readonly transport?: INeonOutboundTransport;
  /**
   * Gate-Fakten. Wenn nicht gesetzt, werden sie aus `env` (Default `process.env`)
   * gelesen. So bleibt der Default-Pfad ohne explizite Aktivierung no-send.
   */
  readonly gateFacts?: INeonCanaryOutboundGateFacts;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optionale Canary-Channel-Allowlist. Wenn gesetzt, verlangt das Gate
   * ZUSÄTZLICH, dass `target.channelId` auf der Allowlist steht — so bleibt der
   * Canary-Blast-Radius auf explizit benannte Kanäle begrenzt. Nicht gesetzt =
   * keine Kanal-Einschränkung (bestehendes Verhalten).
   */
  readonly channelAllowlist?: INeonCanaryChannelAllowlist;
}

const outboundBodyPreviewMaxLength = 280;
const outboundBodyMaxLength = 16_000;
const cutoverStageIds: readonly TCutoverStageId[] = [
  "shadow",
  "mirror",
  "canary",
  "primary",
  "retire"
];

/**
 * No-op Outbound-Sender. Sendet NICHTS und gibt immer `outboundSent: false`
 * zurück. Der Rohtext wird nie gespeichert oder geloggt: `bodyPreview` wird
 * durch `redactText` gereinigt und auf eine kurze Vorschau gekürzt.
 */
export function createNeonDryRunOutboundSender(
  options: INeonDryRunOutboundSenderOptions = {}
): INeonOutboundSender {
  const maxLength = resolveBodyPreviewMaxLength(options.bodyPreviewMaxLength);

  return {
    sendText(target, message): Promise<INeonOutboundSendResult> {
      const attemptedAt = (options.now?.() ?? new Date()).toISOString();

      return Promise.resolve({
        outboundSent: false,
        target,
        bodyPreview: createOutboundBodyPreview(message, maxLength),
        reason: "dry-run-no-send",
        cutoverStage: "shadow",
        attemptedAt
      });
    },
    sendMedia(target, message): Promise<INeonOutboundSendResult> {
      const attemptedAt = (options.now?.() ?? new Date()).toISOString();
      const previewSource = message ?? "media attachment";

      return Promise.resolve({
        outboundSent: false,
        target,
        bodyPreview: createOutboundBodyPreview(previewSource, maxLength),
        reason: "dry-run-no-send",
        cutoverStage: "shadow",
        attemptedAt
      });
    }
  };
}

/**
 * Gated Outbound-Sender. KANN senden, sendet aber nur, wenn ALLE vier
 * Bedingungen erfüllt sind:
 *   1. cutoverStage === "canary",
 *   2. canaryApproved === true (NEON_CUTOVER_CANARY_APPROVED),
 *   3. outboundEnabled === true (NEON_CUTOVER_OUTBOUND_ENABLED),
 *   4. ein Transport ist injiziert.
 * Fehlt auch nur eine, liefert er ein no-send-Resultat mit
 * `reason: "canary-gate-closed"`. Es gibt keinen anderen Sende-Pfad: ohne
 * Transport ist Senden konstruktiv unmöglich. `bodyPreview` ist immer redigiert
 * und gekürzt; der Transport bekommt den redigierten, aber nicht auf Preview-
 * Länge gekürzten Text, damit echte Canary-Replies nicht amputiert werden.
 */
export function createNeonCanaryOutboundSender(
  options: INeonCanaryOutboundSenderOptions = {}
): INeonOutboundSender {
  const maxLength = resolveBodyPreviewMaxLength(options.bodyPreviewMaxLength);
  const bodyMaxLength = resolveOutboundBodyMaxLength(options.bodyMaxLength);
  const transport = options.transport;
  const resolveGateFacts = createGateFactsResolver(options);

  return {
    async sendText(target, message): Promise<INeonOutboundSendResult> {
      const now = options.now?.() ?? new Date();
      const bodyPreview = createOutboundBodyPreview(message, maxLength);
      const transportBody = createOutboundBody(message, bodyMaxLength);
      const facts = resolveGateFacts();
      const stage = facts.cutoverStage;
      const channelAllowed =
        !options.channelAllowlist ||
        isNeonCanaryChannelEligible(target.channelId, options.channelAllowlist);
      const gateOpen =
        isNeonOutboundStage(stage) &&
        facts.canaryApproved === true &&
        facts.outboundEnabled === true &&
        channelAllowed &&
        Boolean(transport);

      if (!gateOpen || !transport || !isNeonOutboundStage(stage)) {
        return {
          outboundSent: false,
          target,
          bodyPreview,
          reason: !channelAllowed ? "canary-channel-not-allowlisted" : "canary-gate-closed",
          cutoverStage: stage,
          attemptedAt: now.toISOString()
        };
      }

      const delivered = await transport.postMessage(target, transportBody);

      return {
        outboundSent: true,
        target,
        bodyPreview,
        cutoverStage: stage,
        messageId: delivered.messageId,
        sentAt: now.toISOString()
      };
    },

    async sendMedia(
      target,
      message,
      attachments
    ): Promise<INeonOutboundSendResult> {
      const now = options.now?.() ?? new Date();
      const previewSource = message ?? "media attachment";
      const bodyPreview = createOutboundBodyPreview(previewSource, maxLength);
      const transportBody =
        message !== undefined && message.trim().length > 0 ? createOutboundBody(message, bodyMaxLength) : undefined;
      const facts = resolveGateFacts();
      const stage = facts.cutoverStage;
      const channelAllowed =
        !options.channelAllowlist ||
        isNeonCanaryChannelEligible(target.channelId, options.channelAllowlist);
      const gateOpen =
        isNeonOutboundStage(stage) &&
        facts.canaryApproved === true &&
        facts.outboundEnabled === true &&
        channelAllowed &&
        Boolean(transport?.postMedia);

      if (!gateOpen || !transport?.postMedia || !isNeonOutboundStage(stage)) {
        return {
          outboundSent: false,
          target,
          bodyPreview,
          reason: !channelAllowed ? "canary-channel-not-allowlisted" : "canary-gate-closed",
          cutoverStage: stage,
          attemptedAt: now.toISOString()
        };
      }

      const delivered = await transport.postMedia(target, transportBody, attachments);

      return {
        outboundSent: true,
        target,
        bodyPreview,
        cutoverStage: stage,
        messageId: delivered.messageId,
        sentAt: now.toISOString()
      };
    }
  };
}

/**
 * Verdrahtet einen bestehenden Delivery-Kandidaten durch den Outbound-Sender.
 *
 * Reine Funktion über den Sender-Vertrag: nimmt das bereits redigierte
 * `finalTextPreview` des Kandidaten und schickt es durch `sendText`. Mit dem
 * DryRunSender trägt das Ergebnis `outboundSent: false`.
 */
export function deliverNeonDeliveryDryRunCandidate(
  sender: INeonOutboundSender,
  candidate: INeonDeliveryQueueCandidate
): Promise<INeonOutboundSendResult> {
  return sender.sendText(candidate.target, candidate.finalTextPreview);
}

function createGateFactsResolver(
  options: INeonCanaryOutboundSenderOptions
): () => INeonCanaryOutboundGateFacts {
  if (options.gateFacts) {
    const facts = options.gateFacts;
    return () => facts;
  }

  const env = options.env ?? process.env;

  return () => ({
    cutoverStage: readCutoverStage(env),
    canaryApproved: readReadyCutoverEnv(env, "NEON_CUTOVER_CANARY_APPROVED"),
    outboundEnabled: readReadyCutoverEnv(env, "NEON_CUTOVER_OUTBOUND_ENABLED")
  });
}

function readCutoverStage(env: Readonly<Record<string, string | undefined>>): TCutoverStageId {
  const stage = env["NEON_CUTOVER_STAGE"]?.trim();

  if (stage && cutoverStageIds.includes(stage as TCutoverStageId)) {
    return stage as TCutoverStageId;
  }

  return "shadow";
}

function resolveBodyPreviewMaxLength(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return outboundBodyPreviewMaxLength;
  }

  return Math.floor(value);
}

function resolveOutboundBodyMaxLength(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return outboundBodyMaxLength;
  }

  return Math.floor(value);
}

function createOutboundBodyPreview(message: string, maxLength: number): string {
  const preview = createOutboundBody(message, outboundBodyMaxLength).replace(/\s+/gu, " ").trim();
  return truncateText(preview, maxLength);
}

function createOutboundBody(message: string, maxLength: number): string {
  const redacted = redactText(message);
  const formatted = formatNeonDiscordReplyText(redacted).trim();

  return truncateText(formatted, maxLength);
}

function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 1 && value.length > maxLength) {
    return "…";
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${truncateUtf16Safe(value, maxLength - 1)}…`;
}
