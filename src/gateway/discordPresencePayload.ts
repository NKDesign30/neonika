import { ActivityType } from "discord.js";
import type { PresenceData } from "discord.js";

/**
 * Pure, side-effect-free builder + validator for a Discord bot presence update
 * (status + optional activity). Mirrors the other discord*Payload builders: it
 * validates a leak-safe Neon presence model up front and maps it to the discord.js
 * `PresenceData` shape that `client.user.setPresence(...)` accepts, so the gated
 * presence transport never hands discord.js an invalid update.
 *
 * Presence is client-global (not channel-scoped), so it has its own transport
 * (discordPresenceTransport) rather than living on the channel-send outbound
 * transport. No client, no token here — this is the read-only half.
 */

// Discord activity name hard limit (stable platform constant).
export const NEON_DISCORD_PRESENCE_LIMITS = {
  activityName: 128,
  activityState: 128
} as const;

export type TNeonDiscordPresenceStatus = "online" | "idle" | "dnd" | "invisible";

export type TNeonDiscordActivityType =
  | "playing"
  | "streaming"
  | "listening"
  | "watching"
  | "custom"
  | "competing";

export interface INeonDiscordActivity {
  readonly type: TNeonDiscordActivityType;
  /** Shown text for non-custom types; for custom, the activity label. 1–128 chars. */
  readonly name: string;
  /** Custom-status text (ActivityType.Custom). 1–128 chars when present. */
  readonly state?: string;
  /**
   * Stream URL for type "streaming". Discord only renders the live badge for
   * twitch.tv / youtube.com URLs, so any other host is rejected rather than
   * silently shown as a plain "Playing".
   */
  readonly url?: string;
}

export interface INeonDiscordPresence {
  readonly status: TNeonDiscordPresenceStatus;
  readonly activity?: INeonDiscordActivity;
}

export type TNeonDiscordPresenceBuildResult =
  | { readonly ok: true; readonly presence: PresenceData }
  | { readonly ok: false; readonly errors: readonly string[] };

const VALID_STATUSES: ReadonlySet<string> = new Set<TNeonDiscordPresenceStatus>([
  "online",
  "idle",
  "dnd",
  "invisible"
]);

const ACTIVITY_TYPE_BY_NAME: Record<TNeonDiscordActivityType, ActivityType> = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  custom: ActivityType.Custom,
  competing: ActivityType.Competing
};

/**
 * Validate + build a presence update. Returns every validation error at once. On
 * any error the result is `ok: false` and the transport stays suppressed.
 */
export function buildNeonDiscordPresencePayload(
  presence: INeonDiscordPresence
): TNeonDiscordPresenceBuildResult {
  const errors: string[] = [];

  if (!VALID_STATUSES.has(presence.status)) {
    errors.push(`presence status "${presence.status}" must be one of online/idle/dnd/invisible`);
  }

  const activities: NonNullable<PresenceData["activities"]>[number][] = [];
  if (presence.activity !== undefined) {
    const activity = presence.activity;
    const name = activity.name.trim();
    if (name.length === 0) {
      errors.push("presence activity requires a non-empty name");
    } else if (name.length > NEON_DISCORD_PRESENCE_LIMITS.activityName) {
      errors.push(`presence activity name exceeds ${NEON_DISCORD_PRESENCE_LIMITS.activityName} chars`);
    }
    if (!(activity.type in ACTIVITY_TYPE_BY_NAME)) {
      errors.push(`presence activity type "${activity.type}" is not supported`);
    }
    if (activity.state !== undefined && activity.state.length > NEON_DISCORD_PRESENCE_LIMITS.activityState) {
      errors.push(`presence activity state exceeds ${NEON_DISCORD_PRESENCE_LIMITS.activityState} chars`);
    }
    if (activity.url !== undefined) {
      if (activity.type !== "streaming") {
        errors.push('presence activity url is only valid for type "streaming"');
      } else if (!isStreamingUrl(activity.url)) {
        errors.push("presence activity url must be an http(s) twitch.tv or youtube.com URL");
      }
    }

    if (errors.length === 0) {
      activities.push({
        name,
        type: ACTIVITY_TYPE_BY_NAME[activity.type],
        ...(activity.state !== undefined && activity.state.trim().length > 0 ? { state: activity.state } : {}),
        ...(activity.url !== undefined ? { url: activity.url } : {})
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, presence: { status: presence.status, activities } };
}

// Hosts Discord recognises for the streaming activity badge. Apex + any subdomain.
const NEON_DISCORD_STREAMING_HOSTS: readonly string[] = ["twitch.tv", "youtube.com"];

function isStreamingUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return NEON_DISCORD_STREAMING_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
