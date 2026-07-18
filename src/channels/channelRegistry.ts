/**
 * Neon channel registry.
 *
 * Read-only projection that folds the static channel manifest catalog
 * (`channelManifest.ts`) together with Discord route inspection and WhatsApp
 * linked-session readiness. Upstream exposes a runtime channel
 * registry (`src/channels/registry.ts`) that lists registered channel plugins
 * and their meta; Neon's version is intentionally narrower and safer: it never
 * loads a transport, never logs in, and never sends. Discord and WhatsApp carry
 * real configured posture; every other platform is a gated inventory entry.
 *
 * This is the single inventory consumed by the `channel-registry` CLI, the
 * `/api/neon-channels` endpoint, the Doctor channel-manifest check, and the
 * Mission Control Channel View.
 */

import {
  listNeonChannelManifests,
  summarizeNeonChannelManifests,
  type INeonChannelManifest,
  type INeonChannelManifestTotals,
  type TNeonChannelLiveStatus,
  type TNeonChannelPlatform
} from "./channelManifest.js";
import {
  createNeonGatewayRouteInspectionSnapshot,
  type TNeonGatewayChannelAuthState
} from "../gateway/routeInspection.js";
import type { TNeonDiscordRouteProbeState } from "../gateway/discordRouteProbe.js";
import { inspectNeonWhatsAppAuthState } from "./whatsappAuth.js";

/** Overall registry posture across enabled live channels. */
export type TNeonChannelRegistryState = "ready" | "needs-config" | "unsafe";

/** Outbound posture per channel — always suppressed in shadow mode. */
export type TNeonChannelDeliveryPosture = "suppressed";

/**
 * Runtime status overlaid on a manifest. For Discord it carries the real
 * route-inspection auth + probe state; for gated channels it is the honest
 * "inventoried, not connected" posture.
 */
export interface INeonChannelRuntimeStatus {
  readonly liveStatus: TNeonChannelLiveStatus;
  readonly delivery: TNeonChannelDeliveryPosture;
  readonly inbound: "live-tap" | "disabled" | "gated";
  readonly authState?: TNeonGatewayChannelAuthState;
  readonly probeState?: TNeonDiscordRouteProbeState;
  readonly notes: readonly string[];
}

export interface INeonChannelRegistryEntry {
  readonly manifest: INeonChannelManifest;
  readonly runtime: INeonChannelRuntimeStatus;
}

export interface INeonChannelRegistryTotals extends INeonChannelManifestTotals {
  /** Channels whose outbound is suppressed — every channel, by contract. */
  readonly suppressed: number;
}

export interface INeonChannelRegistrySnapshot {
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly state: TNeonChannelRegistryState;
  readonly totals: INeonChannelRegistryTotals;
  readonly entries: readonly INeonChannelRegistryEntry[];
  readonly referenceImplementation: "src/channels/registry.ts";
}

export interface ICreateNeonChannelRegistrySnapshotOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export async function createNeonChannelRegistrySnapshot(
  projectRoot: string,
  options: ICreateNeonChannelRegistrySnapshotOptions = {}
): Promise<INeonChannelRegistrySnapshot> {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const routeInspection = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
    ...(options.env ? { env: options.env } : {}),
    now
  });
  const discordAuth = routeInspection.authStatus.find((auth) => auth.channel === "discord");
  const whatsappRuntime = await buildWhatsAppRuntime(env);
  const entries = listNeonChannelManifests().map((manifest): INeonChannelRegistryEntry => {
    if (manifest.id === "discord") {
      return {
        manifest,
        runtime: buildDiscordRuntime(
          discordAuth?.state ?? "needs-config",
          routeInspection.discordProbe.state
        )
      };
    }
    if (manifest.id === "whatsapp") {
      return { manifest, runtime: whatsappRuntime };
    }

    return {
      manifest,
      runtime: buildGatedRuntime(manifest)
    };
  });

  return {
    generatedAt: now().toISOString(),
    projectRoot,
    state: resolveRegistryState(
      discordAuth?.state ?? "needs-config",
      whatsappRuntime.authState
    ),
    totals: buildTotals(),
    entries,
    referenceImplementation: "src/channels/registry.ts"
  };
}

export function renderNeonChannelRegistryReport(
  snapshot: INeonChannelRegistrySnapshot
): string {
  const lines = snapshot.entries.map((entry) => {
    const runtime = entry.runtime;
    const liveDetail =
      runtime.liveStatus === "live"
        ? `auth=${runtime.authState ?? "disabled"} probe=${runtime.probeState ?? "n/a"}`
        : `login=${entry.manifest.loginPolicy}`;

    return `- ${entry.manifest.id}: ${runtime.liveStatus} inbound=${runtime.inbound} delivery=${runtime.delivery} ${liveDetail}`;
  });

  return [
    `Neonika Channel Registry: ${snapshot.state}`,
    `Channels: total=${snapshot.totals.total} live=${snapshot.totals.live} gated=${snapshot.totals.gated} suppressed=${snapshot.totals.suppressed}`,
    "Routes:",
    ...lines
  ].join("\n");
}

async function buildWhatsAppRuntime(
  env: Readonly<Record<string, string | undefined>>
): Promise<INeonChannelRuntimeStatus> {
  if (!isReadyLike(env["NEON_WHATSAPP_ENABLED"])) {
    return {
      liveStatus: "live",
      delivery: "suppressed",
      inbound: "disabled",
      notes: ["Live owner-only shadow tap is available but not enabled."]
    };
  }
  const authPath = env["NEON_WHATSAPP_AUTH_DIR"]?.trim();
  const ownerPeer = env["NEON_WHATSAPP_OWNER_PEER"]?.trim();
  if (!authPath || !ownerPeer) {
    return {
      liveStatus: "live",
      delivery: "suppressed",
      inbound: "disabled",
      authState: "needs-config",
      notes: ["WhatsApp is enabled but owner link or private auth path is missing."]
    };
  }
  const evidence = await inspectNeonWhatsAppAuthState(authPath);
  return evidence.state === "linked"
    ? {
        liveStatus: "live",
        delivery: "suppressed",
        inbound: "live-tap",
        authState: "ready",
        notes: ["Linked owner-only shadow tap; groups disabled; replies suppressed."]
      }
    : {
        liveStatus: "live",
        delivery: "suppressed",
        inbound: "disabled",
        authState: evidence.state === "invalid" ? "unsafe" : "needs-config",
        notes: [
          evidence.state === "invalid"
            ? "WhatsApp linked-device auth state is unsafe or invalid."
            : "WhatsApp linked-device login is pending."
        ]
      };
}

function buildDiscordRuntime(
  authState: TNeonGatewayChannelAuthState,
  probeState: TNeonDiscordRouteProbeState
): INeonChannelRuntimeStatus {
  return {
    liveStatus: "live",
    delivery: "suppressed",
    inbound: "live-tap",
    authState,
    probeState,
    notes: ["Live shadow tap; outbound suppressed until canary cutover."]
  };
}

function buildGatedRuntime(manifest: INeonChannelManifest): INeonChannelRuntimeStatus {
  return {
    liveStatus: "gated",
    delivery: "suppressed",
    inbound: "gated",
    notes: [
      `Inventoried manifest only (${manifest.transport}); ${manifest.loginPolicy}, no inbound, no send.`
    ]
  };
}

function resolveRegistryState(
  discordAuth: TNeonGatewayChannelAuthState,
  whatsappAuth: TNeonGatewayChannelAuthState | undefined
): TNeonChannelRegistryState {
  if (discordAuth === "unsafe" || whatsappAuth === "unsafe") {
    return "unsafe";
  }

  if (discordAuth === "needs-config" || whatsappAuth === "needs-config") {
    return "needs-config";
  }

  return "ready";
}

function isReadyLike(value: string | undefined): boolean {
  return ["1", "true", "ready", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function buildTotals(): INeonChannelRegistryTotals {
  const totals = summarizeNeonChannelManifests();

  return {
    ...totals,
    suppressed: totals.total
  };
}

const neonChannelRegistryPlatformOrder: readonly TNeonChannelPlatform[] =
  listNeonChannelManifests().map((manifest) => manifest.id);

export { neonChannelRegistryPlatformOrder };
