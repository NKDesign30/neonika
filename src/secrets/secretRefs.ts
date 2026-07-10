export type TNeonSecretInputStatus = "missing" | "value" | "ref";

const onePasswordSecretRefPattern = /\bop:\/\/[^\s"'`]+/gi;

export function countOnePasswordSecretRefs(value: string): number {
  onePasswordSecretRefPattern.lastIndex = 0;
  return Array.from(value.matchAll(onePasswordSecretRefPattern)).length;
}

export function isOnePasswordSecretRef(value: string): boolean {
  onePasswordSecretRefPattern.lastIndex = 0;
  return onePasswordSecretRefPattern.test(value.trim());
}

export function resolveSecretInputStatus(value: string | undefined): TNeonSecretInputStatus {
  if (value === undefined || value.trim().length === 0) {
    return "missing";
  }

  return isOnePasswordSecretRef(value) ? "ref" : "value";
}

// Structural reachability for a 1Password `op://` reference WITHOUT resolving it.
// Ported in spirit from OpenClaw `src/config/redact-snapshot.secret-ref.ts`
// (`isSecretRefShape` validates the ref shape; `redactSecretRefId` keeps the
// shape while redacting the identifier). OpenClaw validates structured
// `{source, provider, id}` config refs; Neon Core is `op://`-string specific, so
// this rebuilds an op:// shape validator. NO `op` CLI call, NO value resolution:
// it only classifies whether a ref *could* resolve, never what it resolves to.
// See THIRD_PARTY_NOTICES.md for attribution.

export type TOnePasswordSecretRefReachability = "resolvable" | "incomplete" | "malformed";

export interface IOnePasswordSecretRefParts {
  readonly vault: string;
  readonly item: string;
  readonly field: string;
  readonly section?: string;
}

export interface IOnePasswordSecretRefReachabilitySummary {
  readonly total: number;
  readonly resolvable: number;
  readonly incomplete: number;
  readonly malformed: number;
}

function splitOnePasswordSecretRefSegments(value: string): readonly string[] {
  const trimmed = value.trim();
  const match = /^op:\/\/(.*)$/i.exec(trimmed);

  if (!match) {
    return [];
  }

  return (match[1] ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Parse `op://vault/item/field` or `op://vault/item/section/field` into its
 * structural parts. Returns null when the shape cannot resolve. The parts are
 * identifiers (not secret values), but callers that render to operator surfaces
 * should still prefer the count summary over echoing names.
 */
export function parseOnePasswordSecretRef(value: string): IOnePasswordSecretRefParts | null {
  const segments = splitOnePasswordSecretRefSegments(value);

  if (segments.length === 3) {
    return { vault: segments[0] ?? "", item: segments[1] ?? "", field: segments[2] ?? "" };
  }

  if (segments.length === 4) {
    return {
      vault: segments[0] ?? "",
      item: segments[1] ?? "",
      section: segments[2] ?? "",
      field: segments[3] ?? ""
    };
  }

  return null;
}

/** Classify a single value's `op://` reachability, or null when it is not an op:// ref. */
export function classifyOnePasswordSecretRef(
  value: string
): TOnePasswordSecretRefReachability | null {
  if (!/^op:\/\//i.test(value.trim())) {
    return null;
  }

  const segments = splitOnePasswordSecretRefSegments(value);

  if (segments.length === 3 || segments.length === 4) {
    return "resolvable";
  }

  if (segments.length === 1 || segments.length === 2) {
    return "incomplete";
  }

  return "malformed";
}

/** Summarize op:// reachability across all references embedded in a text blob. */
export function summarizeOnePasswordSecretRefReachability(
  value: string
): IOnePasswordSecretRefReachabilitySummary {
  onePasswordSecretRefPattern.lastIndex = 0;
  let resolvable = 0;
  let incomplete = 0;
  let malformed = 0;

  for (const match of value.matchAll(onePasswordSecretRefPattern)) {
    switch (classifyOnePasswordSecretRef(match[0])) {
      case "resolvable":
        resolvable += 1;
        break;
      case "incomplete":
        incomplete += 1;
        break;
      case "malformed":
        malformed += 1;
        break;
      default:
        break;
    }
  }

  return { total: resolvable + incomplete + malformed, resolvable, incomplete, malformed };
}
