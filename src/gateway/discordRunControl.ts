import type { INeonDiscordComponentActionRegistry } from "./discordComponentActionRegistry.js";
import type { INeonInFlightRunRecord, INeonInFlightRunRegistry } from "./inFlightRunRegistry.js";
import type { INeonSessionActorQueue } from "./sessionActorQueue.js";

export type TNeonDiscordRunControlCommand = "stop";
export type TNeonDiscordRunControlState = "stopped" | "idle" | "blocked" | "partial";

export interface INeonDiscordRunControlResult {
  readonly command: TNeonDiscordRunControlCommand;
  readonly state: TNeonDiscordRunControlState;
  readonly activeRunsMatched: number;
  readonly interruptsSent: number;
  readonly localAbortsSent: number;
  readonly pendingTasksCancelled: number;
  readonly failures: number;
  readonly message: string;
  readonly controlledAt: string;
}

export interface INeonDiscordRunControlRuntime {
  readonly inFlightRuns: INeonInFlightRunRegistry;
  resolveAbortSignal(
    runId: string,
    sessionKey: string,
    receivedAt?: string
  ): AbortSignal;
  stopSession(sessionKey: string): Promise<INeonDiscordRunControlResult>;
}

export interface INeonDiscordRunControlOptions {
  readonly inFlightRuns: INeonInFlightRunRegistry;
  readonly sessionQueue: INeonSessionActorQueue;
  readonly interruptRun: (record: INeonInFlightRunRecord) => Promise<void>;
  readonly now?: () => Date;
  readonly maxControllers?: number;
  readonly maxCutoffs?: number;
}

export interface INeonDiscordStopActionInput {
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly runControl: INeonDiscordRunControlRuntime;
  readonly ownerUserId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly expiresAt: string;
}

const stopCommands = new Set(["/stop", "/abort", "stop", "stopp", "abbruch", "abbrechen"]);
const defaultMaxEntries = 5_000;

interface IAbortControllerRecord {
  readonly controller: AbortController;
  readonly sessionKey: string;
}

export function parseNeonDiscordRunControlCommand(
  content: string
): TNeonDiscordRunControlCommand | undefined {
  const normalized = content
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/[.!?！？…,，。;；:：'"’”]+$/u, "")
    .replace(/\s+/gu, " ");
  return stopCommands.has(normalized) ? "stop" : undefined;
}

export function createNeonDiscordRunControl(
  options: INeonDiscordRunControlOptions
): INeonDiscordRunControlRuntime {
  const controllers = new Map<string, IAbortControllerRecord>();
  const stopCutoffs = new Map<string, number>();
  const now = options.now ?? (() => new Date());
  const maxControllers = normalizeMaxEntries(options.maxControllers);
  const maxCutoffs = normalizeMaxEntries(options.maxCutoffs);

  return {
    inFlightRuns: options.inFlightRuns,
    resolveAbortSignal(runId, sessionKey, receivedAt) {
      const normalizedRunId = requireNonEmpty(runId, "runId");
      const normalizedSessionKey = requireNonEmpty(sessionKey, "sessionKey");
      const controller = new AbortController();
      controllers.set(normalizedRunId, { controller, sessionKey: normalizedSessionKey });
      enforceMapLimit(controllers, maxControllers);

      const cutoff = stopCutoffs.get(normalizedSessionKey);
      const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
      if (cutoff !== undefined && Number.isFinite(receivedAtMs) && receivedAtMs <= cutoff) {
        controller.abort("neon_discord_stop_cutoff");
      }
      return controller.signal;
    },
    async stopSession(sessionKey) {
      const normalizedSessionKey = requireNonEmpty(sessionKey, "sessionKey");
      const controlledAt = now();

      if (!options.inFlightRuns.gate.enabled) {
        return createResult({
          state: "blocked",
          controlledAt,
          message: "Stop ist für diese Runtime nicht aktiviert."
        });
      }

      stopCutoffs.delete(normalizedSessionKey);
      stopCutoffs.set(normalizedSessionKey, controlledAt.getTime());
      enforceMapLimit(stopCutoffs, maxCutoffs);

      const records = options.inFlightRuns
        .snapshot()
        .running.filter((record) => record.sessionKey === normalizedSessionKey);
      const runIds = new Set(records.map((record) => record.runId));
      for (const [runId, record] of controllers) {
        if (record.sessionKey === normalizedSessionKey) {
          runIds.add(runId);
        }
      }

      let interruptsSent = 0;
      let localAbortsSent = 0;
      let failures = 0;
      for (const runId of runIds) {
        const record = controllers.get(runId);
        if (!record) {
          continue;
        }
        if (!record.controller.signal.aborted) {
          record.controller.abort("neon_discord_stop");
          localAbortsSent += 1;
        }
        controllers.delete(runId);
      }
      const interruptOutcomes = await Promise.allSettled(
        records.map(async (record) => {
          options.inFlightRuns.markInterrupting(record.runId);
          await options.interruptRun(record);
        })
      );
      interruptsSent = interruptOutcomes.filter((outcome) => outcome.status === "fulfilled").length;
      failures = interruptOutcomes.length - interruptsSent;

      const pendingTasksCancelled = options.sessionQueue.cancelPending(normalizedSessionKey);
      const stopped = interruptsSent + localAbortsSent + pendingTasksCancelled;
      const state: TNeonDiscordRunControlState =
        failures > 0 && stopped > 0 ? "partial" : failures > 0 ? "blocked" : stopped > 0 ? "stopped" : "idle";
      const message =
        state === "idle"
          ? "Keine laufende Aufgabe in dieser Session."
          : state === "blocked"
            ? "Die Aufgabe konnte nicht gestoppt werden."
            : state === "partial"
              ? "Stop teilweise ausgeführt. Die Runtime prüft den Rest weiter."
              : `✓ Gestoppt: ${runIds.size} laufend, ${pendingTasksCancelled} wartend.`;

      return createResult({
        state,
        activeRunsMatched: runIds.size,
        interruptsSent,
        localAbortsSent,
        pendingTasksCancelled,
        failures,
        controlledAt,
        message
      });
    }
  };
}

export function registerNeonDiscordStopAction(
  input: INeonDiscordStopActionInput
): { readonly actionId: string; readonly customId: string; readonly expiresAt: string } {
  return input.registry.register({
    ownerUserId: input.ownerUserId,
    ...(input.guildId ? { guildId: input.guildId } : {}),
    channelId: input.channelId,
    sessionKey: input.sessionKey,
    actionType: "run-control:stop",
    interactionKind: "button",
    consumptionKey: `run-control:stop:${input.sessionKey}`,
    expiresAt: input.expiresAt,
    handler: async () => {
      const result = await input.runControl.stopSession(input.sessionKey);
      return { message: result.message };
    }
  });
}

function createResult(
  input: Partial<Omit<INeonDiscordRunControlResult, "command" | "controlledAt">> & {
    readonly state: TNeonDiscordRunControlState;
    readonly controlledAt: Date;
    readonly message: string;
  }
): INeonDiscordRunControlResult {
  return {
    command: "stop",
    state: input.state,
    activeRunsMatched: input.activeRunsMatched ?? 0,
    interruptsSent: input.interruptsSent ?? 0,
    localAbortsSent: input.localAbortsSent ?? 0,
    pendingTasksCancelled: input.pendingTasksCancelled ?? 0,
    failures: input.failures ?? 0,
    message: input.message,
    controlledAt: input.controlledAt.toISOString()
  };
}

function normalizeMaxEntries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultMaxEntries;
  }
  return Math.max(1, Math.trunc(value));
}

function enforceMapLimit<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Discord run control ${field} is required`);
  }
  return normalized;
}
