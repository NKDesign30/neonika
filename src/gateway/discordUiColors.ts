/**
 * Adapted in part from OpenClaw extensions/discord/src/ui-colors.ts and approval-handler.runtime.ts.
 * See THIRD_PARTY_NOTICES.md for attribution and license details.
 */
/**
 * Shared Discord card colors for Neonika.
 *
 * Pattern rebuilt after OpenClaw's per-account accent + severity coloring
 * (openclaw extensions/discord/src/ui-colors.ts, approval-handler.runtime.ts):
 * every card carries a left accent bar so bot output reads as one brand, and
 * approval-like cards escalate by severity. Values are RGB integers as the
 * Discord embed `color` field expects.
 */
export const NEON_DISCORD_ACCENT_COLOR = 0xf28a4b;

export type TNeonDiscordCardSeverity = "critical" | "warning" | "info";

export const neonDiscordSeverityColors: {
  readonly [severity in TNeonDiscordCardSeverity]: number;
} = {
  critical: 0xed4245,
  warning: 0xfaa61a,
  info: 0x5865f2
};

/**
 * Renders a Discord client-side live countdown ("in 4 minutes", ticking) for
 * an ISO expiry timestamp — plain message text, no API feature required.
 */
export function formatNeonDiscordExpiryCountdown(expiresAtIso: string): string {
  const unixSeconds = Math.floor(Date.parse(expiresAtIso) / 1000);
  return `<t:${unixSeconds}:R>`;
}
