/**
 * Neonika Roundtable Discord wake-nudge (spec issue #15, ticket #21).
 *
 * When a round escalates to the human judge (decision-gate #19: a will/tradeoff
 * or ambiguous stall, or an answerable one with no specialist) and the owner is
 * away, this sends a gated "Roundtable needs you" nudge to the private Discord
 * chat through the existing outbound seam (`gateway/outboundSender.ts`).
 *
 * v1 boundary: Discord is only the wake signal, never the answer channel. The
 * decision still comes back in-window via the injected `judge`. So the nudge
 * body carries NO situation text and NO room content — only that a decision of
 * a given class is waiting, plus the leak-safe round id. It is run through the
 * outbound redaction seam regardless (defensive: a marker payload or accidental
 * content can never reach Discord).
 *
 * Suppressed by default. The nudge goes through whatever `INeonOutboundSender`
 * the caller injects; the shipped wiring injects the dry-run sender, so the
 * result is `suppressed` (`outboundSent: false`) until the canary cutover gate
 * is armed. Owner presence is not modelled in Neon yet, so `ownerAway` is an
 * explicit injected signal (v1: the runtime assumes away and relies on the
 * shadow contract to keep the send suppressed).
 */

import type { INeonDeliveryQueueTarget } from "../gateway/deliveryQueue.js";
import type { INeonOutboundSender } from "../gateway/outboundSender.js";
import { redactText } from "../harness/redaction.js";
import type { TNeonRoundtableStallClass } from "./roundtableRound.js";

export interface INeonRoundtableWakeNudgeContent {
  /** How the decision gate routed the stall (#19); a safe enum label. */
  readonly stallClass: TNeonRoundtableStallClass;
  /** Caller-minted round slug (`round-<base36>`), not user content. */
  readonly roundId: string;
}

/**
 * Builds the leak-safe wake-signal line. Fixed copy plus the stall class and the
 * round id — never the escalated situation. The whole line still passes through
 * `redactText` so no marker payload or accidental content can reach the wire.
 */
export function buildNeonRoundtableWakeNudgeMessage(
  content: INeonRoundtableWakeNudgeContent
): string {
  const line = `Roundtable needs you — a ${content.stallClass} decision is waiting in the window (round ${content.roundId}).`;
  return redactText(line);
}

export type TNeonRoundtableWakeNudgeState =
  | "skipped-owner-present"
  | "suppressed"
  | "sent";

export interface INeonRoundtableWakeNudgeResult {
  readonly state: TNeonRoundtableWakeNudgeState;
  readonly stallClass: TNeonRoundtableStallClass;
  readonly roundId: string;
  /** Redacted, length-capped preview from the outbound sender; empty when skipped. */
  readonly bodyPreview: string;
  /** Mirrors the sender: only the armed canary path can ever make this true. */
  readonly outboundSent: boolean;
}

export interface IDispatchNeonRoundtableWakeNudgeOptions {
  readonly sender: INeonOutboundSender;
  readonly target: INeonDeliveryQueueTarget;
  readonly stallClass: TNeonRoundtableStallClass;
  readonly roundId: string;
  /**
   * The nudge only fires to wake an absent owner. A present owner is already at
   * the window, so the nudge is skipped (`skipped-owner-present`) — no send.
   */
  readonly ownerAway: boolean;
}

/**
 * Dispatches the wake-nudge through the injected outbound sender. Never throws:
 * the sender's contract is a resolved suppressed/sent result, so a caller can
 * await this at the escalation point without guarding the discussion round.
 */
export async function dispatchNeonRoundtableWakeNudge(
  options: IDispatchNeonRoundtableWakeNudgeOptions
): Promise<INeonRoundtableWakeNudgeResult> {
  const base = { stallClass: options.stallClass, roundId: options.roundId };

  if (!options.ownerAway) {
    return { ...base, state: "skipped-owner-present", bodyPreview: "", outboundSent: false };
  }

  const message = buildNeonRoundtableWakeNudgeMessage(base);
  const result = await options.sender.sendText(options.target, message);

  return {
    ...base,
    state: result.outboundSent ? "sent" : "suppressed",
    bodyPreview: result.bodyPreview,
    outboundSent: result.outboundSent
  };
}
