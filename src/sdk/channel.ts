// Neon SDK — Channel surface.
//
// Curated, stable contract for a channel author: the channel identity, the
// inbound-message shape the gateway ingests, the shadow run/delivery records a
// channel produces, and the outbound send seam (dry-run no-op + canary-gated
// live sender). The one concrete channel adapter (Discord) contributes its
// envelope, ingress decision, and slash-interaction mapping as the reference
// shape. Thin re-export facade over `gateway/types.ts`,
// `gateway/outboundSender.ts`, and `gateway/discordIngress.ts` — no behavior,
// no code moved.
//
// Delivery/ingress orchestration (e.g. running a shadow ingress end to end)
// stays in the runtime barrel; the SDK exposes the contracts, not the drivers.

// Channel identity.
export type { TNeonChannel } from "../harness/types.js";

// Inbound + shadow-run record contracts.
export type {
  INeonGatewayDeliveryResult,
  INeonGatewayInboundMessage,
  INeonGatewayPersistedFinding,
  INeonGatewayRunRequest,
  INeonGatewayShadowInput,
  INeonGatewayShadowRun,
  TNeonGatewayDeliveryState,
  TNeonGatewayRunMode,
  TNeonGatewayRunStatus
} from "../gateway/types.js";

// Outbound send seam: dry-run no-op + canary-gated live sender + eligibility.
export {
  createNeonCanaryOutboundSender,
  createNeonDryRunOutboundSender,
  evaluateNeonCanaryLivePreconditions,
  isNeonCanaryChannelEligible,
  resolveNeonCanaryChannelAllowlist
} from "../gateway/outboundSender.js";

export type {
  INeonCanaryChannelAllowlist,
  INeonCanaryLivePreconditions,
  INeonCanaryOutboundGateFacts,
  INeonCanaryOutboundSenderOptions,
  INeonDryRunOutboundSenderOptions,
  INeonOutboundSendResult,
  INeonOutboundSender,
  INeonOutboundSentResult,
  INeonOutboundSuppressedResult,
  INeonOutboundTransport
} from "../gateway/outboundSender.js";

// Reference channel adapter (Discord): envelope + ingress decision + slash map.
export {
  createNeonDiscordIngressDecision,
  mapDiscordSlashInteractionToMessageEnvelope,
  normalizeDiscordContent
} from "../gateway/discordIngress.js";

export type {
  INeonDiscordAuthor,
  INeonDiscordIngressInput,
  INeonDiscordIngressPolicy,
  INeonDiscordMessageEnvelope,
  INeonDiscordSlashInteractionEnvelope,
  INeonDiscordSlashOption,
  TDiscordMentionPolicy,
  TNeonDiscordDropReason,
  TNeonDiscordIngressDecision,
  TNeonDiscordIngressDecisionState,
  TNeonDiscordSlashOptionValue
} from "../gateway/discordIngress.js";

// Channel-registry domain (per-platform manifests + registry snapshot). Bundled
// wholesale via `export *` so this surface stays the one channel contract import
// and tracks the domain module without per-symbol coupling.
export * from "../channels/channelManifest.js";
export * from "../channels/channelRegistry.js";
