/**
 * Pure, side-effect-free parser for a Discord message reference. Turns a canonical
 * message URL into the three snowflake ids Neon needs to address a single
 * message — without a client, token, or fetch.
 *
 * Accepted shapes (mirrors upstream's parseDiscordMessageLink):
 *   https://discord.com/channels/<guildId>/<channelId>/<messageId>
 *   plus the discordapp.com alias and the ptb./canary. subdomains, an optional
 *   missing scheme, and a trailing slash or query string.
 *
 * No throw on bad input: a malformed link returns `null` so a caller (e.g. a future
 * single-message read) can surface the reason and stay suppressed, matching the
 * Result-style discord*Payload builders. The fetch itself stays behind the gated
 * transport; this is only the read-only address-resolution half.
 */

export interface INeonDiscordMessageRef {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
}

// Canonical message URL across discord.com / discordapp.com and the ptb/canary
// subdomains; an absent scheme, trailing slash, or query string are tolerated.
// Each id is a snowflake (digit run). Guild DMs (@me) are out of scope, matching
// Upstream — a guild id is required.
const NEON_DISCORD_MESSAGE_LINK_PATTERN =
  /^(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?:\/|\?.*)?$/i;

/**
 * Parse a Discord message link into its guild/channel/message ids. Returns `null`
 * for anything that is not a well-formed message URL.
 */
export function parseNeonDiscordMessageLink(link: string): INeonDiscordMessageRef | null {
  const match = link.trim().match(NEON_DISCORD_MESSAGE_LINK_PATTERN);
  if (match === null) {
    return null;
  }
  const guildId = match[1];
  const channelId = match[2];
  const messageId = match[3];
  if (guildId === undefined || channelId === undefined || messageId === undefined) {
    return null;
  }
  return { guildId, channelId, messageId };
}
