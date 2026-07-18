/**
 * Access-group allow-from expansion, a rebuild of upstream
 * `src/plugin-sdk/access-groups.ts` (`expandAllowFromWithAccessGroups`).
 *
 * Allow-from lists can carry `accessGroup:<name>` indirections
 * (`channels/inboundAllowFromPolicy.ts` parses the prefix). This module resolves
 * those names against a read-only group store: when the sender is a member of a
 * referenced group, the group "matches" and the sender's own id is folded into
 * the effective allow-from so the downstream exact matcher
 * (`isNeonSenderIdAllowed`) passes.
 *
 * Intentional Neon scope vs upstream: only the inline `message.senders` group
 * kind is resolved here, and resolution is PURE + SYNCHRONOUS so it can run
 * inside the synchronous Discord ingress decision. Upstream also supports an
 * async membership resolver (role/pairing-backed groups); that is modeled as the
 * documented `resolveMembership` seam below but is not used by the sync ingress
 * path — a role-backed resolver belongs to a later live-arming slice, not shadow.
 *
 * Pure, no side effect, no state.
 */

import {
  NEON_ACCESS_GROUP_ALLOW_FROM_PREFIX,
  normalizeNeonStringEntries,
  parseNeonAccessGroupAllowFromEntry
} from "./inboundAllowFromPolicy.js";

/** An inline sender-membership group: channel-keyed member ids, `*` = any channel. */
export interface INeonMessageSendersAccessGroup {
  readonly type: "message.senders";
  readonly members: Readonly<Record<string, readonly string[]>>;
}

export type TNeonAccessGroup = INeonMessageSendersAccessGroup;

export interface INeonAccessGroupMatchState {
  /** Distinct group names referenced via `accessGroup:<name>` in the allow-from. */
  readonly referenced: readonly string[];
  /** Referenced groups whose members include the sender. */
  readonly matched: readonly string[];
  /** Referenced names with no group definition. */
  readonly missing: readonly string[];
  /** Referenced groups of a kind this sync resolver does not handle. */
  readonly unsupported: readonly string[];
  readonly hasReferences: boolean;
  readonly hasMatch: boolean;
}

function resolveMessageSenderEntries(
  group: TNeonAccessGroup,
  channel: string
): readonly string[] {
  if (group.type !== "message.senders") {
    return [];
  }
  return [...(group.members["*"] ?? []), ...(group.members[channel] ?? [])];
}

/**
 * Resolves which referenced access groups the sender belongs to. Membership is
 * the inline `message.senders` member test; unknown names and unsupported kinds
 * are reported but never throw.
 */
export function resolveNeonAccessGroupMatchState(params: {
  readonly allowFrom?: readonly (string | number)[];
  readonly accessGroups?: Readonly<Record<string, TNeonAccessGroup>>;
  readonly channel: string;
  readonly senderId: string;
  readonly isSenderAllowed: (senderId: string, allowFrom: readonly string[]) => boolean;
}): INeonAccessGroupMatchState {
  const referenced = Array.from(
    new Set(
      (params.allowFrom ?? [])
        .map((entry) => parseNeonAccessGroupAllowFromEntry(String(entry)))
        .filter((name): name is string => name != null)
    )
  );

  const matched: string[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];

  for (const name of referenced) {
    const group = params.accessGroups?.[name];
    if (!group) {
      missing.push(name);
      continue;
    }
    if (group.type !== "message.senders") {
      unsupported.push(name);
      continue;
    }
    const senderEntries = resolveMessageSenderEntries(group, params.channel);
    if (senderEntries.length > 0 && params.isSenderAllowed(params.senderId, senderEntries)) {
      matched.push(name);
    }
  }

  return {
    referenced,
    matched,
    missing,
    unsupported,
    hasReferences: referenced.length > 0,
    hasMatch: matched.length > 0
  };
}

/**
 * Expands `accessGroup:<name>` allow-from entries into an effective allow-from.
 * When any referenced group matches the sender, the sender's id is appended so
 * the downstream exact matcher allows them; otherwise the input is returned
 * unchanged (the `accessGroup:` literals never match an id directly).
 */
export function expandNeonAllowFromWithAccessGroups(params: {
  readonly allowFrom?: readonly (string | number)[];
  readonly accessGroups?: Readonly<Record<string, TNeonAccessGroup>>;
  readonly channel: string;
  readonly senderId: string;
  readonly isSenderAllowed: (senderId: string, allowFrom: readonly string[]) => boolean;
}): string[] {
  const baseAllowFrom = normalizeNeonStringEntries(params.allowFrom);
  const state = resolveNeonAccessGroupMatchState({
    ...(params.allowFrom ? { allowFrom: params.allowFrom } : {}),
    ...(params.accessGroups ? { accessGroups: params.accessGroups } : {}),
    channel: params.channel,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed
  });

  if (!state.hasMatch) {
    return baseAllowFrom;
  }

  const senderEntry = params.senderId.trim();
  if (senderEntry.length === 0 || baseAllowFrom.includes(senderEntry)) {
    return baseAllowFrom;
  }
  return [...baseAllowFrom, senderEntry];
}

/** Leak-safe summary: counts only, never raw group names or sender ids. */
export function formatNeonAccessGroupMatchMeta(state: INeonAccessGroupMatchState): string {
  return [
    `referenced=${state.referenced.length}`,
    `matched=${state.matched.length}`,
    `missing=${state.missing.length}`,
    `unsupported=${state.unsupported.length}`
  ].join(" ");
}

export { NEON_ACCESS_GROUP_ALLOW_FROM_PREFIX };
