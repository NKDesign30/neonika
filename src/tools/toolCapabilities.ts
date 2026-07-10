import { readReadyCutoverEnv } from "../core/cutover.js";

// Neon Tools Runtime — capability type model + availability/gate evaluation.
//
// Rebuild-native from upstream `src/tools/types.ts` + `src/tools/availability.ts`
// + `src/tools/planner.ts`. Upstream models a generic tool registry with
// owner/executor refs and an availability expression DSL; Neon Core keeps that
// shape but narrows it to the five target families (web-search, web-fetch,
// browser, media, voice) and adds a shadow-contract side-effect classification
// so the planner can reason about *what a tool would do* without ever doing it.
//
// Nothing here resolves a secret value or performs a side effect. Availability
// is computed from env-var PRESENCE only (never the value) and the live gate is
// default-off, matching the Neon gate pattern (resolveNeonXGate via
// readReadyCutoverEnv).

export type TNeonToolFamily = "web-search" | "web-fetch" | "browser" | "media" | "voice";

/**
 * How a tool touches the outside world. Drives the gate decision: only
 * `read-local` is ever auto-allowed; everything that hits the network or emits
 * outbound media is gated behind an explicit live flag and stays dry-run by
 * default.
 */
export type TNeonToolSideEffect =
  | "read-local" // local-only read (e.g. enumerate browser tabs over loopback CDP)
  | "network-read" // outbound network read (web fetch, web search lookups)
  | "network-write" // outbound network write/cost (provider API call that mutates/charges)
  | "local-exec" // spawns a local binary (ffmpeg transcode/image ops)
  | "outbound-media"; // emits synthesized media outward (voice/TTS)

export type TNeonToolOwnerRef =
  | { readonly kind: "core" }
  | { readonly kind: "provider"; readonly providerId: string };

export type TNeonToolExecutorRef =
  | { readonly kind: "core"; readonly executorId: string }
  | { readonly kind: "provider"; readonly providerId: string; readonly capability: string };

/**
 * A single availability requirement. `secret-ref` checks env-var PRESENCE only
 * (never the value); `binary` notes a required local binary; `loopback` marks a
 * local-only transport (e.g. CDP) that needs no secret.
 */
export type TNeonToolAvailabilitySignal =
  | { readonly kind: "always" }
  | { readonly kind: "secret-ref"; readonly providerId: string; readonly envRefs: readonly string[] }
  | { readonly kind: "binary"; readonly binary: string }
  | { readonly kind: "loopback"; readonly transport: string };

export type TNeonToolAvailabilityExpression =
  | TNeonToolAvailabilitySignal
  | { readonly anyOf: readonly TNeonToolAvailabilityExpression[] }
  | { readonly allOf: readonly TNeonToolAvailabilityExpression[] };

export type TNeonToolUnavailableReason =
  | "secret-ref-missing"
  | "binary-unverified"
  | "empty-group"
  | "unsupported-signal";

export interface INeonToolAvailabilityDiagnostic {
  readonly reason: TNeonToolUnavailableReason;
  readonly message: string;
  readonly providerId?: string;
}

export interface INeonToolDescriptor {
  readonly name: string;
  readonly family: TNeonToolFamily;
  readonly title: string;
  readonly description: string;
  readonly sideEffect: TNeonToolSideEffect;
  readonly owner: TNeonToolOwnerRef;
  readonly executor: TNeonToolExecutorRef;
  readonly availability: TNeonToolAvailabilityExpression;
}

/**
 * Evaluation context. `presentEnvRefs` carries only the NAMES of env vars that
 * are set to a non-empty value — never the values themselves. `availableBinaries`
 * is the set of binaries Doctor/host probing confirmed; absent binaries are
 * reported as `binary-unverified` (a soft, non-fatal signal).
 */
export interface INeonToolAvailabilityContext {
  readonly presentEnvRefs?: ReadonlySet<string>;
  readonly availableBinaries?: ReadonlySet<string>;
  readonly availableTransports?: ReadonlySet<string>;
}

function evaluateSignal(
  signal: TNeonToolAvailabilitySignal,
  context: INeonToolAvailabilityContext
): INeonToolAvailabilityDiagnostic | null {
  switch (signal.kind) {
    case "always":
      return null;
    case "secret-ref": {
      const present = signal.envRefs.some((ref) => context.presentEnvRefs?.has(ref) === true);
      return present
        ? null
        : {
            reason: "secret-ref-missing",
            providerId: signal.providerId,
            message: `Missing secret ref for provider ${signal.providerId}: ${signal.envRefs.join(" | ")}`
          };
    }
    case "binary":
      return context.availableBinaries?.has(signal.binary) === true
        ? null
        : { reason: "binary-unverified", message: `Local binary not verified: ${signal.binary}` };
    case "loopback":
      return context.availableTransports?.has(signal.transport) === true
        ? null
        : {
            reason: "binary-unverified",
            message: `Local transport not verified: ${signal.transport}`
          };
    default: {
      const exhaustive: never = signal;
      return {
        reason: "unsupported-signal",
        message: `Unsupported availability signal: ${JSON.stringify(exhaustive)}`
      };
    }
  }
}

/**
 * Returns the diagnostics that block a tool from being available. Empty array =
 * available. An `anyOf` group is satisfied when at least one branch yields no
 * diagnostics; `allOf` requires every branch to be clean.
 */
export function evaluateNeonToolAvailability(
  expression: TNeonToolAvailabilityExpression,
  context: INeonToolAvailabilityContext
): readonly INeonToolAvailabilityDiagnostic[] {
  if ("kind" in expression) {
    const diagnostic = evaluateSignal(expression, context);
    return diagnostic ? [diagnostic] : [];
  }

  if ("anyOf" in expression) {
    if (expression.anyOf.length === 0) {
      return [{ reason: "empty-group", message: "Empty availability anyOf group" }];
    }
    const branchDiagnostics = expression.anyOf.map((branch) =>
      evaluateNeonToolAvailability(branch, context)
    );
    const satisfied = branchDiagnostics.some((diagnostics) => diagnostics.length === 0);
    return satisfied ? [] : branchDiagnostics.flat();
  }

  if (expression.allOf.length === 0) {
    return [{ reason: "empty-group", message: "Empty availability allOf group" }];
  }
  return expression.allOf.flatMap((branch) => evaluateNeonToolAvailability(branch, context));
}

export interface INeonToolsLiveGate {
  readonly enabled: boolean;
  readonly reason: "tools-live-enabled" | "tools-live-disabled";
  readonly envKey: "NEON_TOOLS_LIVE_ENABLED";
}

const toolsLiveGateEnvKey = "NEON_TOOLS_LIVE_ENABLED" as const;

/**
 * The single decision point for live tool invocation. Default-off: the gate
 * arms only on an explicit ready-like flag value (1/ready/true/yes). When
 * closed, every side-effecting tool stays dry-run regardless of provider
 * readiness — no ungated web/api/voice side effect is possible.
 */
export function resolveNeonToolsLiveGate(
  env: Readonly<Record<string, string | undefined>>
): INeonToolsLiveGate {
  const enabled = readReadyCutoverEnv(env, toolsLiveGateEnvKey);
  return {
    enabled,
    reason: enabled ? "tools-live-enabled" : "tools-live-disabled",
    envKey: toolsLiveGateEnvKey
  };
}
