/**
 * Typing-indicator start guard, a rebuild of upstream
 * `src/channels/typing-start-guard.ts`.
 *
 * A circuit breaker around the (outbound-adjacent) typing indicator. The guard
 * performs no I/O itself: the caller passes a `start` thunk and the guard
 * decides whether to run it, counts consecutive failures, and trips after a
 * threshold so a failing typing endpoint is not hammered. It also stays sealed
 * once the surrounding run is done (`isSealed`).
 *
 * This fits the shadow contract the same way the dry-run sender does: nothing is
 * sent by the guard. In shadow mode the caller's `start` thunk is a no-op (or
 * the gated sender), so arming a real typing signal stays a product decision.
 *
 * Leak-safe by construction: the guard stores only a failure counter and a
 * tripped flag, never the raw error — errors go to the caller's `onStartError`
 * and are only rethrown when `rethrowOnError` is set.
 */

export type TNeonTypingStartOutcome = "started" | "skipped" | "failed" | "tripped";

export interface INeonTypingStartGuard {
  readonly run: (start: () => Promise<void> | void) => Promise<TNeonTypingStartOutcome>;
  readonly reset: () => void;
  readonly isTripped: () => boolean;
}

export interface INeonTypingStartGuardParams {
  readonly isSealed: () => boolean;
  readonly shouldBlock?: () => boolean;
  readonly onStartError?: (err: unknown) => void;
  readonly maxConsecutiveFailures?: number;
  readonly onTrip?: () => void;
  readonly rethrowOnError?: boolean;
}

export function createNeonTypingStartGuard(
  params: INeonTypingStartGuardParams
): INeonTypingStartGuard {
  const maxConsecutiveFailures =
    typeof params.maxConsecutiveFailures === "number" && params.maxConsecutiveFailures > 0
      ? Math.floor(params.maxConsecutiveFailures)
      : undefined;
  let consecutiveFailures = 0;
  let tripped = false;

  const isBlocked = (): boolean => {
    if (params.isSealed()) {
      return true;
    }
    if (tripped) {
      return true;
    }
    return params.shouldBlock?.() === true;
  };

  const run: INeonTypingStartGuard["run"] = async (start) => {
    if (isBlocked()) {
      return "skipped";
    }
    try {
      await start();
      consecutiveFailures = 0;
      return "started";
    } catch (err) {
      consecutiveFailures += 1;
      params.onStartError?.(err);
      if (params.rethrowOnError) {
        throw err;
      }
      if (maxConsecutiveFailures && consecutiveFailures >= maxConsecutiveFailures) {
        tripped = true;
        params.onTrip?.();
        return "tripped";
      }
      return "failed";
    }
  };

  return {
    run,
    reset: () => {
      consecutiveFailures = 0;
      tripped = false;
    },
    isTripped: () => tripped
  };
}

export function renderNeonTypingStartGuardReport(
  outcomes: readonly { readonly label: string; readonly outcome: TNeonTypingStartOutcome }[]
): string {
  return ["Neonika Typing Start Guard", ...outcomes.map((o) => `${o.label}: ${o.outcome}`)].join("\n");
}
