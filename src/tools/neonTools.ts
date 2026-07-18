import {
  resolveNeonToolsLiveGate,
  type INeonToolAvailabilityContext,
  type INeonToolsLiveGate,
  type TNeonToolExecutorRef,
  type TNeonToolFamily,
  type TNeonToolSideEffect,
  type TNeonToolUnavailableReason
} from "./toolCapabilities.js";
import {
  buildNeonToolPlan,
  neonToolDescriptorCatalog,
  neonToolProviderCatalog,
  type INeonToolProvider,
  type TNeonToolProviderKind
} from "./toolCatalog.js";
import {
  planNeonToolInvocation,
  type TNeonToolInvocationDecision
} from "./toolPolicy.js";

// Neonika Tools Runtime — read-only inventory snapshot + report (entry-point glue).
//
// Composes the capability model + catalog + policy into one truth object that
// the CLI, the /api/neon-tools route, Doctor, and Mission Control all read. No
// secret value is ever read or echoed: provider readiness is reported as a
// present/total ref COUNT and a boolean, never the values. No tool is executed.

export type TNeonToolProviderReadiness = "ready" | "missing-secret" | "local-unverified";

export interface INeonToolProviderSnapshot {
  readonly id: string;
  readonly label: string;
  readonly kind: TNeonToolProviderKind;
  readonly families: readonly TNeonToolFamily[];
  readonly readiness: TNeonToolProviderReadiness;
  readonly refsPresent: number;
  readonly refsTotal: number;
  /** Env-var reference NAMES (identifiers only, never values). */
  readonly envRefs: readonly string[];
}

export interface INeonToolEntrySnapshot {
  readonly name: string;
  readonly family: TNeonToolFamily;
  readonly title: string;
  readonly sideEffect: TNeonToolSideEffect;
  readonly available: boolean;
  readonly decision: TNeonToolInvocationDecision;
  readonly mode: "dry-run" | "live";
  readonly executor: string;
  readonly diagnostics: readonly TNeonToolUnavailableReason[];
}

export interface INeonToolFamilySnapshot {
  readonly family: TNeonToolFamily;
  readonly total: number;
  readonly available: number;
  readonly hidden: number;
}

export interface INeonToolInventoryTotals {
  readonly tools: number;
  readonly available: number;
  readonly hidden: number;
  readonly providers: number;
  readonly providersReady: number;
}

export interface INeonToolInventorySnapshot {
  readonly generatedAt: string;
  readonly title: "Neonika Tools";
  readonly gate: INeonToolsLiveGate;
  readonly totals: INeonToolInventoryTotals;
  readonly families: readonly INeonToolFamilySnapshot[];
  readonly providers: readonly INeonToolProviderSnapshot[];
  readonly tools: readonly INeonToolEntrySnapshot[];
}

export interface ICreateNeonToolInventoryOptions {
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly availableBinaries?: ReadonlySet<string>;
  readonly availableTransports?: ReadonlySet<string>;
}

const toolFamilyOrder: readonly TNeonToolFamily[] = [
  "web-search",
  "web-fetch",
  "browser",
  "media",
  "voice"
];

/**
 * Collect the NAMES of env vars that are set to a non-empty value. Only the
 * identifiers are returned — never the values. This is the sole bridge between
 * process env and the availability model.
 */
export function collectPresentToolSecretRefs(
  env: Readonly<Record<string, string | undefined>>,
  providers: readonly INeonToolProvider[] = neonToolProviderCatalog
): ReadonlySet<string> {
  const present = new Set<string>();
  for (const provider of providers) {
    for (const ref of provider.envRefs) {
      if ((env[ref] ?? "").trim().length > 0) {
        present.add(ref);
      }
    }
  }
  return present;
}

function formatExecutorRef(executor: TNeonToolExecutorRef): string {
  return executor.kind === "core"
    ? `core:${executor.executorId}`
    : `provider:${executor.providerId}/${executor.capability}`;
}

function resolveProviderReadiness(
  provider: INeonToolProvider,
  presentEnvRefs: ReadonlySet<string>,
  availableBinaries: ReadonlySet<string>,
  availableTransports: ReadonlySet<string>
): TNeonToolProviderReadiness {
  if (provider.kind === "api-key") {
    return provider.envRefs.some((ref) => presentEnvRefs.has(ref)) ? "ready" : "missing-secret";
  }
  if (provider.kind === "binary") {
    return provider.binary && availableBinaries.has(provider.binary)
      ? "ready"
      : "local-unverified";
  }
  return provider.transport && availableTransports.has(provider.transport)
    ? "ready"
    : "local-unverified";
}

/**
 * Build the full read-only Neonika Tools inventory: the live gate, every provider's
 * readiness (by ref count, never value), each tool's availability + dry-run/live
 * decision, and per-family totals. Performs no execution and no secret read.
 */
export function createNeonToolInventorySnapshot(
  options: ICreateNeonToolInventoryOptions = {}
): INeonToolInventorySnapshot {
  const env = options.env ?? {};
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const gate = resolveNeonToolsLiveGate(env);

  const presentEnvRefs = collectPresentToolSecretRefs(env);
  const availableBinaries = options.availableBinaries ?? new Set<string>();
  const availableTransports = options.availableTransports ?? new Set<string>();
  const availability: INeonToolAvailabilityContext = {
    presentEnvRefs,
    availableBinaries,
    availableTransports
  };

  const providers: INeonToolProviderSnapshot[] = neonToolProviderCatalog.map((provider) => {
    const refsPresent = provider.envRefs.filter((ref) => presentEnvRefs.has(ref)).length;
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      families: provider.families,
      readiness: resolveProviderReadiness(
        provider,
        presentEnvRefs,
        availableBinaries,
        availableTransports
      ),
      refsPresent,
      refsTotal: provider.envRefs.length,
      envRefs: provider.envRefs
    };
  });

  const plan = buildNeonToolPlan({ availability });
  const visibleNames = new Set(plan.visible.map((entry) => entry.descriptor.name));

  const tools: INeonToolEntrySnapshot[] = neonToolDescriptorCatalog
    .map((descriptor) => {
      const invocation = planNeonToolInvocation({ descriptor, gate, availability });
      return {
        name: descriptor.name,
        family: descriptor.family,
        title: descriptor.title,
        sideEffect: descriptor.sideEffect,
        available: visibleNames.has(descriptor.name),
        decision: invocation.decision,
        mode: invocation.mode,
        executor: formatExecutorRef(descriptor.executor),
        diagnostics: invocation.diagnostics.map((diagnostic) => diagnostic.reason)
      };
    })
    .sort((left, right) => left.family.localeCompare(right.family) || left.name.localeCompare(right.name));

  const families: INeonToolFamilySnapshot[] = toolFamilyOrder.map((family) => {
    const familyTools = tools.filter((tool) => tool.family === family);
    const available = familyTools.filter((tool) => tool.available).length;
    return {
      family,
      total: familyTools.length,
      available,
      hidden: familyTools.length - available
    };
  });

  const available = tools.filter((tool) => tool.available).length;

  return {
    generatedAt,
    title: "Neonika Tools",
    gate,
    totals: {
      tools: tools.length,
      available,
      hidden: tools.length - available,
      providers: providers.length,
      providersReady: providers.filter((provider) => provider.readiness === "ready").length
    },
    families,
    providers,
    tools
  };
}

/** Render the inventory as a leak-safe operator report (no secret values). */
export function renderNeonToolInventoryReport(snapshot: INeonToolInventorySnapshot): string {
  const gateLine = `Live gate: ${snapshot.gate.enabled ? "ARMED" : "closed"} (${snapshot.gate.envKey}=${snapshot.gate.reason})`;
  const totalsLine = `Tools: ${snapshot.totals.available}/${snapshot.totals.tools} available | Providers ready: ${snapshot.totals.providersReady}/${snapshot.totals.providers}`;

  const familyLines = snapshot.families.map(
    (family) => `- ${family.family}: ${family.available}/${family.total} available`
  );

  const providerLines = snapshot.providers.map((provider) => {
    const refs = provider.envRefs.length > 0 ? ` refs ${provider.refsPresent}/${provider.refsTotal}` : "";
    return `- ${provider.id} (${provider.kind}): ${provider.readiness}${refs}`;
  });

  const toolLines = snapshot.tools.map((tool) => {
    const reasons = tool.diagnostics.length > 0 ? ` [${tool.diagnostics.join(",")}]` : "";
    return `- ${tool.name} (${tool.sideEffect}) -> ${tool.decision}/${tool.mode} via ${tool.executor}${reasons}`;
  });

  return [
    snapshot.title,
    gateLine,
    totalsLine,
    "",
    "Families:",
    ...familyLines,
    "",
    "Providers:",
    ...providerLines,
    "",
    "Tools:",
    ...toolLines
  ].join("\n");
}
