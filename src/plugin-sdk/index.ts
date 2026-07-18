/**
 * Neonika Plugin SDK — the pure, source-backed contract for describing and
 * trust-evaluating plugins without ever loading their code.
 *
 * The host runtime lives in `src/plugins`; this module is intentionally free of
 * filesystem and node-runtime imports so the contract stays portable and
 * trivially testable.
 */

export {
  parseNeonPluginManifest,
  type INeonPluginCapabilityContribution,
  type INeonPluginCommandContribution,
  type INeonPluginInstallConstraints,
  type INeonPluginManifest,
  type IParseNeonPluginManifestOptions,
  type TNeonPluginManifestFormat
} from "./manifest.js";

export {
  createDefaultNeonPluginTrustPolicy,
  defaultBlockedPluginDependencies,
  evaluateNeonPluginTrust,
  NEON_PLUGIN_HOST_VERSION,
  satisfiesMinHostVersion,
  type ICreateNeonPluginTrustPolicyOptions,
  type INeonPluginTrustDecision,
  type INeonPluginTrustPolicy,
  type TNeonPluginTrustLevel
} from "./trust.js";
