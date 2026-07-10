/**
 * Leak-safe Discord bot-identity derivation.
 *
 * A Discord bot token has the shape `<base64url(userId)>.<base64url(timestamp)>.<hmac>`.
 * Only the first segment is decoded here: it is the bot's user id (equal to the
 * application id for bots) and is fully public — it appears in every invite URL
 * and `<@id>` mention. The third segment is the actual secret and is never read,
 * decoded, logged, or returned. Callers must keep it that way: only the derived
 * application id (a plain snowflake string) may cross a boundary.
 */

export type TDiscordBotIdentityConsistency = "match" | "mismatch" | "unknown";

/**
 * Decode the public Discord application id from the first token segment.
 *
 * Returns `undefined` for any input that is not a well-formed bot token whose
 * leading segment base64url-decodes to a snowflake. The function deliberately
 * touches only segment 0 — never the timestamp or the HMAC secret.
 */
export function parseDiscordApplicationIdFromToken(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }

  const trimmed = token.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const segments = trimmed.split(".");

  // Bot tokens carry three dot-separated segments; user/mfa tokens do not encode
  // an application id in segment 0, so anything without at least id+timestamp is rejected.
  if (segments.length < 2) {
    return undefined;
  }

  const firstSegment = segments[0];

  if (!firstSegment || firstSegment.length === 0) {
    return undefined;
  }

  let decoded: string;

  try {
    decoded = Buffer.from(firstSegment, "base64url").toString("utf8");
  } catch {
    return undefined;
  }

  // A valid Discord application id is a snowflake: 17-20 ASCII digits today.
  if (!/^\d{17,20}$/.test(decoded)) {
    return undefined;
  }

  return decoded;
}

/**
 * Compare the token-derived application id against the operator-configured bot
 * user id. `unknown` when either side is absent — no claim is made without both.
 */
export function resolveDiscordBotIdentityConsistency(
  applicationId: string | undefined,
  configuredBotUserId: string | undefined
): TDiscordBotIdentityConsistency {
  if (!applicationId || !configuredBotUserId) {
    return "unknown";
  }

  return applicationId === configuredBotUserId ? "match" : "mismatch";
}
