import { resolveNeonCronTimerGate, type INeonCronTimerGate } from "../automation/cronTimerRuntime.js";

// Neonika Transcript Indexer — gated scheduler intent (S5). This is the smallest
// honest scheduler slice: it DESCRIBES the cron job that would run the read-only
// transcript projection, gated by the existing cron-timer gate, and starts
// nothing. There is no setInterval, no daemon, no cron-store write. Even when the
// gate is armed it only flips `wouldEmit` — a real periodic runner is a separate
// daemon step (deferred). `safety.executed`/`timerStarted` are always false.

const DEFAULT_CADENCE_MINUTES = 5;
const TRANSCRIPT_INDEXER_JOB_ID = "neon-transcript-indexer";
const TRANSCRIPT_INDEXER_COMMAND = "node dist/src/cli.js transcript";

export interface INeonTranscriptScheduleIntent {
  readonly jobId: string;
  readonly cadenceMinutes: number;
  /** The read-only command a scheduler would invoke. Never executed here. */
  readonly command: string;
  readonly gateEnabled: boolean;
  readonly gateReason: INeonCronTimerGate["reason"];
  readonly gateEnvKey: INeonCronTimerGate["envKey"];
  /** True only when the gate is armed; still nothing runs from this module. */
  readonly wouldEmit: boolean;
  readonly generatedAt: string;
  readonly safety: {
    readonly executed: false;
    readonly outboundSent: false;
    readonly timerStarted: false;
  };
}

export interface IBuildNeonTranscriptScheduleIntentOptions {
  readonly gate?: INeonCronTimerGate;
  readonly now?: number;
  readonly cadenceMinutes?: number;
}

const safety = { executed: false, outboundSent: false, timerStarted: false } as const;

export function buildNeonTranscriptScheduleIntent(
  options: IBuildNeonTranscriptScheduleIntentOptions = {}
): INeonTranscriptScheduleIntent {
  const gate = options.gate ?? resolveNeonCronTimerGate();
  const now = options.now ?? Date.now();
  const cadenceMinutes = options.cadenceMinutes ?? DEFAULT_CADENCE_MINUTES;

  return {
    jobId: TRANSCRIPT_INDEXER_JOB_ID,
    cadenceMinutes,
    command: TRANSCRIPT_INDEXER_COMMAND,
    gateEnabled: gate.enabled,
    gateReason: gate.reason,
    gateEnvKey: gate.envKey,
    wouldEmit: gate.enabled,
    generatedAt: new Date(now).toISOString(),
    safety
  };
}

export function renderNeonTranscriptScheduleIntentReport(
  intent: INeonTranscriptScheduleIntent
): string {
  return [
    `Neonika Transcript Schedule Intent: ${intent.jobId}`,
    `Cadence: every ${intent.cadenceMinutes} min`,
    `Command: ${intent.command}`,
    `Gate: ${intent.gateReason} (env ${intent.gateEnvKey}), would-emit: ${intent.wouldEmit}`,
    `Safety: executed=${intent.safety.executed} timerStarted=${intent.safety.timerStarted} outboundSent=${intent.safety.outboundSent}`
  ].join("\n");
}
