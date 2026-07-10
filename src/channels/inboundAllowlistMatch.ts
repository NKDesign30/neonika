/**
 * Inbound access allowlist matching, a rebuild of upstream
 * `src/channels/allowlist-match.ts`.
 *
 * This is the access layer that decides whether a sender is allowed to reach
 * the bot at all — the input that feeds `commandAuthorized` in the slash/control
 * command gate (`skills/slashCommandGate.ts`) and the mention-decision bypass
 * (`channels/inboundMentionDecision.ts`). Neon had channel-scoped allowlists
 * (`resolveNeonCanaryChannelAllowlist` for outbound canary channels, the node
 * exec-kind allowlist) but no sender-identity matcher (by id / name / tag /
 * username candidates with wildcard support). This adds it.
 *
 * Pure decision, no side effect, no state. Candidates are tried in order and the
 * first one whose normalized value is in the compiled set wins.
 *
 * One intentional Neon difference from upstream: `formatNeonAllowlistMatchMeta`
 * renders `matchSource` and a `matched`/`none` flag but NOT the raw `matchKey`.
 * The matched key is a sender identifier (id / name) — PII under Neon's
 * redaction-everywhere posture. The structured `INeonAllowlistMatch` still
 * carries `matchKey` for in-process audit; only the boundary-crossing string
 * label is leak-safe.
 */

export type TNeonAllowlistMatchSource =
  | "wildcard"
  | "id"
  | "name"
  | "tag"
  | "username"
  | "prefixed-id"
  | "prefixed-user"
  | "prefixed-name"
  | "slug"
  | "localpart";

export interface INeonAllowlistMatch<TSource extends string = TNeonAllowlistMatchSource> {
  readonly allowed: boolean;
  readonly matchKey?: string;
  readonly matchSource?: TSource;
}

export interface INeonCompiledAllowlist {
  readonly set: ReadonlySet<string>;
  readonly wildcard: boolean;
}

export interface INeonAllowlistCandidate<TSource extends string> {
  readonly value?: string;
  readonly source: TSource;
}

/** Trim + lowercase; empty after trim becomes `undefined`. */
function normalizeNeonOptionalLowercase(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

/** Trim + lowercase; empty after trim becomes `""`. */
function normalizeNeonLowercaseOrEmpty(value: unknown): string {
  return normalizeNeonOptionalLowercase(value) ?? "";
}

/** Compiles raw allowlist entries into a set, flagging the `*` wildcard. */
export function compileNeonAllowlist(entries: readonly string[]): INeonCompiledAllowlist {
  const set = new Set(entries.filter(Boolean));
  return { set, wildcard: set.has("*") };
}

function compileNeonSimpleAllowlist(
  entries: readonly (string | number)[]
): INeonCompiledAllowlist {
  return compileNeonAllowlist(
    entries
      .map((entry) => normalizeNeonOptionalLowercase(String(entry)))
      .filter((entry): entry is string => Boolean(entry))
  );
}

/** Returns the first candidate whose value is in the compiled set, else not-allowed. */
export function resolveNeonAllowlistCandidates<TSource extends string>(params: {
  readonly compiledAllowlist: INeonCompiledAllowlist;
  readonly candidates: readonly INeonAllowlistCandidate<TSource>[];
}): INeonAllowlistMatch<TSource> {
  for (const candidate of params.candidates) {
    if (!candidate.value) {
      continue;
    }
    if (params.compiledAllowlist.set.has(candidate.value)) {
      return { allowed: true, matchKey: candidate.value, matchSource: candidate.source };
    }
  }
  return { allowed: false };
}

/**
 * Resolves a match against an already-compiled allowlist. An empty allowlist
 * denies everyone; a `*` wildcard allows everyone; otherwise the candidates are
 * tried in order.
 */
export function resolveNeonCompiledAllowlistMatch<TSource extends string>(params: {
  readonly compiledAllowlist: INeonCompiledAllowlist;
  readonly candidates: readonly INeonAllowlistCandidate<TSource>[];
}): INeonAllowlistMatch<TSource> {
  if (params.compiledAllowlist.set.size === 0) {
    return { allowed: false };
  }
  if (params.compiledAllowlist.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" as TSource };
  }
  return resolveNeonAllowlistCandidates(params);
}

/** Compiles `allowList` then resolves the candidates against it. */
export function resolveNeonAllowlistMatchByCandidates<TSource extends string>(params: {
  readonly allowList: readonly string[];
  readonly candidates: readonly INeonAllowlistCandidate<TSource>[];
}): INeonAllowlistMatch<TSource> {
  return resolveNeonCompiledAllowlistMatch({
    compiledAllowlist: compileNeonAllowlist(params.allowList),
    candidates: params.candidates
  });
}

/**
 * The common case: match a sender by id, and optionally by name. Names are only
 * considered when `allowNameMatching` is explicitly true (upstream parity —
 * name matching is opt-in because names are not unique).
 */
export function resolveNeonAllowlistMatchSimple(params: {
  readonly allowFrom: readonly (string | number)[];
  readonly senderId: string;
  readonly senderName?: string | null;
  readonly allowNameMatching?: boolean;
}): INeonAllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = compileNeonSimpleAllowlist(params.allowFrom);

  if (allowFrom.set.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = normalizeNeonLowercaseOrEmpty(params.senderId);
  const senderName = normalizeNeonOptionalLowercase(params.senderName);
  const candidates: INeonAllowlistCandidate<"id" | "name">[] = [
    { value: senderId, source: "id" },
    ...(params.allowNameMatching === true && senderName
      ? [{ value: senderName, source: "name" as const }]
      : [])
  ];
  return resolveNeonAllowlistCandidates({ compiledAllowlist: allowFrom, candidates });
}

/**
 * Leak-safe meta label. Shows the match source and whether something matched,
 * never the raw matched key (a sender identifier / PII). See module header.
 */
export function formatNeonAllowlistMatchMeta(
  match?: Pick<INeonAllowlistMatch, "matchKey" | "matchSource"> | null
): string {
  const matchSource = match?.matchSource ?? "none";
  const matched = match?.matchKey ? "matched" : "none";
  return `matchKey=${matched} matchSource=${matchSource}`;
}
