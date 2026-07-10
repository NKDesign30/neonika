/**
 * Neon Plugin trust + allowlist policy.
 *
 * Trust is the gate that keeps Neon read-only: a plugin can be catalogued and
 * audited from its manifest, but it is never loadable. Every trust decision
 * carries `autoLoadable: false` as a structural invariant — there is no policy
 * input that can flip it to `true`. An operator allowlist only makes a plugin
 * *eligible for a gated install plan*, never for execution.
 *
 * OpenClaw references: `src/plugins/plugin-config-trust.ts`,
 * `src/plugins/min-host-version.ts`, `src/plugins/dependency-denylist.ts`.
 */

import type { INeonPluginManifest } from "./manifest.js";

/** Default Neon host version used for `minHostVersion` floor checks. */
export const NEON_PLUGIN_HOST_VERSION = "0.1.0";

// Ported from OpenClaw `src/plugins/dependency-denylist.ts`
// (`blockedInstallDependencyPackageNames`). OpenClaw uses it as an install gate;
// Neon uses it to mark a catalogued plugin as `blocked` for any gated plan.
// See THIRD_PARTY_NOTICES.md for attribution.
export const defaultBlockedPluginDependencies: readonly string[] = ["plain-crypto-js"];

export type TNeonPluginTrustLevel = "reference-only" | "allowlisted" | "blocked";

export interface INeonPluginTrustPolicy {
  /** Neon host version compared against each manifest's `minHostVersion`. */
  readonly hostVersion: string;
  /** Plugin ids an operator has explicitly allowed (gated planning only). */
  readonly allowlist: readonly string[];
  /** Plugin ids an operator has explicitly blocked. */
  readonly denylist: readonly string[];
  /** Dependency package names that hard-block a plugin from any gated plan. */
  readonly blockedDependencies: readonly string[];
}

export interface INeonPluginTrustDecision {
  readonly pluginId: string;
  readonly level: TNeonPluginTrustLevel;
  /** Structural invariant: Neon never auto-loads plugin code. Always false. */
  readonly autoLoadable: false;
  /** Human-readable reasons for the level and for any ignored auto-load intent. */
  readonly reasons: readonly string[];
}

export interface ICreateNeonPluginTrustPolicyOptions {
  readonly hostVersion?: string;
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
  readonly blockedDependencies?: readonly string[];
}

export function createDefaultNeonPluginTrustPolicy(
  options: ICreateNeonPluginTrustPolicyOptions = {}
): INeonPluginTrustPolicy {
  return {
    hostVersion: options.hostVersion ?? NEON_PLUGIN_HOST_VERSION,
    allowlist: dedupe(options.allowlist ?? []),
    denylist: dedupe(options.denylist ?? []),
    blockedDependencies: dedupe(options.blockedDependencies ?? defaultBlockedPluginDependencies)
  };
}

export function evaluateNeonPluginTrust(
  manifest: INeonPluginManifest,
  policy: INeonPluginTrustPolicy
): INeonPluginTrustDecision {
  const reasons: string[] = [];
  let blocked = false;

  if (manifest.parseError) {
    blocked = true;
    reasons.push(`manifest could not be parsed: ${manifest.parseError}`);
  }

  if (policy.denylist.includes(manifest.id)) {
    blocked = true;
    reasons.push("plugin id is on the operator denylist");
  }

  for (const dependency of manifest.install.declaredDependencies) {
    if (policy.blockedDependencies.includes(dependency)) {
      blocked = true;
      reasons.push(`declares blocked dependency: ${dependency}`);
    }
  }

  const floor = manifest.install.minHostVersion;
  if (floor !== undefined && !satisfiesMinHostVersion(policy.hostVersion, floor)) {
    blocked = true;
    reasons.push(`host ${policy.hostVersion} does not satisfy ${floor}`);
  }

  // Auto-load intent never changes loadability; it is recorded as evidence that
  // Neon is deliberately ignoring the manifest's request to run on startup.
  if (manifest.autoLoadOnStartup) {
    reasons.push("declares auto-load on startup; Neon ignores it (no plugin code is executed)");
  }

  const level = resolveLevel(blocked, policy.allowlist.includes(manifest.id));
  if (level === "allowlisted") {
    reasons.push("operator-allowlisted: eligible for a gated install plan, not for execution");
  }

  return {
    pluginId: manifest.id,
    level,
    autoLoadable: false,
    reasons
  };
}

function resolveLevel(blocked: boolean, allowlisted: boolean): TNeonPluginTrustLevel {
  if (blocked) {
    return "blocked";
  }
  return allowlisted ? "allowlisted" : "reference-only";
}

interface ISemverCore {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * True when `hostVersion` is >= the `">=x.y.z"` floor declared by a manifest.
 * Compares numeric core versions only; pre-release/build metadata is ignored
 * for the floor check (a conservative, total comparison). Unparsable input is
 * treated as not-satisfied so a malformed constraint fails closed.
 */
export function satisfiesMinHostVersion(hostVersion: string, floor: string): boolean {
  const required = parseSemverCore(floor.replace(/^>=/, ""));
  const host = parseSemverCore(hostVersion);
  if (!required || !host) {
    return false;
  }

  if (host.major !== required.major) {
    return host.major > required.major;
  }
  if (host.minor !== required.minor) {
    return host.minor > required.minor;
  }
  return host.patch >= required.patch;
}

function parseSemverCore(value: string): ISemverCore | undefined {
  const core = value.trim().split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10));
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    Number.isNaN(major) ||
    Number.isNaN(minor) ||
    Number.isNaN(patch)
  ) {
    return undefined;
  }

  return { major, minor, patch };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
