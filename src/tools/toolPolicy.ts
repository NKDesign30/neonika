import { redactText } from "../harness/redaction.js";
import {
  evaluateNeonToolAvailability,
  type INeonToolAvailabilityContext,
  type INeonToolAvailabilityDiagnostic,
  type INeonToolDescriptor,
  type INeonToolsLiveGate,
  type TNeonToolExecutorRef,
  type TNeonToolFamily,
  type TNeonToolSideEffect
} from "./toolCapabilities.js";

// Neon Tools Runtime — policy/gate layer.
//
// Two pure functions, no I/O, no execution:
//  - planNeonToolInvocation: decides dry-run vs gated-live for a tool WITHOUT
//    running it. The plan is the single shadow-safe truth: `executed:false` and
//    `outboundPerformed:false` are hardcoded machine-checkable assertions. A
//    live decision only states that invocation WOULD be permitted, never that it
//    happened — no network/voice/exec path is wired anywhere in this module.
//  - boundNeonToolResult: the bounded + redacted shape every tool result must
//    take before crossing a boundary (redactText + byte/item caps).

export type TNeonToolInvocationDecision = "live-allowed" | "dry-run" | "blocked-unavailable";

export interface INeonToolInvocationPlan {
  readonly tool: string;
  readonly family: TNeonToolFamily;
  readonly sideEffect: TNeonToolSideEffect;
  readonly available: boolean;
  readonly gate: INeonToolsLiveGate;
  readonly decision: TNeonToolInvocationDecision;
  readonly mode: "dry-run" | "live";
  /** Hardcoded shadow-contract assertions: this module never executes a tool. */
  readonly executed: false;
  readonly outboundPerformed: false;
  readonly rationale: string;
  readonly diagnostics: readonly INeonToolAvailabilityDiagnostic[];
  readonly executor: TNeonToolExecutorRef;
}

export interface IPlanNeonToolInvocationParams {
  readonly descriptor: INeonToolDescriptor;
  readonly gate: INeonToolsLiveGate;
  readonly availability?: INeonToolAvailabilityContext;
}

/**
 * Decide how a tool would be invoked. Never executes. Decision matrix:
 *  - unavailable (availability diagnostics)      -> "blocked-unavailable" (dry-run mode)
 *  - available + gate closed (default)           -> "dry-run"
 *  - available + gate open                        -> "live-allowed" (live mode, still no execution)
 */
export function planNeonToolInvocation(
  params: IPlanNeonToolInvocationParams
): INeonToolInvocationPlan {
  const diagnostics = evaluateNeonToolAvailability(
    params.descriptor.availability,
    params.availability ?? {}
  );
  const available = diagnostics.length === 0;

  let decision: TNeonToolInvocationDecision;
  let rationale: string;
  if (!available) {
    decision = "blocked-unavailable";
    rationale = `Unavailable: ${diagnostics.map((diagnostic) => diagnostic.reason).join(", ")}`;
  } else if (!params.gate.enabled) {
    decision = "dry-run";
    rationale = `Live gate closed (${params.gate.envKey}); default dry-run`;
  } else {
    decision = "live-allowed";
    rationale = `Live gate open (${params.gate.envKey}); ${params.descriptor.sideEffect} invocation permitted`;
  }

  return {
    tool: params.descriptor.name,
    family: params.descriptor.family,
    sideEffect: params.descriptor.sideEffect,
    available,
    gate: params.gate,
    decision,
    mode: decision === "live-allowed" ? "live" : "dry-run",
    executed: false,
    outboundPerformed: false,
    rationale,
    diagnostics,
    executor: params.descriptor.executor
  };
}

export interface INeonToolResult {
  readonly tool: string;
  readonly redacted: true;
  readonly truncated: boolean;
  readonly byteCount: number;
  readonly itemCount: number;
  readonly preview: string;
}

export interface IBoundNeonToolResultParams {
  readonly tool: string;
  readonly text?: string;
  readonly items?: readonly string[];
}

export interface IBoundNeonToolResultOptions {
  readonly maxBytes?: number;
  readonly maxItems?: number;
}

const defaultMaxResultBytes = 2048;
const defaultMaxResultItems = 20;

/**
 * Produce the bounded, redacted shape a tool result must take before it crosses
 * any boundary. Redacts via redactText FIRST, then bounds by item count and
 * UTF-8 byte length. `truncated` is true when either cap clipped the input.
 */
export function boundNeonToolResult(
  params: IBoundNeonToolResultParams,
  options: IBoundNeonToolResultOptions = {}
): INeonToolResult {
  const maxBytes = Math.max(0, options.maxBytes ?? defaultMaxResultBytes);
  const maxItems = Math.max(0, options.maxItems ?? defaultMaxResultItems);

  const sourceItems = params.items ?? [];
  const itemTruncated = sourceItems.length > maxItems;
  const keptItems = sourceItems.slice(0, maxItems).map((item) => redactText(item));

  const joined = [params.text !== undefined ? redactText(params.text) : "", ...keptItems]
    .filter((segment) => segment.length > 0)
    .join("\n");

  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(joined);
  const byteTruncated = fullBytes.length > maxBytes;
  const preview = byteTruncated
    ? new TextDecoder().decode(fullBytes.slice(0, maxBytes))
    : joined;

  return {
    tool: params.tool,
    redacted: true,
    truncated: itemTruncated || byteTruncated,
    byteCount: encoder.encode(preview).length,
    itemCount: keptItems.length,
    preview
  };
}
