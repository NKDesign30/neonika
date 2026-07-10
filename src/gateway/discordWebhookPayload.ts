import { buildNeonDiscordEmbedPayload, type INeonDiscordEmbed } from "./discordRichPayload.js";

/**
 * Pure, side-effect-free builder + validator for a Discord webhook message
 * (proxy identity). Mirrors the other discord*Payload builders: it validates a
 * leak-safe Neon webhook model up front so the gated webhook transport never
 * hands discord.js a payload the API would reject.
 *
 * Webhook send is a distinct trust vector: it can post under an arbitrary
 * username/avatar (a proxy identity), so the username is bounded and the
 * Discord-forbidden substrings ("clyde"/"discord") are rejected. The webhook URL
 * itself carries a token secret and is handled only by the transport, never here.
 */

export const NEON_DISCORD_WEBHOOK_LIMITS = {
  username: 80,
  content: 2000
} as const;

// Discord rejects webhook usernames containing these (case-insensitive).
const FORBIDDEN_USERNAME_SUBSTRINGS: readonly string[] = ["clyde", "discord"];

export interface INeonWebhookPayload {
  readonly content: string;
  /** Proxy display name. 1–80 chars, may not contain "clyde"/"discord". */
  readonly username?: string;
  /** Proxy avatar. Must be http(s). */
  readonly avatarUrl?: string;
  readonly embeds?: readonly INeonDiscordEmbed[];
  readonly threadId?: string;
}

export interface INeonValidatedWebhookPayload {
  readonly content: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly embeds?: readonly INeonDiscordEmbed[];
  readonly threadId?: string;
}

export type TNeonWebhookBuildResult =
  | { readonly ok: true; readonly payload: INeonValidatedWebhookPayload }
  | { readonly ok: false; readonly errors: readonly string[] };

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Validate + build a webhook payload. Returns every validation error at once. On
 * any error the result is `ok: false` and the transport stays suppressed.
 */
export function buildNeonWebhookPayload(payload: INeonWebhookPayload): TNeonWebhookBuildResult {
  const errors: string[] = [];

  const content = payload.content.trim();
  const hasEmbeds = (payload.embeds?.length ?? 0) > 0;
  if (content.length === 0 && !hasEmbeds) {
    errors.push("webhook payload requires content or at least one embed");
  }
  if (content.length > NEON_DISCORD_WEBHOOK_LIMITS.content) {
    errors.push(`webhook content exceeds ${NEON_DISCORD_WEBHOOK_LIMITS.content} chars`);
  }

  if (payload.username !== undefined) {
    const username = payload.username.trim();
    if (username.length === 0 || username.length > NEON_DISCORD_WEBHOOK_LIMITS.username) {
      errors.push(`webhook username must be 1–${NEON_DISCORD_WEBHOOK_LIMITS.username} chars`);
    } else {
      const lowered = username.toLowerCase();
      const forbidden = FORBIDDEN_USERNAME_SUBSTRINGS.find((needle) => lowered.includes(needle));
      if (forbidden) {
        errors.push(`webhook username may not contain "${forbidden}"`);
      }
    }
  }

  if (payload.avatarUrl !== undefined && !isHttpUrl(payload.avatarUrl)) {
    errors.push("webhook avatarUrl must be http(s)");
  }

  if (payload.embeds && payload.embeds.length > 0) {
    const embedResult = buildNeonDiscordEmbedPayload(payload.embeds);
    if (!embedResult.ok) {
      errors.push(`embeds: ${embedResult.errors.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    payload: {
      content,
      ...(payload.username !== undefined ? { username: payload.username.trim() } : {}),
      ...(payload.avatarUrl !== undefined ? { avatarUrl: payload.avatarUrl } : {}),
      ...(payload.embeds !== undefined ? { embeds: payload.embeds } : {}),
      ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {})
    }
  };
}
