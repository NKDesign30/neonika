import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  describeNeonChannelRoute,
  normalizeNeonChannelRoute,
  type INeonChannelRouteInput,
  type INeonChannelRouteRef
} from "../channels/routeProjection.js";
import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";

/**
 * Gated, persistent Cron-job CRUD store (Automation plane).
 *
 * neonika's automation job catalog is otherwise hardcoded (neonAutomation.ts
 * createAutomationJobs -> heartbeat-review, memory-digest) with no add/edit/
 * remove/enable/disable and no persistence. This module is the upstream cron-store
 * parity slice (src/cron/store.ts saveCronStore + the cron-cli register.* CRUD
 * commands), rebuilt native and shadow-safe:
 *
 *  - Append-only JSONL of mutation EVENTS (never an in-place rewrite), exactly
 *    like commitmentStore.ts. Reading projects the events to the current job set
 *    (latest-per-id; a `remove` event tombstones the id).
 *  - Writing is gated default-OFF behind `NEON_CRON_STORE_ENABLED`. With the gate
 *    closed, `appendNeonCronStoreEvent` is a no-op that reports `blocked` — no file
 *    is created. Reading is always live (read-only never needs the gate).
 *  - Free-text fields (label) go through `redactText` before they touch disk.
 *
 * This persists the job DEFINITION only. It does not arm a scheduler or deliver
 * anything — the cron timer (cronTimerRuntime) and delivery stay separately gated.
 */

const cronStoreEnabledEnvKey = "NEON_CRON_STORE_ENABLED" as const;

export type TNeonCronJobMutation = "add" | "update" | "remove" | "enable" | "disable";

export interface INeonCronStoreJob {
  readonly id: string;
  readonly schedule: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deliveryTarget?: INeonChannelRouteRef;
}

export interface INeonCronStoreEvent {
  readonly id: string;
  readonly mutation: TNeonCronJobMutation;
  readonly atMs: number;
  readonly schedule?: string;
  readonly label?: string;
  readonly deliveryTarget?: INeonChannelRouteRef;
}

export interface INeonCronStoreGate {
  readonly enabled: boolean;
  readonly reason: "store-enabled" | "store-disabled";
  readonly envKey: typeof cronStoreEnabledEnvKey;
}

export type TNeonCronStoreAppendState = "appended" | "blocked";

export interface INeonCronStoreAppendResult {
  readonly state: TNeonCronStoreAppendState;
  readonly gate: INeonCronStoreGate;
  readonly storePath?: string;
  readonly diagnostics: readonly string[];
}

export type TNeonCronMutationResolution =
  | { readonly ok: true; readonly event: INeonCronStoreEvent }
  | { readonly ok: false; readonly reason: string };

export interface IResolveNeonCronMutationInput {
  readonly id: string;
  readonly mutation: TNeonCronJobMutation;
  readonly atMs: number;
  readonly schedule?: string;
  readonly label?: string;
  readonly deliveryTarget?: INeonChannelRouteInput;
}

export function resolveNeonCronStoreGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCronStoreGate {
  const enabled = readReadyCutoverEnv(env, cronStoreEnabledEnvKey);
  return {
    enabled,
    reason: enabled ? "store-enabled" : "store-disabled",
    envKey: cronStoreEnabledEnvKey
  };
}

export function resolveNeonCronStorePath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "cron", "cron-jobs.jsonl");
}

/**
 * Validate a requested mutation against the CURRENT projected job set and produce
 * the event to append. Pure: never touches disk. `add` requires the id to be free
 * and a schedule; `update/remove/enable/disable` require the id to exist.
 */
export function resolveNeonCronMutation(
  current: readonly INeonCronStoreJob[],
  input: IResolveNeonCronMutationInput
): TNeonCronMutationResolution {
  const existing = current.find((job) => job.id === input.id);

  if (input.mutation === "add") {
    if (existing) {
      return { ok: false, reason: `job "${input.id}" already exists` };
    }
    if (!input.schedule || input.schedule.trim().length === 0) {
      return { ok: false, reason: `job "${input.id}" needs a schedule to add` };
    }
  } else if (!existing) {
    return { ok: false, reason: `job "${input.id}" does not exist for ${input.mutation}` };
  }

  let deliveryTarget: INeonChannelRouteRef | undefined;
  if (input.deliveryTarget !== undefined) {
    deliveryTarget = normalizeNeonChannelRoute(input.deliveryTarget);
    if (!deliveryTarget) {
      return { ok: false, reason: `job "${input.id}" delivery target is not routable` };
    }
  }

  return {
    ok: true,
    event: {
      id: input.id,
      mutation: input.mutation,
      atMs: input.atMs,
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.label !== undefined ? { label: redactText(input.label) } : {}),
      ...(deliveryTarget ? { deliveryTarget } : {})
    }
  };
}

export async function appendNeonCronStoreEvent(
  projectRoot: string,
  gate: INeonCronStoreGate,
  event: INeonCronStoreEvent
): Promise<INeonCronStoreAppendResult> {
  if (!gate.enabled) {
    return {
      state: "blocked",
      gate,
      diagnostics: [`cron-store write blocked: requires ${gate.envKey}`]
    };
  }

  const storePath = resolveNeonCronStorePath(projectRoot);
  await mkdir(dirname(storePath), { recursive: true });
  await appendFile(storePath, `${JSON.stringify(event)}\n`, "utf8");

  return { state: "appended", gate, storePath, diagnostics: [] };
}

export async function readNeonCronStoreEvents(projectRoot: string): Promise<readonly INeonCronStoreEvent[]> {
  const storePath = resolveNeonCronStorePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const events: INeonCronStoreEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseNeonCronStoreEvent(line);
    if (parsed) {
      events.push(parsed);
    }
  }
  return events;
}

/**
 * Project an append-only event log to the current job set. Events apply in order;
 * `remove` tombstones an id, every other mutation upserts it. Pure, total.
 */
export function projectNeonCronStoreJobs(
  events: readonly INeonCronStoreEvent[]
): readonly INeonCronStoreJob[] {
  const jobs = new Map<string, INeonCronStoreJob>();

  for (const event of events) {
    if (event.mutation === "remove") {
      jobs.delete(event.id);
      continue;
    }

    const previous = jobs.get(event.id);
    const enabled = event.mutation === "disable" ? false : event.mutation === "enable" ? true : previous?.enabled ?? true;
    const deliveryTarget = event.deliveryTarget ?? previous?.deliveryTarget;

    jobs.set(event.id, {
      id: event.id,
      schedule: event.schedule ?? previous?.schedule ?? "",
      label: event.label ?? previous?.label ?? "",
      enabled,
      createdAtMs: previous?.createdAtMs ?? event.atMs,
      updatedAtMs: event.atMs,
      ...(deliveryTarget ? { deliveryTarget } : {})
    });
  }

  return [...jobs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderNeonCronStoreJobs(jobs: readonly INeonCronStoreJob[]): string {
  if (jobs.length === 0) {
    return "Neonika Cron store: 0 job(s)";
  }
  const lines = [`Neonika Cron store: ${jobs.length} job(s)`];
  for (const job of jobs) {
    lines.push(`- ${job.id} [${job.enabled ? "enabled" : "disabled"}] ${job.schedule} :: ${job.label}`);
  }
  return lines.join("\n");
}

/**
 * Read-only preview of where each job WOULD deliver. Always suppressed — it
 * describes the route, it never sends (mirrors the Shadow outbound seam
 * createNeonDryRunOutboundSender). Routes render leak-safe via
 * describeNeonChannelRoute (target ids redacted). Pure.
 */
export function renderNeonCronDeliveryPreview(jobs: readonly INeonCronStoreJob[]): string {
  if (jobs.length === 0) {
    return "Neonika Cron delivery preview: 0 job(s)";
  }
  const lines = [`Neonika Cron delivery preview: ${jobs.length} job(s) (suppressed, no send)`];
  for (const job of jobs) {
    lines.push(
      job.deliveryTarget
        ? `- ${job.id}: would deliver to ${describeNeonChannelRoute(job.deliveryTarget)} — suppressed`
        : `- ${job.id}: no delivery target`
    );
  }
  return lines.join("\n");
}

function parseNeonCronStoreEvent(line: string): INeonCronStoreEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as {
    readonly id?: unknown;
    readonly mutation?: unknown;
    readonly atMs?: unknown;
    readonly schedule?: unknown;
    readonly label?: unknown;
    readonly deliveryTarget?: unknown;
  };
  if (typeof record.id !== "string" || !isCronMutation(record.mutation) || typeof record.atMs !== "number") {
    return undefined;
  }
  const deliveryTarget = parseNeonCronDeliveryTarget(record.deliveryTarget);
  return {
    id: record.id,
    mutation: record.mutation,
    atMs: record.atMs,
    ...(typeof record.schedule === "string" ? { schedule: record.schedule } : {}),
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(deliveryTarget ? { deliveryTarget } : {})
  };
}

/** Tolerant parse of a persisted delivery target; normalization drops anything invalid. */
function parseNeonCronDeliveryTarget(value: unknown): INeonChannelRouteRef | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return normalizeNeonChannelRoute({
    channel: typeof record["channel"] === "string" ? record["channel"] : undefined,
    accountId: typeof record["accountId"] === "string" ? record["accountId"] : undefined,
    to: typeof record["to"] === "string" ? record["to"] : undefined,
    threadId: typeof record["threadId"] === "string" ? record["threadId"] : undefined,
    chatType: typeof record["chatType"] === "string" ? record["chatType"] : undefined
  });
}

function isCronMutation(value: unknown): value is TNeonCronJobMutation {
  return (
    value === "add" ||
    value === "update" ||
    value === "remove" ||
    value === "enable" ||
    value === "disable"
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
