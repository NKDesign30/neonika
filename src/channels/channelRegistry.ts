/**
 * Neon channel registry.
 *
 * Read-only projection that folds the static channel manifest catalog
 * (`channelManifest.ts`) together with the *live* Discord route-inspection
 * snapshot (`gateway/routeInspection.ts`). Upstream exposes a runtime channel
 * registry (`src/channels/registry.ts`) that lists registered channel plugins
 * and their meta; Neon's version is intentionally narrower and safer: it never
 * loads a transport, never logs in, and never sends. Discord carries its real
 * configured auth/probe posture; every other platform is reported as a gated
 * inventory entry with outbound hard-suppressed.
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

/** Overall registry posture: driven by the one live channel (Discord). */
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
  readonly inbound: "live-tap" | "gated";
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
  const routeInspection = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
    ...(options.env ? { env: options.env } : {}),
    now
  });
  const discordAuth = routeInspection.authStatus.find((auth) => auth.channel === "discord");
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

    return {
      manifest,
      runtime: buildGatedRuntime(manifest)
    };
  });

  return {
    generatedAt: now().toISOString(),
    projectRoot,
    state: resolveRegistryState(discordAuth?.state ?? "needs-config"),
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
        ? `auth=${runtime.authState ?? "needs-config"} probe=${runtime.probeState ?? "unknown"}`
        : `login=${entry.manifest.loginPolicy}`;

    return `- ${entry.manifest.id}: ${runtime.liveStatus} inbound=${runtime.inbound} delivery=${runtime.delivery} ${liveDetail}`;
  });

  return [
    `Neon Channel Registry: ${snapshot.state}`,
    `Channels: total=${snapshot.totals.total} live=${snapshot.totals.live} gated=${snapshot.totals.gated} suppressed=${snapshot.totals.suppressed}`,
    "Routes:",
    ...lines
  ].join("\n");
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
  discordAuth: TNeonGatewayChannelAuthState
): TNeonChannelRegistryState {
  if (discordAuth === "unsafe") {
    return "unsafe";
  }

  if (discordAuth === "needs-config") {
    return "needs-config";
  }

  return "ready";
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
