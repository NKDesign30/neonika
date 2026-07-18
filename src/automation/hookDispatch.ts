import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";

/**
 * Internal hook dispatch (DP-9).
 *
 * Upstream registers handlers (`registerInternalHook`) and fires them with
 * `triggerInternalHook(event)` — `for (const handler of handlers) await handler(event)`
 * (`src/hooks/internal-hooks.ts`), where a handler may do anything (send, write,
 * cascade). That live dispatch is the side effect.
 *
 * Neonika keeps dispatch **default-off** and, even when armed, runs only handlers
 * that DECLARE `policy: "read-only"` and structurally can only observe: each handler
 * receives a frozen, redacted context and returns a short observation string — it is
 * never handed mutable state, a sender, or a writer. A handler that is not read-only
 * is filtered out of this path entirely (a write-capable hook would need its own gate
 * and operator approval). Every run produces a leak-safe audit trail; nothing is sent,
 * written, or mutated.
 */
export type TNeonHookDispatchReason = "dispatch-disabled" | "dispatch-enabled";

const hookDispatchEnabledEnvKey = "NEON_HOOK_DISPATCH_ENABLED";
const observationMaxLength = 200;
const payloadPreviewMaxLength = 160;

export interface INeonHookDispatchGate {
  readonly enabled: boolean;
  readonly reason: TNeonHookDispatchReason;
  readonly envKey: typeof hookDispatchEnabledEnvKey;
}

export interface INeonInternalHookContext {
  readonly event: string;
  readonly payloadPreview: string;
}

export interface INeonReadOnlyHookHandler {
  readonly hookId: string;
  readonly event: string;
  readonly policy: "read-only";
  readonly observe: (context: INeonInternalHookContext) => string;
}

export interface INeonHookDispatchAuditEntry {
  readonly hookId: string;
  readonly event: string;
  readonly outcome: "observed" | "handler-error";
  readonly observedAt: string;
  readonly observation: string;
}

export interface INeonHookDispatchResult {
  readonly dispatched: boolean;
  readonly event: string;
  readonly gate: INeonHookDispatchGate;
  readonly evaluatedAt: string;
  readonly ranHandlers: readonly string[];
  readonly skippedNonReadOnly: readonly string[];
  readonly audit: readonly INeonHookDispatchAuditEntry[];
  readonly safety: { readonly mutated: false; readonly outboundSent: false };
  readonly diagnostics: readonly string[];
}

export interface IDispatchNeonInternalHookOptions {
  readonly event: string;
  readonly gate: INeonHookDispatchGate;
  readonly payload?: unknown;
  readonly handlers?: readonly INeonReadOnlyHookHandler[];
  readonly now?: () => Date;
}

export function resolveNeonHookDispatchGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonHookDispatchGate {
  const enabled = readReadyCutoverEnv(env, hookDispatchEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "dispatch-enabled" : "dispatch-disabled",
    envKey: hookDispatchEnabledEnvKey
  };
}

/**
 * The shipped read-only handler set — observers bound to events already present in
 * the automation hook registry (`gateway:startup`, `message:received`). Each only
 * returns an observation string; it cannot reach send/write/mutation surfaces.
 */
export function createNeonReadOnlyHookHandlers(): readonly INeonReadOnlyHookHandler[] {
  return [
    {
      hookId: "gateway-start-observer",
      event: "gateway:startup",
      policy: "read-only",
      observe: (context) =>
        `observed ${context.event}${context.payloadPreview ? ` payload(${context.payloadPreview})` : ""}`
    },
    {
      hookId: "message-received-observer",
      event: "message:received",
      policy: "read-only",
      observe: (context) =>
        `observed inbound ${context.event}${context.payloadPreview ? ` payload(${context.payloadPreview})` : ""}`
    }
  ];
}

export function dispatchNeonInternalHook(
  options: IDispatchNeonInternalHookOptions
): INeonHookDispatchResult {
  const evaluatedAt = (options.now?.() ?? new Date()).toISOString();
  const handlers = options.handlers ?? createNeonReadOnlyHookHandlers();
  const forEvent = handlers.filter((handler) => handler.event === options.event);
  const readOnly = forEvent.filter((handler) => handler.policy === "read-only");
  const skippedNonReadOnly = forEvent
    .filter((handler) => handler.policy !== "read-only")
    .map((handler) => handler.hookId);

  if (!options.gate.enabled) {
    return {
      dispatched: false,
      event: options.event,
      gate: options.gate,
      evaluatedAt,
      ranHandlers: [],
      skippedNonReadOnly,
      audit: [],
      safety: { mutated: false, outboundSent: false },
      diagnostics: [
        "Hook dispatch is disabled (default). No handler ran; set NEON_HOOK_DISPATCH_ENABLED to arm read-only dispatch.",
        "Only handlers that declare policy:read-only are ever run by this path; write-capable hooks stay blocked."
      ]
    };
  }

  const payloadPreview = redactText(stringifyHookPayload(options.payload)).slice(0, payloadPreviewMaxLength);
  const context: INeonInternalHookContext = Object.freeze({ event: options.event, payloadPreview });

  const audit: INeonHookDispatchAuditEntry[] = [];
  const ranHandlers: string[] = [];

  for (const handler of readOnly) {
    ranHandlers.push(handler.hookId);
    try {
      const observation = redactText(handler.observe(context)).slice(0, observationMaxLength);
      audit.push({
        hookId: handler.hookId,
        event: handler.event,
        outcome: "observed",
        observedAt: evaluatedAt,
        observation
      });
    } catch {
      // Never surface a raw handler error (could carry context); reduce to a fixed marker.
      audit.push({
        hookId: handler.hookId,
        event: handler.event,
        outcome: "handler-error",
        observedAt: evaluatedAt,
        observation: "handler-error"
      });
    }
  }

  return {
    dispatched: true,
    event: options.event,
    gate: options.gate,
    evaluatedAt,
    ranHandlers,
    skippedNonReadOnly,
    audit,
    safety: { mutated: false, outboundSent: false },
    diagnostics: [
      `Hook dispatch armed: ran ${ranHandlers.length} read-only handler(s) for ${options.event}, skipped ${skippedNonReadOnly.length} non-read-only.`,
      "Handlers only observe; no send, write, or mutation path is reachable from dispatch."
    ]
  };
}

export function renderNeonHookDispatchReport(result: INeonHookDispatchResult): string {
  const lines = [
    `Neonika Hook Dispatch: ${result.dispatched ? "armed" : "disabled"} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Event: ${result.event}`,
    `Evaluated: ${result.evaluatedAt}`,
    `Ran handlers: ${result.ranHandlers.length}${result.ranHandlers.length ? ` (${result.ranHandlers.join(", ")})` : ""}`,
    `Skipped non-read-only: ${result.skippedNonReadOnly.length}`,
    `Safety: mutated=${result.safety.mutated} outboundSent=${result.safety.outboundSent}`
  ];

  for (const entry of result.audit) {
    lines.push(`- ${entry.hookId} [${entry.outcome}] ${entry.observation}`);
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}

function stringifyHookPayload(payload: unknown): string {
  if (payload === undefined || payload === null) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return "[unserializable-payload]";
  }
}
