import {
  evaluateNeonToolAvailability,
  type INeonToolAvailabilityContext,
  type INeonToolAvailabilityDiagnostic,
  type INeonToolDescriptor,
  type TNeonToolFamily
} from "./toolCapabilities.js";

// Neon Tools Runtime — provider + tool descriptor catalog and availability plan.
//
// Data layer for the capability model. The provider catalog records ONLY the
// env-var reference NAMES that would unlock each provider — never a value, never
// a resolution. Sourced from the upstream extension manifests
// (extensions/{brave,tavily,firecrawl,elevenlabs}/openclaw.plugin.json) and the
// CDP/ffmpeg local capabilities (extensions/browser, src/media). Strategy:
// rebuild-native — Neon owns a static, audited catalog instead of upstream's
// dynamic plugin registry.

export type TNeonToolProviderKind = "api-key" | "loopback" | "binary";

export interface INeonToolProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: TNeonToolProviderKind;
  readonly families: readonly TNeonToolFamily[];
  /** Env-var reference NAMES (never values). Empty for loopback/binary providers. */
  readonly envRefs: readonly string[];
  /** Local transport id for loopback providers (e.g. CDP). */
  readonly transport?: string;
  /** Local binary name for binary providers (e.g. ffmpeg). */
  readonly binary?: string;
}

/**
 * The audited Neon provider catalog. Secrets appear only as `op://`-style ref
 * NAMES (env-var identifiers); resolving them is out of scope and never done
 * here.
 */
export const neonToolProviderCatalog: readonly INeonToolProvider[] = [
  {
    id: "brave",
    label: "Brave Search",
    kind: "api-key",
    families: ["web-search"],
    envRefs: ["BRAVE_API_KEY"]
  },
  {
    id: "tavily",
    label: "Tavily",
    kind: "api-key",
    families: ["web-search"],
    envRefs: ["TAVILY_API_KEY"]
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    kind: "api-key",
    families: ["web-search", "web-fetch"],
    envRefs: ["FIRECRAWL_API_KEY"]
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    kind: "api-key",
    families: ["media", "voice"],
    envRefs: ["ELEVENLABS_API_KEY", "XI_API_KEY"]
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible Speech",
    kind: "api-key",
    families: ["voice"],
    envRefs: ["OPENAI_API_KEY"]
  },
  {
    id: "chrome-cdp",
    label: "Chrome DevTools (loopback)",
    kind: "loopback",
    families: ["browser"],
    envRefs: [],
    transport: "chrome-cdp"
  },
  {
    id: "ffmpeg",
    label: "ffmpeg (local binary)",
    kind: "binary",
    families: ["media"],
    envRefs: [],
    binary: "ffmpeg"
  }
];

/**
 * The Neon tool descriptor catalog. Each tool carries its side-effect class and
 * availability expression so the planner can mark it visible/hidden and the
 * policy layer can decide dry-run vs gated-live without ever executing it.
 */
export const neonToolDescriptorCatalog: readonly INeonToolDescriptor[] = [
  {
    name: "web.search.run",
    family: "web-search",
    title: "Web Search",
    description: "Run a provider-backed web search query and return ranked results.",
    sideEffect: "network-write",
    owner: { kind: "core" },
    executor: { kind: "provider", providerId: "brave", capability: "web-search" },
    availability: {
      anyOf: [
        { kind: "secret-ref", providerId: "brave", envRefs: ["BRAVE_API_KEY"] },
        { kind: "secret-ref", providerId: "tavily", envRefs: ["TAVILY_API_KEY"] },
        { kind: "secret-ref", providerId: "firecrawl", envRefs: ["FIRECRAWL_API_KEY"] }
      ]
    }
  },
  {
    name: "web.fetch.url",
    family: "web-fetch",
    title: "Web Fetch",
    description: "Fetch a single URL and return bounded, redacted text content.",
    sideEffect: "network-read",
    owner: { kind: "core" },
    executor: { kind: "core", executorId: "web-fetch" },
    availability: { kind: "always" }
  },
  {
    name: "web.fetch.extract",
    family: "web-fetch",
    title: "Web Extract",
    description: "Fetch and structure a URL via a provider extractor (Firecrawl).",
    sideEffect: "network-write",
    owner: { kind: "provider", providerId: "firecrawl" },
    executor: { kind: "provider", providerId: "firecrawl", capability: "web-fetch" },
    availability: { kind: "secret-ref", providerId: "firecrawl", envRefs: ["FIRECRAWL_API_KEY"] }
  },
  {
    name: "browser.tabs",
    family: "browser",
    title: "Browser Tabs",
    description: "Enumerate open browser tabs over loopback CDP (title + host only).",
    sideEffect: "read-local",
    owner: { kind: "core" },
    executor: { kind: "core", executorId: "browser-cdp" },
    availability: { kind: "loopback", transport: "chrome-cdp" }
  },
  {
    name: "browser.navigate",
    family: "browser",
    title: "Browser Navigate",
    description: "Drive a loopback browser to a URL (outbound page load).",
    sideEffect: "network-read",
    owner: { kind: "core" },
    executor: { kind: "core", executorId: "browser-cdp" },
    availability: { kind: "loopback", transport: "chrome-cdp" }
  },
  {
    name: "media.transcode",
    family: "media",
    title: "Media Transcode",
    description: "Transcode local audio/video via the ffmpeg binary.",
    sideEffect: "local-exec",
    owner: { kind: "core" },
    executor: { kind: "core", executorId: "ffmpeg" },
    availability: { kind: "binary", binary: "ffmpeg" }
  },
  {
    name: "media.understanding",
    family: "media",
    title: "Media Understanding",
    description: "Transcribe/analyze media via a provider (ElevenLabs).",
    sideEffect: "network-write",
    owner: { kind: "provider", providerId: "elevenlabs" },
    executor: { kind: "provider", providerId: "elevenlabs", capability: "media-understanding" },
    availability: {
      kind: "secret-ref",
      providerId: "elevenlabs",
      envRefs: ["ELEVENLABS_API_KEY", "XI_API_KEY"]
    }
  },
  {
    name: "voice.tts.synthesize",
    family: "voice",
    title: "Voice Synthesis",
    description: "Synthesize speech audio from text via a provider (outbound media).",
    sideEffect: "outbound-media",
    owner: { kind: "provider", providerId: "elevenlabs" },
    executor: { kind: "provider", providerId: "elevenlabs", capability: "tts" },
    availability: {
      anyOf: [
        {
          kind: "secret-ref",
          providerId: "elevenlabs",
          envRefs: ["ELEVENLABS_API_KEY", "XI_API_KEY"]
        },
        { kind: "secret-ref", providerId: "openai-compatible", envRefs: ["OPENAI_API_KEY"] }
      ]
    }
  },
  {
    name: "voice.tts.voices",
    family: "voice",
    title: "Voice Catalog",
    description: "List available synthesis voices from a provider.",
    sideEffect: "network-read",
    owner: { kind: "provider", providerId: "elevenlabs" },
    executor: { kind: "provider", providerId: "elevenlabs", capability: "tts" },
    availability: {
      anyOf: [
        {
          kind: "secret-ref",
          providerId: "elevenlabs",
          envRefs: ["ELEVENLABS_API_KEY", "XI_API_KEY"]
        },
        { kind: "secret-ref", providerId: "openai-compatible", envRefs: ["OPENAI_API_KEY"] }
      ]
    }
  }
];

export type TNeonToolPlanContractCode = "duplicate-tool-name";

export class NeonToolPlanContractError extends Error {
  readonly code: TNeonToolPlanContractCode;
  readonly toolName: string;

  constructor(params: { code: TNeonToolPlanContractCode; toolName: string; message: string }) {
    super(params.message);
    this.name = "NeonToolPlanContractError";
    this.code = params.code;
    this.toolName = params.toolName;
  }
}

export interface INeonToolPlanEntry {
  readonly descriptor: INeonToolDescriptor;
}

export interface INeonHiddenToolPlanEntry {
  readonly descriptor: INeonToolDescriptor;
  readonly diagnostics: readonly INeonToolAvailabilityDiagnostic[];
}

export interface INeonToolPlan {
  readonly visible: readonly INeonToolPlanEntry[];
  readonly hidden: readonly INeonHiddenToolPlanEntry[];
}

export interface IBuildNeonToolPlanOptions {
  readonly descriptors?: readonly INeonToolDescriptor[];
  readonly availability?: INeonToolAvailabilityContext;
}

function compareDescriptors(left: INeonToolDescriptor, right: INeonToolDescriptor): number {
  return left.family.localeCompare(right.family) || left.name.localeCompare(right.name);
}

/**
 * Split the descriptor catalog into available (visible) and unavailable (hidden,
 * with diagnostics) given an availability context. Duplicate tool names are a
 * contract violation. Pure: performs no I/O and no side effect.
 */
export function buildNeonToolPlan(options: IBuildNeonToolPlanOptions = {}): INeonToolPlan {
  const descriptors = [...(options.descriptors ?? neonToolDescriptorCatalog)].sort(
    compareDescriptors
  );

  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new NeonToolPlanContractError({
        code: "duplicate-tool-name",
        toolName: descriptor.name,
        message: `Duplicate tool descriptor name: ${descriptor.name}`
      });
    }
    seen.add(descriptor.name);
  }

  const context: INeonToolAvailabilityContext = options.availability ?? {};
  const visible: INeonToolPlanEntry[] = [];
  const hidden: INeonHiddenToolPlanEntry[] = [];

  for (const descriptor of descriptors) {
    const diagnostics = evaluateNeonToolAvailability(descriptor.availability, context);
    if (diagnostics.length === 0) {
      visible.push({ descriptor });
    } else {
      hidden.push({ descriptor, diagnostics });
    }
  }

  return { visible, hidden };
}
