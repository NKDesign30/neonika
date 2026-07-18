/**
 * Tiny, pure record helpers for the Neon Plugin SDK.
 *
 * The plugin SDK is intentionally a standalone contract module with no
 * filesystem or node-runtime imports, mirroring how upstream keeps
 * `packages/plugin-sdk` / `packages/plugin-package-contract` decoupled from the
 * host. These helpers are deliberately duplicated (rather than imported from
 * `skills/neonSkillFs.ts`, which mixes in `node:fs`) so the SDK stays a pure,
 * trivially testable contract that operates only on already-parsed records.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a trimmed non-empty string, or undefined for anything else. */
export function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return readOptionalText(record[key]);
}

export function readRecord(
  record: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/** Coerces a string or string[] field into a de-duplicated, trimmed list. */
export function readStringList(value: unknown): readonly string[] {
  const collected: string[] = [];
  const push = (entry: unknown): void => {
    const text = readOptionalText(entry);
    if (text !== undefined && !collected.includes(text)) {
      collected.push(text);
    }
  };

  if (typeof value === "string") {
    push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      push(entry);
    }
  }

  return collected;
}

export function readBoolean(value: unknown): boolean {
  return value === true;
}
