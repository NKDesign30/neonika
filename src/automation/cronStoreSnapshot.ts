import {
  computeNeonNextRunAtMs,
  parseNeonCronSchedule
} from "./cronSchedule.js";
import {
  projectNeonCronStoreJobs,
  readNeonCronStoreEvents,
  type INeonCronStoreJob
} from "./cronStore.js";
import {
  createNeonAutomationSnapshot,
  evaluateNeonCronRunIntent,
  type INeonAutomationDream,
  type INeonAutomationHook,
  type INeonAutomationJob,
  type INeonAutomationSnapshot
} from "./neonAutomation.js";

export interface ICreateNeonCronStoreAutomationSnapshotOptions {
  readonly generatedAt?: Date;
  readonly evaluateCronJobId?: string;
  readonly forceCronJobId?: string;
  readonly lastRunAtByJobId?: Readonly<Record<string, string>>;
}

export async function createNeonCronStoreAutomationSnapshot(
  projectRoot: string,
  options: ICreateNeonCronStoreAutomationSnapshotOptions = {}
): Promise<INeonAutomationSnapshot> {
  const generatedAt = options.generatedAt ?? new Date();
  const base = createNeonAutomationSnapshot({
    generatedAt,
    ...(options.evaluateCronJobId ? { evaluateCronJobId: options.evaluateCronJobId } : {}),
    ...(options.forceCronJobId ? { forceCronJobId: options.forceCronJobId } : {}),
    ...(options.lastRunAtByJobId ? { lastRunAtByJobId: options.lastRunAtByJobId } : {})
  });
  const storeJobs = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
  const runtimeJobs = buildNeonCronStoreAutomationJobs(storeJobs, {
    generatedAt,
    lastRunAtByJobId: options.lastRunAtByJobId ?? {}
  });
  const jobsById = new Map<string, INeonAutomationJob>();
  for (const job of base.jobs) {
    jobsById.set(job.id, job);
  }
  for (const job of runtimeJobs) {
    jobsById.set(job.id, job);
  }
  const jobs = [...jobsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const runIntent = evaluateNeonCronRunIntent(jobs, {
    evaluatedAt: generatedAt,
    ...(options.evaluateCronJobId ? { evaluateCronJobId: options.evaluateCronJobId } : {}),
    ...(options.forceCronJobId ? { forceCronJobId: options.forceCronJobId } : {})
  });

  return {
    ...base,
    jobs,
    runIntent,
    totals: buildAutomationTotals(jobs, base.hooks, base.dreams)
  };
}

export function buildNeonCronStoreAutomationJobs(
  jobs: readonly INeonCronStoreJob[],
  options: {
    readonly generatedAt: Date;
    readonly lastRunAtByJobId: Readonly<Record<string, string>>;
  }
): readonly INeonAutomationJob[] {
  return jobs.map((job) => buildNeonCronStoreAutomationJob(job, options));
}

function buildNeonCronStoreAutomationJob(
  job: INeonCronStoreJob,
  options: {
    readonly generatedAt: Date;
    readonly lastRunAtByJobId: Readonly<Record<string, string>>;
  }
): INeonAutomationJob {
  const parsedSchedule = parseNeonCronSchedule(job.schedule);
  const lastRunAt = options.lastRunAtByJobId[job.id];
  const lastRunAtMs = lastRunAt ? Date.parse(lastRunAt) : undefined;
  const hasLastRunAt = typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs);
  const nextRunAtMs =
    parsedSchedule.kind === "interval"
      ? computeNeonNextRunAtMs(
          job.schedule,
          hasLastRunAt ? lastRunAtMs : options.generatedAt.getTime() - parsedSchedule.intervalMs
        )
      : hasLastRunAt
        ? computeNeonNextRunAtMs(job.schedule, lastRunAtMs)
        : undefined;
  const intervalMinutes =
    parsedSchedule.kind === "interval" ? Math.max(1, Math.round(parsedSchedule.intervalMs / 60_000)) : undefined;

  return {
    id: job.id,
    kind: "cron",
    label: job.label,
    state: job.enabled ? "ready" : "disabled",
    policy: "operator-approval-required",
    schedule: job.schedule,
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
    ...(hasLastRunAt && lastRunAt ? { lastRunAt } : {}),
    ...(nextRunAtMs !== undefined ? { nextRunAt: new Date(nextRunAtMs).toISOString() } : {}),
    source: "cron-store",
    summary: job.deliveryTarget
      ? "Operator-defined cron job with a delivery target; shadow executor still suppresses outbound."
      : "Operator-defined cron job; shadow executor writes run-store visibility only."
  };
}

function buildAutomationTotals(
  jobs: readonly INeonAutomationJob[],
  hooks: readonly INeonAutomationHook[],
  dreams: readonly INeonAutomationDream[]
): INeonAutomationSnapshot["totals"] {
  const allStates = [
    ...jobs.map((job) => job.state),
    ...hooks.map((hook) => hook.state),
    ...dreams.map((dream) => dream.state)
  ];
  return {
    jobs: jobs.length,
    hooks: hooks.length,
    dreams: dreams.length,
    enabled: allStates.filter((state) => state === "ready").length,
    disabled: allStates.filter((state) => state === "disabled").length
  };
}
