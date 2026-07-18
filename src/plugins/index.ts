/**
 * Neon plugin host runtime — read-only catalog + trust + gated install planning
 * over upstream extension manifests. Consumes the pure `src/plugin-sdk` contract
 * and never loads, requires, or executes plugin code.
 */

export {
  readNeonPluginManifestSources,
  type INeonPluginManifestSource,
  type INeonPluginManifestSourceScan,
  type IReadNeonPluginManifestSourcesOptions
} from "./manifestSource.js";

export {
  buildNeonPluginCatalog,
  defaultPluginManifestLimit,
  type IBuildNeonPluginCatalogOptions,
  type INeonPluginCatalog,
  type INeonPluginCatalogEntry,
  type INeonPluginCatalogTotals
} from "./catalog.js";

export {
  neonPluginInstallGateFlag,
  planNeonPluginAction,
  resolveNeonPluginInstallGate,
  type INeonPluginGatePlan,
  type INeonPluginGatePlanStep,
  type INeonPluginInstallGate,
  type TNeonPluginGateAction,
  type TNeonPluginGateDecision
} from "./installGate.js";

export {
  createNeonPluginInventorySnapshot,
  renderNeonPluginInstallPlanReport,
  renderNeonPluginsReport,
  resolveNeonPluginInstallPlan,
  type ICreateNeonPluginInventoryOptions,
  type INeonPluginInstallPlanResult,
  type INeonPluginInventoryEntry,
  type INeonPluginInventorySnapshot,
  type INeonPluginPackageProof,
  type IResolveNeonPluginInstallPlanOptions,
  type TNeonPluginInventoryState,
  type TNeonPluginPackageJsonState,
  type TNeonPluginPackageLiveProofState,
  type TNeonPluginPackageRuntimeEntryState
} from "./inventorySnapshot.js";
