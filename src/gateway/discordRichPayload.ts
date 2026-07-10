import type { APIEmbed, APIEmbedField } from "discord.js";

/**
 * Pure, side-effect-free builder + validator for Discord rich message payloads
 * (currently embeds). It translates a leak-safe Neon embed model into the raw
 * `APIEmbed` shape that `channel.send({ embeds })` accepts, enforcing Discord's
 * documented hard limits up front so the gated canary transport never hands
 * discord.js a payload the API would reject at send time.
 *
 * No network, no client, no token — this is the read-only half of the embed
 * capability. The gated transport (the only live-side-effect site) consumes the
 * validated output. Validation uses a Result shape (no throw for caller-input
 * errors) so the transport can stay suppressed and surface the reason.
 */

// Discord API hard limits (stable platform constants, not discord.js-specific).
export const NEON_DISCORD_EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  embedsPerMessage: 10,
  totalChars: 6000
} as const;

export interface INeonDiscordEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface INeonDiscordEmbed {
  readonly title?: string;
  readonly description?: string;
  readonly url?: string;
  /** RGB integer (0x000000–0xFFFFFF). Out-of-range values are rejected. */
  readonly color?: number;
  readonly fields?: readonly INeonDiscordEmbedField[];
  /** Large embed image (CDN surface). Must be http(s); not counted toward the 6000-char total. */
  readonly imageUrl?: string;
  /** Small corner thumbnail (CDN surface). Must be http(s). */
  readonly thumbnailUrl?: string;
  readonly footerText?: string;
  /** Footer icon, shown left of the footer text. Requires footerText; must be http(s). */
  readonly footerIconUrl?: string;
  readonly authorName?: string;
  /** Author link target. Requires authorName; must be http(s). */
  readonly authorUrl?: string;
  /** Author avatar icon, shown left of the author name. Requires authorName; must be http(s). */
  readonly authorIconUrl?: string;
  /** ISO-8601 timestamp; invalid strings are rejected rather than silently dropped. */
  readonly timestamp?: string;
}

export type TNeonDiscordEmbedBuildResult =
  | { readonly ok: true; readonly embeds: readonly APIEmbed[] }
  | { readonly ok: false; readonly errors: readonly string[] };

function embedCharCount(embed: APIEmbed): number {
  let total = 0;
  total += embed.title?.length ?? 0;
  total += embed.description?.length ?? 0;
  total += embed.footer?.text.length ?? 0;
  total += embed.author?.name.length ?? 0;
  for (const field of embed.fields ?? []) {
    total += field.name.length + field.value.length;
  }
  return total;
}

function validateField(field: INeonDiscordEmbedField, index: number, errors: string[]): APIEmbedField | undefined {
  const name = field.name.trim();
  const value = field.value.trim();
  if (name.length === 0 || value.length === 0) {
    errors.push(`embed field ${index} requires a non-empty name and value`);
    return undefined;
  }
  if (name.length > NEON_DISCORD_EMBED_LIMITS.fieldName) {
    errors.push(`embed field ${index} name exceeds ${NEON_DISCORD_EMBED_LIMITS.fieldName} chars`);
    return undefined;
  }
  if (value.length > NEON_DISCORD_EMBED_LIMITS.fieldValue) {
    errors.push(`embed field ${index} value exceeds ${NEON_DISCORD_EMBED_LIMITS.fieldValue} chars`);
    return undefined;
  }
  return { name, value, ...(field.inline !== undefined ? { inline: field.inline } : {}) };
}

function buildOneEmbed(input: INeonDiscordEmbed, index: number, errors: string[]): APIEmbed | undefined {
  const embed: APIEmbed = {};
  const before = errors.length;

  if (input.title !== undefined) {
    if (input.title.trim().length === 0 || input.title.length > NEON_DISCORD_EMBED_LIMITS.title) {
      errors.push(`embed ${index} title must be 1–${NEON_DISCORD_EMBED_LIMITS.title} chars`);
    } else {
      embed.title = input.title;
    }
  }
  if (input.description !== undefined) {
    if (input.description.length > NEON_DISCORD_EMBED_LIMITS.description) {
      errors.push(`embed ${index} description exceeds ${NEON_DISCORD_EMBED_LIMITS.description} chars`);
    } else {
      embed.description = input.description;
    }
  }
  if (input.url !== undefined) {
    if (!isHttpUrl(input.url)) {
      errors.push(`embed ${index} url must be http(s)`);
    } else {
      embed.url = input.url;
    }
  }
  if (input.imageUrl !== undefined) {
    if (!isHttpUrl(input.imageUrl)) {
      errors.push(`embed ${index} imageUrl must be http(s)`);
    } else {
      embed.image = { url: input.imageUrl };
    }
  }
  if (input.thumbnailUrl !== undefined) {
    if (!isHttpUrl(input.thumbnailUrl)) {
      errors.push(`embed ${index} thumbnailUrl must be http(s)`);
    } else {
      embed.thumbnail = { url: input.thumbnailUrl };
    }
  }
  if (input.color !== undefined) {
    if (!Number.isInteger(input.color) || input.color < 0 || input.color > 0xffffff) {
      errors.push(`embed ${index} color must be an integer 0x000000–0xFFFFFF`);
    } else {
      embed.color = input.color;
    }
  }
  if (input.timestamp !== undefined) {
    const ms = Date.parse(input.timestamp);
    if (Number.isNaN(ms)) {
      errors.push(`embed ${index} timestamp must be an ISO-8601 date`);
    } else {
      embed.timestamp = new Date(ms).toISOString();
    }
  }
  // A footer icon has no surface without footer text; reject rather than silently drop it.
  if (input.footerIconUrl !== undefined && (input.footerText === undefined || input.footerText.trim().length === 0)) {
    errors.push(`embed ${index} footerIconUrl requires a non-empty footerText`);
  }
  if (input.footerText !== undefined) {
    if (input.footerText.length > NEON_DISCORD_EMBED_LIMITS.footerText) {
      errors.push(`embed ${index} footer exceeds ${NEON_DISCORD_EMBED_LIMITS.footerText} chars`);
    } else if (input.footerText.trim().length > 0) {
      embed.footer = { text: input.footerText };
      if (input.footerIconUrl !== undefined) {
        if (!isHttpUrl(input.footerIconUrl)) {
          errors.push(`embed ${index} footerIconUrl must be http(s)`);
        } else {
          embed.footer.icon_url = input.footerIconUrl;
        }
      }
    }
  }
  // Author url/icon both require an author name to attach to.
  if (
    (input.authorUrl !== undefined || input.authorIconUrl !== undefined) &&
    (input.authorName === undefined || input.authorName.trim().length === 0)
  ) {
    errors.push(`embed ${index} authorUrl/authorIconUrl require a non-empty authorName`);
  }
  if (input.authorName !== undefined) {
    if (input.authorName.length > NEON_DISCORD_EMBED_LIMITS.authorName) {
      errors.push(`embed ${index} author exceeds ${NEON_DISCORD_EMBED_LIMITS.authorName} chars`);
    } else if (input.authorName.trim().length > 0) {
      embed.author = { name: input.authorName };
      if (input.authorUrl !== undefined) {
        if (!isHttpUrl(input.authorUrl)) {
          errors.push(`embed ${index} authorUrl must be http(s)`);
        } else {
          embed.author.url = input.authorUrl;
        }
      }
      if (input.authorIconUrl !== undefined) {
        if (!isHttpUrl(input.authorIconUrl)) {
          errors.push(`embed ${index} authorIconUrl must be http(s)`);
        } else {
          embed.author.icon_url = input.authorIconUrl;
        }
      }
    }
  }
  if (input.fields !== undefined) {
    if (input.fields.length > NEON_DISCORD_EMBED_LIMITS.fields) {
      errors.push(`embed ${index} exceeds ${NEON_DISCORD_EMBED_LIMITS.fields} fields`);
    } else {
      const built: APIEmbedField[] = [];
      input.fields.forEach((field, fieldIndex) => {
        const result = validateField(field, fieldIndex, errors);
        if (result) {
          built.push(result);
        }
      });
      if (built.length > 0) {
        embed.fields = built;
      }
    }
  }

  if (errors.length > before) {
    return undefined;
  }
  if (Object.keys(embed).length === 0) {
    errors.push(`embed ${index} is empty; provide at least a title, description, or field`);
    return undefined;
  }
  return embed;
}

/**
 * Validate + build a bounded set of Discord embeds. Returns every validation
 * error at once (not just the first) so an operator fixing a payload sees the
 * full picture. On any error the result is `ok: false` and the transport stays
 * suppressed.
 */
export function buildNeonDiscordEmbedPayload(
  embeds: readonly INeonDiscordEmbed[]
): TNeonDiscordEmbedBuildResult {
  const errors: string[] = [];

  if (embeds.length === 0) {
    return { ok: false, errors: ["at least one embed is required"] };
  }
  if (embeds.length > NEON_DISCORD_EMBED_LIMITS.embedsPerMessage) {
    errors.push(`a message carries at most ${NEON_DISCORD_EMBED_LIMITS.embedsPerMessage} embeds`);
  }

  const built: APIEmbed[] = [];
  embeds.forEach((embed, index) => {
    const result = buildOneEmbed(embed, index, errors);
    if (result) {
      built.push(result);
    }
  });

  const totalChars = built.reduce((sum, embed) => sum + embedCharCount(embed), 0);
  if (totalChars > NEON_DISCORD_EMBED_LIMITS.totalChars) {
    errors.push(`combined embed text ${totalChars} exceeds the ${NEON_DISCORD_EMBED_LIMITS.totalChars}-char message cap`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, embeds: built };
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}
