import {
  isNeonOutboundStage,
  readReadyCutoverEnv,
  type TCutoverStageId,
  type TNeonOutboundStage
} from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";
import {
  isNeonCanaryChannelEligible,
  type INeonCanaryChannelAllowlist,
  type INeonCanaryOutboundGateFacts
} from "./outboundSender.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";

/**
 * Message-Edit/Delete-Sender-Vertrag für Neonika.
 *
 * Schwester von `outboundSender.ts` / `reactionSender.ts`, aber für das Ändern
 * bzw. Löschen einer bereits gesendeten Bot-Nachricht. Der DryRunSender erfüllt
 * diesen Vertrag garantiert no-send: keine Discord-API, kein HTTP. Der
 * CanarySender KANN editieren/löschen, tut es aber nur, wenn ein hartes Gate
 * (Stage, Approval, Aktivierungs-Flag, injizierter Transport, Channel-
 * Allowlist) vollständig erfüllt ist — und auch dann ausschließlich über den
 * injizierten Transport. Default ist immer no-send.
 *
 * Vorlage: upstream `extensions/discord/src/send.messages.ts`
 * (`editMessageDiscord`, `deleteMessageDiscord`) + `internal/api.messages.ts`
 * (`editChannelMessage`, `deleteChannelMessage`).
 */
export interface INeonMessageEditSender {
  editMessage(
    target: INeonDeliveryQueueTarget,
    messageId: string,
    body: string
  ): Promise<INeonMessageEditResult>;
  deleteMessage(
    target: INeonDeliveryQueueTarget,
    messageId: string
  ): Promise<INeonMessageDeleteResult>;
}

export type TNeonMessageMutationSuppressReason =
  | "dry-run-no-send"
  | "canary-gate-closed"
  | "canary-channel-not-allowlisted";

export type INeonMessageEditResult =
  | INeonMessageEditSuppressedResult
  | INeonMessageEditSentResult;

export interface INeonMessageEditSuppressedResult {
  readonly editSent: false;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly bodyPreview: string;
  readonly reason: TNeonMessageMutationSuppressReason;
  readonly cutoverStage: TCutoverStageId;
  readonly attemptedAt: string;
}

export interface INeonMessageEditSentResult {
  readonly editSent: true;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly bodyPreview: string;
  readonly cutoverStage: TNeonOutboundStage;
  readonly editedAt: string;
}

export type INeonMessageDeleteResult =
  | INeonMessageDeleteSuppressedResult
  | INeonMessageDeleteSentResult;

export interface INeonMessageDeleteSuppressedResult {
  readonly deleteSent: false;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly reason: TNeonMessageMutationSuppressReason;
  readonly cutoverStage: TCutoverStageId;
  readonly attemptedAt: string;
}

export interface INeonMessageDeleteSentResult {
  readonly deleteSent: true;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly cutoverStage: TNeonOutboundStage;
  readonly deletedAt: string;
}

/**
 * Injektions-Punkt für echtes Editieren/Löschen (z.B. Discord-REST PATCH/DELETE
 * `channelMessage`). Der Transport bekommt nur den bereits redigierten/gekürzten
 * Edit-Body. In diesem Slice wird KEIN echter Transport mitgeliefert — der
 * Default-Pfad bleibt no-send.
 */
export interface INeonMessageEditTransport {
  editMessage(
    target: INeonDeliveryQueueTarget,
    messageId: string,
    body: string
  ): Promise<void>;
  deleteMessage(target: INeonDeliveryQueueTarget, messageId: string): Promise<void>;
}

export interface INeonDryRunMessageEditSenderOptions {
  readonly now?: () => Date;
  readonly bodyPreviewMaxLength?: number;
}

export interface INeonCanaryMessageEditSenderOptions {
  readonly now?: () => Date;
  readonly bodyPreviewMaxLength?: number;
  /**
   * Echter Edit/Delete-Transport. Ohne Transport kann der Sender konstruktiv
   * NICHT mutieren — das Gate bleibt verriegelt, egal welche Flags gesetzt sind.
   */
  readonly transport?: INeonMessageEditTransport;
  /**
   * Gate-Fakten. Wenn nicht gesetzt, aus `env` (Default `process.env`) gelesen.
   * Identischer Faktentyp wie der Outbound-/Reaction-Sender, damit alle drei
   * Mutations-Gates nie auseinanderlaufen.
   */
  readonly gateFacts?: INeonCanaryOutboundGateFacts;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly channelAllowlist?: INeonCanaryChannelAllowlist;
}

const messageEditBodyPreviewMaxLength = 280;
const messageEditCutoverStageIds: readonly TCutoverStageId[] = [
  "shadow",
  "mirror",
  "canary",
  "primary",
  "retire"
];

/**
 * No-op Edit/Delete-Sender. Mutiert NICHTS und gibt immer `editSent:false` bzw.
 * `deleteSent:false` zurück. Der Edit-Body wird nie gespeichert oder geloggt:
 * `bodyPreview` wird durch `redactText` gereinigt und gekürzt.
 */
export function createNeonDryRunMessageEditSender(
  options: INeonDryRunMessageEditSenderOptions = {}
): INeonMessageEditSender {
  const maxLength = resolveMessageEditPreviewMaxLength(options.bodyPreviewMaxLength);

  return {
    editMessage(target, messageId, body): Promise<INeonMessageEditResult> {
      const attemptedAt = (options.now?.() ?? new Date()).toISOString();
      return Promise.resolve({
        editSent: false,
        target,
        messageId,
        bodyPreview: createMessageEditBodyPreview(body, maxLength),
        reason: "dry-run-no-send",
        cutoverStage: "shadow",
        attemptedAt
      });
    },
    deleteMessage(target, messageId): Promise<INeonMessageDeleteResult> {
      const attemptedAt = (options.now?.() ?? new Date()).toISOString();
      return Promise.resolve({
        deleteSent: false,
        target,
        messageId,
        reason: "dry-run-no-send",
        cutoverStage: "shadow",
        attemptedAt
      });
    }
  };
}

/**
 * Gated Edit/Delete-Sender. KANN mutieren, tut es aber nur, wenn ALLE
 * Bedingungen erfüllt sind: stage=canary + canaryApproved + outboundEnabled +
 * (falls Allowlist gesetzt) Channel eligible + injizierter Transport. Fehlt auch
 * nur eine, liefert er ein no-send-Resultat. Ohne Transport ist Mutieren
 * konstruktiv unmöglich.
 */
export function createNeonCanaryMessageEditSender(
  options: INeonCanaryMessageEditSenderOptions = {}
): INeonMessageEditSender {
  const maxLength = resolveMessageEditPreviewMaxLength(options.bodyPreviewMaxLength);
  const transport = options.transport;
  const resolveGateFacts = createMessageEditGateFactsResolver(options);

  const evaluateGate = (
    target: INeonDeliveryQueueTarget
  ):
    | { readonly open: true; readonly stage: TNeonOutboundStage }
    | { readonly open: false; readonly reason: TNeonMessageMutationSuppressReason } => {
    const facts = resolveGateFacts();
    const stage = facts.cutoverStage;
    const channelAllowed =
      !options.channelAllowlist ||
      isNeonCanaryChannelEligible(target.channelId, options.channelAllowlist);
    const open =
      isNeonOutboundStage(stage) &&
      facts.canaryApproved === true &&
      facts.outboundEnabled === true &&
      channelAllowed &&
      Boolean(transport);

    if (open && isNeonOutboundStage(stage)) {
      return { open: true, stage };
    }
    return {
      open: false,
      reason: !channelAllowed ? "canary-channel-not-allowlisted" : "canary-gate-closed"
    };
  };

  const resolveStage = (): TCutoverStageId => resolveGateFacts().cutoverStage;

  return {
    async editMessage(target, messageId, body): Promise<INeonMessageEditResult> {
      const now = options.now?.() ?? new Date();
      const bodyPreview = createMessageEditBodyPreview(body, maxLength);
      const gate = evaluateGate(target);

      if (!gate.open || !transport) {
        return {
          editSent: false,
          target,
          messageId,
          bodyPreview,
          reason: gate.open ? "canary-gate-closed" : gate.reason,
          cutoverStage: resolveStage(),
          attemptedAt: now.toISOString()
        };
      }

      await transport.editMessage(target, messageId, bodyPreview);

      return {
        editSent: true,
        target,
        messageId,
        bodyPreview,
        cutoverStage: gate.stage,
        editedAt: now.toISOString()
      };
    },
    async deleteMessage(target, messageId): Promise<INeonMessageDeleteResult> {
      const now = options.now?.() ?? new Date();
      const gate = evaluateGate(target);

      if (!gate.open || !transport) {
        return {
          deleteSent: false,
          target,
          messageId,
          reason: gate.open ? "canary-gate-closed" : gate.reason,
          cutoverStage: resolveStage(),
          attemptedAt: now.toISOString()
        };
      }

      await transport.deleteMessage(target, messageId);

      return {
        deleteSent: true,
        target,
        messageId,
        cutoverStage: gate.stage,
        deletedAt: now.toISOString()
      };
    }
  };
}

function createMessageEditGateFactsResolver(
  options: INeonCanaryMessageEditSenderOptions
): () => INeonCanaryOutboundGateFacts {
  if (options.gateFacts) {
    const facts = options.gateFacts;
    return () => facts;
  }

  const env = options.env ?? process.env;

  return () => ({
    cutoverStage: readMessageEditCutoverStage(env),
    canaryApproved: readReadyCutoverEnv(env, "NEON_CUTOVER_CANARY_APPROVED"),
    outboundEnabled: readReadyCutoverEnv(env, "NEON_CUTOVER_OUTBOUND_ENABLED")
  });
}

function readMessageEditCutoverStage(
  env: Readonly<Record<string, string | undefined>>
): TCutoverStageId {
  const stage = env["NEON_CUTOVER_STAGE"]?.trim();

  if (stage && messageEditCutoverStageIds.includes(stage as TCutoverStageId)) {
    return stage as TCutoverStageId;
  }

  return "shadow";
}

function resolveMessageEditPreviewMaxLength(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return messageEditBodyPreviewMaxLength;
  }

  return Math.floor(value);
}

function createMessageEditBodyPreview(body: string, maxLength: number): string {
  const redacted = redactText(body).replace(/\s+/g, " ").trim();

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${truncateUtf16Safe(redacted, maxLength - 1)}…`;
}
