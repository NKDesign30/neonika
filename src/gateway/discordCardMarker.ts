import { redactText } from "../harness/redaction.js";
import { NEON_DISCORD_EMBED_LIMITS } from "./discordRichPayload.js";
import type { INeonDiscordEmbed } from "./discordRichPayload.js";
import { NEON_DISCORD_ACCENT_COLOR, neonDiscordSeverityColors } from "./discordUiColors.js";

/**
 * Agent-authored rich-card marker, pattern-following the poll marker
 * (discordPollMarker.ts). An agent wraps a card body in the marker; the reply
 * loop strips it from the outgoing text and posts a branded embed alongside
 * the reply.
 *
 * Marker shape (body may span multiple lines):
 *   <NEON_CARD title="..." color="emerald" image="https://...">description</NEON_CARD>
 *
 * Colors are named, never raw hex, so every agent card stays inside the Neon
 * palette. Pure parser: no client, no send. Title/description/image are
 * redacted at the source; a redacted (broken) image URL simply drops the
 * image instead of leaking. Invalid markers are still stripped from the text.
 */

export interface INeonDiscordCardMarkerParseResult {
  /** Reply text with every card marker removed. */
  readonly text: string;
  /** First valid card found in the text, if any. */
  readonly card?: INeonDiscordEmbed;
}

export const neonDiscordCardMarkerColors: Readonly<Record<string, number>> = {
  emerald: NEON_DISCORD_ACCENT_COLOR,
  red: neonDiscordSeverityColors.critical,
  orange: neonDiscordSeverityColors.warning,
  blurple: neonDiscordSeverityColors.info
};

const CARD_MARKER_PATTERN =
  /<NEON_CARD title="([^"<>\r\n]{1,256})"(?: color="(emerald|red|orange|blurple)")?(?: image="(https?:\/\/[^"<>\s]{1,512})")?>([\s\S]{1,4096}?)<\/NEON_CARD>/gu;

/**
 * Extract the first valid `<NEON_CARD …>` marker from an agent reply and strip
 * every marker occurrence from the text. Returns the cleaned text plus the
 * embed model when the marker validates against the Discord embed limits.
 */
export function parseNeonDiscordCardMarker(text: string): INeonDiscordCardMarkerParseResult {
  let card: INeonDiscordEmbed | undefined;

  const cleaned = text.replace(
    CARD_MARKER_PATTERN,
    (_match, title: string, color: string | undefined, image: string | undefined, body: string) => {
      card = card ?? buildCardFromMarker(title, color, image, body);
      return "";
    }
  );

  return {
    text: cleaned.replace(/\n{3,}/gu, "\n\n").trim(),
    ...(card ? { card } : {})
  };
}

function buildCardFromMarker(
  title: string,
  color: string | undefined,
  image: string | undefined,
  body: string
): INeonDiscordEmbed | undefined {
  const cleanTitle = redactText(title.trim());
  if (cleanTitle.length === 0 || cleanTitle.length > NEON_DISCORD_EMBED_LIMITS.title) {
    return undefined;
  }

  const cleanBody = redactText(body.trim());
  if (cleanBody.length === 0 || cleanBody.length > NEON_DISCORD_EMBED_LIMITS.description) {
    return undefined;
  }

  // Redaction can mangle a token-bearing URL; if it is no longer a clean
  // http(s) URL afterwards, drop the image rather than the whole card.
  const cleanImage = image ? redactText(image) : undefined;
  const imageUrl = cleanImage && /^https?:\/\/\S+$/u.test(cleanImage) ? cleanImage : undefined;

  return {
    title: cleanTitle,
    description: cleanBody,
    color: neonDiscordCardMarkerColors[color ?? "emerald"] ?? NEON_DISCORD_ACCENT_COLOR,
    ...(imageUrl ? { imageUrl } : {})
  };
}
