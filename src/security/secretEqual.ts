import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret/credential comparison.
 *
 * Pads both inputs to the longer byte length before `timingSafeEqual`, so the
 * comparison time does not depend on where two equal-length secrets diverge AND
 * — unlike a `a.length === b.length && timingSafeEqual(a, b)` guard — it does not
 * short-circuit (and thus leak timing) when the lengths differ. The exact length
 * check runs AFTER the constant-time content compare. Node built-in only, no dep.
 *
 * Rebuild-native from upstream `src/security/secret-equal.ts` (safeEqualSecret).
 */
export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const byteLength = Math.max(providedBytes.length, expectedBytes.length);
  if (byteLength === 0) {
    return true;
  }

  return (
    timingSafeEqual(
      padSecretBytes(providedBytes, byteLength),
      padSecretBytes(expectedBytes, byteLength)
    ) && providedBytes.length === expectedBytes.length
  );
}

function padSecretBytes(bytes: Buffer, length: number): Buffer {
  if (bytes.length === length) {
    return bytes;
  }
  const padded = Buffer.alloc(length);
  bytes.copy(padded);
  return padded;
}
