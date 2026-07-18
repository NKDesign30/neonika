/**
 * Inbound mention decision, a rebuild of upstream
 * `src/channels/mention-gating.ts` `resolveInboundMentionDecision`.
 *
 * Neon's channel-inbound decision (`channelInbound.ts`) already gates on a plain
 * `wasMentioned` + mention policy. This adds the richer dimension upstream has
 * and Neon lacked: implicit mention kinds (reply-to-bot, quoted-bot,
 * thread-participant, native) filtered by an allow-list, plus the
 * control-command bypass that lets an authorized command through a
 * mention-required group without an explicit mention.
 *
 * Pure decision, no side effect. It composes with the slash/control command
 * gate (`skills/slashCommandGate.ts`), whose `commandAuthorized` feeds the
 * bypass. The nested `{ facts, policy }` shape is used (upstream's preferred
 * call shape); the deprecated flat variant is intentionally not rebuilt.
 */

export type TNeonImplicitMentionKind =
  | "reply_to_bot"
  | "quoted_bot"
  | "bot_thread_participant"
  | "native";

export interface INeonInboundMentionFacts {
  readonly canDetectMention: boolean;
  readonly wasMentioned: boolean;
  readonly hasAnyMention?: boolean;
  readonly implicitMentionKinds?: readonly TNeonImplicitMentionKind[];
}

export interface INeonInboundMentionPolicy {
  readonly isGroup: boolean;
  readonly requireMention: boolean;
  readonly allowedImplicitMentionKinds?: readonly TNeonImplicitMentionKind[];
  readonly allowTextCommands: boolean;
  readonly hasControlCommand: boolean;
  readonly commandAuthorized: boolean;
}

export interface IResolveNeonInboundMentionDecisionParams {
  readonly facts: INeonInboundMentionFacts;
  readonly policy: INeonInboundMentionPolicy;
}

export interface INeonInboundMentionDecision {
  readonly implicitMention: boolean;
  readonly matchedImplicitMentionKinds: readonly TNeonImplicitMentionKind[];
  readonly effectiveWasMentioned: boolean;
  readonly shouldBypassMention: boolean;
  readonly shouldSkip: boolean;
}

/** Returns `[kind]` when enabled, else `[]` — for building implicit-kind lists. */
export function neonImplicitMentionKindWhen(
  kind: TNeonImplicitMentionKind,
  enabled: boolean
): TNeonImplicitMentionKind[] {
  return enabled ? [kind] : [];
}

function resolveMatchedImplicitMentionKinds(
  inputKinds: readonly TNeonImplicitMentionKind[] | undefined,
  allowedImplicitMentionKinds: readonly TNeonImplicitMentionKind[] | undefined
): TNeonImplicitMentionKind[] {
  const kinds = inputKinds ?? [];
  if (kinds.length === 0) {
    return [];
  }
  const allowed = allowedImplicitMentionKinds ? new Set(allowedImplicitMentionKinds) : null;
  const matched: TNeonImplicitMentionKind[] = [];
  for (const kind of kinds) {
    if (allowed && !allowed.has(kind)) {
      continue;
    }
    if (!matched.includes(kind)) {
      matched.push(kind);
    }
  }
  return matched;
}

/**
 * Resolves whether an inbound message should be skipped for lack of a mention.
 * An implicit mention (allow-listed kind) or a bypassing authorized control
 * command counts as effectively mentioned. Mirrors upstream exactly.
 */
export function resolveNeonInboundMentionDecision(
  params: IResolveNeonInboundMentionDecisionParams
): INeonInboundMentionDecision {
  const { facts, policy } = params;

  const shouldBypassMention =
    policy.isGroup &&
    policy.requireMention &&
    !facts.wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;

  const matchedImplicitMentionKinds = resolveMatchedImplicitMentionKinds(
    facts.implicitMentionKinds,
    policy.allowedImplicitMentionKinds
  );
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned = facts.wasMentioned || implicitMention || shouldBypassMention;
  const shouldSkip = policy.requireMention && facts.canDetectMention && !effectiveWasMentioned;

  return {
    implicitMention,
    matchedImplicitMentionKinds,
    effectiveWasMentioned,
    shouldBypassMention,
    shouldSkip
  };
}

export function renderNeonInboundMentionDecisionReport(
  decision: INeonInboundMentionDecision
): string {
  const implicit =
    decision.matchedImplicitMentionKinds.length > 0
      ? decision.matchedImplicitMentionKinds.join(", ")
      : "none";

  return [
    "Neonika Inbound Mention Decision",
    `Should skip: ${decision.shouldSkip}`,
    `Effective mentioned: ${decision.effectiveWasMentioned}`,
    `Implicit mention: ${decision.implicitMention} (${implicit})`,
    `Bypass mention: ${decision.shouldBypassMention}`
  ].join("\n");
}
