import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

import {
  boundNeonToolResult,
  type INeonToolResult
} from "./toolPolicy.js";
import { type INeonToolsLiveGate } from "./toolCapabilities.js";

/**
 * Public Web-Fetch executor with an SSRF guard (Tools plane, web.fetch.url).
 *
 * Closes the `core:web-fetch` gap: neon-core only had a loopback-ONLY fetch in
 * the node-runner (`parseSafeLoopbackUrl`). Upstream's `fetchWithSsrFGuard`
 * (src/infra/net/fetch-guard.ts) does the inverse — allow public, BLOCK private.
 * This rebuilds that direction natively.
 *
 * Two layers:
 *  - `classifyNeonWebFetchTarget` / `classifyNeonWebFetchHost`: PURE SSRF guard.
 *    http/https only, credentials stripped, and any loopback/private/link-local/
 *    unique-local/unspecified/CGNAT/IPv4-mapped address is blocked. Fully testable
 *    with no network.
 *  - `executeNeonWebFetch`: gated executor. Default (gate closed) is dry-run with
 *    NO network. Only when `NEON_TOOLS_LIVE_ENABLED` is armed does it resolve the
 *    host and re-run the guard on every resolved IP (closing the DNS-rebind gap),
 *    then bounded-fetch through `boundNeonToolResult`. `fetchImpl`/`lookupImpl`
 *    are injectable so tests and the default-off smoke never touch the network.
 */

export type TNeonWebFetchBlockReason =
  | "invalid-url"
  | "unsupported-scheme"
  | "private-host"
  | "resolved-private";

export type INeonWebFetchTargetDecision =
  | { readonly allowed: true; readonly url: string; readonly host: string }
  | { readonly allowed: false; readonly reason: TNeonWebFetchBlockReason; readonly detail: string };

export type INeonWebFetchResult =
  | { readonly kind: "blocked"; readonly reason: TNeonWebFetchBlockReason; readonly detail: string }
  | { readonly kind: "dry-run"; readonly target: string; readonly gateEnvKey: string }
  | { readonly kind: "fetched"; readonly status: number; readonly target: string; readonly result: INeonToolResult };

export interface INeonWebFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface IExecuteNeonWebFetchParams {
  readonly url: string;
  readonly gate: INeonToolsLiveGate;
  /** Injected for tests/smoke so no real network call is made. */
  readonly fetchImpl?: (url: string, init: { readonly signal: AbortSignal }) => Promise<INeonWebFetchResponse>;
  /** Injected for tests; returns the resolved IP literals for the host. */
  readonly lookupImpl?: (host: string) => Promise<readonly string[]>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_FETCH_MAX_BYTES = 4096;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Classify a single host (hostname or IP literal). Returns a block reason string
 * when the host is non-public, `undefined` when it is a routable public host. A
 * bare hostname (not an IP literal) passes here; the live path re-checks the
 * resolved IPs to catch DNS rebinding.
 */
export function classifyNeonWebFetchHost(host: string): string | undefined {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalized.length === 0) {
    return "empty-host";
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return "loopback-hostname";
  }

  const ipKind = isIP(normalized);
  if (ipKind === 4) {
    return classifyBlockedIpv4(normalized);
  }
  if (ipKind === 6) {
    return classifyBlockedIpv6(normalized);
  }

  return undefined;
}

/** Pure URL-level SSRF guard: http/https only, public host only, credentials stripped. */
export function classifyNeonWebFetchTarget(rawUrl: string): INeonWebFetchTargetDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid-url", detail: "not a parseable absolute URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason: "unsupported-scheme",
      detail: `scheme ${url.protocol} not allowed (http/https only)`
    };
  }

  const blocked = classifyNeonWebFetchHost(url.hostname);
  if (blocked) {
    return { allowed: false, reason: "private-host", detail: `host blocked: ${blocked}` };
  }

  // Never carry credentials across the fetch boundary.
  url.username = "";
  url.password = "";

  return { allowed: true, url: url.toString(), host: url.hostname };
}

export async function executeNeonWebFetch(
  params: IExecuteNeonWebFetchParams
): Promise<INeonWebFetchResult> {
  const target = classifyNeonWebFetchTarget(params.url);
  if (!target.allowed) {
    return { kind: "blocked", reason: target.reason, detail: target.detail };
  }

  // Default shadow-safe path: gate closed -> no network, ever.
  if (!params.gate.enabled) {
    return { kind: "dry-run", target: target.url, gateEnvKey: params.gate.envKey };
  }

  // Live path (gate armed): resolve the host and re-run the guard on every
  // resolved IP so a public hostname cannot rebind to a private address.
  const lookup = params.lookupImpl ?? defaultLookup;
  const resolvedIps = await lookup(target.host);
  for (const ip of resolvedIps) {
    const blocked = classifyNeonWebFetchHost(ip);
    if (blocked) {
      return {
        kind: "blocked",
        reason: "resolved-private",
        detail: `${target.host} resolved to blocked ${ip} (${blocked})`
      };
    }
  }

  const fetchImpl = params.fetchImpl ?? defaultFetch;
  const response = await fetchImpl(target.url, {
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
  });
  const body = await response.text();
  const result = boundNeonToolResult(
    { tool: "web.fetch.url", text: stripHtmlForPreview(body) },
    { maxBytes: params.maxBytes ?? DEFAULT_FETCH_MAX_BYTES }
  );

  return { kind: "fetched", status: response.status, target: target.url, result };
}

export function renderNeonWebFetchResult(result: INeonWebFetchResult): string {
  if (result.kind === "blocked") {
    return `Neon Web-Fetch: BLOCKED (${result.reason}) — ${result.detail}`;
  }
  if (result.kind === "dry-run") {
    return [
      `Neon Web-Fetch: dry-run (live gate closed, ${result.gateEnvKey})`,
      `Target (allowed): ${result.target}`,
      "No network call was made; arm the tools-live gate to fetch."
    ].join("\n");
  }
  return [
    `Neon Web-Fetch: fetched ${result.status} from ${result.target}`,
    `Bytes: ${result.result.byteCount} (truncated=${result.result.truncated}, redacted)`,
    `Preview: ${result.result.preview}`
  ].join("\n");
}

function classifyBlockedIpv4(ip: string): string | undefined {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return "malformed-ipv4";
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return "unspecified";
  if (a === 10) return "private-10/8";
  if (a === 127) return "loopback-127/8";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat-100.64/10";
  if (a === 169 && b === 254) return "link-local-169.254/16";
  if (a === 172 && b >= 16 && b <= 31) return "private-172.16/12";
  if (a === 192 && b === 168) return "private-192.168/16";
  return undefined;
}

function classifyBlockedIpv6(ip: string): string | undefined {
  const normalized = ip.toLowerCase();

  if (normalized === "::1") return "loopback-::1";
  if (normalized === "::") return "unspecified-::";

  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped?.[1]) {
    return classifyBlockedIpv4(mapped[1]);
  }

  // fe80::/10 link-local -> hextet prefixes fe8/fe9/fea/feb.
  if (/^fe[89ab]/.test(normalized)) return "link-local-fe80/10";
  // fc00::/7 unique-local -> first byte fc or fd.
  if (/^f[cd]/.test(normalized)) return "unique-local-fc00/7";

  return undefined;
}

function stripHtmlForPreview(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function defaultLookup(host: string): Promise<readonly string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((record) => record.address);
}

async function defaultFetch(url: string, init: { readonly signal: AbortSignal }): Promise<INeonWebFetchResponse> {
  const response = await fetch(url, { signal: init.signal, redirect: "error" });
  return { status: response.status, text: () => response.text() };
}
