// Neonika SDK — surface manifest.
//
// The single source of truth describing the curated SDK layer: which contract
// surfaces exist, what each curates, and which upstream package it mirrors. The
// `sdk` CLI command renders this; the surface test asserts every listed surface
// actually exports its declared anchor symbols, so the manifest can never drift
// from the real barrel without failing a check.

export const NEON_SDK_VERSION = "0.1.0";

export type TNeonSdkSurfaceId = "gateway-client" | "channel" | "tool" | "plugin";

/** The JS identifier each surface is reachable under on the umbrella barrel. */
export type TNeonSdkNamespace = "gatewayClient" | "channel" | "tool" | "plugin";

export type TNeonSdkSurfaceStability = "stable" | "preview";

export interface INeonSdkSurface {
  readonly id: TNeonSdkSurfaceId;
  readonly title: string;
  readonly summary: string;
  readonly stability: TNeonSdkSurfaceStability;
  /** Namespace this surface is reachable under on the umbrella barrel. */
  readonly namespace: TNeonSdkNamespace;
  /** `src/` implementation modules this surface bundles (re-exports from). */
  readonly sourceModules: readonly string[];
  /** upstream package(s) this surface mirrors in intent. */
  readonly referenceImplementation: string;
}

export interface INeonSdkManifest {
  readonly version: string;
  readonly surfaces: readonly INeonSdkSurface[];
}

export const neonSdkSurfaces: readonly INeonSdkSurface[] = [
  {
    id: "gateway-client",
    title: "Gateway Client SDK",
    summary:
      "WS-JSON-RPC + SSE wire contract: frame shapes, method/event vocabulary, protocol constants, frame builders/parsers/guards, runtime event-stream frame.",
    stability: "stable",
    namespace: "gatewayClient",
    sourceModules: ["gateway/protocol.ts", "gateway/lifecycle.ts"],
    referenceImplementation: "packages/gateway-client, packages/gateway-protocol"
  },
  {
    id: "channel",
    title: "Channel SDK",
    summary:
      "Channel identity, per-platform manifests + registry snapshot, inbound-message and shadow-run/delivery records, the outbound send seam (dry-run no-op + canary-gated sender), and the Discord reference adapter envelope/decision/slash mapping.",
    stability: "stable",
    namespace: "channel",
    sourceModules: [
      "channels/channelManifest.ts",
      "channels/channelRegistry.ts",
      "gateway/types.ts",
      "gateway/outboundSender.ts",
      "gateway/discordIngress.ts",
      "harness/types.ts"
    ],
    referenceImplementation: "packages/gateway-protocol, packages/plugin-sdk"
  },
  {
    id: "tool",
    title: "Tool SDK",
    summary:
      "Tool capability/catalog/policy/inventory contracts, the harness run contract and persisted tool/event union, the read-only skill->tool invocation derivation, and the leak-safe chat tool-card render.",
    stability: "stable",
    namespace: "tool",
    sourceModules: [
      "tools/toolCapabilities.ts",
      "tools/toolCatalog.ts",
      "tools/toolPolicy.ts",
      "tools/neonTools.ts",
      "harness/types.ts",
      "skills/skillInvocation.ts",
      "gateway/chatTranscript.ts"
    ],
    referenceImplementation: "packages/plugin-sdk (provider-tools)"
  },
  {
    id: "plugin",
    title: "Plugin SDK",
    summary:
      "Plugin manifest parsing + code-free trust evaluation, skill + extension discovery/inventory shapes, the per-agent enable/deny policy resolver, and the read-only skill-body security scan.",
    stability: "stable",
    namespace: "plugin",
    sourceModules: [
      "plugin-sdk/index.ts",
      "skills/neonSkills.ts",
      "skills/neonSkillExtensions.ts",
      "skills/skillPolicy.ts",
      "skills/skillSecurityScan.ts"
    ],
    referenceImplementation: "packages/plugin-sdk, packages/plugin-package-contract"
  }
];

export function createNeonSdkManifest(): INeonSdkManifest {
  return {
    version: NEON_SDK_VERSION,
    surfaces: neonSdkSurfaces
  };
}

export function renderNeonSdkManifest(): string {
  const lines: string[] = [
    `Neonika SDK v${NEON_SDK_VERSION}`,
    `Surfaces: ${neonSdkSurfaces.length}`,
    ""
  ];

  for (const surface of neonSdkSurfaces) {
    lines.push(`- ${surface.title} [${surface.id}] (${surface.stability})`);
    lines.push(`  namespace: sdk.${surface.namespace}`);
    lines.push(`  ${surface.summary}`);
    lines.push(`  bundles: ${surface.sourceModules.join(", ")}`);
    lines.push(`  upstream: ${surface.referenceImplementation}`);
    lines.push("");
  }

  lines.push("Stable curated umbrella. No code moved; thin re-export facade over src/.");

  return lines.join("\n");
}
