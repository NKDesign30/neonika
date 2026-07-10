/**
 * Inbound access decision chain — the live composition the parity matrix row
 * "Inbound access stack" was missing. The pure pieces existed and were tested in
 * isolation (`inboundAllowFromPolicy`, `inboundAllowlistMatch`,
 * `inboundAccessGroups`, `inboundDirectDmAccess`, `inboundMentionDecision`,
 * `skills/slashCommandGate`) but nothing chained them in the order a real
 * channel ingress needs. This module is that chain, channel-agnostic so both the
 * Discord message ingress and the slash/interaction dispatch reuse it.
 *
 * Order (mirrors upstream channel-ingress-runtime):
 *   1. expand `accessGroup:<name>` -> effective allow-from
 *   2. allowlist match (who may reach the bot)  -> group scope gate
 *   3. direct-DM access guard (DM scope only, when a dmPolicy is set)
 *   4. control-command authorization (group scope, when text commands are on)
 *   5. mention decision (implicit kinds + authorized-command bypass)
 *
 * Backward-compatible by construction: with no allow-from, no access groups, no
 * dmPolicy and text commands off, every gate is a pass and the decision reduces
 * to the plain mention gate Neon already had.
 *
 * Pure decision, no side effect, no state. The structured result carries audit
 * detail for in-process logging; callers render only leak-safe summaries.
 */

import {
  compileNeonAllowFrom,
  isNeonSenderIdAllowed
} from "./inboundAllowFromPolicy.js";
import {
  expandNeonAllowFromWithAccessGroups,
  resolveNeonAccessGroupMatchState,
  type INeonAccessGroupMatchState,
  type TNeonAccessGroup
} from "./inboundAccessGroups.js";
import {
  resolveNeonDirectDmAccess,
  type INeonDirectDmAccess,
  type TNeonDmPolicy
} from "./inboundDirectDmAccess.js";
import {
  resolveNeonInboundMentionDecision,
  type INeonInboundMentionDecision,
  type TNeonImplicitMentionKind
} from "./inboundMentionDecision.js";
import { resolveNeonControlCommandGate } from "../skills/slashCommandGate.js";

export type TNeonInboundAccessBlockReason =
  | "sender-not-allowed"
  | "dm-not-allowed"
  | "dm-pairing-required"
  | "command-not-authorized"
  | "mention-required";

export interface INeonInboundAccessFacts {
  readonly channel: string;
  readonly isGroup: boolean;
  readonly senderId: string;
  readonly allowFrom?: readonly (string | number)[];
  readonly accessGroups?: Readonly<Record<string, TNeonAccessGroup>>;
  /** When set, the DM access guard runs in DM scope; omitted = legacy open DMs. */
  readonly dmPolicy?: TNeonDmPolicy;
  /** Defaults to true (upstream parity); false uses the command-gate fallback mode. */
  readonly useAccessGroups?: boolean;
  /** Defaults to false; gates `/command`-style control commands when true. */
  readonly allowTextCommands?: boolean;
  readonly hasControlCommand: boolean;
  readonly requireMention: boolean;
  readonly canDetectMention: boolean;
  readonly wasMentioned: boolean;
  readonly hasAnyMention?: boolean;
  readonly implicitMentionKinds?: readonly TNeonImplicitMentionKind[];
  readonly allowedImplicitMentionKinds?: readonly TNeonImplicitMentionKind[];
}

export interface INeonInboundAccessDecision {
  readonly outcome: "allow" | "block";
  readonly blockReason?: TNeonInboundAccessBlockReason;
  readonly effectiveAllowFrom: readonly string[];
  readonly senderAllowed: boolean;
  readonly commandAuthorized: boolean;
  readonly accessGroups: INeonAccessGroupMatchState;
  readonly dmAccess?: INeonDirectDmAccess;
  readonly mention: INeonInboundMentionDecision;
}

function isSenderAllowedCaseSensitive(senderId: string, allowFrom: readonly string[]): boolean {
  return isNeonSenderIdAllowed(compileNeonAllowFrom(allowFrom), senderId, false);
}

/**
 * Resolves the full inbound access decision. Returns a structured result; the
 * first failing gate sets `blockReason` and `outcome: "block"`.
 */
export function resolveNeonInboundAccessDecision(
  facts: INeonInboundAccessFacts
): INeonInboundAccessDecision {
  const accessGroups = resolveNeonAccessGroupMatchState({
    ...(facts.allowFrom ? { allowFrom: facts.allowFrom } : {}),
    ...(facts.accessGroups ? { accessGroups: facts.accessGroups } : {}),
    channel: facts.channel,
    senderId: facts.senderId,
    isSenderAllowed: isSenderAllowedCaseSensitive
  });

  const effectiveAllowFrom = expandNeonAllowFromWithAccessGroups({
    ...(facts.allowFrom ? { allowFrom: facts.allowFrom } : {}),
    ...(facts.accessGroups ? { accessGroups: facts.accessGroups } : {}),
    channel: facts.channel,
    senderId: facts.senderId,
    isSenderAllowed: isSenderAllowedCaseSensitive
  });

  const compiled = compileNeonAllowFrom(effectiveAllowFrom);
  // Access layer is default-open: an empty allow-from lets anyone reach the bot
  // (Neon's pre-existing behavior). A configured allow-from gates exact members.
  const senderAllowed = isNeonSenderIdAllowed(compiled, facts.senderId, true);

  const commandGate = resolveNeonControlCommandGate({
    useAccessGroups: facts.useAccessGroups ?? true,
    authorizers: [{ configured: compiled.hasEntries, allowed: senderAllowed }],
    allowTextCommands: facts.allowTextCommands ?? false,
    hasControlCommand: facts.hasControlCommand
  });

  const dmAccess =
    !facts.isGroup && facts.dmPolicy
      ? resolveNeonDirectDmAccess({
          dmPolicy: facts.dmPolicy,
          allowFrom: effectiveAllowFrom,
          senderId: facts.senderId
        })
      : undefined;

  const mention = resolveNeonInboundMentionDecision({
    facts: {
      canDetectMention: facts.canDetectMention,
      wasMentioned: facts.wasMentioned,
      ...(facts.hasAnyMention !== undefined ? { hasAnyMention: facts.hasAnyMention } : {}),
      ...(facts.implicitMentionKinds ? { implicitMentionKinds: facts.implicitMentionKinds } : {})
    },
    policy: {
      isGroup: facts.isGroup,
      requireMention: facts.requireMention,
      ...(facts.allowedImplicitMentionKinds
        ? { allowedImplicitMentionKinds: facts.allowedImplicitMentionKinds }
        : {}),
      allowTextCommands: facts.allowTextCommands ?? false,
      hasControlCommand: facts.hasControlCommand,
      commandAuthorized: commandGate.commandAuthorized
    }
  });

  const base = {
    effectiveAllowFrom,
    senderAllowed,
    commandAuthorized: commandGate.commandAuthorized,
    accessGroups,
    ...(dmAccess ? { dmAccess } : {}),
    mention
  };

  if (facts.isGroup && compiled.hasEntries && !senderAllowed) {
    return { outcome: "block", blockReason: "sender-not-allowed", ...base };
  }

  if (dmAccess && dmAccess.decision === "block") {
    return { outcome: "block", blockReason: "dm-not-allowed", ...base };
  }

  if (dmAccess && dmAccess.decision === "pairing") {
    return { outcome: "block", blockReason: "dm-pairing-required", ...base };
  }

  if (facts.isGroup && commandGate.shouldBlock) {
    return { outcome: "block", blockReason: "command-not-authorized", ...base };
  }

  if (mention.shouldSkip) {
    return { outcome: "block", blockReason: "mention-required", ...base };
  }

  return { outcome: "allow", ...base };
}

/** Leak-safe one-line summary: outcome, reason, gate flags — no ids or names. */
export function renderNeonInboundAccessDecisionReport(
  decision: INeonInboundAccessDecision
): string {
  return [
    "Neon Inbound Access Decision",
    `Outcome: ${decision.outcome}${decision.blockReason ? ` (${decision.blockReason})` : ""}`,
    `Sender allowed: ${decision.senderAllowed}`,
    `Command authorized: ${decision.commandAuthorized}`,
    `Access groups: matched=${decision.accessGroups.matched.length} referenced=${decision.accessGroups.referenced.length}`,
    `DM access: ${decision.dmAccess ? decision.dmAccess.reasonCode : "n/a"}`,
    `Mention skip: ${decision.mention.shouldSkip}`
  ].join("\n");
}
