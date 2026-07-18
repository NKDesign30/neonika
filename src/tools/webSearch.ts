import { boundNeonToolResult, type INeonToolResult } from "./toolPolicy.js";
import { type INeonToolsLiveGate } from "./toolCapabilities.js";
import { neonToolProviderCatalog, type INeonToolProvider } from "./toolCatalog.js";
import { resolveNeonWebSearchProviders } from "./webSearchResolution.js";

/**
 * Web-Search executor (Tools plane, web.search.run): the gated live half of the
 * capability whose resolver already lives in `webSearchResolution.ts`.
 *
 * `webSearchResolution.ts` decides WHICH provider would be used (from present
 * secret-ref names only). This module runs the actual provider call — but only
 * when the tools-live gate is armed. Default (gate closed) is dry-run with NO
 * network, mirroring `executeNeonWebFetch`.
 *
 * Shape parity with upstream `web-search/runtime.ts` (provider POST + ranked
 * results), rebuilt native:
 *  - Provider key is supplied by the caller (read from env at the edge) and is
 *    only ever placed in the Authorization header — never logged, never echoed.
 *  - Every hit crosses the boundary through `boundNeonToolResult` (redactText +
 *    byte/item caps), so provider content can never leak a secret-shaped value.
 *  - `searchImpl` is injectable so tests and the default-off smoke never touch
 *    the network. The default impl speaks the Tavily Search REST API
 *    (POST https://api.tavily.com/search, Bearer auth) — the only provider with
 *    a key present in this deployment; other providers throw "not wired" rather
 *    than silently posting a key to the wrong host.
 */

export type TNeonWebSearchBlockReason = "empty-query" | "no-provider" | "no-key";

export interface INeonWebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type INeonWebSearchResult =
  | { readonly kind: "blocked"; readonly reason: TNeonWebSearchBlockReason; readonly detail: string }
  | { readonly kind: "dry-run"; readonly provider: string; readonly query: string; readonly gateEnvKey: string }
  | {
      readonly kind: "searched";
      readonly provider: string;
      readonly query: string;
      readonly hitCount: number;
      readonly result: INeonToolResult;
    };

export interface INeonWebSearchProviderRequest {
  readonly provider: string;
  readonly query: string;
  /** Secret VALUE, used only in the Authorization header. Never logged. */
  readonly apiKey: string;
  readonly maxResults: number;
  readonly signal: AbortSignal;
}

export type TNeonWebSearchImpl = (request: INeonWebSearchProviderRequest) => Promise<readonly INeonWebSearchHit[]>;

export interface IExecuteNeonWebSearchParams {
  readonly query: string;
  readonly gate: INeonToolsLiveGate;
  /** Present secret-ref NAMES (from collectPresentToolSecretRefs); never values. */
  readonly presentEnvRefs: ReadonlySet<string>;
  /** Secret VALUE for the chosen provider, read by the caller from env. */
  readonly providerKey?: string | undefined;
  /** Injected for tests/smoke so no real network call is made. */
  readonly searchImpl?: TNeonWebSearchImpl;
  readonly maxResults?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly providers?: readonly INeonToolProvider[];
}

const DEFAULT_SEARCH_MAX_RESULTS = 5;
const DEFAULT_SEARCH_MAX_BYTES = 4096;
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;

/**
 * Parse an unknown provider payload into bounded hits. Tolerant by design: a
 * missing or mistyped field collapses to an empty string rather than throwing,
 * so a provider shape drift degrades the preview instead of crashing the run.
 */
export function extractNeonWebSearchHits(payload: unknown): INeonWebSearchHit[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const results = (payload as { readonly results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  const hits: INeonWebSearchHit[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as { readonly title?: unknown; readonly url?: unknown; readonly content?: unknown };
    hits.push({
      title: typeof record.title === "string" ? record.title : "",
      url: typeof record.url === "string" ? record.url : "",
      snippet: typeof record.content === "string" ? record.content : ""
    });
  }
  return hits;
}

function resolveNeonWebSearchKeyRef(provider: string, providers: readonly INeonToolProvider[]): string | undefined {
  return providers.find((candidate) => candidate.id === provider)?.envRefs[0];
}

export async function executeNeonWebSearch(
  params: IExecuteNeonWebSearchParams
): Promise<INeonWebSearchResult> {
  const query = params.query.trim();
  if (query.length === 0) {
    return { kind: "blocked", reason: "empty-query", detail: "search query is empty" };
  }

  const providers = params.providers ?? neonToolProviderCatalog;
  const resolution = resolveNeonWebSearchProviders(params.presentEnvRefs, providers);
  const provider = resolution.chosen;
  if (!provider) {
    return { kind: "blocked", reason: "no-provider", detail: resolution.reason };
  }

  // Default shadow-safe path: gate closed -> no network, ever.
  if (!params.gate.enabled) {
    return { kind: "dry-run", provider, query, gateEnvKey: params.gate.envKey };
  }

  const apiKey = params.providerKey?.trim();
  if (!apiKey) {
    return {
      kind: "blocked",
      reason: "no-key",
      detail: `provider ${provider} is selected but no key value was supplied`
    };
  }

  const searchImpl = params.searchImpl ?? defaultProviderSearch;
  const hits = await searchImpl({
    provider,
    query,
    apiKey,
    maxResults: params.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
  });

  const result = boundNeonToolResult(
    { tool: "web.search.run", items: hits.map(formatNeonWebSearchHit) },
    { maxBytes: params.maxBytes ?? DEFAULT_SEARCH_MAX_BYTES, maxItems: params.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS }
  );

  return { kind: "searched", provider, query, hitCount: hits.length, result };
}

export function renderNeonWebSearchResult(result: INeonWebSearchResult): string {
  if (result.kind === "blocked") {
    return `Neonika Web-Search: BLOCKED (${result.reason}) — ${result.detail}`;
  }
  if (result.kind === "dry-run") {
    return [
      `Neonika Web-Search: dry-run (live gate closed, ${result.gateEnvKey})`,
      `Provider (chosen): ${result.provider}`,
      `Query: ${result.query}`,
      "No provider call was made; arm the tools-live gate to search."
    ].join("\n");
  }
  return [
    `Neonika Web-Search: ${result.hitCount} hit(s) from ${result.provider} for "${result.query}"`,
    `Bytes: ${result.result.byteCount} (truncated=${result.result.truncated}, redacted)`,
    `Preview: ${result.result.preview}`
  ].join("\n");
}

function formatNeonWebSearchHit(hit: INeonWebSearchHit): string {
  const head = [hit.title, hit.url].filter((part) => part.length > 0).join(" — ");
  return hit.snippet.length > 0 ? `${head} — ${hit.snippet}` : head;
}

/** Provider key/ref helper for callers building the env-derived key value. */
export function resolveNeonWebSearchProviderKeyRef(
  presentEnvRefs: ReadonlySet<string>,
  providers: readonly INeonToolProvider[] = neonToolProviderCatalog
): { readonly provider: string; readonly envRef: string } | undefined {
  const resolution = resolveNeonWebSearchProviders(presentEnvRefs, providers);
  if (!resolution.chosen) {
    return undefined;
  }
  const envRef = resolveNeonWebSearchKeyRef(resolution.chosen, providers);
  return envRef ? { provider: resolution.chosen, envRef } : undefined;
}

async function defaultProviderSearch(request: INeonWebSearchProviderRequest): Promise<readonly INeonWebSearchHit[]> {
  if (request.provider !== "tavily") {
    throw new Error(`live web-search for provider "${request.provider}" is not wired (only tavily)`);
  }
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.apiKey}`
    },
    body: JSON.stringify({
      query: request.query,
      search_depth: "basic",
      max_results: request.maxResults
    }),
    signal: request.signal
  });
  if (!response.ok) {
    throw new Error(`tavily search failed: HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return extractNeonWebSearchHits(payload);
}
