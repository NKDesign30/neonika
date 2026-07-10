// Neon LLM fallback invoker — decorates an INeonLlmInvoker with the v3 escalation
// policy: when the primary (cheap) model genuinely fails or its output is
// quality-rejected, retry once with a stronger model. Gate-shaped non-calls
// (gate closed, no runner injected, dry-run) pass through untouched — a second
// spawn behind the same closed gate is pointless by construction.
//
// Deliberate difference to v3: the neon-core process runner does not capture
// stderr, so auth failures and rate limits are indistinguishable from timeouts
// (all collapse into "llm-call-failed-exit-*"). v3 suppressed the fallback for
// auth/rate; here the worst case is one doomed extra spawn. Classifying stderr
// would widen the shared runner shape and is a separate slice.
//
// Observability stays at the call site (no widening of TNeonLlmResult): the
// optional onFallback hook reports each escalation with a classified reason.

import type {
  INeonLlmInvoker,
  INeonLlmRequest,
  TNeonLlmModel,
  TNeonLlmResult
} from "./llmRuntime.js";

export type TNeonLlmFallbackReason = "call-failed" | "quality-reject";

export interface INeonLlmFallbackEvent {
  readonly from: TNeonLlmModel;
  readonly to: TNeonLlmModel;
  readonly reason: TNeonLlmFallbackReason;
}

export interface ICreateNeonFallbackLlmInvokerOptions {
  readonly invoker: INeonLlmInvoker;
  /** Escalation target — defaults to "sonnet". */
  readonly fallbackModel?: TNeonLlmModel;
  /** Quality hook: return true when the primary text warrants an escalation. */
  readonly shouldFallback?: (text: string) => boolean;
  /** Classified escalation event, fired once per fallback attempt. */
  readonly onFallback?: (event: INeonLlmFallbackEvent) => void;
}

const callFailedReasonPrefix = "llm-call-failed";

export function createNeonFallbackLlmInvoker(
  options: ICreateNeonFallbackLlmInvokerOptions
): INeonLlmInvoker {
  const fallbackModel = options.fallbackModel ?? "sonnet";

  return {
    async invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      const primary = await options.invoker.invoke(request);

      // Self-fallback is a no-op: the primary already ran on the target model.
      if (request.model === fallbackModel) {
        return primary;
      }

      let reason: TNeonLlmFallbackReason | null = null;
      if (!primary.called) {
        // Only a genuine call failure escalates. Gate-closed / no-runner /
        // dry-run non-calls would fail identically on the fallback model.
        if (primary.reason.startsWith(callFailedReasonPrefix)) {
          reason = "call-failed";
        }
      } else if (options.shouldFallback?.(primary.text) === true) {
        reason = "quality-reject";
      }

      if (reason === null) {
        return primary;
      }

      options.onFallback?.({ from: request.model, to: fallbackModel, reason });
      return options.invoker.invoke({ prompt: request.prompt, model: fallbackModel });
    }
  };
}
