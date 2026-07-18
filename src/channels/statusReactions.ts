import type { INeonDeliveryQueueTarget } from "../gateway/deliveryQueue.js";
import type {
  INeonReactionResult,
  INeonReactionSender
} from "../gateway/reactionSender.js";

/**
 * Channel-agnostische Status-Reaction-Policy für Neonika.
 *
 * Schwester von `gateway/reactionSender.ts` (dem gegateten Send-Seam): dieses
 * Modul entscheidet, WELCHES Emoji ein Agent-Status bekommt und OB/WANN ein
 * Übergang gesetzt werden darf. Bewusst pure und clock-injiziert — der Debounce
 * ist eine Daten-Entscheidung (`planNeonStatusReactionEmit`), kein `setTimeout`.
 * Damit ist die Policy deterministisch testbar und leak-frei, und der echte
 * Send läuft ausschließlich über den injizierten Reaction-Sender (default
 * no-send via DryRun).
 *
 * Vorlage: upstream `src/channels/status-reactions.ts`
 * (`StatusReactionController`, `DEFAULT_EMOJIS`, `DEFAULT_TIMING`,
 * `resolveToolEmoji`).
 */
export type TNeonStatusReactionState =
  | "queued"
  | "thinking"
  | "tool"
  | "coding"
  | "web"
  | "build"
  | "deploy"
  | "done"
  | "error"
  | "stall";

/**
 * Default-Emoji pro Status. Form 1:1 nach upstream projects `DEFAULT_EMOJIS`, reduziert
 * auf die Zustände, die neonika wirklich modelliert.
 */
export const neonStatusReactionEmojis: {
  readonly [state in TNeonStatusReactionState]: string;
} = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  build: "🏗️",
  deploy: "🛫",
  done: "✅",
  error: "❌",
  stall: "⏳"
};

/** Default-Debounce für Zwischenzustände (upstream `DEFAULT_TIMING.debounceMs`). */
export const NEON_STATUS_REACTION_DEBOUNCE_MS = 700;

/**
 * Terminale Zustände werden sofort gesetzt (kein Debounce) und verriegeln
 * danach weitere Übergänge — wie upstream projects "terminal state protection".
 */
const neonTerminalStatusReactions: ReadonlySet<TNeonStatusReactionState> = new Set([
  "done",
  "error"
]);

export function isNeonTerminalStatusReaction(state: TNeonStatusReactionState): boolean {
  return neonTerminalStatusReactions.has(state);
}

export type TNeonStatusReactionOverrides = Partial<
  Record<TNeonStatusReactionState, string>
>;

export function resolveNeonStatusReactionEmoji(
  state: TNeonStatusReactionState,
  overrides?: TNeonStatusReactionOverrides
): string {
  const override = overrides?.[state];
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  return neonStatusReactionEmojis[state];
}

// Tool-Name -> Kategorie-Token-Listen (Vorlage upstream `resolveToolEmoji`).
const neonDeployToolTokens: readonly string[] = ["deploy", "release", "publish", "ship"];
const neonBuildToolTokens: readonly string[] = [
  "build",
  "compile",
  "bundle",
  "webpack",
  "vite",
  "tsc",
  "cargo",
  "gradle",
  "make"
];
const neonWebToolTokens: readonly string[] = ["fetch", "http", "web", "url", "browser", "curl"];
const neonCodingToolTokens: readonly string[] = [
  "exec",
  "process",
  "shell",
  "bash",
  "edit",
  "write",
  "patch",
  "lint"
];

/**
 * Leitet aus einem Tool-Namen den passenden Status (und damit das Emoji) ab.
 * Reine Token-Klassifikation, kein I/O. Unbekannte Tools -> generisches "tool".
 */
export function resolveNeonToolReactionState(toolName: string | undefined): TNeonStatusReactionState {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (normalized === "") {
    return "tool";
  }
  if (neonDeployToolTokens.some((token) => normalized.includes(token))) {
    return "deploy";
  }
  if (neonBuildToolTokens.some((token) => normalized.includes(token))) {
    return "build";
  }
  if (neonWebToolTokens.some((token) => normalized.includes(token))) {
    return "web";
  }
  if (neonCodingToolTokens.some((token) => normalized.includes(token))) {
    return "coding";
  }
  return "tool";
}

/**
 * Scope-Gate: darf für diesen Kanal/diese Konfiguration überhaupt eine
 * Status-Reaction gesetzt werden? Reine Vorbedingung, bevor die Debounce-
 * Entscheidung greift. Vorlage upstream `shouldAckReaction` (channel-/config-
 * scoped). Default-restriktiv: beide Bedingungen müssen erfüllt sein.
 */
export function shouldEmitNeonStatusReaction(params: {
  readonly channelSupportsReactions: boolean;
  readonly statusReactionsEnabled: boolean;
}): boolean {
  return params.channelSupportsReactions && params.statusReactionsEnabled;
}

export type TNeonStatusReactionAction = "emit" | "hold" | "skip-finished" | "unchanged";

export interface INeonStatusReactionPlan {
  readonly action: TNeonStatusReactionAction;
  readonly state: TNeonStatusReactionState;
  readonly emoji: string;
  readonly holdRemainingMs?: number;
}

/**
 * Debounce-Entscheidung als reine Funktion (clock-injiziert, kein Timer):
 *
 * - `finished` (ein terminaler Zustand wurde schon gesetzt) -> `skip-finished`.
 * - terminaler Zielzustand -> `emit` sofort (kein Debounce).
 * - Ziel-Emoji == aktuelles Emoji -> `unchanged`.
 * - Zwischenzustand innerhalb des Debounce-Fensters -> `hold` (+ Restzeit).
 * - sonst -> `emit`.
 *
 * Der Caller hält den State (`currentEmoji`, `finished`, `lastIntermediateEmitAt`)
 * und fährt die Uhr über `now`. So bleibt die Policy ohne Hintergrund-Timer.
 */
export function planNeonStatusReactionEmit(params: {
  readonly nextState: TNeonStatusReactionState;
  readonly currentEmoji: string;
  readonly finished: boolean;
  readonly lastIntermediateEmitAt: number | null;
  readonly now: number;
  readonly debounceMs?: number;
  readonly overrides?: TNeonStatusReactionOverrides;
}): INeonStatusReactionPlan {
  const emoji = resolveNeonStatusReactionEmoji(params.nextState, params.overrides);

  if (params.finished) {
    return { action: "skip-finished", state: params.nextState, emoji };
  }

  if (isNeonTerminalStatusReaction(params.nextState)) {
    return { action: "emit", state: params.nextState, emoji };
  }

  if (emoji === params.currentEmoji) {
    return { action: "unchanged", state: params.nextState, emoji };
  }

  const debounceMs =
    params.debounceMs !== undefined && params.debounceMs > 0
      ? params.debounceMs
      : NEON_STATUS_REACTION_DEBOUNCE_MS;

  if (params.lastIntermediateEmitAt !== null) {
    const elapsed = params.now - params.lastIntermediateEmitAt;
    if (elapsed < debounceMs) {
      return {
        action: "hold",
        state: params.nextState,
        emoji,
        holdRemainingMs: debounceMs - elapsed
      };
    }
  }

  return { action: "emit", state: params.nextState, emoji };
}

/**
 * Konsumenten-Vertrag: routet eine `emit`-Entscheidung durch den injizierten
 * Reaction-Sender. Nur bei `action === "emit"` wird gesendet — alle anderen
 * Aktionen liefern `null` (kein Send). Mit dem DryRun-Sender trägt das Ergebnis
 * `reactionSent: false`; der echte Send entsteht nur über den gegateten
 * Canary-Sender.
 */
export function applyNeonStatusReaction(params: {
  readonly sender: INeonReactionSender;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly plan: INeonStatusReactionPlan;
}): Promise<INeonReactionResult | null> {
  if (params.plan.action !== "emit") {
    return Promise.resolve(null);
  }

  return params.sender.setReaction(params.target, params.messageId, params.plan.emoji);
}
