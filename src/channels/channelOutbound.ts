/**
 * Generic Neon channel outbound policy.
 *
 * Default is no-send. The only platform with a real (still gated) live delivery
 * path is Discord, governed by the canary cutover gate
 * (`gateway/outboundSender.ts: createNeonCanaryOutboundSender` +
 * `evaluateNeonCanaryLivePreconditions`). Every manifest-only platform is
 * hard-suppressed because no transport exists to send through. This module
 * projects, per platform, whether outbound is `suppressed` (no path) or
 * `canary-gated` (a gated path exists), and whether the gate is currently open —
 * reusing the existing canary precondition evaluation rather than duplicating it.
 */

import {
  evaluateNeonCanaryLivePreconditions,
  type INeonCanaryLivePreconditions
} from "../gateway/outboundSender.js";
import {
  getNeonChannelManifest,
  type TNeonChannelPlatform
} from "./channelManifest.js";

/**
 * `suppressed` = no live transport, hard no-send. `canary-gated` = a gated live
 * path exists (Discord) whose `canSend` follows the canary cutover gate.
 */
export type TNeonChannelOutboundMode = "suppressed" | "canary-gated";

export interface INeonChannelOutboundPolicy {
  readonly platform: TNeonChannelPlatform;
  readonly mode: TNeonChannelOutboundMode;
  readonly canSend: boolean;
  readonly reason: string;
  /** Present only for the channel with a gated live path (Discord). */
  readonly canary?: INeonCanaryLivePreconditions;
}

export interface IResolveNeonChannelOutboundPolicyOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function resolveNeonChannelOutboundPolicy(
  platform: TNeonChannelPlatform,
  options: IResolveNeonChannelOutboundPolicyOptions = {}
): INeonChannelOutboundPolicy {
  const manifest = getNeonChannelManifest(platform);

  // Manifest-only platforms have no transport: always hard-suppressed.
  if (!manifest || manifest.transport === "manifest-only") {
    return {
      platform,
      mode: "suppressed",
      canSend: false,
      reason: "No live transport (manifest-only); outbound hard-suppressed."
    };
  }

  // Discord: a gated live path exists; the canary gate decides if it is open.
  const canary = evaluateNeonCanaryLivePreconditions(options.env ?? process.env);

  return {
    platform,
    mode: "canary-gated",
    canSend: canary.ready,
    reason: canary.ready
      ? "Canary gate open; outbound permitted to explicitly allowlisted channels."
      : "Canary gate closed; outbound suppressed by default.",
    canary
  };
}

export function resolveAllNeonChannelOutboundPolicies(
  platforms: readonly TNeonChannelPlatform[],
  options: IResolveNeonChannelOutboundPolicyOptions = {}
): readonly INeonChannelOutboundPolicy[] {
  return platforms.map((platform) => resolveNeonChannelOutboundPolicy(platform, options));
}

export function renderNeonChannelOutboundPolicyLine(
  policy: INeonChannelOutboundPolicy
): string {
  return `${policy.platform}: mode=${policy.mode} canSend=${policy.canSend ? "yes" : "no"}`;
}
