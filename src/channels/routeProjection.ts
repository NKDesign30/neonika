import type { INeonChannelInboundIdentity } from "./channelInbound.js";
import { neonChannelPlatforms, type TNeonChannelPlatform } from "./channelManifest.js";
import { redactText } from "../harness/redaction.js";

/**
 * Pure channel-route projection (no side effects, Shadow-safe).
 *
 * neon-core had no route/delivery-target model at all — grep for RouteRef /
 * normalizeRoutable / DeliveryContext across src returned zero. Upstream
 * normalizes a ChannelRouteRef across channels and cron sends
 * (src/channels/route-projection.ts normalizeRoutableChannelRoute). This is the
 * smallest native parity slice: a flat INeonChannelRouteRef, a total normalizer
 * that drops empties and requires channel + to (mirrors upstream's "no channel
 * or no target.to => undefined"), and a projection from the existing accepted
 * inbound identity. No outbound, no persistence — a routing fact only.
 */

export type TNeonChannelRouteChatType = "direct" | "group" | "channel";

/** A routable delivery target: which channel + account + recipient + thread. */
export interface INeonChannelRouteRef {
  readonly channel: TNeonChannelPlatform;
  readonly accountId?: string;
  readonly to: string;
  readonly threadId?: string;
  readonly chatType?: TNeonChannelRouteChatType;
}

/** Loose partial accepted by the normalizer; any field may be absent/empty. */
export interface INeonChannelRouteInput {
  readonly channel?: string | undefined;
  readonly accountId?: string | undefined;
  readonly to?: string | undefined;
  readonly threadId?: string | undefined;
  readonly chatType?: string | undefined;
}

function isNeonChannelPlatform(value: unknown): value is TNeonChannelPlatform {
  return typeof value === "string" && neonChannelPlatforms.includes(value as TNeonChannelPlatform);
}

function isNeonChannelRouteChatType(value: unknown): value is TNeonChannelRouteChatType {
  return value === "direct" || value === "group" || value === "channel";
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize a partial route into a routable ref, or undefined when it cannot
 * address a delivery target. Requires a known channel and a non-empty `to`
 * (upstream normalizeRoutableChannelRoute returns undefined without channel/to).
 * Pure: trims fields, drops empties, never throws.
 */
export function normalizeNeonChannelRoute(
  input: INeonChannelRouteInput
): INeonChannelRouteRef | undefined {
  if (!isNeonChannelPlatform(input.channel)) {
    return undefined;
  }
  const to = trimToUndefined(input.to);
  if (!to) {
    return undefined;
  }
  const accountId = trimToUndefined(input.accountId);
  const threadId = trimToUndefined(input.threadId);
  return {
    channel: input.channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(isNeonChannelRouteChatType(input.chatType) ? { chatType: input.chatType } : {})
  };
}

/**
 * Project an accepted inbound identity to the route a reply would target. The
 * reply goes back to the originating channel id; a workspace-scoped message is a
 * channel post, a workspace-less one is a direct message. Pure read.
 */
export function neonChannelRouteFromInboundIdentity(
  identity: INeonChannelInboundIdentity
): INeonChannelRouteRef | undefined {
  return normalizeNeonChannelRoute({
    channel: identity.platform,
    accountId: identity.accountId,
    to: identity.channelId,
    ...(identity.threadId ? { threadId: identity.threadId } : {}),
    chatType: identity.workspaceId ? "channel" : "direct"
  });
}

/**
 * Whether two routes address the same delivery target. Account ids only
 * disqualify when both are present and differ (mirrors upstream
 * routesShareDeliveryTarget). Pure.
 */
export function neonRoutesShareTarget(
  left: INeonChannelRouteRef | undefined,
  right: INeonChannelRouteRef | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  const sameAccount = !left.accountId || !right.accountId || left.accountId === right.accountId;
  return (
    left.channel === right.channel &&
    left.to === right.to &&
    sameAccount &&
    (left.threadId ?? "") === (right.threadId ?? "")
  );
}

/**
 * Leak-safe one-line description of a route for previews/logs. The target id
 * goes through redactText; only channel + chatType + presence flags are shown
 * directly. Never emits secrets.
 */
export function describeNeonChannelRoute(route: INeonChannelRouteRef): string {
  const parts: string[] = [route.channel];
  if (route.chatType) {
    parts.push(route.chatType);
  }
  parts.push(`to=${redactText(route.to)}`);
  if (route.threadId) {
    parts.push("thread");
  }
  if (route.accountId) {
    parts.push("acct");
  }
  return parts.join(" ");
}
