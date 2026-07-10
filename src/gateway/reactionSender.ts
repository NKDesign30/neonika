import {
  isNeonOutboundStage,
  readReadyCutoverEnv,
  type TCutoverStageId,
  type TNeonOutboundStage
} from "../core/cutover.js";
import {
  isNeonCanaryChannelEligible,
  type INeonCanaryChannelAllowlist,
  type INeonCanaryOutboundGateFacts
} from "./outboundSender.js";
import type {
  INeonDeliveryQueueTarget,
  TNeonDeliveryAckState
} from "./deliveryQueue.js";

/**
 * Reaction-Sender-Vertrag für Neon Core.
 *
 * Schwester des Outbound-Senders (`outboundSender.ts`), aber für Emoji-
 * Reaktionen auf eine bestehende Nachricht statt Text-Posts. Der DryRunSender
 * erfüllt diesen Vertrag garantiert no-send: keine Discord-API, kein HTTP. Der
 * CanarySender KANN eine Reaktion setzen, tut es aber nur, wenn ein hartes Gate
 * (Stage, Approval, Aktivierungs-Flag, injizierter Transport, Channel-
 * Allowlist) vollständig erfüllt ist — und auch dann ausschließlich über den
 * injizierten Transport. Default ist immer no-send.
 */
export interface INeonReactionSender {
  setReaction(
    target: INeonDeliveryQueueTarget,
    messageId: string,
    emoji: string
  ): Promise<INeonReactionResult>;
}

/**
 * Ergebnis eines Reaction-Versuchs als diskriminierte Union über
 * `reactionSent`. Der no-send-Pfad (`reactionSent: false`) ist der Default; der
 * Sent-Pfad (`reactionSent: true`) entsteht ausschließlich, wenn der
 * CanarySender sein Gate vollständig erfüllt und über einen injizierten
 * Transport reagiert.
 */
export type INeonReactionResult =
  | INeonReactionSuppressedResult
  | INeonReactionSentResult;

/**
 * No-send-Resultat. `reactionSent` ist bewusst der Literal-Typ `false`: ein
 * versehentlich gesetztes `true` wäre hier ein Compile-Fehler.
 */
export interface INeonReactionSuppressedResult {
  readonly reactionSent: false;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly emoji: string;
  readonly reason:
    | "dry-run-no-send"
    | "canary-gate-closed"
    | "canary-channel-not-allowlisted";
  readonly cutoverStage: TCutoverStageId;
  readonly attemptedAt: string;
}

/**
 * Sent-Resultat. Entsteht nur, wenn der CanarySender sein Gate vollständig
 * erfüllt und über den injizierten Transport reagiert hat. Es wird kein Bot-
 * Token gespeichert oder geloggt.
 */
export interface INeonReactionSentResult {
  readonly reactionSent: true;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly emoji: string;
  readonly cutoverStage: TNeonOutboundStage;
  readonly sentAt: string;
}

/**
 * Injektions-Punkt für echtes Reagieren (z.B. Discord-REST `message.react`).
 * Der Transport bekommt nur die bereits normalisierte Emoji-Kennung. In diesem
 * Slice wird KEIN echter Transport mitgeliefert — der Default-Pfad bleibt
 * no-send.
 */
export interface INeonReactionTransport {
  addReaction(
    target: INeonDeliveryQueueTarget,
    messageId: string,
    emoji: string
  ): Promise<void>;
}

export interface INeonDryRunReactionSenderOptions {
  readonly now?: () => Date;
}

export interface INeonCanaryReactionSenderOptions {
  readonly now?: () => Date;
  /**
   * Echter Reaction-Transport. Ohne Transport kann der Sender konstruktiv NICHT
   * reagieren — das Gate bleibt verriegelt, egal welche Flags gesetzt sind.
   */
  readonly transport?: INeonReactionTransport;
  /**
   * Gate-Fakten. Wenn nicht gesetzt, werden sie aus `env` (Default
   * `process.env`) gelesen. So bleibt der Default-Pfad ohne explizite
   * Aktivierung no-send. Identischer Faktentyp wie der Outbound-Sender, damit
   * Reaction- und Text-Gate nie auseinanderlaufen.
   */
  readonly gateFacts?: INeonCanaryOutboundGateFacts;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optionale Canary-Channel-Allowlist. Wenn gesetzt, verlangt das Gate
   * ZUSÄTZLICH, dass `target.channelId` auf der Allowlist steht — so bleibt der
   * Canary-Blast-Radius auf explizit benannte Kanäle begrenzt.
   */
  readonly channelAllowlist?: INeonCanaryChannelAllowlist;
}

const reactionEmojiMaxLength = 64;
const reactionCutoverStageIds: readonly TCutoverStageId[] = [
  "shadow",
  "mirror",
  "canary",
  "primary",
  "retire"
];

/**
 * Default-Emoji pro Ack-Lebenszyklus-Zustand. Quelle: neon-cores eigenes
 * Ack-Modell (`deliveryQueue.ts` `TNeonDeliveryAckState`); Form 1:1 nach
 * Upstream projects Status-Reactions (Status -> Emoji). Bewusst klein gehalten auf die
 * drei Zustände, die neon-core wirklich modelliert.
 */
export const neonAckStateReactionEmojis: {
  readonly [state in TNeonDeliveryAckState]: string;
} = {
  queued: "👀",
  working: "⏳",
  done: "✅"
};

export function mapNeonAckStateToReactionEmoji(state: TNeonDeliveryAckState): string {
  return neonAckStateReactionEmojis[state];
}

/**
 * No-op Reaction-Sender. Reagiert NICHTS und gibt immer `reactionSent: false`
 * zurück.
 */
export function createNeonDryRunReactionSender(
  options: INeonDryRunReactionSenderOptions = {}
): INeonReactionSender {
  return {
    setReaction(target, messageId, emoji): Promise<INeonReactionResult> {
      const attemptedAt = (options.now?.() ?? new Date()).toISOString();

      return Promise.resolve({
        reactionSent: false,
        target,
        messageId,
        emoji: normalizeReactionEmoji(emoji),
        reason: "dry-run-no-send",
        cutoverStage: "shadow",
        attemptedAt
      });
    }
  };
}

/**
 * Gated Reaction-Sender. KANN reagieren, tut es aber nur, wenn ALLE Bedingungen
 * erfüllt sind:
 *   1. cutoverStage === "canary",
 *   2. canaryApproved === true (NEON_CUTOVER_CANARY_APPROVED),
 *   3. outboundEnabled === true (NEON_CUTOVER_OUTBOUND_ENABLED),
 *   4. (falls Allowlist gesetzt) target.channelId ist eligible,
 *   5. ein Transport ist injiziert.
 * Fehlt auch nur eine, liefert er ein no-send-Resultat. Es gibt keinen anderen
 * Reaktions-Pfad: ohne Transport ist Reagieren konstruktiv unmöglich.
 */
export function createNeonCanaryReactionSender(
  options: INeonCanaryReactionSenderOptions = {}
): INeonReactionSender {
  const transport = options.transport;
  const resolveGateFacts = createReactionGateFactsResolver(options);

  return {
    async setReaction(target, messageId, emoji): Promise<INeonReactionResult> {
      const now = options.now?.() ?? new Date();
      const normalizedEmoji = normalizeReactionEmoji(emoji);
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
          reactionSent: false,
          target,
          messageId,
          emoji: normalizedEmoji,
          reason: !channelAllowed
            ? "canary-channel-not-allowlisted"
            : "canary-gate-closed",
          cutoverStage: stage,
          attemptedAt: now.toISOString()
        };
      }

      await transport.addReaction(target, messageId, normalizedEmoji);

      return {
        reactionSent: true,
        target,
        messageId,
        emoji: normalizedEmoji,
        cutoverStage: stage,
        sentAt: now.toISOString()
      };
    }
  };
}

/**
 * Verdrahtet einen Ack-Lebenszyklus-Zustand durch den Reaction-Sender: mappt
 * den Zustand auf sein Default-Emoji und setzt es über `setReaction`. Mit dem
 * DryRunSender trägt das Ergebnis `reactionSent: false`. Dies ist der
 * Konsumenten-Vertrag, an dem die Ack-Lifecycle (queued/working/done) später
 * echte Status-Reaktionen aufhängen kann.
 */
export function reactNeonAckState(
  sender: INeonReactionSender,
  target: INeonDeliveryQueueTarget,
  messageId: string,
  state: TNeonDeliveryAckState
): Promise<INeonReactionResult> {
  return sender.setReaction(target, messageId, mapNeonAckStateToReactionEmoji(state));
}

function createReactionGateFactsResolver(
  options: INeonCanaryReactionSenderOptions
): () => INeonCanaryOutboundGateFacts {
  if (options.gateFacts) {
    const facts = options.gateFacts;
    return () => facts;
  }

  const env = options.env ?? process.env;

  return () => ({
    cutoverStage: readReactionCutoverStage(env),
    canaryApproved: readReadyCutoverEnv(env, "NEON_CUTOVER_CANARY_APPROVED"),
    outboundEnabled: readReadyCutoverEnv(env, "NEON_CUTOVER_OUTBOUND_ENABLED")
  });
}

function readReactionCutoverStage(
  env: Readonly<Record<string, string | undefined>>
): TCutoverStageId {
  const stage = env["NEON_CUTOVER_STAGE"]?.trim();

  if (stage && reactionCutoverStageIds.includes(stage as TCutoverStageId)) {
    return stage as TCutoverStageId;
  }

  return "shadow";
}

function normalizeReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();

  if (trimmed.length <= reactionEmojiMaxLength) {
    return trimmed;
  }

  return trimmed.slice(0, reactionEmojiMaxLength);
}
