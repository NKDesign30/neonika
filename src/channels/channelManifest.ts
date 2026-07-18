/**
 * Generic Neon channel contract.
 *
 * Upstream models each messaging platform as a channel plugin with a capability
 * manifest (`src/channels/plugins/types.core.ts: ChannelMeta`,
 * `src/channels/registry.ts`, and per-platform `extensions/<channel>/openclaw.plugin.json`).
 * Neonika rebuilds the *shape* of that idea natively: a static, leak-safe
 * capability manifest per platform, instead of dynamically loading channel
 * plugin implementations (which upstream deliberately keeps "heavy" because they
 * pull in live transports, monitors, and web login).
 *
 * Why static and gated, not live: the project's shadow contract keeps Discord as
 * the only live channel. Telegram/Slack/WhatsApp/Matrix/Teams are inventoried as
 * `gated` capabilities — modeled, route-inspectable, Doctor-checkable — but they
 * never open a new live login and never send. This file is the source of truth
 * for "what channels exist and what they can do", consumed by the channel
 * registry, route inspection, Doctor, and Mission Control.
 */

/** Messaging platform identifiers Neon models as channel capabilities. */
export type TNeonChannelPlatform =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "matrix"
  | "msteams";

/**
 * Live posture of a channel. `live` means a real inbound transport is wired and
 * exercised (Discord shadow tap). `gated` means the capability is inventoried
 * but intentionally not connected — no login, no inbound, no send.
 */
export type TNeonChannelLiveStatus = "live" | "gated";

/**
 * Inbound transport binding. Only Discord has a real adapter; every other
 * platform is `manifest-only` until a future, separately-approved slice.
 */
export type TNeonChannelTransport = "discord.js" | "manifest-only";

/** How a platform names its top-level, account-scoped container. */
export type TNeonChannelWorkspaceScope =
  | "guild" // Discord
  | "chat" // Telegram (chats / groups / channels)
  | "workspace" // Slack
  | "account" // WhatsApp (no workspace; per-account groups/DMs)
  | "homeserver" // Matrix (rooms under a homeserver)
  | "team"; // Microsoft Teams

/**
 * Login posture. Only Discord may reuse an existing live session; every other
 * platform is hard-pinned to `no-new-login` to enforce the goal constraint
 * "keine neuen Live-Logins außer Discord".
 */
export type TNeonChannelLoginPolicy = "existing-discord-session" | "no-new-login";

/** Inbound message-handling capabilities a platform exposes. */
export interface INeonChannelInboundCapabilities {
  readonly messages: boolean;
  readonly mentions: boolean;
  readonly threads: boolean;
  readonly slashCommands: boolean;
  readonly attachments: boolean;
}

/** Outbound delivery capabilities a platform exposes (all suppressed at runtime). */
export interface INeonChannelOutboundCapabilities {
  readonly text: boolean;
  readonly attachments: boolean;
  readonly reactions: boolean;
  readonly threads: boolean;
}

/**
 * Static capability manifest for one messaging platform. Pure, leak-safe data:
 * no tokens, no account ids, no secrets — only what the platform *can* do and
 * how Neon is allowed to talk to it.
 */
export interface INeonChannelManifest {
  readonly id: TNeonChannelPlatform;
  readonly label: string;
  readonly blurb: string;
  readonly liveStatus: TNeonChannelLiveStatus;
  readonly transport: TNeonChannelTransport;
  readonly workspaceScope: TNeonChannelWorkspaceScope;
  readonly markdownCapable: boolean;
  readonly requiresLogin: boolean;
  readonly loginPolicy: TNeonChannelLoginPolicy;
  readonly allowlistSupported: boolean;
  readonly mentionPolicySupported: boolean;
  readonly inbound: INeonChannelInboundCapabilities;
  readonly outbound: INeonChannelOutboundCapabilities;
  /** Concrete upstream reference path this manifest mirrors. */
  readonly referenceImplementation: string;
}

/** Totals projected over the manifest catalog. */
export interface INeonChannelManifestTotals {
  readonly total: number;
  readonly live: number;
  readonly gated: number;
}

const richInbound: INeonChannelInboundCapabilities = {
  messages: true,
  mentions: true,
  threads: true,
  slashCommands: true,
  attachments: true
};

const richOutbound: INeonChannelOutboundCapabilities = {
  text: true,
  attachments: true,
  reactions: true,
  threads: true
};

/**
 * The channel capability catalog. Discord is the one live channel; the rest are
 * gated manifests mirroring upstream's per-platform channel plugins. Capability
 * flags reflect well-established platform facts (e.g. WhatsApp has no native
 * slash commands and only inline-style markdown), not fabricated data.
 *
 * Ordered Discord-first (the live channel), then alphabetically.
 */
export const neonChannelManifests: readonly INeonChannelManifest[] = Object.freeze([
  {
    id: "discord",
    label: "Discord",
    blurb: "Live shadow channel: guilds, DMs, threads, slash commands.",
    liveStatus: "live",
    transport: "discord.js",
    workspaceScope: "guild",
    markdownCapable: true,
    requiresLogin: true,
    loginPolicy: "existing-discord-session",
    allowlistSupported: true,
    mentionPolicySupported: true,
    inbound: richInbound,
    outbound: richOutbound,
    referenceImplementation: "extensions/discord/openclaw.plugin.json"
  },
  {
    id: "matrix",
    label: "Matrix",
    blurb: "Gated manifest: rooms and direct messages under a homeserver.",
    liveStatus: "gated",
    transport: "manifest-only",
    workspaceScope: "homeserver",
    markdownCapable: true,
    requiresLogin: true,
    loginPolicy: "no-new-login",
    allowlistSupported: true,
    mentionPolicySupported: true,
    inbound: {
      messages: true,
      mentions: true,
      threads: true,
      slashCommands: false,
      attachments: true
    },
    outbound: richOutbound,
    referenceImplementation: "extensions/matrix/openclaw.plugin.json"
  },
  {
    id: "msteams",
    label: "Microsoft Teams",
    blurb: "Gated manifest: bot conversations across teams and channels.",
    liveStatus: "gated",
    transport: "manifest-only",
    workspaceScope: "team",
    markdownCapable: true,
    requiresLogin: true,
    loginPolicy: "no-new-login",
    allowlistSupported: true,
    mentionPolicySupported: true,
    inbound: {
      messages: true,
      mentions: true,
      threads: true,
      slashCommands: false,
      attachments: true
    },
    outbound: richOutbound,
    referenceImplementation: "extensions/msteams/openclaw.plugin.json"
  },
  {
    id: "slack",
    label: "Slack",
    blurb: "Gated manifest: channels, DMs, commands, and app events.",
    liveStatus: "gated",
    transport: "manifest-only",
    workspaceScope: "workspace",
    markdownCapable: true,
    requiresLogin: true,
    loginPolicy: "no-new-login",
    allowlistSupported: true,
    mentionPolicySupported: true,
    inbound: richInbound,
    outbound: richOutbound,
    referenceImplementation: "extensions/slack/openclaw.plugin.json"
  },
  {
    id: "telegram",
    label: "Telegram",
    blurb: "Gated manifest: chats, groups, channels, and bot commands.",
    liveStatus: "gated",
    transport: "manifest-only",
    workspaceScope: "chat",
    markdownCapable: true,
    requiresLogin: true,
    loginPolicy: "no-new-login",
    allowlistSupported: true,
    mentionPolicySupported: true,
    inbound: {
      messages: true,
      mentions: true,
      threads: false,
      slashCommands: true,
      attachments: true
    },
    outbound: richOutbound,
    referenceImplementation: "extensions/telegram/openclaw.plugin.json"
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    blurb: "Gated manifest: WhatsApp Web chats and groups.",
    liveStatus: "gated",
    transport: "manifest-only",
    workspaceScope: "account",
    markdownCapable: false,
    requiresLogin: true,
    loginPolicy: "no-new-login",
    allowlistSupported: true,
    mentionPolicySupported: true,
    inbound: {
      messages: true,
      mentions: true,
      threads: false,
      slashCommands: false,
      attachments: true
    },
    outbound: {
      text: true,
      attachments: true,
      reactions: true,
      threads: false
    },
    referenceImplementation: "extensions/whatsapp/openclaw.plugin.json"
  }
]);

const neonChannelManifestById: ReadonlyMap<TNeonChannelPlatform, INeonChannelManifest> = new Map(
  neonChannelManifests.map((manifest) => [manifest.id, manifest])
);

/** Platform ids in catalog order. */
export const neonChannelPlatforms: readonly TNeonChannelPlatform[] = neonChannelManifests.map(
  (manifest) => manifest.id
);

const neonChannelPlatformSet: ReadonlySet<string> = new Set(neonChannelPlatforms);

export function isNeonChannelPlatform(value: unknown): value is TNeonChannelPlatform {
  return typeof value === "string" && neonChannelPlatformSet.has(value);
}

export function getNeonChannelManifest(
  id: TNeonChannelPlatform
): INeonChannelManifest | undefined {
  return neonChannelManifestById.get(id);
}

export function listNeonChannelManifests(): readonly INeonChannelManifest[] {
  return neonChannelManifests;
}

export function summarizeNeonChannelManifests(
  manifests: readonly INeonChannelManifest[] = neonChannelManifests
): INeonChannelManifestTotals {
  let live = 0;
  for (const manifest of manifests) {
    if (manifest.liveStatus === "live") {
      live += 1;
    }
  }

  return {
    total: manifests.length,
    live,
    gated: manifests.length - live
  };
}

/**
 * One-line, leak-safe summary of a manifest for CLI/report rendering. Carries
 * only capability metadata — never account ids, tokens, or runtime state.
 */
export function renderNeonChannelManifestLine(manifest: INeonChannelManifest): string {
  return [
    `${manifest.id}=${manifest.liveStatus}`,
    `transport=${manifest.transport}`,
    `scope=${manifest.workspaceScope}`,
    `login=${manifest.loginPolicy}`,
    `markdown=${manifest.markdownCapable ? "yes" : "no"}`
  ].join(" ");
}
