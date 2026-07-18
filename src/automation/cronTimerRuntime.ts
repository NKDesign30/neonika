import { readReadyCutoverEnv } from "../core/cutover.js";
import {
  createNeonAutomationSnapshot,
  evaluateNeonCronRunIntent,
  type INeonAutomationRunIntent,
  type INeonAutomationSnapshot
} from "./neonAutomation.js";

/**
 * Cron timer runtime (DP-8).
 *
 * Upstream runs a real scheduler that arms timers and executes agent runs:
 * `src/cron/service/timer.ts` (run + deliver) guarded by `src/cron/active-jobs.ts`
 * (`markCronJobActive`/`isCronJobActive` — a Set of in-flight job ids that
 * prevents-duplicate-timers) and rearmed via `computeNextRunAtMs`
 * (`src/cron/schedule.ts`).
 *
 * Neonika deliberately stops short of execution. The timer is the autonomous
 * side effect, so it is **default-off**: a tick only evaluates anything when
 * `NEON_CRON_TIMER_ENABLED` is explicitly ready. When armed it emits read-only
 * `shadow-run-intent`s — it never starts a run, writes the cron store, or sends.
 * Actual execution stays behind the harness write-mode gate (DP-4).
 *
 * intentionally-different vs upstream:
 * - "prevents-duplicate-timers" becomes due-window dedup: a job already emitted
 *   for its current `dueAt` window is not re-emitted (see `alreadyEmitted`),
 *   the no-execution analog of upstream's active-job Set.
 * - "rearm-when-running" has no analog because nothing runs; the next due window
 *   is already modeled by each job's `nextRunAt` in the automation snapshot.
 */
export type TNeonCronTimerReason = "timer-disabled" | "timer-enabled";

const cronTimerEnabledEnvKey = "NEON_CRON_TIMER_ENABLED";

export interface INeonCronTimerGate {
  readonly enabled: boolean;
  readonly reason: TNeonCronTimerReason;
  readonly envKey: typeof cronTimerEnabledEnvKey;
}

export interface IEvaluateNeonCronTickOptions {
  readonly gate: INeonCronTimerGate;
  readonly snapshot?: INeonAutomationSnapshot;
  readonly now?: () => Date;
  readonly forceJobIds?: readonly string[];
  readonly alreadyEmitted?: Readonly<Record<string, string>>;
}

export interface INeonCronTickResult {
  readonly armed: boolean;
  readonly gate: INeonCronTimerGate;
  readonly evaluatedAt: string;
  readonly intents: readonly INeonAutomationRunIntent[];
  readonly emitted: readonly string[];
  readonly deduped: readonly string[];
  readonly nextEmitted: Readonly<Record<string, string>>;
  readonly safety: { readonly executed: false; readonly outboundSent: false };
  readonly diagnostics: readonly string[];
}

export function resolveNeonCronTimerGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCronTimerGate {
  const enabled = readReadyCutoverEnv(env, cronTimerEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "timer-enabled" : "timer-disabled",
    envKey: cronTimerEnabledEnvKey
  };
}

export function evaluateNeonCronTick(
  options: IEvaluateNeonCronTickOptions
): INeonCronTickResult {
  const now = (options.now ?? (() => new Date()))();
  const evaluatedAt = now.toISOString();
  const snapshot = options.snapshot ?? createNeonAutomationSnapshot({ generatedAt: now });
  const cronJobs = snapshot.jobs.filter((job) => job.kind === "cron");

  if (!options.gate.enabled) {
    return {
      armed: false,
      gate: options.gate,
      evaluatedAt,
      intents: [],
      emitted: [],
      deduped: [],
      nextEmitted: options.alreadyEmitted ?? {},
      safety: { executed: false, outboundSent: false },
      diagnostics: [
        "Cron timer is disabled (default). No tick ran; set NEON_CRON_TIMER_ENABLED to arm read-only intent evaluation.",
        "Even when armed the timer only emits shadow run intents; execution stays gated by the harness write-mode gate (DP-4)."
      ]
    };
  }

  const intents: INeonAutomationRunIntent[] = [];
  const emitted: string[] = [];
  const deduped: string[] = [];
  const nextEmitted: Record<string, string> = { ...(options.alreadyEmitted ?? {}) };

  for (const job of cronJobs) {
    const forced = options.forceJobIds?.includes(job.id) ?? false;
    const intent = evaluateNeonCronRunIntent(snapshot.jobs, {
      evaluatedAt: now,
      evaluateCronJobId: job.id,
      ...(forced ? { forceCronJobId: job.id } : {})
    });
    intents.push(intent);

    if (intent.action !== "shadow-run-intent") {
      continue;
    }

    const windowKey = intent.dueAt ?? evaluatedAt;
    if (options.alreadyEmitted?.[job.id] === windowKey) {
      deduped.push(job.id);
      continue;
    }

    emitted.push(job.id);
    nextEmitted[job.id] = windowKey;
  }

  return {
    armed: true,
    gate: options.gate,
    evaluatedAt,
    intents,
    emitted,
    deduped,
    nextEmitted,
    safety: { executed: false, outboundSent: false },
    diagnostics: [
      `Cron timer armed: evaluated ${cronJobs.length} cron job(s), emitted ${emitted.length} read-only run intent(s), deduped ${deduped.length}.`,
      "Timer emits shadow run intents only; execution stays gated by the harness write-mode gate (DP-4)."
    ]
  };
}

export function renderNeonCronTickReport(result: INeonCronTickResult): string {
  const lines = [
    `Neon Cron Timer: ${result.armed ? "armed" : "disabled"} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Evaluated: ${result.evaluatedAt}`,
    `Cron jobs evaluated: ${result.intents.length}`,
    `Emitted run intents: ${result.emitted.length}${result.emitted.length ? ` (${result.emitted.join(", ")})` : ""}`,
    `Deduped (same due-window): ${result.deduped.length}${result.deduped.length ? ` (${result.deduped.join(", ")})` : ""}`,
    `Safety: executed=${result.safety.executed} outboundSent=${result.safety.outboundSent}`
  ];

  for (const intent of result.intents) {
    lines.push(`- ${intent.jobId}: ${intent.state} / ${intent.reason} / action=${intent.action}`);
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}
