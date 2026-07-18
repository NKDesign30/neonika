/**
 * Inbound text-debounce policy, a 1:1 rebuild of the pure decision layer of
 * Upstream `src/channels/inbound-debounce-policy.ts` (`shouldDebounceTextInbound`)
 * and `src/auto-reply/inbound-debounce.ts` (`resolveInboundDebounceMs`).
 *
 * Pure decision + config precedence only — it decides WHETHER a rapid inbound
 * text message should be coalesced and HOW LONG the debounce window is. It holds
 * no timers and no state: the stateful per-key coalescer is the runtime piece
 * that an armed ingress loop would drive. `isControlCommand` is taken as an
 * input boolean so this stays decoupled from command detection.
 */

export interface IShouldDebounceNeonTextInboundParams {
  readonly text: string | null | undefined;
  /** True when the message is a control/slash command — never debounced. */
  readonly isControlCommand: boolean;
  readonly hasMedia?: boolean;
  /** Explicit opt-out; `false` disables debouncing for this message. */
  readonly allowDebounce?: boolean;
}

export interface IResolveNeonInboundDebounceMsParams {
  readonly baseDebounceMs?: number;
  readonly byChannelMs?: number;
  readonly overrideMs?: number;
}

/**
 * Decides whether a text inbound should be debounced. Media, empty text,
 * control commands, and an explicit `allowDebounce: false` are never debounced.
 */
export function shouldDebounceNeonTextInbound(params: IShouldDebounceNeonTextInboundParams): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia === true) {
    return false;
  }
  const text = (params.text ?? "").trim();
  if (text.length === 0) {
    return false;
  }
  return !params.isControlCommand;
}

function normalizeDebounceMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

/**
 * Resolves the effective debounce window with upstream's precedence:
 * per-message override, then per-channel, then the base config, else 0.
 * Each candidate is clamped to a non-negative integer.
 */
export function resolveNeonInboundDebounceMs(params: IResolveNeonInboundDebounceMsParams): number {
  return (
    normalizeDebounceMs(params.overrideMs) ??
    normalizeDebounceMs(params.byChannelMs) ??
    normalizeDebounceMs(params.baseDebounceMs) ??
    0
  );
}

export function renderNeonInboundDebounceReport(params: {
  readonly decision: boolean;
  readonly debounceMs: number;
}): string {
  return [
    "Neonika Inbound Debounce Policy",
    `Debounce: ${params.decision}`,
    `Window: ${params.debounceMs}ms`
  ].join("\n");
}
