/**
 * Allow-from source resolution, a rebuild of upstream
 * `src/channels/allow-from.ts`.
 *
 * This sits one layer above the allowlist matcher
 * (`channels/inboundAllowlistMatch.ts`): it resolves *which* allow-from entries
 * apply before a sender is matched against them — DM vs group scope, store-vs-
 * config precedence, and the `accessGroup:<name>` indirection. Neon had the
 * channel-scoped canary allowlist and (now) the sender matcher, but not this
 * source-resolution step.
 *
 * Pure, no side effect, no state. Note a deliberate asymmetry carried over from
 * Upstream: `normalizeNeonStringEntries` trims and drops empties but does NOT
 * lowercase (allow-from entries keep their case here), and
 * `isNeonSenderIdAllowed` does a case-sensitive `includes`. The case-insensitive
 * path lives in the matcher (`resolveNeonAllowlistMatchSimple`). Callers pick the
 * path that matches how their ids are normalized.
 *
 * The `accessGroup:<name>` expander itself (turning a group name into member
 * ids) needs a group store and is not built here — only the prefix parser is, to
 * document the seam.
 */

export const NEON_ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

/** Parses an `accessGroup:<name>` allow-from entry; returns the name or null. */
export function parseNeonAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(NEON_ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(NEON_ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/** Coerces to trimmed strings, dropping empties. No lowercasing, no dedupe. */
export function normalizeNeonStringEntries(list?: readonly unknown[]): string[] {
  return (list ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Merges configured allow-from with the persisted store allow-from. Store entries
 * are dropped when the DM policy is `allowlist` or `open` (those policies define
 * access by their own means, so the store list must not widen them).
 */
export function mergeNeonDmAllowFromSources(params: {
  readonly allowFrom?: readonly (string | number)[];
  readonly storeAllowFrom?: readonly (string | number)[];
  readonly dmPolicy?: string;
}): string[] {
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : (params.storeAllowFrom ?? []);
  return normalizeNeonStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}

/**
 * Resolves the allow-from sources for a group scope. An explicit non-empty
 * `groupAllowFrom` wins; otherwise it falls back to the global `allowFrom`
 * unless `fallbackToAllowFrom` is explicitly false (then the group is closed).
 */
export function resolveNeonGroupAllowFromSources(params: {
  readonly allowFrom?: readonly (string | number)[];
  readonly groupAllowFrom?: readonly (string | number)[];
  readonly fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  return normalizeNeonStringEntries(scoped);
}

export interface INeonCompiledAllowFrom {
  readonly entries: readonly string[];
  readonly hasWildcard: boolean;
  readonly hasEntries: boolean;
}

/** Compiles raw allow-from entries into the precomputed shape used by the gate. */
export function compileNeonAllowFrom(entries?: readonly (string | number)[]): INeonCompiledAllowFrom {
  const normalized = normalizeNeonStringEntries(entries);
  return {
    entries: normalized,
    hasWildcard: normalized.includes("*"),
    hasEntries: normalized.length > 0
  };
}

/**
 * Decides whether a sender id is allowed by a compiled allow-from. An empty list
 * yields `allowWhenEmpty` (caller's default-open vs default-closed choice); a `*`
 * wildcard allows anyone; otherwise an exact (case-sensitive) membership test.
 */
export function isNeonSenderIdAllowed(
  allow: INeonCompiledAllowFrom,
  senderId: string | undefined,
  allowWhenEmpty: boolean
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}

export function renderNeonAllowFromPolicyReport(params: {
  readonly label: string;
  readonly allow: INeonCompiledAllowFrom;
  readonly senderId: string | undefined;
  readonly allowWhenEmpty: boolean;
}): string {
  const allowed = isNeonSenderIdAllowed(params.allow, params.senderId, params.allowWhenEmpty);
  return [
    `### ${params.label}`,
    `Entries: ${params.allow.entries.length} wildcard=${params.allow.hasWildcard}`,
    `Allowed: ${allowed}`
  ].join("\n");
}
