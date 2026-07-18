import { neonToolProviderCatalog, type INeonToolProvider } from "./toolCatalog.js";

/**
 * Web-Search provider resolution (Tools plane, web.search.run): auto-detect which
 * configured providers are usable and in what fallback order, from the present
 * secret-ref NAMES only. Pure: no I/O, no secret VALUE is read or echoed, no
 * search is executed.
 *
 * This is the Neon-native half of upstream `resolveWebSearchCandidates`
 * (src/web-search/runtime.ts). It closes the "Provider-Resolution + Auto-Detect +
 * Fallback-Kette" capability. The actual provider search call (definition.execute)
 * stays blocked: it needs an external provider account/API key plus an outbound
 * POST, which is a product + secret decision (NEON_TOOLS_LIVE_ENABLED + a
 * BRAVE/TAVILY/FIRECRAWL key), not an autonomous one.
 *
 * Priority is the provider catalog declaration order (brave, tavily, firecrawl),
 * which matches the web.search.run descriptor's default executor (provider:brave).
 */

export interface INeonUnavailableWebSearchProvider {
  readonly id: string;
  /** Env-var NAMES this provider needs (identifiers only, never values). */
  readonly missingEnvRefs: readonly string[];
}

export interface INeonWebSearchResolution {
  /** First available provider by catalog priority, or undefined when none configured. */
  readonly chosen: string | undefined;
  /** Available providers in priority order (chosen first). */
  readonly fallbackChain: readonly string[];
  readonly unavailable: readonly INeonUnavailableWebSearchProvider[];
  readonly reason: string;
}

export function resolveNeonWebSearchProviders(
  presentEnvRefs: ReadonlySet<string>,
  providers: readonly INeonToolProvider[] = neonToolProviderCatalog
): INeonWebSearchResolution {
  const webSearchProviders = providers.filter((provider) => provider.families.includes("web-search"));

  const available: string[] = [];
  const unavailable: INeonUnavailableWebSearchProvider[] = [];

  for (const provider of webSearchProviders) {
    const hasKey = provider.envRefs.some((ref) => presentEnvRefs.has(ref));
    if (hasKey) {
      available.push(provider.id);
    } else {
      unavailable.push({ id: provider.id, missingEnvRefs: provider.envRefs });
    }
  }

  const chosen = available[0];
  const reason = chosen
    ? `Chose ${chosen} (first available by catalog priority); ${available.length}/${webSearchProviders.length} provider(s) ready.`
    : `No web-search provider configured; set one of ${webSearchProviders
        .flatMap((provider) => provider.envRefs)
        .join("/")}.`;

  return { chosen, fallbackChain: available, unavailable, reason };
}

export function renderNeonWebSearchResolution(resolution: INeonWebSearchResolution): string {
  const lines = [
    `Neonika Web-Search resolution: ${resolution.chosen ?? "none"}`,
    `Fallback chain: ${resolution.fallbackChain.length > 0 ? resolution.fallbackChain.join(" -> ") : "(empty)"}`,
    resolution.reason
  ];

  if (resolution.unavailable.length > 0) {
    lines.push("Unavailable (missing secret refs):");
    for (const provider of resolution.unavailable) {
      lines.push(`- ${provider.id}: needs ${provider.missingEnvRefs.join(" or ")}`);
    }
  }

  lines.push("Live provider search stays gated (NEON_TOOLS_LIVE_ENABLED) + needs a provider key.");

  return lines.join("\n");
}
