import { isNeonCronScheduleDue, parseNeonCronSchedule } from "./cronSchedule.js";

export type TNeonAutomationState = "ready";
export type TNeonAutomationEntryState = "disabled" | "ready";
export type TNeonAutomationEntryPolicy = "read-only" | "operator-approval-required";
export type TNeonAutomationJobKind = "cron" | "hook" | "dream";
export type TNeonAutomationHookRegistryState = "read-only";
export type TNeonAutomationDreamPhase = "off" | "light" | "deep" | "rem";
export type TNeonAutomationRunIntentState = "blocked" | "not-due" | "ready";
export type TNeonAutomationRunIntentReason =
  | "job-not-found"
  | "scheduler-disabled"
  | "manual-only"
  | "not-due"
  | "ready";
export type TNeonAutomationRunIntentAction = "none" | "shadow-run-intent";

export interface ICreateNeonAutomationSnapshotOptions {
  readonly generatedAt?: Date;
  readonly evaluateCronJobId?: string;
  readonly forceCronJobId?: string;
  readonly lastRunAtByJobId?: Readonly<Record<string, string>>;
}

export interface INeonAutomationJob {
  readonly id: string;
  readonly kind: TNeonAutomationJobKind;
  readonly label: string;
  readonly state: TNeonAutomationEntryState;
  readonly policy: TNeonAutomationEntryPolicy;
  readonly schedule: string;
  readonly intervalMinutes?: number;
  readonly lastRunAt?: string;
  readonly nextRunAt?: string;
  readonly source: string;
  readonly summary: string;
}

export interface INeonAutomationRunIntent {
  readonly jobId: string;
  readonly state: TNeonAutomationRunIntentState;
  readonly reason: TNeonAutomationRunIntentReason;
  readonly action: TNeonAutomationRunIntentAction;
  readonly evaluatedAt: string;
  readonly forced: boolean;
  readonly due: boolean;
  readonly dueAt?: string;
  readonly diagnostics: readonly string[];
}

export interface INeonAutomationHook {
  readonly id: string;
  readonly event: string;
  readonly state: TNeonAutomationEntryState;
  readonly policy: TNeonAutomationEntryPolicy;
  readonly source: string;
  readonly summary: string;
}

export interface INeonAutomationHookRegistration {
  readonly hookId: string;
  readonly event: string;
  readonly state: TNeonAutomationEntryState;
  readonly policy: TNeonAutomationEntryPolicy;
}

export interface INeonAutomationHookEventGroup {
  readonly event: string;
  readonly hookIds: readonly string[];
}

export interface INeonAutomationHookRegistry {
  readonly state: TNeonAutomationHookRegistryState;
  readonly registrations: readonly INeonAutomationHookRegistration[];
  readonly byEvent: readonly INeonAutomationHookEventGroup[];
  readonly eventKeys: readonly string[];
  readonly handlerCount: 0;
  readonly dispatchEnabled: false;
  readonly diagnostics: readonly string[];
}

export interface INeonAutomationDream {
  readonly id: string;
  readonly state: TNeonAutomationEntryState;
  readonly policy: TNeonAutomationEntryPolicy;
  readonly phase: TNeonAutomationDreamPhase;
  readonly lastReflectionAt: string | null;
  readonly reflectionEnabled: boolean;
  readonly source: string;
  readonly summary: string;
}

export interface INeonAutomationSource {
  readonly referenceCronDocs: string;
  readonly referenceHooksDocs: string;
  readonly referenceCronSource: string;
  readonly referenceHooksSource: string;
}

export interface INeonAutomationTotals {
  readonly jobs: number;
  readonly hooks: number;
  readonly dreams: number;
  readonly enabled: number;
  readonly disabled: number;
}

export interface INeonAutomationSnapshot {
  readonly state: TNeonAutomationState;
  readonly generatedAt: string;
  readonly source: INeonAutomationSource;
  readonly policy: "shadow-read-only";
  readonly jobs: readonly INeonAutomationJob[];
  readonly hooks: readonly INeonAutomationHook[];
  readonly hookRegistry: INeonAutomationHookRegistry;
  readonly dreams: readonly INeonAutomationDream[];
  readonly runIntent: INeonAutomationRunIntent;
  readonly totals: INeonAutomationTotals;
  readonly recovery: readonly string[];
}

// Provenance links for the modelled-after references. Public URLs, not local
// checkout paths: a reader can follow them, and no operator's filesystem layout
// leaks into a snapshot that is served over HTTP.
const referenceRepoBlob = "https://github.com/openclaw/openclaw/blob/main";
const referenceCronDocs = `${referenceRepoBlob}/docs/automation/cron-jobs.md`;
const referenceHooksDocs = `${referenceRepoBlob}/docs/automation/hooks.md`;
const referenceCronSource = `${referenceRepoBlob}/src/cli/cron-cli.ts`;
const referenceHooksSource = `${referenceRepoBlob}/src/hooks`;

export function createNeonAutomationSnapshot(
  options: ICreateNeonAutomationSnapshotOptions = {}
): INeonAutomationSnapshot {
  const generatedAt = options.generatedAt ?? new Date();
  const jobs = createAutomationJobs({
    generatedAt,
    ...(options.lastRunAtByJobId ? { lastRunAtByJobId: options.lastRunAtByJobId } : {})
  });
  const hooks = createAutomationHooks();
  const hookRegistry = createNeonAutomationHookRegistry(hooks);
  const dreams = createAutomationDreams();
  const disabled = countDisabled(jobs, hooks, dreams);
  const runIntent = evaluateNeonCronRunIntent(jobs, {
    evaluatedAt: generatedAt,
    ...(options.evaluateCronJobId ? { evaluateCronJobId: options.evaluateCronJobId } : {}),
    ...(options.forceCronJobId ? { forceCronJobId: options.forceCronJobId } : {})
  });

  return {
    state: "ready",
    generatedAt: generatedAt.toISOString(),
    source: {
      referenceCronDocs,
      referenceHooksDocs,
      referenceCronSource,
      referenceHooksSource
    },
    policy: "shadow-read-only",
    jobs,
    hooks,
    hookRegistry,
    dreams,
    runIntent,
    totals: {
      jobs: jobs.length,
      hooks: hooks.length,
      dreams: dreams.length,
      enabled: 0,
      disabled
    },
    recovery: [
      "Keep scheduler disabled until Doctor, route allowlists, and canary approval pass.",
      "Persist job definitions only after operator approval and rollback evidence exist."
    ]
  };
}

export function renderNeonAutomationReport(snapshot: INeonAutomationSnapshot): string {
  const jobLines = snapshot.jobs.map(
    (job) => `- ${job.id}: ${job.state} / ${job.policy} / ${job.schedule}`
  );
  const hookLines = snapshot.hooks.map(
    (hook) => `- ${hook.id}: ${hook.state} / ${hook.event} / ${hook.policy}`
  );
  const dreamLines = snapshot.dreams.map(
    (dream) =>
      `- ${dream.id}: ${dream.state} / ${dream.policy} / phase=${dream.phase} / reflection=${dream.reflectionEnabled ? "on" : "off"}`
  );
  const hookRegistryLines = snapshot.hookRegistry.byEvent.map(
    (group) => `- ${group.event}: ${group.hookIds.join(", ") || "none"}`
  );

  return [
    `Neon Automation: ${snapshot.state}`,
    `Policy: ${snapshot.policy}`,
    `Totals: jobs=${snapshot.totals.jobs} hooks=${snapshot.totals.hooks} dreams=${snapshot.totals.dreams} enabled=${snapshot.totals.enabled}`,
    `Run Intent: ${snapshot.runIntent.jobId} / ${snapshot.runIntent.state} / ${snapshot.runIntent.reason}`,
    `Hook Registry: ${snapshot.hookRegistry.eventKeys.length} event(s) / dispatch=${snapshot.hookRegistry.dispatchEnabled ? "on" : "off"}`,
    ...hookRegistryLines,
    "Jobs:",
    ...jobLines,
    "Hooks:",
    ...hookLines,
    "Dreams:",
    ...dreamLines,
    "Recovery:",
    ...snapshot.recovery.map((step) => `- ${step}`)
  ].join("\n");
}

/**
 * Read-only cron-only listing (parity with upstream's `cron list` / `cron.list`
 * in `src/cli/cron-cli/register.cron-simple.ts:98`). intentionally-different:
 * Upstream paginates a live gateway RPC backed by a real scheduler; Neon renders
 * the read-only automation snapshot. Unlike the full `automation` report this is
 * cron-only and carries richer per-job fields (next/last/source). No scheduler,
 * timer, handler exec, or state write.
 */
export function renderNeonAutomationCronListReport(snapshot: INeonAutomationSnapshot): string {
  const header = [
    `Neon Cron Jobs: ${snapshot.jobs.length} (policy=${snapshot.policy})`,
    "Scheduler: disabled (read-only shadow inventory)"
  ];

  if (snapshot.jobs.length === 0) {
    return [...header, "No cron jobs registered."].join("\n");
  }

  const jobLines = snapshot.jobs.map((job) =>
    [
      `- ${job.id} [${job.state}]`,
      `policy=${job.policy}`,
      `schedule=${job.schedule}${job.intervalMinutes !== undefined ? `(${job.intervalMinutes}m)` : ""}`,
      `next=${job.nextRunAt ?? "none"}`,
      `last=${job.lastRunAt ?? "none"}`,
      `source=${job.source}`
    ].join(" ")
  );

  return [...header, ...jobLines].join("\n");
}

/**
 * Read-only detail report for a single cron job (parity with upstream's
 * `cron get` / `cron.get` CLI in `src/cli/cron-cli/register.cron-simple.ts`).
 * intentionally-different: upstream calls a live gateway RPC backed by a real
 * scheduler; Neon renders the read-only automation snapshot (default-off
 * scheduler) plus the job's evaluated, non-executing run intent. No timer, no
 * handler exec, no state write.
 */
export function renderNeonAutomationCronJobReport(
  snapshot: INeonAutomationSnapshot,
  jobId: string
): string {
  const job = snapshot.jobs.find((entry) => entry.id === jobId);

  if (!job) {
    const available = snapshot.jobs.map((entry) => entry.id).join(", ");
    return `Neon Cron job not found: ${jobId}\nAvailable jobs: ${available || "none"}`;
  }

  const lines = [
    `Neon Cron Job: ${job.id}`,
    `Label: ${job.label}`,
    `State: ${job.state} / policy=${job.policy}`,
    `Schedule: ${job.schedule}${job.intervalMinutes !== undefined ? ` (${job.intervalMinutes}m)` : ""}`,
    `Next run: ${job.nextRunAt ?? "none"}`,
    `Last run: ${job.lastRunAt ?? "none"}`,
    `Source: ${job.source}`,
    `Summary: ${job.summary}`
  ];

  if (snapshot.runIntent.jobId === jobId) {
    const intent = snapshot.runIntent;
    lines.push(
      `Run intent: ${intent.state} / ${intent.reason} / action=${intent.action}`,
      `Due: ${intent.due}${intent.dueAt ? ` (at ${intent.dueAt})` : ""} / forced=${intent.forced} / evaluatedAt=${intent.evaluatedAt}`,
      ...intent.diagnostics.map((diagnostic) => `- ${diagnostic}`)
    );
  }

  return lines.join("\n");
}

function createAutomationJobs(options: {
  readonly generatedAt: Date;
  readonly lastRunAtByJobId?: Readonly<Record<string, string>>;
}): readonly INeonAutomationJob[] {
  const heartbeatTiming = createCronTiming("heartbeat-review", 15, options);

  return [
    {
      id: "heartbeat-review",
      kind: "cron",
      label: "Heartbeat Review",
      state: "disabled",
      policy: "operator-approval-required",
      schedule: "every-15m",
      intervalMinutes: 15,
      ...heartbeatTiming,
      source: referenceCronDocs,
      summary: "Cron-shaped wake lane for future heartbeat checks; scheduler is off."
    },
    {
      id: "memory-digest",
      kind: "cron",
      label: "Memory Digest",
      state: "disabled",
      policy: "operator-approval-required",
      schedule: "manual-only",
      ...(options.lastRunAtByJobId?.["memory-digest"] ? { lastRunAt: options.lastRunAtByJobId["memory-digest"] } : {}),
      source: referenceCronDocs,
      summary: "Future isolated memory summary job; no background run is scheduled."
    }
  ];
}

function createAutomationHooks(): readonly INeonAutomationHook[] {
  return [
    {
      id: "gateway-start",
      event: "gateway:startup",
      state: "disabled",
      policy: "read-only",
      source: referenceHooksDocs,
      summary: "Lifecycle hook catalog entry only; no handler is loaded."
    },
    {
      id: "session-memory",
      event: "session:compact:after",
      state: "disabled",
      policy: "operator-approval-required",
      source: referenceHooksDocs,
      summary: "Future memory persistence hook; writes stay blocked."
    },
    {
      id: "message-received",
      event: "message:received",
      state: "disabled",
      policy: "read-only",
      source: referenceHooksDocs,
      summary: "Read-only inbound-message observation hook; dispatch stays gated off, no reply or write path."
    }
  ];
}

function createNeonAutomationHookRegistry(
  hooks: readonly INeonAutomationHook[]
): INeonAutomationHookRegistry {
  const registrations = hooks.map((hook) => ({
    hookId: hook.id,
    event: hook.event,
    state: hook.state,
    policy: hook.policy
  }));
  const eventKeys = Array.from(new Set(registrations.map((registration) => registration.event))).sort();
  const byEvent = eventKeys.map((event) => ({
    event,
    hookIds: registrations
      .filter((registration) => registration.event === event)
      .map((registration) => registration.hookId)
      .sort()
  }));

  return {
    state: "read-only",
    registrations,
    byEvent,
    eventKeys,
    handlerCount: 0,
    dispatchEnabled: false,
    diagnostics: [
      "Hook events are registered as reference data only.",
      "No hook handlers are loaded and no hook dispatch path is enabled."
    ]
  };
}

function createAutomationDreams(): readonly INeonAutomationDream[] {
  return [
    {
      id: "neon-dreaming",
      state: "disabled",
      policy: "operator-approval-required",
      phase: "off",
      lastReflectionAt: null,
      reflectionEnabled: false,
      source: `${referenceRepoBlob}/ui/src/ui/views/dreaming.ts`,
      summary: "Dreaming view is modeled; autonomous background thinking is off."
    },
    {
      id: "memory-consolidation",
      state: "disabled",
      policy: "operator-approval-required",
      phase: "off",
      lastReflectionAt: null,
      reflectionEnabled: false,
      source: `${referenceRepoBlob}/src/memory-host-sdk/dreaming.ts`,
      summary: "Memory consolidation/promotion is inventoried read-only; no reflection runs and no memory is written."
    }
  ];
}

function countDisabled(
  jobs: readonly INeonAutomationJob[],
  hooks: readonly INeonAutomationHook[],
  dreams: readonly INeonAutomationDream[]
): number {
  return [...jobs, ...hooks, ...dreams].filter((entry) => entry.state === "disabled").length;
}

/**
 * Pure cron run-intent evaluator over an arbitrary job list. Exported so the cron
 * timer runtime (DP-8) can drive a tick over the catalog without re-deriving the
 * due/blocked/manual-only logic. Returns a non-executing intent: `shadow-run-intent`
 * only when a job is both `ready` and due — disabled jobs stay `blocked`/`none`.
 */
export function evaluateNeonCronRunIntent(
  jobs: readonly INeonAutomationJob[],
  options: {
    readonly evaluatedAt: Date;
    readonly evaluateCronJobId?: string;
    readonly forceCronJobId?: string;
  }
): INeonAutomationRunIntent {
  const jobId = options.evaluateCronJobId ?? jobs.find((job) => job.kind === "cron")?.id ?? "unknown";
  const forced = options.forceCronJobId === jobId;
  const job = jobs.find((candidate) => candidate.id === jobId && candidate.kind === "cron");
  const evaluatedAt = options.evaluatedAt.toISOString();

  if (!job) {
    return {
      jobId,
      state: "blocked",
      reason: "job-not-found",
      action: "none",
      evaluatedAt,
      forced,
      due: false,
      diagnostics: ["Cron job is not in the automation catalog; no run intent created."]
    };
  }

  const due = forced || isCronJobDue(job, options.evaluatedAt);
  const dueAt = job.nextRunAt;

  if (job.state !== "ready") {
    return {
      jobId: job.id,
      state: "blocked",
      reason: "scheduler-disabled",
      action: "none",
      evaluatedAt,
      forced,
      due,
      ...(dueAt ? { dueAt } : {}),
      diagnostics: [
        "Automation scheduler is disabled; this is a read-only due evaluation.",
        "No timer, run record, delivery, or workspace side effect was created."
      ]
    };
  }

  if (!forced && job.schedule === "manual-only") {
    return {
      jobId: job.id,
      state: "not-due",
      reason: "manual-only",
      action: "none",
      evaluatedAt,
      forced,
      due: false,
      diagnostics: ["Cron job is manual-only; force evaluation is required before a run intent exists."]
    };
  }

  if (!due) {
    return {
      jobId: job.id,
      state: "not-due",
      reason: "not-due",
      action: "none",
      evaluatedAt,
      forced,
      due: false,
      ...(dueAt ? { dueAt } : {}),
      diagnostics: ["Cron job is not due at the evaluation timestamp."]
    };
  }

  return {
    jobId: job.id,
    state: "ready",
    reason: "ready",
    action: "shadow-run-intent",
    evaluatedAt,
    forced,
    due: true,
    ...(dueAt ? { dueAt } : {}),
    diagnostics: ["Cron job would create a shadow run intent; execution is still gated by caller policy."]
  };
}

function createCronTiming(
  jobId: string,
  intervalMinutes: number,
  options: {
    readonly generatedAt: Date;
    readonly lastRunAtByJobId?: Readonly<Record<string, string>>;
  }
): Pick<INeonAutomationJob, "lastRunAt" | "nextRunAt"> {
  const lastRunAt = options.lastRunAtByJobId?.[jobId];
  const lastRunDate = lastRunAt ? parseIsoDate(lastRunAt) : undefined;
  const nextRunAt = lastRunDate
    ? new Date(lastRunDate.getTime() + intervalMinutes * 60_000)
    : options.generatedAt;

  return {
    ...(lastRunAt ? { lastRunAt } : {}),
    nextRunAt: nextRunAt.toISOString()
  };
}

function isCronJobDue(job: INeonAutomationJob, evaluatedAt: Date): boolean {
  if (job.schedule === "manual-only") {
    return false;
  }
  // Real 5-field cron expressions evaluate due-ness from the expression + last
  // run (UTC). every-<N>m and any other schedule keep the existing precomputed
  // nextRunAt path unchanged.
  if (parseNeonCronSchedule(job.schedule).kind === "cron") {
    const lastRunMs = job.lastRunAt ? parseIsoDate(job.lastRunAt)?.getTime() : undefined;
    return isNeonCronScheduleDue(job.schedule, evaluatedAt.getTime(), lastRunMs);
  }
  const nextRunAt = job.nextRunAt ? parseIsoDate(job.nextRunAt) : undefined;
  return nextRunAt !== undefined && nextRunAt.getTime() <= evaluatedAt.getTime();
}

function parseIsoDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
