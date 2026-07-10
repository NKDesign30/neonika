// Neon SDK — stable curated public surface (umbrella).
//
// The single import for SDK consumers. Like upstream `packages/sdk` (which
// re-exports its workspace packages), this is the umbrella that unifies the
// Neon contract domains — but without a workspace monorepo: one repo, one
// curated `src/sdk/` layer over the runtime `src/` modules.
//
// Each surface is re-exported as a NAMESPACE (`sdk.gatewayClient`, `sdk.channel`,
// `sdk.tool`, `sdk.plugin`). Namespacing is deliberate: the surfaces bundle
// fast-moving domain modules (channels, tools, plugin-sdk), and namespaced
// re-exports are collision-proof and track those modules via `export *` without
// per-symbol coupling. Consumers reach a contract as e.g.
// `sdk.tool.buildNeonToolPlan(...)` or `sdk.plugin.parseNeonPluginManifest(...)`.

export * as gatewayClient from "./gatewayClient.js";
export * as channel from "./channel.js";
export * as tool from "./tool.js";
export * as plugin from "./plugin.js";

export {
  NEON_SDK_VERSION,
  createNeonSdkManifest,
  neonSdkSurfaces,
  renderNeonSdkManifest
} from "./manifest.js";

export type {
  INeonSdkManifest,
  INeonSdkSurface,
  TNeonSdkNamespace,
  TNeonSdkSurfaceId,
  TNeonSdkSurfaceStability
} from "./manifest.js";
